/**
 * ChatEvent → ACP（Agent Client Protocol v1）纯映射。零 I/O，acp bin 与测试共用。
 *
 * 字面量以官方 schema 为准（agentclientprotocol/agent-client-protocol,
 * schema/v1/schema.json）：`sessionUpdate` 判别、StopReason 枚举、
 * PermissionOptionKind、整数 protocolVersion。ACP 是边缘的外来线格式，
 * 不进 @hjqcan/tachikoma-protocol。
 */

import type { ChatEventWire } from '@hjqcan/tachikoma-protocol';

export const ACP_PROTOCOL_VERSION = 1;

/** initialize 应答的能力面：spike 只支持文本 prompt 的全新会话 */
export function initializeResult(): unknown {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    },
    authMethods: [],
  };
}

/** ACP PromptRequest.prompt（ContentBlock[]）→ 纯文本；非文本块忽略 */
export function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('\n');
}

/** 工具名 → ACP ToolKind（客户端据此选图标） */
export function toolKind(tool: string): string {
  switch (tool) {
    case 'read':
      return 'read';
    case 'grep':
    case 'find':
    case 'ls':
      return 'search';
    case 'write':
    case 'edit':
      return 'edit';
    case 'bash':
      return 'execute';
    default:
      return 'other';
  }
}

/** message_complete.status/stopReason → ACP StopReason */
export function stopReasonOf(event: Extract<ChatEventWire, { type: 'message_complete' }>): string {
  if (event.status === 'interrupted') return 'cancelled';
  if (event.stopReason === 'length') return 'max_tokens';
  return 'end_turn';
}

/**
 * ChatEvent → session/update 通知参数（SessionNotification）；
 * 不产生更新的事件（user_message/message_start/审批/记忆/重试/压缩/终结）返回 null。
 */
export function sessionUpdateOf(event: ChatEventWire): unknown | null {
  const wrap = (update: Record<string, unknown>) => ({ sessionId: event.sessionId, update });
  switch (event.type) {
    case 'message_delta':
      return wrap({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.text },
        messageId: event.messageId,
      });
    case 'reasoning_delta':
      return wrap({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: event.text },
        messageId: event.messageId,
      });
    case 'tool_call':
      // tool_call 事件发出时 pi 尚在 before 钩子（路径守卫/审批）之前：pending。
      return wrap({
        sessionUpdate: 'tool_call',
        toolCallId: event.callId,
        title: event.tool,
        kind: toolKind(event.tool),
        status: 'pending',
        rawInput: event.input,
      });
    case 'tool_update':
      return wrap({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: 'in_progress',
      });
    case 'tool_result':
      return wrap({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: event.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: event.output } }],
        rawOutput: event.output,
      });
    default:
      return null;
  }
}

/** 审批选项 id：selected outcome 回传后翻译回 respondToApproval 参数 */
export const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-session', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
] as const;

export function permissionRequestOf(
  event: Extract<ChatEventWire, { type: 'tool_approval_request' }>
): unknown {
  return {
    sessionId: event.sessionId,
    toolCall: {
      toolCallId: event.callId,
      title: event.tool,
      kind: toolKind(event.tool),
      status: 'pending',
      rawInput: event.input,
    },
    options: PERMISSION_OPTIONS.map((option) => ({ ...option })),
  };
}

/** RequestPermissionResponse.outcome → respondToApproval 参数；cancelled → 拒绝 */
export function approvalOf(
  outcome: unknown
): { approved: boolean; scope: 'call' | 'session' } | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const record = outcome as { outcome?: unknown; optionId?: unknown };
  if (record.outcome === 'cancelled') {
    return { approved: false, scope: 'call' };
  }
  if (record.outcome === 'selected') {
    const optionId = record.optionId;
    if (optionId === 'allow') return { approved: true, scope: 'call' };
    if (optionId === 'allow-session') return { approved: true, scope: 'session' };
    if (optionId === 'deny') return { approved: false, scope: 'call' };
  }
  return null;
}
