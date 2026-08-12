/**
 * Tachikoma 本机 sidecar（desktop-plan §2.3/§4.5 的引擎侧实现）。
 *
 * - HTTP `/v1/rpc`：RpcRequest 信封，Bearer token 鉴权。
 * - `POST /v1/auth/ws-ticket`：换 30s TTL 一次性 ticket。
 * - WS `/ws?ticket=…`：首条消息 subscribe {sessionId, fromSeq}，WAL 重放后接实时帧。
 * - server 是每回合事件流的唯一消费者：派 seq → 先写 WAL → 扇出。
 * - 仅 127.0.0.1；凭证永不过线。
 */

import { timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  RPC_METHODS,
  isRpcMethod,
  rpcRequestSchema,
  subscribeRequestSchema,
} from '@tachikoma/protocol';
import type {
  ChatEventWire,
  RpcErrorCode,
  RpcMethod,
  SessionEventFrame,
  SessionSummary,
} from '@tachikoma/protocol';
import type { ServerEnginePort, ServerSessionPort } from './ports';
import { SessionWal } from './wal';

const TICKET_TTL_MS = 30_000;

export interface TachikomaServerOptions {
  engine: ServerEnginePort;
  token: string;
  dataDir: string;
  engineVersion: string;
  port?: number;
  sessionDefaults?: { workDir?: string; toolset?: 'read-only' | 'coding' };
}

export interface TachikomaServer {
  port: number;
  stop(): Promise<void>;
}

interface WsData {
  sessionId?: string;
}

