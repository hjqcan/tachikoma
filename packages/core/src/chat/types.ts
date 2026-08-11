import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';

export interface ChatModelRef {
  provider: string;
  model: string;
}

export type ChatThinkingLevel = ThinkingLevel;

export interface ChatMemoryConfig {
  databasePath?: string;
  userId?: string;
}

export interface ChatEngineConfig {
  dataDir?: string;
  model?: ChatModelRef;
  thinkingLevel?: ChatThinkingLevel;
  systemPrompt?: string;
  memory?: false | ChatMemoryConfig;
  /**
   * 工作区根目录。设置后启用 pi 只读工具集（read/grep/find/ls），
   * 路径边界由 workspace-guard 强制（canonical root + symlink 检查）。
   * 缺省不设 —— 默认产品保持零工具（第一圈保证不被削弱）。
   */
  workDir?: string;
}

export interface ChatSessionInit {
  title?: string;
  model?: ChatModelRef;
  thinkingLevel?: ChatThinkingLevel;
}

export interface ChatSendOptions {
  signal?: AbortSignal;
}

export type ChatMemoryStatus =
  'disabled' | 'ready' | 'recalled' | 'empty' | 'degraded' | 'write-failed';

export interface ChatMemorySnapshot {
  enabled: boolean;
  status: ChatMemoryStatus;
  databasePath?: string;
  error?: string;
}

export interface ChatSessionSummary {
  sessionId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model: ChatModelRef | null;
  thinkingLevel: ChatThinkingLevel | null;
  status: 'ready' | 'corrupt';
  error?: string;
}

export interface ChatCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: ChatUsage;
}

export type ChatUsage = Usage;

interface BaseChatEvent {
  sessionId: string;
  turnId: string;
  timestamp: number;
}

export interface ChatMessageStartEvent extends BaseChatEvent {
  type: 'message_start';
  messageId: string;
}

export interface ChatMessageDeltaEvent extends BaseChatEvent {
  type: 'message_delta';
  messageId: string;
  text: string;
}

export interface ChatReasoningDeltaEvent extends BaseChatEvent {
  type: 'reasoning_delta';
  messageId: string;
  text: string;
}

export interface ChatRetryEvent extends BaseChatEvent {
  type: 'retry';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
}

export interface ChatCompactionEvent extends BaseChatEvent {
  type: 'compaction';
  phase: 'start' | 'complete';
  reason: 'manual' | 'threshold' | 'overflow';
  aborted?: boolean;
  willRetry?: boolean;
  error?: string;
}

export interface ChatMemoryStatusEvent extends BaseChatEvent {
  type: 'memory_status';
  phase: 'session_start' | 'recall' | 'writeback';
  status: ChatMemoryStatus;
  hasContext?: boolean;
  estimatedTokens?: number;
  error?: string;
}

export interface ChatMessageCompleteEvent extends BaseChatEvent {
  type: 'message_complete';
  messageId: string;
  status: 'success' | 'interrupted' | 'failed';
  content: string;
  model: ChatModelRef;
  stopReason: string;
  usage: ChatUsage;
  error?: string;
}

/** 工具开始执行（第二圈增量；仅在 workDir 启用工具时出现） */
export interface ChatToolCallEvent extends BaseChatEvent {
  type: 'tool_call';
  callId: string;
  tool: string;
  input: unknown;
}

export interface ChatToolUpdateEvent extends BaseChatEvent {
  type: 'tool_update';
  callId: string;
  tool: string;
  output: string;
}

export interface ChatToolResultEvent extends BaseChatEvent {
  type: 'tool_result';
  callId: string;
  tool: string;
  output: string;
  isError: boolean;
}

/**
 * 契约演进规则：只做增量扩展（新事件类型），不改既有事件语义；
 * 消费者必须容忍未知事件类型（跳过而非报错），否则圈层推进即破坏性变更。
 */
export type ChatEvent =
  | ChatMessageStartEvent
  | ChatMessageDeltaEvent
  | ChatReasoningDeltaEvent
  | ChatRetryEvent
  | ChatCompactionEvent
  | ChatMemoryStatusEvent
  | ChatToolCallEvent
  | ChatToolUpdateEvent
  | ChatToolResultEvent
  | ChatMessageCompleteEvent;
