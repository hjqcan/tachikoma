/**
 * ACP 映射测试 —— 全程零网络、零 I/O
 *
 * 字面量以官方 v1 schema 为准：sessionUpdate 判别值、StopReason、
 * PermissionOptionKind、整数 protocolVersion。映射是纯函数，逐事件断言。
 */

import { describe, expect, it } from 'bun:test';

import {
  ACP_PROTOCOL_VERSION,
  approvalOf,
  initializeResult,
  permissionRequestOf,
  promptText,
  sessionUpdateOf,
  stopReasonOf,
  toolKind,
} from '../src/acp-map';
import type { ChatEventWire } from '@hjqcan/tachikoma-protocol';

const base = { sessionId: 's1', turnId: 't1', timestamp: 1 };

function completeEvent(
  status: 'success' | 'interrupted' | 'failed',
  stopReason: string
): Extract<ChatEventWire, { type: 'message_complete' }> {
  return {
    ...base,
    type: 'message_complete',
    messageId: 'm1',
    status,
    content: 'done',
    model: { provider: 'p', model: 'm' },
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe('ACP 映射', () => {
  it('initialize：v1 整数版本，能力面如实申报（无 loadSession/图像）', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
    expect(initializeResult()).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    });
  });

  it('promptText：抽取 text 块拼接，忽略非文本块与非法输入', () => {
    expect(
      promptText([
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'world' },
      ])
    ).toBe('hello\nworld');
    expect(promptText('nope')).toBe('');
    expect(promptText([{ type: 'text' }])).toBe('');
  });

  it('delta → agent_message_chunk / agent_thought_chunk（带 messageId）', () => {
    expect(
      sessionUpdateOf({ ...base, type: 'message_delta', messageId: 'm1', text: 'hi' })
    ).toEqual({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
        messageId: 'm1',
      },
    });
    expect(
      sessionUpdateOf({ ...base, type: 'reasoning_delta', messageId: 'm1', text: 'think' })
    ).toMatchObject({ update: { sessionUpdate: 'agent_thought_chunk' } });
  });

  it('工具事件 → tool_call(pending) / tool_call_update(in_progress/completed/failed)', () => {
    expect(
      sessionUpdateOf({
        ...base,
        type: 'tool_call',
        callId: 'c1',
        tool: 'read',
        input: { path: 'x' },
      })
    ).toEqual({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'read',
        kind: 'read',
        status: 'pending',
        rawInput: { path: 'x' },
      },
    });
    expect(
      sessionUpdateOf({
        ...base,
        type: 'tool_update',
        callId: 'c1',
        tool: 'bash',
        output: 'partial',
      })
    ).toMatchObject({ update: { sessionUpdate: 'tool_call_update', status: 'in_progress' } });
    expect(
      sessionUpdateOf({
        ...base,
        type: 'tool_result',
        callId: 'c1',
        tool: 'bash',
        output: 'boom',
        isError: true,
      })
    ).toMatchObject({
      update: {
        sessionUpdate: 'tool_call_update',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
        rawOutput: 'boom',
      },
    });
  });

  it('toolKind 分类；不产生更新的事件返回 null', () => {
    expect(toolKind('grep')).toBe('search');
    expect(toolKind('write')).toBe('edit');
    expect(toolKind('bash')).toBe('execute');
    expect(toolKind('mystery')).toBe('other');
    expect(sessionUpdateOf({ ...base, type: 'user_message', text: 'hi' })).toBeNull();
    expect(sessionUpdateOf({ ...base, type: 'message_start', messageId: 'm1' })).toBeNull();
  });

  it('stopReason：success→end_turn、interrupted→cancelled、length→max_tokens', () => {
    expect(stopReasonOf(completeEvent('success', 'stop'))).toBe('end_turn');
    expect(stopReasonOf(completeEvent('interrupted', 'aborted'))).toBe('cancelled');
    expect(stopReasonOf(completeEvent('success', 'length'))).toBe('max_tokens');
  });

  it('审批：request 带三选项（allow_once/allow_always/reject_once），outcome 翻译回 scope', () => {
    const request = permissionRequestOf({
      ...base,
      type: 'tool_approval_request',
      callId: 'c9',
      tool: 'write',
      input: { path: 'a' },
      timeoutMs: 1000,
    }) as { toolCall: { toolCallId: string }; options: { kind: string }[] };
    expect(request.toolCall.toolCallId).toBe('c9');
    expect(request.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
    ]);

    expect(approvalOf({ outcome: 'selected', optionId: 'allow' })).toEqual({
      approved: true,
      scope: 'call',
    });
    expect(approvalOf({ outcome: 'selected', optionId: 'allow-session' })).toEqual({
      approved: true,
      scope: 'session',
    });
    expect(approvalOf({ outcome: 'selected', optionId: 'deny' })).toEqual({
      approved: false,
      scope: 'call',
    });
    expect(approvalOf({ outcome: 'cancelled' })).toEqual({ approved: false, scope: 'call' });
    expect(approvalOf({ outcome: 'selected', optionId: 'bogus' })).toBeNull();
    expect(approvalOf(null)).toBeNull();
  });
});
