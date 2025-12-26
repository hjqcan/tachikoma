import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { Diagnostic as VSCodeDiagnostic } from 'vscode-languageserver-types';
import type { LspServerHandle } from './server';
import { LANGUAGE_EXTENSIONS } from './language';

const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DIAGNOSTICS_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizePath(value: string): string {
  return path.normalize(value);
}

export namespace LSPClient {
  export type Diagnostic = VSCodeDiagnostic;

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>;

  export async function create(input: {
    serverID: string;
    server: LspServerHandle;
    root: string;
    workDir: string;
    /**
     * Called when the underlying language server process exits or errors.
     *
     * Used by the LSP state manager to evict dead clients so the next request can respawn.
     */
    onServerExit?: (info: { code: number | null; signal: NodeJS.Signals | null; error?: unknown }) => void;
  }): Promise<{
    root: string;
    serverID: string;
    connection: ReturnType<typeof createMessageConnection>;
    notify: {
      open: (input: { path: string }) => Promise<void>;
    };
    diagnostics: Map<string, Diagnostic[]>;
    waitForDiagnostics: (input: { path: string }) => Promise<void>;
    shutdown: () => Promise<void>;
  }> {
    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout),
      new StreamMessageWriter(input.server.process.stdin)
    );

    const diagnostics = new Map<string, Diagnostic[]>();
    const diagnosticsEmitter = new EventEmitter();

    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        connection.end();
      } catch {
        // ignore
      }
      try {
        connection.dispose();
      } catch {
        // ignore
      }
    };

    // If the server crashes, make sure we clean up the JSON-RPC connection and notify the caller
    // so the state manager can evict this client.
    input.server.process.once('exit', (code, signal) => {
      console.warn(`[LSP] Server ${input.serverID} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      cleanupConnection();
      try {
        input.onServerExit?.({ code, signal });
      } catch {
        // ignore
      }
    });
    input.server.process.once('error', (err) => {
      console.error(`[LSP] Server ${input.serverID} process error:`, err);
      cleanupConnection();
      try {
        input.onServerExit?.({ code: null, signal: null, error: err });
      } catch {
        // ignore
      }
    });

    connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: { uri: string; diagnostics: VSCodeDiagnostic[] }) => {
      try {
        const filePath = normalizePath(fileURLToPath(params.uri));
        diagnostics.set(filePath, params.diagnostics);
        diagnosticsEmitter.emit('diagnostics', filePath);
      } catch {
        // Ignore diagnostics parse errors.
      }
      }
    );

    connection.onRequest('window/workDoneProgress/create', async () => null);
    connection.onRequest('workspace/configuration', async () => [input.server.initialization ?? {}]);
    connection.onRequest('client/registerCapability', async () => {});
    connection.onRequest('client/unregisterCapability', async () => {});
    connection.onRequest('workspace/workspaceFolders', async () => [
      {
        name: 'workspace',
        uri: pathToFileURL(input.root).href,
      },
    ]);

    connection.listen();

    await withTimeout(
      connection.sendRequest('initialize', {
        rootUri: pathToFileURL(input.root).href,
        processId: input.server.process.pid,
        workspaceFolders: [
          {
            name: 'workspace',
            uri: pathToFileURL(input.root).href,
          },
        ],
        initializationOptions: {
          ...input.server.initialization,
        },
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            publishDiagnostics: {
              versionSupport: true,
            },
          },
        },
      }),
      45_000
    );

    await connection.sendNotification('initialized', {});

    if (input.server.initialization) {
      await connection.sendNotification('workspace/didChangeConfiguration', {
        settings: input.server.initialization,
      });
    }

    const fileVersions: Record<string, number> = {};

    const notify = {
      async open(args: { path: string }) {
        const resolved = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(input.workDir, args.path);
        const text = await readFile(resolved, 'utf-8');
        const extension = path.extname(resolved);
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? 'plaintext';

        const version = fileVersions[resolved];
        if (version !== undefined) {
          const next = version + 1;
          fileVersions[resolved] = next;
          await connection.sendNotification('textDocument/didChange', {
            textDocument: {
              uri: pathToFileURL(resolved).href,
              version: next,
            },
            contentChanges: [{ text }],
          });
          return;
        }

        diagnostics.delete(resolved);
        await connection.sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: pathToFileURL(resolved).href,
            languageId,
            version: 0,
            text,
          },
        });
        fileVersions[resolved] = 0;
      },
    };

    const waitForDiagnostics = async (args: { path: string }) => {
      const resolved = normalizePath(
        path.isAbsolute(args.path) ? args.path : path.resolve(input.workDir, args.path)
      );

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let handler: ((value: string) => void) | null = null;
      return withTimeout(
        new Promise<void>((resolve) => {
          handler = (value: string) => {
            if (value !== resolved) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              if (handler) diagnosticsEmitter.removeListener('diagnostics', handler);
              resolve();
            }, DIAGNOSTICS_DEBOUNCE_MS);
          };
          diagnosticsEmitter.on('diagnostics', handler);
        }),
        DIAGNOSTICS_TIMEOUT_MS
      )
        .catch(() => {})
        .finally(() => {
          if (handler) diagnosticsEmitter.removeListener('diagnostics', handler);
          if (debounceTimer) clearTimeout(debounceTimer);
        });
    };

    const shutdown = async () => {
      cleanupConnection();
      try {
        input.server.process.kill();
      } catch {
        // ignore
      }
    };

    return {
      root: input.root,
      serverID: input.serverID,
      connection,
      notify,
      diagnostics,
      waitForDiagnostics,
      shutdown,
    };
  }
}
