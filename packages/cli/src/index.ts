import { createInterface } from 'node:readline';
import {
  ChatEngine,
  VERSION as CORE_VERSION,
  type ChatEngineConfig,
  type ChatEvent,
} from '@tachikoma/core';
import type {
  ChatMemorySnapshot,
  ChatModelListing,
  ChatModelRef,
  ChatSession,
  ChatSessionSummary,
  ChatThinkingLevel,
} from '@tachikoma/core';

export const VERSION = CORE_VERSION;

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 与 core 的 APPROVAL_REQUIRED_TOOLS 同集（core 公共面刻意不导出内部策略常量） */
const APPROVABLE_TOOLS = ['write', 'edit', 'bash'] as const;

/** @internal */
export interface ChatSessionPort {
  readonly id: string;
  readonly model: ChatModelRef;
  readonly thinkingLevel: ChatThinkingLevel;
  readonly memoryStatus: ChatMemorySnapshot;
  readonly activeTools: readonly string[];
  readonly workspace: {
    root: string;
    toolset: 'read-only' | 'coding';
    tools: string[];
  } | null;
  abort(): Promise<boolean>;
  respondToApproval(callId: string, approved: boolean, scope?: 'call' | 'session'): boolean;
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
    workDir?: string;
    toolset?: 'read-only' | 'coding';
  }): Promise<ChatSessionPort>;
  deleteSession(sessionId: string): Promise<boolean>;
  listModels(): Promise<ChatModelListing[]>;
  listSessions(): Promise<ChatSessionSummary[]>;
  openSession(sessionId: string): Promise<ChatSessionPort | null>;
}

/** @internal */
export interface CliTerminal {
  readonly lines: AsyncIterable<string>;
  close(): void;
  onInterrupt(handler: () => void): () => void;
  prompt(): void;
  /**
   * 交互式提问（仅 TTY 提供）。abort 信号触发后必须释放输入流：
   * 之后用户输入回到 lines 迭代器，不被吞掉。
   */
  question?(prompt: string, options: { signal: AbortSignal }): Promise<string>;
}

/** 交互式审批回调；'approve-session' = 放行且本会话内该工具不再询问。signal 中止时应 reject */
type AskApproval = (
  request: { callId: string; tool: string; input: unknown },
  signal: AbortSignal
) => Promise<'approve' | 'approve-session' | 'deny'>;

interface ApprovalPolicy {
  /** --allow 预授予集合：命中即放行，不提问 */
  granted: ReadonlySet<string>;
  /** 未预授予时的交互提问；缺省（run 模式 / 非 TTY）即时拒绝 */
  ask?: AskApproval;
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
  /** 工具是能力授予：只走显式 --workdir，不设环境变量回退 */
  workDir?: string;
  /** 显式工具集；缺省 read-only（或由 --allow 隐含 coding） */
  toolset?: 'read-only' | 'coding';
  /** --allow 按次授予的审批工具（write/edit/bash 子集）；隐含 toolset: 'coding' */
  allowTools?: readonly string[];
}

interface TurnResult {
  status: 'success' | 'interrupted' | 'failed';
}

class CliUsageError extends Error {}

function asSessionPort(session: ChatSession): ChatSessionPort {
  return session;
}

function createProcessTerminal(): CliTerminal {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });
  const handlers = new Set<() => void>();
  const handleInterrupt = () => {
    for (const handler of handlers) handler();
  };
  let closed = false;
  input.on('SIGINT', handleInterrupt);
  process.on('SIGINT', handleInterrupt);
  // 逐个提问：并发审批（理论上可能）不共享 readline 的单一 question 槽位。
  let questionChain: Promise<unknown> = Promise.resolve();

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
      if (interactive) {
        input.setPrompt('tachikoma> ');
        input.prompt();
      }
    },
    ...(interactive
      ? {
          question: (prompt: string, options: { signal: AbortSignal }) => {
            const next = questionChain.then(
              () =>
                new Promise<string>((resolve, reject) => {
                  const fail = () => {
                    const error = new Error('The approval prompt was canceled.');
                    error.name = 'AbortError';
                    reject(error);
                  };
                  if (options.signal.aborted) {
                    fail();
                    return;
                  }
                  options.signal.addEventListener('abort', fail, { once: true });
                  input.question(prompt, { signal: options.signal }, (answer) => {
                    options.signal.removeEventListener('abort', fail);
                    resolve(answer);
                  });
                })
            );
            questionChain = next.catch(() => undefined);
            return next;
          },
        }
      : {}),
  };
}

