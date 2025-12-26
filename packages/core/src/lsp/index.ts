import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LSPClient } from './client';
import { LSPClient as LspClient } from './client';
import type { LspServerInfo } from './server';
import { getDefaultServers } from './server';

export interface LspStatus {
  id: string;
  root: string;
  status: 'connected' | 'error';
}

interface LspState {
  workDir: string;
  env: Record<string, string>;
  servers: Record<string, LspServerInfo>;
  clients: LSPClient.Info[];
  broken: Set<string>;
  spawning: Map<string, Promise<LSPClient.Info | undefined>>;
}

const states = new Map<string, LspState>();

function isLspDisabled(env: Record<string, string> | undefined): boolean {
  const value = env?.TACHIKOMA_LSP ?? env?.TACHIKOMA_LSP_ENABLED;
  if (!value) return false;
  return ['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function getState(workDir: string, env?: Record<string, string>): LspState {
  const resolvedWorkDir = path.resolve(workDir);
  const existing = states.get(resolvedWorkDir);
  const disabled = isLspDisabled(env);

  if (existing) {
    if (env && Object.keys(env).length > 0) {
      existing.env = { ...existing.env, ...env };
    }
    if (disabled) {
      existing.servers = {};
    }
    return existing;
  }

  const state: LspState = {
    workDir: resolvedWorkDir,
    env: env ?? {},
    servers: disabled ? {} : getDefaultServers(),
    clients: [],
    broken: new Set<string>(),
    spawning: new Map<string, Promise<LSPClient.Info | undefined>>(),
  };
  states.set(resolvedWorkDir, state);
  return state;
}

async function getClients(filePath: string, workDir: string, env?: Record<string, string>) {
  const state = getState(workDir, env);
  const extension = path.extname(filePath) || filePath;
  const result: LSPClient.Info[] = [];

  for (const server of Object.values(state.servers)) {
    if (server.extensions.length > 0 && !server.extensions.includes(extension)) continue;

    const root = await server.root(filePath, state.workDir);
    if (!root) continue;
    const key = `${root}:${server.id}`;
    if (state.broken.has(key)) continue;

    const existing = state.clients.find((client) => client.root === root && client.serverID === server.id);
    if (existing) {
      result.push(existing);
      continue;
    }

    const inflight = state.spawning.get(key);
    if (inflight) {
      const client = await inflight;
      if (client) result.push(client);
      continue;
    }

    const taskPromise = (async () => {
      try {
        const handle = await server.spawn(root, state.workDir, state.env);
        if (!handle) {
          state.broken.add(key);
          return undefined;
        }
        let client: LSPClient.Info;
        try {
          client = await LspClient.create({
            serverID: server.id,
            server: handle,
            root,
            workDir: state.workDir,
            onServerExit: () => {
              // Evict dead clients so future requests can respawn cleanly.
              state.clients = state.clients.filter(
                (item) => !(item.root === root && item.serverID === server.id)
              );
            },
          });
        } catch (error) {
          handle.process.kill();
          throw error;
        }
        const existingClient = state.clients.find(
          (item) => item.root === root && item.serverID === server.id
        );
        if (existingClient) {
          handle.process.kill();
          return existingClient;
        }

        state.clients.push(client);
        return client;
      } catch (error) {
        state.broken.add(key);
        return undefined;
      }
    })();

    state.spawning.set(key, taskPromise);
    taskPromise.finally(() => {
      if (state.spawning.get(key) === taskPromise) {
        state.spawning.delete(key);
      }
    });
    const client = await taskPromise;
    if (client) result.push(client);
  }

  return result;
}

export namespace LSP {
  export type Diagnostic = LSPClient.Diagnostic;

  export async function init(workDir: string, env?: Record<string, string>) {
    return getState(workDir, env);
  }

  export async function status(workDir: string, env?: Record<string, string>): Promise<LspStatus[]> {
    const state = getState(workDir, env);
    return state.clients.map((client) => ({
      id: client.serverID,
      root: path.relative(state.workDir, client.root),
      status: 'connected',
    }));
  }

  export async function hasClients(filePath: string, workDir: string, env?: Record<string, string>) {
    const state = getState(workDir, env);
    const extension = path.extname(filePath) || filePath;
    for (const server of Object.values(state.servers)) {
      if (server.extensions.length > 0 && !server.extensions.includes(extension)) continue;
      const root = await server.root(filePath, state.workDir);
      if (!root) continue;
      if (state.broken.has(`${root}:${server.id}`)) continue;
      return true;
    }
    return false;
  }

  export async function touchFile(
    filePath: string,
    workDir: string,
    env?: Record<string, string>,
    waitForDiagnostics?: boolean
  ) {
    const clients = await getClients(filePath, workDir, env);
    await Promise.all(
      clients.map(async (client) => {
        const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: filePath }) : Promise.resolve();
        await client.notify.open({ path: filePath });
        return wait;
      })
    );
  }

  export async function diagnostics(workDir: string, env?: Record<string, string>) {
    const state = getState(workDir, env);
    const results: Record<string, LSPClient.Diagnostic[]> = {};
    for (const client of state.clients) {
      for (const [file, diagnostics] of client.diagnostics.entries()) {
        const list = results[file] ?? [];
        list.push(...diagnostics);
        results[file] = list;
      }
    }
    return results;
  }

  export async function hover(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, (client) =>
      client.connection.sendRequest('textDocument/hover', {
        textDocument: {
          uri: pathToFileURL(input.file).href,
        },
        position: {
          line: input.line,
          character: input.character,
        },
      }).catch(() => null)
    );
  }

  export async function definition(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, (client) =>
      client.connection
        .sendRequest('textDocument/definition', {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null)
    ).then((result) => result.flat().filter(Boolean));
  }

  export async function references(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, (client) =>
      client.connection
        .sendRequest('textDocument/references', {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          context: { includeDeclaration: true },
        })
        .catch(() => [])
    ).then((result) => result.flat().filter(Boolean));
  }

  export async function implementation(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, (client) =>
      client.connection
        .sendRequest('textDocument/implementation', {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => null)
    ).then((result) => result.flat().filter(Boolean));
  }

  export async function documentSymbol(
    uri: string,
    workDir: string,
    env?: Record<string, string>
  ) {
    const file = fileURLToPath(uri);
    return run(file, workDir, env, (client) =>
      client.connection
        .sendRequest('textDocument/documentSymbol', {
          textDocument: {
            uri,
          },
        })
        .catch(() => [])
    )
      .then((result) => result.flat())
      .then((result) => result.filter(Boolean));
  }

  export async function workspaceSymbol(
    query: string,
    workDir: string,
    env?: Record<string, string>
  ) {
    return runAll(workDir, env, (client) =>
      client.connection
        .sendRequest('workspace/symbol', {
          query,
        })
        .catch(() => [])
    ).then((result) => result.flat());
  }

  export async function prepareCallHierarchy(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, (client) =>
      client.connection
        .sendRequest('textDocument/prepareCallHierarchy', {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])
    ).then((result) => result.flat().filter(Boolean));
  }

  export async function incomingCalls(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, async (client) => {
      const items = (await client.connection
        .sendRequest('textDocument/prepareCallHierarchy', {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[];
      if (!items?.length) return [];
      return client.connection.sendRequest('callHierarchy/incomingCalls', { item: items[0] }).catch(() => []);
    }).then((result) => result.flat().filter(Boolean));
  }

  export async function outgoingCalls(
    input: { file: string; line: number; character: number },
    workDir: string,
    env?: Record<string, string>
  ) {
    return run(input.file, workDir, env, async (client) => {
      const items = (await client.connection
        .sendRequest('textDocument/prepareCallHierarchy', {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
        })
        .catch(() => [])) as any[];
      if (!items?.length) return [];
      return client.connection.sendRequest('callHierarchy/outgoingCalls', { item: items[0] }).catch(() => []);
    }).then((result) => result.flat().filter(Boolean));
  }

  export function formatDiagnostic(diagnostic: LSPClient.Diagnostic): string {
    const severityMap: Record<number, string> = {
      1: 'ERROR',
      2: 'WARN',
      3: 'INFO',
      4: 'HINT',
    };
    const severity = severityMap[diagnostic.severity ?? 1] ?? 'ERROR';
    const line = diagnostic.range.start.line + 1;
    const col = diagnostic.range.start.character + 1;
    return `${severity} [${line}:${col}] ${diagnostic.message}`;
  }
}

async function runAll<T>(
  workDir: string,
  env: Record<string, string> | undefined,
  input: (client: LSPClient.Info) => Promise<T>
): Promise<T[]> {
  const state = getState(workDir, env);
  const tasks = state.clients.map((client) => input(client));
  return Promise.all(tasks);
}

async function run<T>(
  filePath: string,
  workDir: string,
  env: Record<string, string> | undefined,
  input: (client: LSPClient.Info) => Promise<T>
): Promise<T[]> {
  const clients = await getClients(filePath, workDir, env);
  const tasks = clients.map((client) => input(client));
  return Promise.all(tasks);
}
