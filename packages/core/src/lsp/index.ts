import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LSPClient } from './client';
import { LSPClient as LspClient } from './client';
import type { LspServerHandle, LspServerInfo } from './server';
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

export interface LspServerOverride {
  disabled?: boolean;
  command?: string[];
  extensions?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

type LspOverrideMap = Record<string, LspServerOverride>;

function readEnvValue(env: Record<string, string> | undefined, key: string): string | undefined {
  return env?.[key] ?? process.env[key];
}

function isDisabledValue(value: string | undefined): boolean {
  if (!value) return false;
  return ['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function isTruthyValue(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function isLspDisabled(env: Record<string, string> | undefined): boolean {
  const value = readEnvValue(env, 'TACHIKOMA_LSP') ?? readEnvValue(env, 'TACHIKOMA_LSP_ENABLED');
  return isDisabledValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOverrides(value: unknown): LspOverrideMap | undefined {
  if (!isRecord(value)) return undefined;
  const result: LspOverrideMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const entry: LspServerOverride = {};
    if (raw.disabled === true) {
      entry.disabled = true;
      result[key] = entry;
      continue;
    }
    if (Array.isArray(raw.command) && raw.command.every((item) => typeof item === 'string' && item.length > 0)) {
      entry.command = raw.command;
    }
    if (Array.isArray(raw.extensions) && raw.extensions.every((item) => typeof item === 'string')) {
      entry.extensions = raw.extensions;
    }
    if (isRecord(raw.env)) {
      const envMap: Record<string, string> = {};
      for (const [envKey, envValue] of Object.entries(raw.env)) {
        if (typeof envValue === 'string') envMap[envKey] = envValue;
      }
      if (Object.keys(envMap).length > 0) entry.env = envMap;
    }
    if (isRecord(raw.initialization)) {
      entry.initialization = raw.initialization;
    }
    if (Object.keys(entry).length > 0) result[key] = entry;
  }
  return result;
}

function parseLspOverrides(env: Record<string, string> | undefined): LspOverrideMap | false | undefined {
  const raw =
    readEnvValue(env, 'TACHIKOMA_LSP_CONFIG') ??
    readEnvValue(env, 'TACHIKOMA_LSP_MAP');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === false) return false;
    return normalizeOverrides(parsed);
  } catch {
    return undefined;
  }
}

function applyExperimentalFilters(servers: Record<string, LspServerInfo>, env: Record<string, string> | undefined) {
  const tyEnabled = isTruthyValue(readEnvValue(env, 'TACHIKOMA_LSP_EXPERIMENTAL_TY'));
  if (tyEnabled) {
    delete servers.pyright;
  } else {
    delete servers.ty;
  }
}

function applyLspOverrides(
  servers: Record<string, LspServerInfo>,
  overrides: LspOverrideMap | false | undefined
): Record<string, LspServerInfo> {
  if (overrides === false) return {};
  if (!overrides) return servers;

  const result: Record<string, LspServerInfo> = { ...servers };

  for (const [name, override] of Object.entries(overrides)) {
    if (override.disabled) {
      delete result[name];
      continue;
    }

    const existing = result[name];
    if (!existing && !override.command && !override.extensions) continue;

    const root = existing?.root ?? (async (_file, workDir) => workDir);
    const extensions = override.extensions ?? existing?.extensions ?? [];
    const baseSpawn = existing?.spawn;
    const envOverride = override.env;
    const initOverride = override.initialization;

    const spawnFn = override.command
      ? async (rootDir: string, _workDir: string, env: Record<string, string>) => {
          if (!override.command || override.command.length === 0) return undefined;
          const [first, ...rest] = override.command;
          if (!first) return undefined;
          const handle: LspServerHandle = {
            process: spawn(first, rest, {
              cwd: rootDir,
              env: { ...process.env, ...env, ...(envOverride ?? {}) },
            }),
          };
          if (initOverride && handle) {
            handle.initialization = initOverride;
          }
          return handle;
        }
      : async (rootDir: string, workDir: string, env: Record<string, string>) => {
          if (!baseSpawn) return undefined;
          const mergedEnv = envOverride ? { ...env, ...envOverride } : env;
          const handle = await baseSpawn(rootDir, workDir, mergedEnv);
          if (handle && initOverride) {
            handle.initialization = { ...handle.initialization, ...initOverride };
          }
          return handle;
        };

    result[name] = {
      id: name,
      root,
      extensions,
      spawn: spawnFn,
    };
  }

  return result;
}

function getState(workDir: string, env?: Record<string, string>): LspState {
  const resolvedWorkDir = path.resolve(workDir);
  const existing = states.get(resolvedWorkDir);
  const overrides = parseLspOverrides(env);
  const disabled = isLspDisabled(env) || overrides === false;

  if (existing) {
    if (env && Object.keys(env).length > 0) {
      existing.env = { ...existing.env, ...env };
    }
    if (disabled) {
      existing.servers = {};
    }
    return existing;
  }

  let servers = disabled ? {} : getDefaultServers();
  if (!disabled) {
    applyExperimentalFilters(servers, env);
    servers = applyLspOverrides(servers, overrides);
  }

  const state: LspState = {
    workDir: resolvedWorkDir,
    env: env ?? {},
    servers,
    clients: [],
    broken: new Set<string>(),
    spawning: new Map<string, Promise<LSPClient.Info | undefined>>(),
  };
  states.set(resolvedWorkDir, state);
  return state;
}

async function getClients(filePath: string, workDir: string, env?: Record<string, string>) {
  const state = getState(workDir, env);
  const extension = path.extname(filePath) || path.basename(filePath);
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
    const extension = path.extname(filePath) || path.basename(filePath);
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