const defaultDependencies: CliDependencies = {
  createEngine: (config) => {
    const engine = new ChatEngine(config);
    return {
      createSession: async (input) => asSessionPort(await engine.createSession(input)),
      deleteSession: (sessionId) => engine.deleteSession(sessionId),
      listModels: () => engine.listModels(),
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
  return `Tachikoma ${VERSION}\n\nUsage:\n  tachikoma [chat] [options]\n  tachikoma run [options] <prompt>\n  tachikoma help\n  tachikoma --version\n\nOptions:\n  --provider <id>    pi provider id\n  --model <id>       pi model id (requires --provider)\n  --thinking <level> off|minimal|low|medium|high|xhigh|max\n  --resume <id>      resume a JSONL session\n  --workdir <dir>    enable read-only workspace tools (read/grep/find/ls) in <dir>\n  --toolset <set>    read-only (default) | coding (adds write/edit/bash, per-call approval;\n                     requires --workdir)\n  --allow <tools>    grant write,edit,bash for this invocation (requires --workdir);\n                     without --allow, the REPL asks y/N per call (TTY only);\n                     run mode and non-TTY deny ungranted requests immediately\n  --no-memory        disable GoodMemory for this process\n  -h, --help         show help\n  -v, --version      show version\n\nREPL commands:\n  /new                         create a new session\n  /sessions                    list sessions\n  /resume <id>                 open a session\n  /delete <id>                 delete a session (and its event log)\n  /model [<provider>/<model>]  show or change the session model\n  /models                      list available models\n  /thinking [<level>]          show or change the thinking level\n  /tools                       show active tools\n  /workspace [<dir> [read-only|coding] | off]\n                               show or grant this session's workspace (new session)\n  /compact [instructions]      compact the active session\n  /memory                      show durable-memory status\n  /help                        show REPL help\n  /exit                        close the session and exit\n`;
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
  let workDir: string | undefined;
  let toolset: 'read-only' | 'coding' | undefined;
  let allowTools: readonly string[] | undefined;
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
      case '--workdir':
        workDir = takeValue(args, index, argument);
        index += 1;
        break;
      case '--toolset': {
        const requested = takeValue(args, index, argument);
        if (requested !== 'read-only' && requested !== 'coding') {
          throw new CliUsageError(`--toolset accepts read-only|coding; got: ${requested}`);
        }
        toolset = requested;
        index += 1;
        break;
      }
      case '--allow': {
        const requested = takeValue(args, index, argument)
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
        for (const name of requested) {
          if (!APPROVABLE_TOOLS.includes(name as (typeof APPROVABLE_TOOLS)[number])) {
            throw new CliUsageError(`--allow accepts ${APPROVABLE_TOOLS.join(',')}; got: ${name}`);
          }
        }
        allowTools = requested;
        index += 1;
        break;
      }
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
  if (allowTools && !workDir) {
    throw new CliUsageError('--allow requires --workdir');
  }
  if (toolset && !workDir) {
    throw new CliUsageError('--toolset requires --workdir');
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
    ...(workDir ? { workDir } : {}),
    ...(toolset ? { toolset } : {}),
    ...(allowTools ? { allowTools } : {}),
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
    ...(parsed.workDir ? { workDir: parsed.workDir } : {}),
    ...(parsed.toolset
      ? { toolset: parsed.toolset }
      : parsed.allowTools?.length
        ? { toolset: 'coding' as const }
        : {}),
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

function formatToolInput(input: unknown): string {
  const text = JSON.stringify(input) ?? '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 审批提示需要看清参数（此时 tool_call 尚未发生）：edit/write 走结构化预览，其余 JSON */
function formatApprovalInput(input: unknown): string {
  const clip = (text: string): string => (text.length > 600 ? `${text.slice(0, 599)}…` : text);
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.oldText === 'string' && typeof record.newText === 'string') {
      const path = typeof record.path === 'string' ? `${record.path}\n` : '';
      return `${path}--- old\n${clip(record.oldText)}\n+++ new\n${clip(record.newText)}`;
    }
    if (typeof record.path === 'string' && typeof record.content === 'string') {
      return `${record.path}\n${clip(record.content)}`;
    }
  }
  const text = JSON.stringify(input, null, 2) ?? '';
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}

function formatToolResult(event: Extract<ChatEvent, { type: 'tool_result' }>): string {
  if (event.isError) {
    const firstLine = event.output.split('\n')[0]?.slice(0, 120) ?? '';
    return `[tool:${event.tool}] error: ${firstLine}\n`;
  }
  return `[tool:${event.tool}] ok (${event.output.length} chars)\n`;
}

function formatMemorySnapshot(memory: ChatMemorySnapshot): string {
  const path = memory.databasePath ? ` (${memory.databasePath})` : '';
  return `${memory.status}${path}${memory.error ? `: ${memory.error}` : ''}`;
}

async function consumeTurn(
  session: ChatSessionPort,
  text: string,
  dependencies: Pick<CliDependencies, 'write' | 'writeError'>,
  approvals: ApprovalPolicy = { granted: new Set() }
): Promise<TurnResult> {
  let wroteText = false;
  let terminal: TurnResult['status'] | undefined;
  /** 在途的交互审批提问；resolved 事件（超时/中止）到达即取消对应提问 */
  const pendingAsks = new Map<string, AbortController>();
  /** tool_update 的 partial 输出是累积快照：记录已写长度，只写后缀 */
  const streamedOutput = new Map<string, string>();

  for await (const event of session.send(text)) {
    switch (event.type) {
      case 'tool_approval_request': {
        if (approvals.granted.has(event.tool)) {
          session.respondToApproval(event.callId, true);
          dependencies.writeError(`[approval:${event.tool}] granted (--allow)\n`);
        } else if (approvals.ask) {
          const controller = new AbortController();
          pendingAsks.set(event.callId, controller);
          void approvals
            .ask(event, controller.signal)
            .then((verdict) => {
              if (!pendingAsks.delete(event.callId)) return;
              session.respondToApproval(
                event.callId,
                verdict !== 'deny',
                verdict === 'approve-session' ? 'session' : 'call'
              );
              if (verdict === 'approve-session') {
                dependencies.writeError(
                  `[approval:${event.tool}] approved for the rest of this session\n`
                );
              }
            })
            .catch(() => void pendingAsks.delete(event.callId));
        } else {
          session.respondToApproval(event.callId, false);
          dependencies.writeError(
            `[approval:${event.tool}] denied (add --allow ${event.tool} to grant)\n`
          );
        }
        break;
      }
      case 'tool_approval_resolved': {
        const pendingAsk = pendingAsks.get(event.callId);
        if (pendingAsk && event.reason !== 'reply') {
          pendingAsks.delete(event.callId);
          pendingAsk.abort();
        }
        if (event.reason === 'timeout') {
          dependencies.writeError('[approval] timed out — denied\n');
        }
        break;
      }
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
      case 'tool_call':
        dependencies.writeError(`[tool:${event.tool}] ${formatToolInput(event.input)}\n`);
        break;
      case 'tool_result': {
        const streamed = streamedOutput.get(event.callId);
        if (streamed && !streamed.endsWith('\n')) dependencies.writeError('\n');
        streamedOutput.delete(event.callId);
        dependencies.writeError(formatToolResult(event));
        break;
      }
      case 'tool_update': {
        const previous = streamedOutput.get(event.callId) ?? '';
        const chunk = event.output.startsWith(previous)
          ? event.output.slice(previous.length)
          : event.output;
        if (chunk) dependencies.writeError(chunk);
        streamedOutput.set(event.callId, event.output);
        break;
      }
      case 'message_complete':
        terminal = event.status;
        if (!wroteText && event.content) dependencies.write(event.content);
        if (event.error) dependencies.writeError(`[error] ${event.error}\n`);
        break;
      case 'user_message': // 终端自带输入回显，无需重复渲染
      case 'message_start':
      case 'reasoning_delta':
        break;
    }
  }

  // 事件流已终结：core 保证在途审批都已 resolved，这里兜底取消尚挂着的提问。
  for (const controller of pendingAsks.values()) controller.abort();
  pendingAsks.clear();

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
    case 'delete': {
      if (!value) throw new CliUsageError('Use /delete <session-id>');
      const deletingActive = value === session.id;
      const deleted = await engine.deleteSession(value);
      dependencies.write(deleted ? `[deleted] ${value}\n` : `[delete] not found: ${value}\n`);
      if (deleted && deletingActive) {
        // 删的是当前会话（引擎已连带 close）：接一个同模型/同 thinking 的新会话
        const next = await engine.createSession({
          model: session.model,
          thinkingLevel: session.thinkingLevel,
        });
        dependencies.write(`[session] ${next.id}\n`);
        return { exit: false, session: next };
      }
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
    case 'models': {
      const current = session.model;
      const models = await engine.listModels();
      for (const listing of models) {
        const active =
          listing.provider === current.provider && listing.model === current.model ? ' *' : '';
        dependencies.write(
          `${listing.provider}/${listing.model}${listing.reasoning ? '  [reasoning]' : ''}${active}\n`
        );
      }
      dependencies.write(`[models] ${models.length} available\n`);
      return { exit: false, session };
    }
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
    case 'tools':
      dependencies.write(
        `[tools] ${session.activeTools.length > 0 ? session.activeTools.join(', ') : 'none'}\n`
      );
      return { exit: false, session };
    case 'workspace': {
      if (!value) {
        const workspace = session.workspace;
        dependencies.write(
          workspace
            ? `[workspace] ${workspace.root} (${workspace.toolset}: ${workspace.tools.join(', ')})\n`
            : '[workspace] none — /workspace <dir> [read-only|coding] to grant\n'
        );
        return { exit: false, session };
      }
      const [dir, toolsetArg, extra] = value.split(/\s+/);
      if (extra || (toolsetArg && toolsetArg !== 'read-only' && toolsetArg !== 'coding')) {
        throw new CliUsageError('Use /workspace <dir> [read-only|coding], or /workspace off');
      }
      // 授予是会话级的：换工作区 = 显式开一个带授予的新会话（模型/thinking 延续）
      const next = await engine.createSession({
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        ...(dir !== 'off'
          ? {
              workDir: dir,
              ...(toolsetArg ? { toolset: toolsetArg as 'read-only' | 'coding' } : {}),
            }
          : {}),
      });
      await session.close();
      const workspace = next.workspace;
      dependencies.write(
        `[session] ${next.id}\n[workspace] ${
          workspace
            ? `${workspace.root} (${workspace.toolset}: ${workspace.tools.join(', ')})`
            : 'none'
        }\n`
      );
      return { exit: false, session: next };
    }
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
    // run 模式无交互提问：授予只走显式 --allow，未授予即时拒绝（可脚本化、不挂起）。
    const result = await consumeTurn(session, parsed.prompt ?? '', dependencies, {
      granted: new Set(parsed.allowTools ?? []),
    });
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

  // 交互终端上，未经 --allow 预授予的审批走 y/N 提问；核心超时/中止会取消提问并释放输入流。
  const ask: AskApproval | undefined = terminal.question
    ? async (request, signal) => {
        dependencies.writeError(
          `[approval:${request.tool}]\n${formatApprovalInput(request.input)}\n`
        );
        const answer = (
          await terminal.question!(`approve ${request.tool}? [y/N/a=always this session] `, {
            signal,
          })
        ).trim();
        if (/^a(lways)?$/iu.test(answer)) return 'approve-session';
        return /^y(es)?$/iu.test(answer) ? 'approve' : 'deny';
      }
    : undefined;
  const approvals: ApprovalPolicy = {
    granted: new Set(parsed.allowTools ?? []),
    ...(ask ? { ask } : {}),
  };

  dependencies.write(
    `Tachikoma ${VERSION}\n[session] ${session.id}\n[memory] ${formatMemorySnapshot(session.memoryStatus)}\n${
      session.activeTools.length > 0 ? `[tools] ${session.activeTools.join(', ')}\n` : ''
    }`
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
          await consumeTurn(session, line, dependencies, approvals);
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
