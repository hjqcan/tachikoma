/**
 * 第二圈审批门测试 —— 全程零网络
 *
 * 覆盖：coding 工具集激活、写工具审批放行后真实落盘、拒绝即拦截、
 * 超时默认拒绝、abort 连带拒绝、路径守卫先于审批。
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent, ChatSession } from '../src';
import { CODING_TOOLS } from '../src/chat/workspace-guard';
import { createFauxHarness } from './helpers';
import type { FauxHarness } from './helpers';

async function makeWorkspace(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-approval-ws-'));
  await writeFile(join(workDir, 'hello.txt'), 'SEED\n');
  return workDir;
}

function codingEngine(
  harness: FauxHarness,
  workDir: string,
  approvalTimeoutMs?: number
): ChatEngine {
  return new ChatEngine(
    {
      dataDir: harness.dataDir,
      model: { provider: harness.faux.provider.id, model: 'chat' },
      memory: false,
      workDir,
      toolset: 'coding',
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    },
    { modelRuntime: harness.modelRuntime }
  );
}

async function collectWithApprovals(
  session: ChatSession,
  text: string,
  onApprovalRequest?: (event: Extract<ChatEvent, { type: 'tool_approval_request' }>) => void
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of session.send(text)) {
    events.push(event);
    if (event.type === 'tool_approval_request') {
      onApprovalRequest?.(event);
    }
  }
  return events;
}

describe('第二圈：工具审批门', () => {
  it('coding 工具集激活七件套；read 免审批不产生审批事件', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read', { path: 'hello.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('读到了。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();
      expect([...session.activeTools].sort()).toEqual([...CODING_TOOLS].sort());

      const events = await collectWithApprovals(session, '读一下 hello.txt');
      expect(events.some((event) => event.type === 'tool_approval_request')).toBeFalse();
      expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
        isError: false,
      });
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('write 审批放行后真实落盘，事件序完整（request → resolved(reply) → tool_result）', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: 'APPROVED' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('写好了。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();
      const events = await collectWithApprovals(session, '写个文件', (request) => {
        expect(session.respondToApproval(request.callId, true)).toBeTrue();
      });

      expect(events.find((event) => event.type === 'tool_approval_resolved')).toMatchObject({
        approved: true,
        reason: 'reply',
      });
      expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
        tool: 'write',
        isError: false,
      });
      expect(existsSync(join(workDir, 'note.txt'))).toBeTrue();
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('write 被拒绝时不落盘，模型收到 not approved 的错误结果', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: 'DENIED' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('好的，不写了。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();
      const events = await collectWithApprovals(session, '写个文件', (request) => {
        session.respondToApproval(request.callId, false);
      });

      expect(events.find((event) => event.type === 'tool_approval_resolved')).toMatchObject({
        approved: false,
        reason: 'reply',
      });
      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult).toMatchObject({ isError: true });
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.output).toContain('not approved');
      }
      expect(existsSync(join(workDir, 'note.txt'))).toBeFalse();
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('无人应答时超时默认拒绝', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: 'TIMEOUT' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('好的。'),
      ]);
      const engine = codingEngine(harness, workDir, 50);
      const session = await engine.createSession();
      const events = await collectWithApprovals(session, '写个文件');

      expect(events.find((event) => event.type === 'tool_approval_request')).toMatchObject({
        timeoutMs: 50,
      });
      expect(events.find((event) => event.type === 'tool_approval_resolved')).toMatchObject({
        approved: false,
        reason: 'timeout',
      });
      expect(existsSync(join(workDir, 'note.txt'))).toBeFalse();
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('审批等待中 abort：审批以 aborted 拒绝，回合以 interrupted 终结', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write', { path: 'note.txt', content: 'ABORT' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('不会用到。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();
      const events = await collectWithApprovals(session, '写个文件', () => {
        void session.abort();
      });

      expect(events.find((event) => event.type === 'tool_approval_resolved')).toMatchObject({
        approved: false,
        reason: 'aborted',
      });
      expect(existsSync(join(workDir, 'note.txt'))).toBeFalse();
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'interrupted' });
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('路径守卫先于审批：越界 write 即使自动放行也不产生审批请求、不落盘', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'tachikoma-approval-outside-'));
    try {
      harness.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('write', {
              path: join('..', outside.split('/').at(-1) ?? '', 'escape.txt'),
              content: 'ESCAPE',
            }),
          ],
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage('好的。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();
      const events = await collectWithApprovals(session, '写到外面去', (request) => {
        session.respondToApproval(request.callId, true);
      });

      expect(events.some((event) => event.type === 'tool_approval_request')).toBeFalse();
      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult).toMatchObject({ isError: true });
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.output).toContain('outside the workspace');
      }
      expect(existsSync(join(outside, 'escape.txt'))).toBeFalse();
      await session.close();
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});

describe('第二圈：会话级放行（scope session）', () => {
  it("respondToApproval(…, 'session') 后同工具不再发审批事件，且真实执行", async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write', { path: 'a.txt', content: 'one' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('write', { path: 'b.txt', content: 'two' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('两个都写完了。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();

      const events = await collectWithApprovals(session, '写两个文件', (request) => {
        session.respondToApproval(request.callId, true, 'session');
      });

      const requests = events.filter((event) => event.type === 'tool_approval_request');
      expect(requests).toHaveLength(1);
      const resolved = events.find((event) => event.type === 'tool_approval_resolved');
      expect(resolved).toMatchObject({ approved: true, reason: 'reply', scope: 'session' });
      const results = events.filter((event) => event.type === 'tool_result');
      expect(results).toHaveLength(2);
      expect(results.every((event) => event.type === 'tool_result' && !event.isError)).toBeTrue();
      expect(existsSync(join(workDir, 'a.txt'))).toBeTrue();
      expect(existsSync(join(workDir, 'b.txt'))).toBeTrue();
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('拒绝时 scope session 被忽略（只拒这一次），下次同工具仍询问', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('write', { path: 'x.txt', content: 'no' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('被拒了，作罢。'),
        fauxAssistantMessage([fauxToolCall('write', { path: 'y.txt', content: 'again' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('这次写好了。'),
      ]);
      const engine = codingEngine(harness, workDir);
      const session = await engine.createSession();

      const first = await collectWithApprovals(session, '写 x.txt', (request) => {
        session.respondToApproval(request.callId, false, 'session');
      });
      expect(first.find((event) => event.type === 'tool_approval_resolved')).toMatchObject({
        approved: false,
      });
      expect(existsSync(join(workDir, 'x.txt'))).toBeFalse();

      const second = await collectWithApprovals(session, '再写 y.txt', (request) => {
        session.respondToApproval(request.callId, true);
      });
      expect(second.filter((event) => event.type === 'tool_approval_request')).toHaveLength(1);
      expect(existsSync(join(workDir, 'y.txt'))).toBeTrue();
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});