class RpcFailure extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function startTachikomaServer(
  options: TachikomaServerOptions
): Promise<TachikomaServer> {
  const engine = options.engine;
  const sessions = new Map<string, ServerSessionPort>();
  const wals = new Map<string, Promise<SessionWal>>();
  const subscribers = new Map<string, Set<ServerWebSocket<WsData>>>();
  const tickets = new Map<string, number>();
  const pumps = new Set<Promise<void>>();

  const tokenBytes = new TextEncoder().encode(options.token);
  function authorized(request: Request): boolean {
    const header = request.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = new TextEncoder().encode(header.slice('Bearer '.length));
    return presented.length === tokenBytes.length && timingSafeEqual(presented, tokenBytes);
  }

  // 缓存 load 的 Promise 而非结果：冷会话上 subscribe 与 send 并发时，
  // 缓存结果会造出两个 WAL 实例（订阅端重放空实例、注册太迟，整回合丢失）。
  function wal(sessionId: string): Promise<SessionWal> {
    let existing = wals.get(sessionId);
    if (!existing) {
      existing = SessionWal.load(options.dataDir, sessionId);
      wals.set(sessionId, existing);
    }
    return existing;
  }

  function broadcast(sessionId: string, frame: SessionEventFrame): void {
    for (const socket of subscribers.get(sessionId) ?? []) {
      socket.send(JSON.stringify(frame));
    }
  }

  async function summaryOf(session: ServerSessionPort): Promise<SessionSummary> {
    const listed = (await engine.listSessions()).find(
      (summary) => summary.sessionId === session.id
    );
    const summary = listed ?? {
      sessionId: session.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      status: 'ready' as const,
    };
    // 工作区授予是 live 会话属性（磁盘摘要没有它），server 侧补充。
    return session.workspace ? { ...summary, workspace: session.workspace } : summary;
  }

  async function requireSession(sessionId: string): Promise<ServerSessionPort> {
    const active = sessions.get(sessionId);
    if (active) return active;
    const opened = await engine.openSession(sessionId);
    if (!opened) throw new RpcFailure('not_found', `Session not found: ${sessionId}`);
    sessions.set(sessionId, opened);
    return opened;
  }

  /** server 是回合事件流的唯一消费者：先写 WAL 再扇出；返回首事件的 turnId */
  async function startTurn(session: ServerSessionPort, text: string): Promise<string> {
    const sessionWal = await wal(session.id);
    const iterator = session.send(text)[Symbol.asyncIterator]();
    let first: IteratorResult<ChatEventWire>;
    try {
      first = await iterator.next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/已有生成|already generating/iu.test(message)) {
        throw new RpcFailure('conflict', message);
      }
      throw new RpcFailure('internal', message);
    }
    if (first.done) throw new RpcFailure('internal', 'Turn produced no events.');
    const turnId = first.value.turnId;
    broadcast(session.id, await sessionWal.append(first.value));

    const pump = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        broadcast(session.id, await sessionWal.append(next.value));
      }
    })().catch(() => undefined);
    pumps.add(pump);
    void pump.finally(() => pumps.delete(pump));
    return turnId;
  }

  const handlers: { [M in RpcMethod]: (params: unknown) => Promise<unknown> } = {
    'engine.hello': async (params) => {
      RPC_METHODS['engine.hello'].params.parse(params);
      return {
        protocolVersion: PROTOCOL_VERSION,
        engineVersion: options.engineVersion,
        capabilities: [...CAPABILITIES],
        session: { ...options.sessionDefaults },
      };
    },
    'engine.listModels': async () => ({ models: await engine.listModels() }),
    'engine.shutdown': async () => {
      queueMicrotask(() => void stop());
      return {};
    },
    'session.create': async (params) => {
      const parsed = RPC_METHODS['session.create'].params.parse(params);
      const session = await engine.createSession({
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed.workDir ? { workDir: parsed.workDir } : {}),
        ...(parsed.toolset ? { toolset: parsed.toolset } : {}),
      });
      sessions.set(session.id, session);
      return summaryOf(session);
    },
    'session.list': async () => ({ sessions: await engine.listSessions() }),
    'session.open': async (params) => {
      const parsed = RPC_METHODS['session.open'].params.parse(params);
      return summaryOf(await requireSession(parsed.sessionId));
    },
    'session.delete': async (params) => {
      const parsed = RPC_METHODS['session.delete'].params.parse(params);
      sessions.delete(parsed.sessionId);
      // engine.deleteSession 会先 close 活跃会话（中止在途回合），resolve 后不再有新帧。
      const deleted = await engine.deleteSession(parsed.sessionId);
      // 只摘订阅、不主动 close：Bun 里从 RPC handler 服务端关 WS 会让 server.stop(true)
      // 永久挂起（实测）；死订阅收不到任何帧，socket 生命周期归客户端。
      subscribers.delete(parsed.sessionId);
      // 事件账本随会话一起消亡：缓存过的等在途写入落定再删，没缓存的直接删文件。
      const cached = wals.get(parsed.sessionId);
      wals.delete(parsed.sessionId);
      if (cached) {
        await (await cached).destroy();
      } else {
        await SessionWal.delete(options.dataDir, parsed.sessionId);
      }
      return { deleted };
    },
    'session.send': async (params) => {
      const parsed = RPC_METHODS['session.send'].params.parse(params);
      const session = await requireSession(parsed.sessionId);
      return { turnId: await startTurn(session, parsed.text) };
    },
    'session.abort': async (params) => {
      const parsed = RPC_METHODS['session.abort'].params.parse(params);
      return { aborted: await (await requireSession(parsed.sessionId)).abort() };
    },
    'session.respondToApproval': async (params) => {
      const parsed = RPC_METHODS['session.respondToApproval'].params.parse(params);
      const session = await requireSession(parsed.sessionId);
      return {
        matched: session.respondToApproval(parsed.callId, parsed.approved, parsed.scope),
      };
    },
    'session.setModel': async (params) => {
      const parsed = RPC_METHODS['session.setModel'].params.parse(params);
      const session = await requireSession(parsed.sessionId);
      return { model: await session.setModel(parsed.model) };
    },
    'session.setThinkingLevel': async (params) => {
      const parsed = RPC_METHODS['session.setThinkingLevel'].params.parse(params);
      const session = await requireSession(parsed.sessionId);
      return { level: session.setThinkingLevel(parsed.level) };
    },
    'session.compact': async (params) => {
      const parsed = RPC_METHODS['session.compact'].params.parse(params);
      const session = await requireSession(parsed.sessionId);
      return session.compact(parsed.instructions);
    },
  };

  async function handleRpc(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        id: '',
        ok: false,
        error: { code: 'invalid_params', message: 'Invalid JSON body.' },
      });
    }
    const envelope = rpcRequestSchema.safeParse(body);
    if (!envelope.success) {
      return json(400, {
        id: '',
        ok: false,
        error: { code: 'invalid_params', message: 'Invalid RPC envelope.' },
      });
    }
    const { id, method, params } = envelope.data;
    if (!isRpcMethod(method)) {
      return json(200, {
        id,
        ok: false,
        error: { code: 'unsupported', message: `Unknown method: ${method}` },
      });
    }
    try {
      const result = await handlers[method](params);
      return json(200, { id, ok: true, result });
    } catch (error) {
      if (error instanceof RpcFailure) {
        return json(200, { id, ok: false, error: { code: error.code, message: error.message } });
      }
      const message = error instanceof Error ? error.message : String(error);
      const code: RpcErrorCode = /已有生成|already generating/iu.test(message)
        ? 'conflict'
        : /not found|不存在/iu.test(message)
          ? 'not_found'
          : /invalid|required|expected/iu.test(message)
            ? 'invalid_params'
            : 'internal';
      return json(200, { id, ok: false, error: { code, message } });
    }
  }

  const server = Bun.serve<WsData>({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        return json(200, { ok: true });
      }
      if (url.pathname === '/ws') {
        const ticket = url.searchParams.get('ticket') ?? '';
        const expiry = tickets.get(ticket);
        tickets.delete(ticket);
        if (!expiry || expiry < Date.now()) {
          return json(401, {
            ok: false,
            error: { code: 'unauthorized', message: 'Invalid ticket.' },
          });
        }
        return bunServer.upgrade(request, { data: {} })
          ? undefined
          : json(400, { ok: false, error: { code: 'internal', message: 'Upgrade failed.' } });
      }
      if (!authorized(request)) {
        return json(401, {
          ok: false,
          error: { code: 'unauthorized', message: 'Missing or invalid token.' },
        });
      }
      if (url.pathname === '/v1/auth/ws-ticket' && request.method === 'POST') {
        const ticket = crypto.randomUUID();
        tickets.set(ticket, Date.now() + TICKET_TTL_MS);
        return json(200, { ticket, expiresInMs: TICKET_TTL_MS });
      }
      if (url.pathname === '/v1/rpc' && request.method === 'POST') {
        return handleRpc(request);
      }
      return json(404, { ok: false, error: { code: 'not_found', message: 'No such route.' } });
    },
    websocket: {
      message: (socket: ServerWebSocket<WsData>, message) => {
        void (async () => {
          let raw: unknown;
          try {
            raw = JSON.parse(String(message));
          } catch {
            socket.close(1003, 'invalid json');
            return;
          }
          const subscribe = subscribeRequestSchema.safeParse(raw);
          if (!subscribe.success) {
            socket.close(1008, 'expected subscribe request');
            return;
          }
          const { sessionId, fromSeq } = subscribe.data;
          socket.data.sessionId = sessionId;
          const sessionWal = await wal(sessionId);
          for (const frame of sessionWal.read(fromSeq)) {
            socket.send(JSON.stringify(frame));
          }
          let set = subscribers.get(sessionId);
          if (!set) {
            set = new Set();
            subscribers.set(sessionId, set);
          }
          set.add(socket);
        })();
      },
      close: (socket: ServerWebSocket<WsData>) => {
        if (socket.data.sessionId) {
          subscribers.get(socket.data.sessionId)?.delete(socket);
        }
      },
    },
  });

  async function stop(): Promise<void> {
    for (const session of sessions.values()) {
      await session.close().catch(() => undefined);
    }
    sessions.clear();
    await Promise.allSettled([...pumps]);
    await server.stop(true);
  }

  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    throw new Error('Server did not bind a TCP port.');
  }
  return { port, stop };
}
