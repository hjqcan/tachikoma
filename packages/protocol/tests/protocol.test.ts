/**
 * 协议契约测试：round-trip 恒等、strict 拒绝、未知事件容忍（不丢 seq）、
 * 凭证字段名扫描、schema 快照守卫。
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  chatEventWireSchema,
  compactionResultSchema,
  helloResponseSchema,
  memorySnapshotSchema,
  parseSessionEventFrame,
  rpcRequestSchema,
  rpcResponseSchema,
  RPC_METHODS,
  sessionEventFrameSchema,
  sessionSummarySchema,
} from '../src';
import {
  compactionResultFixture,
  eventFixtures,
  frameFixture,
  memorySnapshotFixture,
  sessionSummaryFixtures,
} from './fixtures';

describe('round-trip 恒等', () => {
  it('每个事件 JSON 往返后 parse 与原值 deep-equal', () => {
    for (const fixture of eventFixtures) {
      const parsed = chatEventWireSchema.parse(JSON.parse(JSON.stringify(fixture)));
      expect(parsed).toEqual(fixture);
    }
  });

  it('帧与 DTO 同样往返恒等', () => {
    expect(sessionEventFrameSchema.parse(JSON.parse(JSON.stringify(frameFixture)))).toEqual(
      frameFixture
    );
    for (const summary of sessionSummaryFixtures) {
      expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    }
    expect(compactionResultSchema.parse(structuredClone(compactionResultFixture))).toEqual(
      compactionResultFixture
    );
    expect(memorySnapshotSchema.parse(structuredClone(memorySnapshotFixture))).toEqual(
      memorySnapshotFixture
    );
  });

  it('strict：未知顶层字段被拒绝', () => {
    const polluted = { ...eventFixtures[0], internalSecretField: 'x' };
    expect(chatEventWireSchema.safeParse(polluted).success).toBeFalse();
    const summaryPolluted = { ...sessionSummaryFixtures[0], apiKey: 'nope' };
    expect(sessionSummarySchema.safeParse(summaryPolluted).success).toBeFalse();
  });

  it('缺字段/错类型被拒绝', () => {
    expect(
      chatEventWireSchema.safeParse({ type: 'message_delta', sessionId: 's', turnId: 't' }).success
    ).toBeFalse();
    expect(
      chatEventWireSchema.safeParse({ ...eventFixtures[1], timestamp: 'not-a-number' }).success
    ).toBeFalse();
  });
});

describe('未知事件容忍', () => {
  it('未来事件类型返回 UnknownEventFrame 且保留 seq 与原始 JSON', () => {
    const future = {
      v: 1,
      sessionId: 'session-1',
      seq: 42,
      event: {
        type: 'subagent_spawn',
        sessionId: 'session-1',
        turnId: 'turn-9',
        timestamp: 1,
        childSessionId: 'session-child',
      },
    };
    const parsed = parseSessionEventFrame(future);
    expect(parsed.ok).toBeTrue();
    if (parsed.ok && !parsed.known) {
      expect(parsed.frame.seq).toBe(42);
      expect(parsed.frame.type).toBe('subagent_spawn');
      expect(parsed.frame.raw).toEqual(future.event);
    } else {
      throw new Error('expected unknown frame');
    }
  });

  it('已知事件走 known 分支；帧壳损坏返回 ok:false', () => {
    const known = parseSessionEventFrame(frameFixture);
    expect(known).toMatchObject({ ok: true, known: true });
    expect(parseSessionEventFrame({ v: 1, seq: 'x' }).ok).toBeFalse();
    expect(parseSessionEventFrame(null).ok).toBeFalse();
  });
});

describe('凭证永不过线', () => {
  const FORBIDDEN = /^(api[_-]?key|apikey|token|authorization|secret|password|credential)$/iu;

  function collectKeys(value: unknown, keys: Set<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, keys);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        collectKeys(nested, keys);
      }
    }
  }

  it('fixture 全字段名不含凭证类键', () => {
    const keys = new Set<string>();
    collectKeys(eventFixtures, keys);
    collectKeys(frameFixture, keys);
    collectKeys(sessionSummaryFixtures, keys);
    const violations = [...keys].filter((key) => FORBIDDEN.test(key));
    expect(violations).toEqual([]);
  });
});

describe('RPC 信封与方法表', () => {
  it('每个方法的 params/result schema 可用且信封往返', () => {
    const request = { id: 'r1', method: 'session.send', params: { sessionId: 's', text: 'hi' } };
    const parsed = rpcRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    expect(parsed).toEqual(request);
    const sendParams = RPC_METHODS['session.send'].params.parse(request.params);
    expect(sendParams.text).toBe('hi');

    const ok = { id: 'r1', ok: true, result: { turnId: 't1' } } as const;
    const error = {
      id: 'r2',
      ok: false,
      error: { code: 'conflict', message: '会话已有生成中的回合' },
    } as const;
    expect(rpcResponseSchema.parse(ok)).toEqual(ok);
    expect(rpcResponseSchema.parse(error)).toEqual(error);
  });

  it('hello 响应不含凭证且往返恒等', () => {
    const hello = {
      protocolVersion: 1,
      engineVersion: '0.2.0',
      capabilities: ['chat', 'tools'],
      session: { workDir: '/workspaces/demo', toolset: 'coding' as const },
    };
    expect(helloResponseSchema.parse(JSON.parse(JSON.stringify(hello)))).toEqual(hello);
  });
});

describe('schema 快照守卫（变更必须显式过审）', () => {
  it('全部 schema 的 JSON Schema 导出与快照一致', () => {
    const snapshot = Object.fromEntries(
      Object.entries({
        chatEventWire: chatEventWireSchema,
        sessionEventFrame: sessionEventFrameSchema,
        sessionSummary: sessionSummarySchema,
        compactionResult: compactionResultSchema,
        memorySnapshot: memorySnapshotSchema,
        helloResponse: helloResponseSchema,
        rpcRequest: rpcRequestSchema,
        ...Object.fromEntries(
          Object.entries(RPC_METHODS).flatMap(([method, entry]) => [
            [`${method}.params`, entry.params],
            [`${method}.result`, entry.result],
          ])
        ),
      }).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'output' })])
    );
    expect(snapshot).toMatchSnapshot();
  });
});
