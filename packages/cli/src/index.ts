import { createInterface } from 'node:readline';
import {
  ChatEngine,
  VERSION as CORE_VERSION,
  type ChatEngineConfig,
  type ChatEvent,
} from '@tachikoma/core';
import type {
  ChatMemorySnapshot,
  ChatModelRef,
  ChatSession,
  ChatSessionSummary,
  ChatThinkingLevel,
} from '@tachikoma/core';

export const VERSION = CORE_VERSION;

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** @internal */
export interface ChatSessionPort {
  readonly id: string;
  readonly model: ChatModelRef;
  readonly thinkingLevel: ChatThinkingLevel;
  readonly memoryStatus: ChatMemorySnapshot;
  abort(): Promise<boolean>;
  close(): Promise<void>;
  compact(instructions?: string): Promise<unknown>;
  send(text: string, options?: { signal?: AbortSignal }): AsyncGenerator<ChatEvent>;
  setModel(model: ChatModelRef): Promise<ChatModelRef>;
  setThinkingLevel(level: ChatThinkingLevel): ChatThinkingLevel;
}

/** @internal */
export interface ChatEnginePort {
  createSession(input?: {
    model?: ChatModelRef;
    thinkingLevel?: ChatThinkingLevel;
    title?: string;
  }): Promise<ChatSessionPort>;
  listSessions(): Promise<ChatSessionSummary[]>;
  openSession(sessionId: string): Promise<ChatSessionPort | null>;
}

/** @internal */
export interface CliTerminal {
  readonly lines: AsyncIterable<string>;
  close(): void;
  onInterrupt(handler: () => void): () => void;
  prompt(): void;
}

/** @internal */
export interface CliDependencies {
  createEngine(config: ChatEngineConfig): ChatEnginePort;
  createTerminal(): CliTerminal;
  env: Readonly<Record<string, string | undefined>>;
  onInterrupt(handler: () => void): () => void;
  write(text: string): void;
  writeError(text: string): void;
}

interface ParsedArguments {
  command: 'chat' | 'help' | 'run' | 'version';
  model?: ChatModelRef;
  noMemory: boolean;
  prompt?: string;
  resumeId?: string;
  thinkingLevel?: ChatThinkingLevel;
}

interface TurnResult {
  status: 'success' | 'interrupted' | 'failed';
}

class CliUsageError extends Error {}

function asSessionPort(session: ChatSession): ChatSessionPort {
  return session;
}

function createProcessTerminal(): CliTerminal {
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  const handlers = new Set<() => void>();
  const handleInterrupt = () => {
    for (const handler of handlers) handler();
  };
  let closed = false;
  input.on('SIGINT', handleInterrupt);
  process.on('SIGINT', handleInterrupt);

  return {
    lines: input,
    close: () => {
      if (closed) return;
      closed = true;
      process.off('SIGINT', handleInterrupt);
      input.close();
    },
    onInterrupt: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    prompt: () => {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        input.setPrompt('tachikoma> ');
        input.prompt();
      }
    },
  };
}

const defaultDependencies: CliDependencies = {
  createEngine: (config) => {
    const engine = new ChatEngine(config);
    return {
      createSession: async (input) => asSessionPort(await engine.createSession(input)),
      listSessions: () => engine.listSessions(),
      openSession: async (sessionId) => {
        const session = await engine.openSession(sessionId);
        return session ? asSessionPort(session) : null;
      },
    };
  },
  createTerminal: createProcessTerminal,
  env: process.env,
  onInterrupt: (handler) => {
    process.on('SIGINT', handler);
    return () => process.off('SIGINT', handler);
  },
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
};

function helpText(): string {
  return `Tachikoma ${VERSION}\n\nUsage:\n  tachikoma [chat] [options]\n  tachikoma run [options] <prompt>\n  tachikoma help\n  tachikoma --version\n\nOptions:\n  --provider <id>    pi provider id\n  --model <id>       pi model id (requires --provider)\n  --thinking <level> off|minimal|low|medium|high|xhigh|max\n  --resume <id>      resume a JSONL session\n  --no-memory        disable GoodMemory for this process\n  -h, --help         show help\n  -v, --version      show version\n\nREPL commands:\n  /new                         create a new session\n  /sessions                    list sessions\n  /resume <id>                 open a session\n  /model [<provider>/<model>]  show or change the session model\n  /thinking [<level>]          show or change the thinking level\n  /compact [instructions]      compact the active session\n  /memory                      show durable-memory status\n  /help                        show REPL help\n  /exit                        close the session and exit\n`;
}

function parseThinkingLevel(value: string): ChatThinkingLevel {
  if (!THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number])) {
    throw new CliUsageError(`Unknown thinking level: ${value}`);
  }
  return value as ChatThinkingLevel;
}

function takeValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

