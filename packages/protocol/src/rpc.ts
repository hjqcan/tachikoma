/**
 * RPC 信封与方法表。传输为 HTTP（请求/响应）+ WS（事件帧流）；
 * 本包只定义消息形状，鉴权/端口/ticket 语义见 docs/tachikoma-desktop-plan.md §2.3。
 */

import { z } from 'zod';
import {
  compactionResultSchema,
  memoryRecordSchema,
  modelListingSchema,
  modelRefSchema,
  sessionSummarySchema,
  thinkingLevelSchema,
  toolsetSchema,
} from './dto';

export const rpcErrorCodeSchema = z.enum([
  'unauthorized',
  'not_found',
  'conflict',
  'invalid_params',
  'unsupported',
  'internal',
]);
export type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;

export const rpcRequestSchema = z.strictObject({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
});
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const rpcOkSchema = z.strictObject({
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
});
export const rpcErrorSchema = z.strictObject({
  id: z.string(),
  ok: z.literal(false),
  error: z.strictObject({ code: rpcErrorCodeSchema, message: z.string() }),
});
export const rpcResponseSchema = z.union([rpcOkSchema, rpcErrorSchema]);
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

// =============================================================================
// 握手
// =============================================================================

export const helloRequestSchema = z.strictObject({
  protocolVersion: z.number().int(),
  client: z.string(),
});
export type HelloRequest = z.infer<typeof helloRequestSchema>;

export const helloResponseSchema = z.strictObject({
  protocolVersion: z.number().int(),
  engineVersion: z.string(),
  capabilities: z.array(z.string()),
  session: z.strictObject({
    workDir: z.string().optional(),
    toolset: toolsetSchema.optional(),
    /** sidecar 会话默认 skill 授予路径（capability 'skills'） */
    skills: z.array(z.string()).optional(),
  }),
});
export type HelloResponse = z.infer<typeof helloResponseSchema>;

// =============================================================================
// 方法表：params/result schema 一一对应（server 按表校验与分发）
// =============================================================================

const empty = z.strictObject({});
const sessionRef = z.strictObject({ sessionId: z.string() });

export const RPC_METHODS = {
  'engine.hello': { params: helloRequestSchema, result: helloResponseSchema },
  'engine.listModels': {
    params: empty,
    result: z.strictObject({ models: z.array(modelListingSchema) }),
  },
  'engine.shutdown': { params: empty, result: empty },
  'session.create': {
    params: z.strictObject({
      model: modelRefSchema.optional(),
      thinkingLevel: thinkingLevelSchema.optional(),
      title: z.string().optional(),
      /** 会话级工作区授予（capability 'session-workspace'）；不持久化 */
      workDir: z.string().optional(),
      toolset: toolsetSchema.optional(),
      /**
       * 会话级 skill 授予（capability 'skills'）：SKILL.md 文件或目录路径，
       * 替换引擎默认（[] = 显式无）；不持久化，且要求工作区授予。
       */
      skills: z.array(z.string()).optional(),
    }),
    result: sessionSummarySchema,
  },
  'session.list': {
    params: empty,
    result: z.strictObject({ sessions: z.array(sessionSummarySchema) }),
  },
  'session.open': { params: sessionRef, result: sessionSummarySchema },
  'session.delete': {
    params: sessionRef,
    result: z.strictObject({ deleted: z.boolean() }),
  },
  'session.send': {
    params: z.strictObject({
      sessionId: z.string(),
      text: z.string().min(1),
      /** 图片附件（capability 'image-input'）：base64 原文进引擎，事件只留元数据 */
      images: z
        .array(
          z.strictObject({
            name: z.string().optional(),
            mimeType: z.string(),
            data: z.string().min(1),
          })
        )
        .optional(),
    }),
    result: z.strictObject({ turnId: z.string() }),
  },
  'session.abort': {
    params: sessionRef,
    result: z.strictObject({ aborted: z.boolean() }),
  },
  'session.respondToApproval': {
    params: z.strictObject({
      sessionId: z.string(),
      callId: z.string(),
      approved: z.boolean(),
      /** 'session'（仅在 approved 时有意义）：该工具本会话内此后自动放行 */
      scope: z.enum(['call', 'session']).optional(),
    }),
    result: z.strictObject({ matched: z.boolean() }),
  },
  'session.setModel': {
    params: z.strictObject({ sessionId: z.string(), model: modelRefSchema }),
    result: z.strictObject({ model: modelRefSchema }),
  },
  'session.setThinkingLevel': {
    params: z.strictObject({ sessionId: z.string(), level: thinkingLevelSchema }),
    result: z.strictObject({ level: thinkingLevelSchema }),
  },
  'session.rename': {
    params: z.strictObject({ sessionId: z.string(), title: z.string().min(1) }),
    result: z.strictObject({ title: z.string() }),
  },
  'session.compact': {
    params: z.strictObject({ sessionId: z.string(), instructions: z.string().optional() }),
    result: compactionResultSchema,
  },
  // 记忆管理面（capability 'memory-management'）：跨会话 scope，库禁用时报错
  'memory.list': {
    params: empty,
    result: z.strictObject({ records: z.array(memoryRecordSchema) }),
  },
  'memory.search': {
    params: z.strictObject({ query: z.string().min(1) }),
    result: z.strictObject({ records: z.array(memoryRecordSchema) }),
  },
  'memory.forget': {
    params: z.strictObject({ memoryId: z.string() }),
    result: z.strictObject({ forgotten: z.boolean() }),
  },
  'memory.clear': {
    params: empty,
    result: z.strictObject({ deleted: z.number() }),
  },
} as const;

export type RpcMethod = keyof typeof RPC_METHODS;

export function isRpcMethod(method: string): method is RpcMethod {
  return method in RPC_METHODS;
}

// =============================================================================
// WS 订阅（升级后客户端首条消息）
// =============================================================================

export const subscribeRequestSchema = z.strictObject({
  sessionId: z.string(),
  /** 0 = 全量重放；否则重放 seq > fromSeq 的帧后接续实时流 */
  fromSeq: z.number().int().min(0),
});
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;
