/**
 * ACP stdio 端到端冒烟 —— 零网络（faux preload 注入模型）。
 *
 * spawn 真 bin（src/acp.ts）走完整 JSON-RPC v1 流程：
 * initialize → session/new → session/prompt（write 工具 → 审批往返 → 落盘）
 * → stopReason end_turn。这在 Zed 手测之前把 stdio 循环、带外审批、
 * 事件映射整条链验证掉。
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Frame {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

class AcpChild {
  private readonly child: ReturnType<typeof Bun.spawn>;
  private readonly frames: Frame[] = [];
  private waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  private buffer = '';

  constructor(env: Record<string, string>) {
    this.child = Bun.spawn(
      [
        'bun',
        '--preload',
        // 与 cli-faux-preload 同惯例：faux 注入源放 core/tests（pi 依赖在 core）。
        join(import.meta.dir, '..', '..', 'core', 'tests', 'acp-faux-preload.ts'),
        join(import.meta.dir, '..', 'src', 'acp.ts'),
        '--toolset',
        'coding',
      ],
      { env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' }
    );
    void this.pump();
  }

  private async pump(): Promise<void> {
    const reader = (this.child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value);
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          const frame = JSON.parse(line) as Frame;
          this.frames.push(frame);
          this.waiters = this.waiters.filter((waiter) => {
            if (waiter.predicate(frame)) {
              waiter.resolve(frame);
              return false;
            }
            return true;
          });
        }
        newline = this.buffer.indexOf('\n');
      }
    }
  }

  /** stdin: 'pipe' 下恒为 FileSink；Bun.spawn 的返回类型未随选项窄化，此处断言 */
  private get stdin(): Bun.FileSink {
    return this.child.stdin as Bun.FileSink;
  }

  send(message: Record<string, unknown>): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  /** 等待第一帧满足谓词（含已收帧）；5s 超时响亮失败 */
  wait(predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
    const already = this.frames.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for: ${label}`)), 5000);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  updates(): unknown[] {
    return this.frames
      .filter((frame) => frame.method === 'session/update')
      .map((frame) => (frame.params as { update: unknown }).update);
  }

  async close(): Promise<number> {
    this.stdin.end();
    return this.child.exited;
  }
}

describe('ACP stdio 冒烟', () => {
  it('initialize → session/new → prompt（审批放行落盘）→ end_turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-acp-data-'));
    const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-acp-ws-'));
    const child = new AcpChild({
      TACHIKOMA_PROVIDER: 'tachikoma-acp-faux',
      TACHIKOMA_MODEL: 'chat',
      TACHIKOMA_DATA_DIR: dataDir,
    });
    try {
      child.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const init = await child.wait((frame) => frame.id === 1, 'initialize response');
      expect(init.result).toMatchObject({ protocolVersion: 1 });

      child.send({ id: 2, method: 'session/new', params: { cwd: workDir, mcpServers: [] } });
      const created = await child.wait((frame) => frame.id === 2, 'session/new response');
      const sessionId = (created.result as { sessionId: string }).sessionId;
      expect(sessionId).toBeTruthy();

      child.send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'write acp.txt' }] },
      });

      // 服务端出站请求：审批。
      const permission = await child.wait(
        (frame) => frame.method === 'session/request_permission',
        'permission request'
      );
      const request = permission.params as {
        sessionId: string;
        toolCall: { toolCallId: string; title: string };
        options: { optionId: string }[];
      };
      expect(request.sessionId).toBe(sessionId);
      expect(request.toolCall.title).toBe('write');
      expect(request.options.map((option) => option.optionId)).toEqual([
        'allow',
        'allow-session',
        'deny',
      ]);
      child.send({
        id: permission.id as number,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });

      const done = await child.wait((frame) => frame.id === 3, 'prompt response');
      expect(done.result).toEqual({ stopReason: 'end_turn' });

      // 文件真实落盘；更新流含 tool_call(pending) 与 completed 的 tool_call_update。
      expect(existsSync(join(workDir, 'acp.txt'))).toBeTrue();
      expect(readFileSync(join(workDir, 'acp.txt'), 'utf8')).toBe('ACP-SMOKE-OK');
      const updates = child.updates() as { sessionUpdate: string; status?: string }[];
      expect(
        updates.some((u) => u.sessionUpdate === 'tool_call' && u.status === 'pending')
      ).toBeTrue();
      expect(
        updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')
      ).toBeTrue();
      expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBeTrue();

      expect(await child.close()).toBe(0);
    } finally {
      await child.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
