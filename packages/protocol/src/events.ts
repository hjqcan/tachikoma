/**
 * ChatEvent 的 wire 镜像 + 会话事件帧。
 *
 * 语义源头是 @tachikoma/core 的 ChatEvent 联合（第一、二圈已冻结）；
 * 双向类型兼容由 tests/type-compat.test.ts 在编译期强制。
 * 演进规则：只增不改；消费者必须容忍未知事件类型（parseSessionEventFrame 绝不丢 seq）。
 */

import { z } from 'zod';
import { modelRefSchema, memoryStatusSchema, usageSchema } from './dto';

const base = {
  sessionId: z.string(),
  turnId: z.string(),
  timestamp: z.number(),
};

export const messageStartEventSchema = z.strictObject({
  ...base,
  type: z.literal('message_start'),
  messageId: z.string(),
});

export const messageDeltaEventSchema = z.strictObject({
  ...base,
  type: z.literal('message_delta'),
  messageId: z.string(),
  text: z.string(),
});

export const reasoningDeltaEventSchema = z.strictObject({
  ...base,
  type: z.literal('reasoning_delta'),
  messageId: z.string(),
  text: z.string(),
});

export const retryEventSchema = z.strictObject({
  ...base,
  type: z.literal('retry'),
  attempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  error: z.string(),
});

export const compactionEventSchema = z.strictObject({
  ...base,
  type: z.literal('compaction'),
  phase: z.enum(['start', 'complete']),
  reason: z.enum(['manual', 'threshold', 'overflow']),
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  error: z.string().optional(),
});

export const memoryStatusEventSchema = z.strictObject({
  ...base,
  type: z.literal('memory_status'),
  phase: z.enum(['session_start', 'recall', 'writeback']),
  status: memoryStatusSchema,
  hasContext: z.boolean().optional(),
  estimatedTokens: z.number().optional(),
  error: z.string().optional(),
});

export const toolCallEventSchema = z.strictObject({
  ...base,
  type: z.literal('tool_call'),
  callId: z.string(),
  tool: z.string(),
  input: z.unknown(),
});

export const toolUpdateEventSchema = z.strictObject({
  ...base,
  type: z.literal('tool_update'),
  callId: z.string(),
  tool: z.string(),
  output: z.string(),
});

export const toolResultEventSchema = z.strictObject({
  ...base,
  type: z.literal('tool_result'),
  callId: z.string(),
  tool: z.string(),
  output: z.string(),
  isError: z.boolean(),
});

export const toolApprovalRequestEventSchema = z.strictObject({
  ...base,
  type: z.literal('tool_approval_request'),
  callId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  timeoutMs: z.number(),
});

export const toolApprovalResolvedEventSchema = z.strictObject({
  ...base,
  type: z.literal('tool_approval_resolved'),
  callId: z.string(),
  approved: z.boolean(),
  reason: z.enum(['reply', 'timeout', 'aborted']),
  /** 'session' = 放行并在本会话内对该工具不再询问；缺省 'call' */
  scope: z.enum(['call', 'session']).optional(),
});

export const messageCompleteEventSchema = z.strictObject({
  ...base,
  type: z.literal('message_complete'),
  messageId: z.string(),
  status: z.enum(['success', 'interrupted', 'failed']),
  content: z.string(),
  model: modelRefSchema,
  stopReason: z.string(),
  usage: usageSchema,
  error: z.string().optional(),
});

export const chatEventWireSchema = z.discriminatedUnion('type', [
  messageStartEventSchema,
  messageDeltaEventSchema,
  reasoningDeltaEventSchema,
  retryEventSchema,
  compactionEventSchema,
  memoryStatusEventSchema,
  toolCallEventSchema,
  toolUpdateEventSchema,
  toolResultEventSchema,
  toolApprovalRequestEventSchema,
  toolApprovalResolvedEventSchema,
  messageCompleteEventSchema,
]);
export type ChatEventWire = z.infer<typeof chatEventWireSchema>;

// =============================================================================
// 会话事件帧：seq 属传输层（server 派发，先写 WAL 再扇出）
// =============================================================================

export const FRAME_VERSION = 1;

export const sessionEventFrameSchema = z.strictObject({
  v: z.literal(FRAME_VERSION),
  sessionId: z.string(),
  seq: z.number().int().positive(),
  event: chatEventWireSchema,
});
export type SessionEventFrame = z.infer<typeof sessionEventFrameSchema>;

/** 帧外壳可解析、event.type 未知（未来圈层的增量事件）——保留原始 JSON，绝不丢 seq */
export interface UnknownEventFrame {
  v: typeof FRAME_VERSION;
  sessionId: string;
  seq: number;
  unknown: true;
  type: string;
  raw: unknown;
}

const frameShellSchema = z
  .object({
    v: z.literal(FRAME_VERSION),
    sessionId: z.string(),
    seq: z.number().int().positive(),
    event: z.object({ type: z.string() }).loose(),
  })
  .loose();

export type ParsedSessionEventFrame =
  | { ok: true; known: true; frame: SessionEventFrame }
  | { ok: true; known: false; frame: UnknownEventFrame }
  | { ok: false; error: string };

export function parseSessionEventFrame(raw: unknown): ParsedSessionEventFrame {
  const known = sessionEventFrameSchema.safeParse(raw);
  if (known.success) {
    return { ok: true, known: true, frame: known.data };
  }
  const shell = frameShellSchema.safeParse(raw);
  if (shell.success) {
    return {
      ok: true,
      known: false,
      frame: {
        v: FRAME_VERSION,
        sessionId: shell.data.sessionId,
        seq: shell.data.seq,
        unknown: true,
        type: shell.data.event.type,
        raw: shell.data.event,
      },
    };
  }
  return { ok: false, error: known.error.message };
}
