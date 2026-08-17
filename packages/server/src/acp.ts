#!/usr/bin/env bun
/**
 * tachikoma-acp —— ACP（Agent Client Protocol v1）stdio 适配器（spike）。
 *
 * 编辑器（Zed/JetBrains 等）以子进程方式拉起本 bin，经 stdin/stdout 走
 * 换行分隔的 JSON-RPC 2.0。进程内直接包 ChatEngine（不代理 engined——ACP
 * 的进程模型就是"编辑器管子进程"，编辑器自持转录，WAL 扇出在此无用武之地）。
 *
 * 支持面（能力协商如实申报）：全新会话 + 纯文本 prompt + 工具流 + 审批 +
 * 取消。不支持 session/load、客户端 fs/terminal、MCP 透传、图像。
 * 审批是带外的：session/request_permission 发出后不阻塞事件泵——引擎自己的
 * 超时/中止兜底，迟到或重复的应答安全忽略（respondToApproval 未命中返回 false）。
 *
 * 模型经 TACHIKOMA_PROVIDER/TACHIKOMA_MODEL（Zed 配置的 env 块）；
 * --toolset read-only|coding；记忆关闭。stdout 只写 JSON-RPC 帧。
 */

import { createInterface } from 'node:readline';
import { ChatEngine } from '@hjqcan/tachikoma-core';
import type { ChatSession } from '@hjqcan/tachikoma-core';
import {
  approvalOf,
  initializeResult,
  permissionRequestOf,
  promptText,
  sessionUpdateOf,
  stopReasonOf,
} from './acp-map';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function parseArgs(argv: string[]): { toolset: 'read-only' | 'coding' } {
  let toolset: 'read-only' | 'coding' = 'read-only';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--toolset') {
      const value = argv[index + 1];
      if (value !== 'read-only' && value !== 'coding') {
        console.error(`tachikoma-acp: invalid --toolset: ${value ?? '(missing)'}`);
        process.exit(2);
      }
      toolset = value;
      index += 1;
    }
  }
  return { toolset };
}

const { toolset } = parseArgs(process.argv.slice(2));

const provider = process.env.TACHIKOMA_PROVIDER;
const model = process.env.TACHIKOMA_MODEL;
if (!provider || !model) {
  console.error('tachikoma-acp: TACHIKOMA_PROVIDER and TACHIKOMA_MODEL are required.');
  process.exit(2);
}

const engine = new ChatEngine({
  ...(process.env.TACHIKOMA_DATA_DIR ? { dataDir: process.env.TACHIKOMA_DATA_DIR } : {}),
  ...(process.env.TACHIKOMA_CONFIG_DIR ? { configDir: process.env.TACHIKOMA_CONFIG_DIR } : {}),
  model: { provider, model },
  memory: false,
  toolset,
});

const sessions = new Map<string, ChatSession>();
let nextOutboundId = 1;
/** 出站请求（session/request_permission）应答回调；键为 JSON-RPC id */
const outboundHandlers = new Map<number, (result: unknown) => void>();

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function sendNotification(method: string, params: unknown): void {
  send({ method, params });
}

function sendRequest(method: string, params: unknown, onResult: (result: unknown) => void): number {
  const id = nextOutboundId;
  nextOutboundId += 1;
  outboundHandlers.set(id, onResult);
  send({ id, method, params });
  return id;
}

const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL = -32603;
const RPC_METHOD_NOT_FOUND = -32601;

async function handlePrompt(params: unknown): Promise<unknown> {
  const { sessionId, prompt } = (params ?? {}) as { sessionId?: unknown; prompt?: unknown };
  const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  if (!session) {
    throw { code: RPC_INVALID_PARAMS, message: `Unknown sessionId: ${String(sessionId)}` };
  }
  const text = promptText(prompt);
  if (!text.trim()) {
    throw { code: RPC_INVALID_PARAMS, message: 'Prompt has no text content.' };
  }
  // 本回合发出的审批请求 id：回合终结时清扫未应答的 handler——编辑器可以永远
  // 不回（引擎超时兜底已拒），残留的闭包会捕获 session 终生驻留。
  const pendingPermissionIds: number[] = [];
  try {
    for await (const event of session.send(text)) {
      if (event.type === 'tool_approval_request') {
        const callId = event.callId;
        // 带外审批：不 await；引擎超时/中止兜底，迟到应答被 respondToApproval 安全吞掉。
        pendingPermissionIds.push(
          sendRequest('session/request_permission', permissionRequestOf(event), (result) => {
            const outcome = (result as { outcome?: unknown } | null)?.outcome;
            const decision = approvalOf(outcome);
            if (decision) {
              session.respondToApproval(callId, decision.approved, decision.scope);
            }
          })
        );
        continue;
      }
      if (event.type === 'message_complete') {
        if (event.status === 'failed') {
          throw { code: RPC_INTERNAL, message: event.error ?? 'Chat turn failed.' };
        }
        return { stopReason: stopReasonOf(event) };
      }
      const update = sessionUpdateOf(event);
      if (update) {
        sendNotification('session/update', update);
      }
    }
    throw { code: RPC_INTERNAL, message: 'Turn ended without a terminal event.' };
  } finally {
    for (const id of pendingPermissionIds) {
      outboundHandlers.delete(id);
    }
  }
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return initializeResult();
    case 'session/new': {
      const { cwd } = (params ?? {}) as { cwd?: unknown };
      if (typeof cwd !== 'string' || cwd.length === 0) {
        throw { code: RPC_INVALID_PARAMS, message: 'session/new requires an absolute cwd.' };
      }
      const session = await engine.createSession({ workDir: cwd, toolset });
      sessions.set(session.id, session);
      return { sessionId: session.id };
    }
    case 'session/prompt':
      return handlePrompt(params);
    default:
      throw { code: RPC_METHOD_NOT_FOUND, message: `Method not supported: ${method}` };
  }
}

function handleNotification(method: string, params: unknown): void {
  if (method === 'session/cancel') {
    const { sessionId } = (params ?? {}) as { sessionId?: unknown };
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    void session?.abort();
  }
}

const readline = createInterface({ input: process.stdin });
readline.on('line', (line) => {
  if (!line.trim()) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // 出站请求的应答：有 id、无 method。
  if (message.method === undefined && typeof message.id === 'number') {
    const handler = outboundHandlers.get(message.id);
    outboundHandlers.delete(message.id);
    handler?.(message.result ?? null);
    return;
  }
  if (typeof message.method !== 'string') {
    return;
  }
  if (message.id === undefined || message.id === null) {
    handleNotification(message.method, message.params);
    return;
  }
  const id = message.id;
  void dispatch(message.method, message.params)
    .then((result) => send({ id, result }))
    .catch((error: unknown) => {
      const rpcError =
        error && typeof error === 'object' && 'code' in error
          ? error
          : { code: RPC_INTERNAL, message: error instanceof Error ? error.message : String(error) };
      send({ id, error: rpcError });
    });
});

readline.on('close', () => {
  void (async () => {
    for (const session of sessions.values()) {
      await session.close().catch(() => undefined);
    }
    process.exit(0);
  })();
});
