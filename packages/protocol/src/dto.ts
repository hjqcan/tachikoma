/**
 * DTO schemas —— core JSON-safe 类型的 wire 镜像。
 * 全部 strictObject：未知顶层字段一律拒绝（防止引擎内部字段意外上线）。
 */

import { z } from 'zod';

export const modelRefSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const modelListingSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  reasoning: z.boolean(),
  /** 上下文窗口与单次输出上限（tokens）；上下文用量仪表的分母 */
  contextWindow: z.number(),
  maxTokens: z.number(),
});
export type ModelListing = z.infer<typeof modelListingSchema>;

export const thinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const usageSchema = z.strictObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  totalTokens: z.number(),
  cost: z.strictObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
export type Usage = z.infer<typeof usageSchema>;

export const toolsetSchema = z.enum(['read-only', 'coding']);
export type Toolset = z.infer<typeof toolsetSchema>;

/** live 会话的工作区授予状态；授予不持久化（重开会话需重新授予），列表摘要不携带 */
export const workspaceStateSchema = z.strictObject({
  root: z.string(),
  toolset: toolsetSchema,
  tools: z.array(z.string()),
});
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

/** 已加载 skill 的展示信息（capability 'skills'）；授予同为 live 态，不持久化 */
export const skillInfoSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
});
export type SkillInfo = z.infer<typeof skillInfoSchema>;

export const memoryStatusSchema = z.enum([
  'disabled',
  'ready',
  'recalled',
  'empty',
  'degraded',
  'write-failed',
]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

/** 记忆管理面的扁平记录行（GoodMemory 各桶投影；score 仅搜索结果携带） */
export const memoryRecordSchema = z.strictObject({
  id: z.string(),
  type: z.enum(['fact', 'preference', 'reference', 'episode', 'feedback', 'archive', 'experience']),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  importance: z.number().optional(),
  createdAt: z.string().optional(),
  lifecycle: z.enum(['active', 'superseded', 'inactive']).optional(),
  score: z.number().optional(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const memorySnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  status: memoryStatusSchema,
  databasePath: z.string().optional(),
  error: z.string().optional(),
});
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;

export const sessionSummarySchema = z.strictObject({
  sessionId: z.string(),
  title: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
  model: modelRefSchema.nullable(),
  thinkingLevel: thinkingLevelSchema.nullable(),
  status: z.enum(['ready', 'corrupt']),
  error: z.string().optional(),
  /** 仅 live 会话携带（server 侧补充） */
  workspace: workspaceStateSchema.optional(),
  /** 仅 live 会话携带（server 侧补充）：已加载 skills（capability 'skills'） */
  skills: z.array(skillInfoSchema).optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const compactionResultSchema = z.strictObject({
  summary: z.string(),
  firstKeptEntryId: z.string(),
  tokensBefore: z.number(),
  estimatedTokensAfter: z.number().optional(),
  usage: usageSchema.optional(),
});
export type CompactionResult = z.infer<typeof compactionResultSchema>;
