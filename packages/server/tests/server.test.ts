/**
 * sidecar 测试 —— 真实 127.0.0.1 HTTP/WS，fake 引擎脚本化事件（零网络外呼、零 pi）。
 *
 * 覆盖：鉴权（token/ticket）、hello、会话 CRUD、send → WS 帧（seq 单调 + WAL 落盘）、
 * fromSeq 重放、并发 conflict、审批应答直达会话、崩溃恢复合成终结帧、未知方法。
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatEventWire,
  CompactionResult,
  MemorySnapshot,
  ModelListing,
  ModelRef,
  RpcResponse,
  SessionEventFrame,
  SessionSummary,
  ThinkingLevel,
  Toolset,
  WorkspaceState,
} from '@tachikoma/protocol';

import type { ServerEnginePort, ServerSessionPort } from '../src/ports';
import { startTachikomaServer } from '../src/server';

const TOKEN = 'test-token-0123456789';

function baseEvent(
  sessionId: string,
  turnId: string
): Pick<ChatEventWire, 'sessionId' | 'turnId' | 'timestamp'> {
  return { sessionId, turnId, timestamp: 1 };
}

function turnEvents(sessionId: string, turnId: string, text: string): ChatEventWire[] {
  const base = baseEvent(sessionId, turnId);
  return [
    { ...base, type: 'message_start', messageId: `${turnId}-m` },
    { ...base, type: 'message_delta', messageId: `${turnId}-m`, text },
    {
      ...base,
      type: 'message_complete',
      messageId: `${turnId}-m`,
      status: 'success',
      content: text,
      model: { provider: 'faux', model: 'chat' },
      stopReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ];
}

class FakeSession implements ServerSessionPort {
  model: ModelRef = { provider: 'faux', model: 'chat' };
  thinkingLevel: ThinkingLevel = 'off';
  memoryStatus: MemorySnapshot = { enabled: false, status: 'disabled' };
  activeTools: readonly string[] = [];
  workspace: WorkspaceState | null = null;
  approvals: { callId: string; approved: boolean }[] = [];
  aborted = 0;
  closed = 0;
  sending = false;
  script: ChatEventWire[][] = [];
  private turn = 0;

  constructor(readonly id: string) {}

  async *send(text: string): AsyncGenerator<ChatEventWire> {
    if (this.sending) {
      throw new Error(`会话 ${this.id} 已有生成在进行中`);
    }
    this.sending = true;
    try {
      const events =
        this.script[this.turn] ?? turnEvents(this.id, `turn-${this.turn + 1}`, `echo:${text}`);
      this.turn += 1;
      for (const event of events) {
        await Bun.sleep(1);
        yield event;
      }
    } finally {
      this.sending = false;
    }
  }

  async abort(): Promise<boolean> {
    this.aborted += 1;
    return true;
  }

  respondToApproval(callId: string, approved: boolean): boolean {
    this.approvals.push({ callId, approved });
    return true;
  }

  async setModel(model: ModelRef): Promise<ModelRef> {
    this.model = model;
    return model;
  }

  setThinkingLevel(level: ThinkingLevel): ThinkingLevel {
    this.thinkingLevel = level;
    return level;
  }

  async compact(): Promise<CompactionResult> {
    return { summary: 'compacted', firstKeptEntryId: 'e1', tokensBefore: 10 };
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeEngine implements ServerEnginePort {
  readonly sessions = new Map<string, FakeSession>();
  private counter = 0;

  async createSession(init?: { workDir?: string; toolset?: Toolset }): Promise<FakeSession> {
    this.counter += 1;
    const session = new FakeSession(`session-${this.counter}`);
    if (init?.workDir) {
      const toolset = init.toolset ?? 'read-only';
      session.workspace = {
        root: init.workDir,
        toolset,
        tools:
          toolset === 'coding'
            ? ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash']
            : ['read', 'grep', 'find', 'ls'],
      };
      session.activeTools = session.workspace.tools;
    }
    this.sessions.set(session.id, session);
    return session;
  }

  async openSession(sessionId: string): Promise<FakeSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      status: 'ready' as const,
    }));
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  async listModels(): Promise<ModelListing[]> {
    return [{ provider: 'faux', model: 'chat', reasoning: true }];
  }
}

interface Harness {
  engine: FakeEngine;
  port: number;
  dataDir: string;
  rpc(method: string, params?: unknown, token?: string): Promise<RpcResponse>;
  ws(
    sessionId: string,
    fromSeq: number
  ): Promise<{ frames: SessionEventFrame[]; close(): void; waitFor(count: number): Promise<void> }>;
  stop(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const engine = new FakeEngine();
  const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-server-'));
  const server = await startTachikomaServer({
    engine,
    token: TOKEN,
    dataDir,
    engineVersion: '0.2.0-test',
    sessionDefaults: { workDir: '/workspaces/demo', toolset: 'read-only' },
  });

  async function rpc(method: string, params: unknown = {}, token = TOKEN): Promise<RpcResponse> {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), method, params }),
    });
    return (await response.json()) as RpcResponse;
  }

  async function ws(sessionId: string, fromSeq: number) {
    const ticketResponse = await fetch(`http://127.0.0.1:${server.port}/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?ticket=${ticket}`);
    const frames: SessionEventFrame[] = [];
    const waiters: { count: number; resolve(): void }[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(JSON.parse(String(event.data)) as SessionEventFrame);
      for (const waiter of [...waiters]) {
        if (frames.length >= waiter.count) {
          waiter.resolve();
          waiters.splice(waiters.indexOf(waiter), 1);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('ws failed')));
    });
    socket.send(JSON.stringify({ sessionId, fromSeq }));
    return {
      frames,
      close: () => socket.close(),
      waitFor: (count: number) =>
        frames.length >= count
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () =>
                  reject(new Error(`timed out waiting for ${count} frames (got ${frames.length})`)),
                5_000
              );
              waiters.push({
                count,
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
              });
            }),
    };
  }

  return {
    engine,
    port: server.port,
    dataDir,
    rpc,
    ws,
    stop: async () => {
      await server.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

describe('sidecar', () => {
  it('healthz 无鉴权可达；RPC 错误 token 401；未知方法 unsupported', async () => {
    const harness = await startHarness();
    try {
      const health = await fetch(`http://127.0.0.1:${harness.port}/healthz`);
      expect(health.status).toBe(200);

      const bad = await fetch(`http://127.0.0.1:${harness.port}/v1/rpc`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ id: '1', method: 'engine.hello', params: {} }),
      });
      expect(bad.status).toBe(401);

      const unknown = await harness.rpc('engine.doesNotExist');
      expect(unknown).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    } finally {
      await harness.stop();
    }
  });

  it('hello 报协议版本、能力与工具姿态；不含凭证', async () => {
    const harness = await startHarness();
    try {
      const hello = await harness.rpc('engine.hello', { protocolVersion: 1, client: 'test/0' });
      expect(hello.ok).toBeTrue();
      if (hello.ok) {
        expect(hello.result).toMatchObject({
          protocolVersion: 1,
          engineVersion: '0.2.0-test',
          session: { workDir: '/workspaces/demo', toolset: 'read-only' },
        });
        expect(JSON.stringify(hello.result)).not.toContain('sk-');
      }
    } finally {
      await harness.stop();
    }
  });

  it('send 返回 turnId；WS 收到 seq 单调帧且与 WAL 文件一致；fromSeq 重放', async () => {
    const harness = await startHarness();
    try {
      const created = await harness.rpc('session.create');
      if (!created.ok) throw new Error('create failed');
      const sessionId = (created.result as SessionSummary).sessionId;

      const live = await harness.ws(sessionId, 0);
      const sent = await harness.rpc('session.send', { sessionId, text: '你好' });
      expect(sent).toMatchObject({ ok: true, result: { turnId: 'turn-1' } });

      await live.waitFor(3);
      expect(live.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
      expect(live.frames.at(-1)?.event).toMatchObject({
        type: 'message_complete',
        content: 'echo:你好',
      });
      live.close();

      const walContent = await readFile(
        join(harness.dataDir, 'sessions', `${sessionId}.events.jsonl`),
        'utf8'
      );
      const walSeqs = walContent
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as SessionEventFrame).seq);
      expect(walSeqs).toEqual([1, 2, 3]);

      const replay = await harness.ws(sessionId, 1);
      await replay.waitFor(2);
      expect(replay.frames.map((frame) => frame.seq)).toEqual([2, 3]);
      replay.close();
    } finally {
      await harness.stop();
    }
  });

  it('同会话并发 send 得 conflict', async () => {
    const harness = await startHarness();
    try {
      const created = await harness.rpc('session.create');
      if (!created.ok) throw new Error('create failed');
      const sessionId = (created.result as SessionSummary).sessionId;
      const session = harness.engine.sessions.get(sessionId);
      if (!session) throw new Error('missing fake session');
      session.script = [
        [
          ...turnEvents(sessionId, 'turn-1', 'slow').slice(0, 2),
          // 故意留一个未完成的长回合：complete 延后由脚本第二段给出
        ],
        turnEvents(sessionId, 'turn-2', 'second'),
      ];

      const first = await harness.rpc('session.send', { sessionId, text: 'a' });
      expect(first.ok).toBeTrue();
      const second = await harness.rpc('session.send', { sessionId, text: 'b' });
      expect(second).toMatchObject({ ok: false, error: { code: 'conflict' } });
    } finally {
      await harness.stop();
    }
  });

  it('session.create 携带 workDir/toolset 时，摘要带回 live workspace；零工具会话不带', async () => {
    const harness = await startHarness();
    try {
      const granted = await harness.rpc('session.create', {
        workDir: '/workspaces/demo',
        toolset: 'coding',
      });
      expect(granted.ok).toBeTrue();
      if (granted.ok) {
        expect(granted.result).toMatchObject({
          workspace: { root: '/workspaces/demo', toolset: 'coding' },
        });
        expect((granted.result as SessionSummary).workspace?.tools).toContain('bash');
      }

      const bare = await harness.rpc('session.create');
      expect(bare.ok).toBeTrue();
      if (bare.ok) {
        expect((bare.result as SessionSummary).workspace).toBeUndefined();
      }

      const invalid = await harness.rpc('session.create', { toolset: 'sudo' });
      expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    } finally {
      await harness.stop();
    }
  });

  it('respondToApproval 直达会话', async () => {
    const harness = await startHarness();
    try {
      const created = await harness.rpc('session.create');
      if (!created.ok) throw new Error('create failed');
      const sessionId = (created.result as SessionSummary).sessionId;
      const response = await harness.rpc('session.respondToApproval', {
        sessionId,
        callId: 'call-9',
        approved: true,
      });
      expect(response).toMatchObject({ ok: true, result: { matched: true } });
      expect(harness.engine.sessions.get(sessionId)?.approvals).toEqual([
        { callId: 'call-9', approved: true },
      ]);
    } finally {
      await harness.stop();
    }
  });

  it('WS 无 ticket 拒绝；ticket 只能用一次', async () => {
    const harness = await startHarness();
    try {
      const direct = await fetch(`http://127.0.0.1:${harness.port}/ws?ticket=nope`);
      expect(direct.status).toBe(401);

      const ticketResponse = await fetch(`http://127.0.0.1:${harness.port}/v1/auth/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const { ticket } = (await ticketResponse.json()) as { ticket: string };
      const reuse = await fetch(`http://127.0.0.1:${harness.port}/ws?ticket=${ticket}`);
      // 非升级请求消费掉 ticket 后，第二次使用必须失败。
      void reuse;
      const second = await fetch(`http://127.0.0.1:${harness.port}/ws?ticket=${ticket}`);
      expect(second.status).toBe(401);
    } finally {
      await harness.stop();
    }
  });

  it('崩溃恢复：WAL 里未终结的回合在下次加载时补合成 failed 终结帧', async () => {
    const harness = await startHarness();
    try {
      const created = await harness.rpc('session.create');
      if (!created.ok) throw new Error('create failed');
      const sessionId = (created.result as SessionSummary).sessionId;
      const session = harness.engine.sessions.get(sessionId);
      if (!session) throw new Error('missing fake session');
      // 脚本一个只有 start+delta、没有 complete 的"死亡回合"
      session.script = [turnEvents(sessionId, 'turn-1', 'dead').slice(0, 2)];
      await harness.rpc('session.send', { sessionId, text: 'x' });
      await Bun.sleep(30);

      // 模拟重启：新 server 挂同一 dataDir
      const revived = await startTachikomaServer({
        engine: harness.engine,
        token: TOKEN,
        dataDir: harness.dataDir,
        engineVersion: '0.2.0-test',
      });
      try {
        const ticketResponse = await fetch(`http://127.0.0.1:${revived.port}/v1/auth/ws-ticket`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        const { ticket } = (await ticketResponse.json()) as { ticket: string };
        const socket = new WebSocket(`ws://127.0.0.1:${revived.port}/ws?ticket=${ticket}`);
        const frames: SessionEventFrame[] = [];
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`replay timeout (got ${frames.length})`)),
            5_000
          );
          socket.addEventListener('message', (event) => {
            frames.push(JSON.parse(String(event.data)) as SessionEventFrame);
            const last = frames.at(-1);
            if (last?.event.type === 'message_complete') {
              clearTimeout(timer);
              resolve();
            }
          });
          socket.addEventListener('open', () =>
            socket.send(JSON.stringify({ sessionId, fromSeq: 0 }))
          );
          socket.addEventListener('error', () => reject(new Error('ws failed')));
        });
        await done;
        socket.close();

        const terminal = frames.at(-1);
        expect(terminal?.event).toMatchObject({
          type: 'message_complete',
          status: 'failed',
          error: 'engine restarted',
        });
        expect(terminal?.seq).toBe(3);
      } finally {
        await revived.stop();
      }
    } finally {
      await harness.stop();
    }
  });
});