function parseArguments(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): ParsedArguments {
  let provider: string | undefined;
  let modelId: string | undefined;
  let thinkingLevel: ChatThinkingLevel | undefined;
  let resumeId: string | undefined;
  let noMemory = false;
  let forceHelp = false;
  let forceVersion = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--provider':
        provider = takeValue(args, index, argument);
        index += 1;
        break;
      case '--model':
        modelId = takeValue(args, index, argument);
        index += 1;
        break;
      case '--thinking':
        thinkingLevel = parseThinkingLevel(takeValue(args, index, argument));
        index += 1;
        break;
      case '--resume':
        resumeId = takeValue(args, index, argument);
        index += 1;
        break;
      case '--no-memory':
        noMemory = true;
        break;
      case '--help':
      case '-h':
        forceHelp = true;
        break;
      case '--version':
      case '-v':
        forceVersion = true;
        break;
      default:
        if (argument?.startsWith('-')) throw new CliUsageError(`Unknown option: ${argument}`);
        if (argument) positional.push(argument);
    }
  }

  if (forceHelp) return { command: 'help', noMemory };
  if (forceVersion) return { command: 'version', noMemory };

  provider ??= env.TACHIKOMA_PROVIDER || undefined;
  modelId ??= env.TACHIKOMA_MODEL || undefined;
  if (Boolean(provider) !== Boolean(modelId)) {
    throw new CliUsageError('Model selection requires both provider and model');
  }

  const first = positional[0];
  const command = first === undefined ? 'chat' : first;
  if (!['chat', 'help', 'run', 'version'].includes(command)) {
    throw new CliUsageError(`Unknown command: ${command}`);
  }

  if (command === 'chat' && positional.length > 1) {
    throw new CliUsageError('chat does not accept a prompt; use tachikoma run <prompt>');
  }
  const prompt = command === 'run' ? positional.slice(1).join(' ').trim() : undefined;
  if (command === 'run' && !prompt) throw new CliUsageError('run requires a prompt');

  return {
    command: command as ParsedArguments['command'],
    noMemory,
    ...(provider && modelId ? { model: { provider, model: modelId } } : {}),
    ...(prompt ? { prompt } : {}),
    ...(resumeId ? { resumeId } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function engineConfig(
  parsed: ParsedArguments,
  env: Readonly<Record<string, string | undefined>>
): ChatEngineConfig {
  return {
    ...(env.TACHIKOMA_DATA_DIR ? { dataDir: env.TACHIKOMA_DATA_DIR } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
    memory: parsed.noMemory
      ? false
      : {
          ...(env.TACHIKOMA_USER_ID ? { userId: env.TACHIKOMA_USER_ID } : {}),
        },
  };
}

function formatMemoryEvent(event: Extract<ChatEvent, { type: 'memory_status' }>): string {
  const detail = event.error ? `: ${event.error}` : '';
  return `[memory:${event.phase}] ${event.status}${detail}\n`;
}

function formatMemorySnapshot(memory: ChatMemorySnapshot): string {
  const path = memory.databasePath ? ` (${memory.databasePath})` : '';
  return `${memory.status}${path}${memory.error ? `: ${memory.error}` : ''}`;
}

async function consumeTurn(
  session: ChatSessionPort,
  text: string,
  dependencies: Pick<CliDependencies, 'write' | 'writeError'>
): Promise<TurnResult> {
  let wroteText = false;
  let terminal: TurnResult['status'] | undefined;

  for await (const event of session.send(text)) {
    switch (event.type) {
      case 'message_delta':
        dependencies.write(event.text);
        wroteText = true;
        break;
      case 'retry':
        dependencies.writeError(
          `[retry] ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.error}\n`
        );
        break;
      case 'compaction':
        dependencies.writeError(
          `[compaction] ${event.phase} (${event.reason})${event.error ? `: ${event.error}` : ''}\n`
        );
        break;
      case 'memory_status':
        dependencies.writeError(formatMemoryEvent(event));
        break;
      case 'message_complete':
        terminal = event.status;
        if (!wroteText && event.content) dependencies.write(event.content);
        if (event.error) dependencies.writeError(`[error] ${event.error}\n`);
        break;
      case 'message_start':
      case 'reasoning_delta':
        break;
    }
  }

  if (wroteText || terminal === 'success') dependencies.write('\n');
  if (!terminal) {
    dependencies.writeError('[error] turn ended without message_complete\n');
    return { status: 'failed' };
  }
  return { status: terminal };
}

async function openInitialSession(
  engine: ChatEnginePort,
  parsed: ParsedArguments
): Promise<ChatSessionPort> {
  if (parsed.resumeId) {
    const resumed = await engine.openSession(parsed.resumeId);
    if (!resumed) throw new CliUsageError(`Session not found: ${parsed.resumeId}`);
    return resumed;
  }
  return engine.createSession({
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
  });
}

function parseModelReference(value: string): ChatModelRef {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliUsageError('Use /model <provider>/<model>');
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function formatSession(summary: ChatSessionSummary): string {
  const model = summary.model
    ? `${summary.model.provider}/${summary.model.model}`
    : 'model unavailable';
  const suffix =
    summary.status === 'corrupt' ? ` corrupt: ${summary.error ?? 'unknown error'}` : '';
  return `${summary.sessionId}  ${model}  ${summary.messageCount} messages${suffix}\n`;
}

async function handleSlashCommand(
  line: string,
  engine: ChatEnginePort,
  session: ChatSessionPort,
  dependencies: Pick<CliDependencies, 'write' | 'writeError'>
): Promise<{ exit: boolean; session: ChatSessionPort }> {
  const [command, ...arguments_] = line.slice(1).trim().split(/\s+/);
  const value = arguments_.join(' ').trim();

  switch (command) {
    case 'new': {
      const model = session.model;
      const thinkingLevel = session.thinkingLevel;
      const next = await engine.createSession({
        model,
        thinkingLevel,
      });
      await session.close();
      dependencies.write(`[session] ${next.id}\n`);
      return { exit: false, session: next };
    }
    case 'sessions': {
      const sessions = await engine.listSessions();
      if (sessions.length === 0) dependencies.write('[sessions] none\n');
      for (const summary of sessions) dependencies.write(formatSession(summary));
      return { exit: false, session };
    }
    case 'resume': {
      if (!value) throw new CliUsageError('Use /resume <session-id>');
      const next = await engine.openSession(value);
      if (!next) throw new CliUsageError(`Session not found: ${value}`);
      if (next !== session) await session.close();
      dependencies.write(`[session] ${next.id}\n`);
      return { exit: false, session: next };
    }
    case 'model':
      if (!value) {
        dependencies.write(`[model] ${session.model.provider}/${session.model.model}\n`);
      } else {
        const model = await session.setModel(parseModelReference(value));
        dependencies.write(`[model] ${model.provider}/${model.model}\n`);
      }
      return { exit: false, session };
    case 'thinking':
      if (!value) {
        dependencies.write(`[thinking] ${session.thinkingLevel}\n`);
      } else {
        const level = session.setThinkingLevel(parseThinkingLevel(value));
        dependencies.write(`[thinking] ${level}\n`);
      }
      return { exit: false, session };
    case 'compact':
      await session.compact(value || undefined);
      dependencies.write('[compaction] complete\n');
      return { exit: false, session };
    case 'memory':
      dependencies.write(`[memory] ${formatMemorySnapshot(session.memoryStatus)}\n`);
      return { exit: false, session };
    case 'help':
      dependencies.write(helpText());
      return { exit: false, session };
    case 'exit':
      return { exit: true, session };
    default:
      throw new CliUsageError(`Unknown REPL command: /${command ?? ''}`);
  }
}

async function runOneShot(
  engine: ChatEnginePort,
  parsed: ParsedArguments,
  dependencies: CliDependencies
): Promise<number> {
  const session = await openInitialSession(engine, parsed);
  let interrupted = false;
  const removeInterrupt = dependencies.onInterrupt(() => {
    interrupted = true;
    void session.abort();
  });

  try {
    const result = await consumeTurn(session, parsed.prompt ?? '', dependencies);
    if (interrupted || result.status === 'interrupted') return 130;
    return result.status === 'success' ? 0 : 1;
  } finally {
    removeInterrupt();
    await session.close();
  }
}

async function runRepl(
  engine: ChatEnginePort,
  parsed: ParsedArguments,
  dependencies: CliDependencies
): Promise<number> {
  let session = await openInitialSession(engine, parsed);
  const terminal = dependencies.createTerminal();
  let processing = false;
  let signalExit = false;
  const removeInterrupt = terminal.onInterrupt(() => {
    if (processing) {
      void session.abort();
      return;
    }
    signalExit = true;
    terminal.close();
  });

  dependencies.write(
    `Tachikoma ${VERSION}\n[session] ${session.id}\n[memory] ${formatMemorySnapshot(session.memoryStatus)}\n`
  );
  terminal.prompt();

  try {
    for await (const rawLine of terminal.lines) {
      const line = rawLine.trim();
      if (!line) {
        terminal.prompt();
        continue;
      }

      try {
        if (line.startsWith('/')) {
          const result = await handleSlashCommand(line, engine, session, dependencies);
          session = result.session;
          if (result.exit) break;
        } else {
          processing = true;
          await consumeTurn(session, line, dependencies);
          processing = false;
        }
      } catch (error) {
        processing = false;
        dependencies.writeError(
          `[error] ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
      terminal.prompt();
    }
  } finally {
    removeInterrupt();
    terminal.close();
    await session.close();
  }

  return signalExit ? 130 : 0;
}

export function runCli(args: readonly string[]): Promise<number>;
/** @internal */
export function runCli(
  args: readonly string[],
  overrides: Partial<CliDependencies>
): Promise<number>;
export async function runCli(
  args: readonly string[],
  overrides: Partial<CliDependencies> = {}
): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  try {
    const parsed = parseArguments(args, dependencies.env);
    if (parsed.command === 'help') {
      dependencies.write(helpText());
      return 0;
    }
    if (parsed.command === 'version') {
      dependencies.write(`Tachikoma ${VERSION}\n`);
      return 0;
    }

    const engine = dependencies.createEngine(engineConfig(parsed, dependencies.env));
    return parsed.command === 'run'
      ? await runOneShot(engine, parsed, dependencies)
      : await runRepl(engine, parsed, dependencies);
  } catch (error) {
    dependencies.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}
