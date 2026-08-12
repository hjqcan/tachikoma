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

export const memoryStatusSchema = z.enum([
  'disabled',
  'ready',
  'recalled',
  'empty',
  'degraded',
  'write-failed',
]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

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
