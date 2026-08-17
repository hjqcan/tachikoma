/**
 * 循环提醒守卫测试 —— 全程零网络
 *
 * 覆盖：第 3 次同参调用的结果被追加提醒、异参不触发、第 5 次升级、
 * 8 次起每次强提醒、新用户回合重置、被拒绝的重复也计数、
 * 提醒进 tool_result 事件（模型可见即记录）。
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent, ChatSession } from '../src';
import { canonicalizeInput } from '../src/chat/loop-guard';
import { createFauxHarness } from './helpers';
import type { FauxHarness } from './helpers';

async function makeWorkspace(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-loop-ws-'));
  await writeFile(join(workDir, 'hello.txt'), 'SEED\n');
  return workDir;
}

function buildEngine(
  harness: FauxHarness,
  workDir: string,
  toolset: 'read-only' | 'coding' = 'read-only'
): ChatEngine {
  return new ChatEngine(
    {
      dataDir: harness.dataDir,
      model: { provider: harness.faux.provider.id, model: 'chat' },
      memory: false,
      workDir,
      toolset,
    },
    { modelRuntime: harness.modelRuntime }
  );
}

async function collect(
  session: ChatSession,
  text: string,
  approve: boolean | undefined = undefined
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of session.send(text)) {
    events.push(event);
    if (event.type === 'tool_approval_request' && approve !== undefined) {
      session.respondToApproval(event.callId, approve);
    }
  }
  return events;
}

function toolResults(events: ChatEvent[]): Extract<ChatEvent, { type: 'tool_result' }>[] {
  return events.filter((event) => event.type === 'tool_result');
}

const readCall = () => fauxToolCall('read', { path: 'hello.txt' });
const readRound = (calls: number) =>
  fauxAssistantMessage(Array.from({ length: calls }, readCall), { stopReason: 'toolUse' });

describe('循环提醒守卫', () => {
  it('第 3 次同参调用的结果带提醒，前两次干净；提醒在 tool_result 事件里（模型可见即记录）', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        readRound(1),
        readRound(1),
        readRound(1),
        fauxAssistantMessage('读了三遍。'),
      ]);
      const session = await buildEngine(harness, workDir).createSession();
      const events = await collect(session, '反复读同一个文件');
      const results = toolResults(events);
      expect(results).toHaveLength(3);
      expect(results[0]?.output).not.toContain('tachikoma-loop-reminder');
      expect(results[1]?.output).not.toContain('tachikoma-loop-reminder');
      expect(results[2]?.output).toContain('<tachikoma-loop-reminder>');
      expect(results[2]?.output).toContain('3 times in this turn');
      // 原始工具输出仍在，提醒是追加不是替换。
      expect(results[2]?.output).toContain('SEED');
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('参数不同不触发；第 5 次升级、第 8 次起每次强提醒', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      await writeFile(join(workDir, 'other.txt'), 'OTHER\n');
      harness.faux.setResponses([
        // 8 次同参 + 1 次异参，一个回合内分两批发出
        readRound(4),
        fauxAssistantMessage(
          [...Array.from({ length: 4 }, readCall), fauxToolCall('read', { path: 'other.txt' })],
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage('读完了。'),
      ]);
      const session = await buildEngine(harness, workDir).createSession();
      const events = await collect(session, '狂读');
      const results = toolResults(events);
      expect(results).toHaveLength(9);
      // read 并行安全：批内结果事件乱序，但提醒按 callId 附着——按内容断言。
      // 同参第 3、5、8 次各一条提醒（共 3 条），4/6/7 次静默，异参调用干净。
      const reminded = results.filter((result) =>
        result.output.includes('tachikoma-loop-reminder')
      );
      expect(reminded).toHaveLength(3);
      expect(reminded.filter((r) => r.output.includes('3 times'))).toHaveLength(1);
      expect(
        reminded.filter(
          (r) => r.output.includes('5 times') && r.output.includes('will not produce different')
        )
      ).toHaveLength(1);
      expect(
        reminded.filter(
          (r) => r.output.includes('8 times') && r.output.includes('looks like a loop')
        )
      ).toHaveLength(1);
      const otherResult = results.find((result) => result.output.includes('OTHER'));
      expect(otherResult?.output).not.toContain('tachikoma-loop-reminder');
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('新用户回合重置计数', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        readRound(2),
        fauxAssistantMessage('第一回合。'),
        readRound(2),
        fauxAssistantMessage('第二回合。'),
      ]);
      const session = await buildEngine(harness, workDir).createSession();
      const first = await collect(session, '读两次');
      const second = await collect(session, '再读两次');
      const all = [...toolResults(first), ...toolResults(second)];
      expect(all).toHaveLength(4);
      // 若不重置，第二回合的第 2 次就是累计第 4 次…第一回合 2 次 + 第二回合 1 次 = 3 会触发。
      expect(all.every((result) => !result.output.includes('tachikoma-loop-reminder'))).toBeTrue();
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('被拒绝的重复调用也计数：第 3 次同参 write 获批后结果带提醒', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      const writeCall = () => fauxToolCall('write', { path: 'x.txt', content: 'X' });
      harness.faux.setResponses([
        fauxAssistantMessage([writeCall()], { stopReason: 'toolUse' }),
        fauxAssistantMessage([writeCall()], { stopReason: 'toolUse' }),
        fauxAssistantMessage([writeCall()], { stopReason: 'toolUse' }),
        fauxAssistantMessage('终于写上了。'),
      ]);
      const session = await buildEngine(harness, workDir, 'coding').createSession();
      const events: ChatEvent[] = [];
      let approvalCount = 0;
      for await (const event of session.send('写文件')) {
        events.push(event);
        if (event.type === 'tool_approval_request') {
          approvalCount += 1;
          // 前两次拒绝（blocked 不走 tool_result 钩子，但计数），第三次放行。
          session.respondToApproval(event.callId, approvalCount >= 3);
        }
      }
      const results = toolResults(events);
      expect(results).toHaveLength(3);
      expect(results[0]?.isError).toBeTrue();
      expect(results[1]?.isError).toBeTrue();
      expect(results[2]?.isError).toBeFalse();
      // 第三次是累计第 3 次同参调用：获批执行后，结果带上提醒。
      expect(results[2]?.output).toContain('<tachikoma-loop-reminder>');
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});

describe('参数指纹', () => {
  it('键序不敏感、深度递归、数组保序', () => {
    expect(canonicalizeInput({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalizeInput({ a: { c: 3, d: 2 }, b: 1 })
    );
    expect(canonicalizeInput([1, 2])).not.toBe(canonicalizeInput([2, 1]));
    expect(canonicalizeInput({ a: 1 })).not.toBe(canonicalizeInput({ a: 2 }));
  });
});
