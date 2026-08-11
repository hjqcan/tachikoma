/**
 * Chat 模块类型定义
 *
 * 螺旋第一、二圈：顶级 chatbot + pi-mono 工具循环。
 * 用户消息 → LLM（token 级流式）→ 可选工具调用 → 回复，不经过 planner/orchestrator。
 * 事件命名与 docs/tachikoma-desktop-plan.md 的 StreamEvent v2（message_delta 等）对齐，
 * 后续圈层（工具调用、协调）在同一事件联合上做增量扩展。
 */

import type { Message } from '@earendil-works/pi-ai';

// =============================================================================
// Provider / 模型配置
// =============================================================================

export type ChatProvider = 'anthropic' | 'openai' | 'openai-compatible';

export interface ChatModelConfig {
  provider: ChatProvider;
  model: string;
  apiKey: string;
  /** OpenAI 兼容端点（如 OpenRouter）或自定义网关 */
  baseUrl?: string;
}

// =============================================================================
// 消息与会话
// =============================================================================

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** 生成该条 assistant 消息时使用的 `provider/model`，混合模型会话可追溯 */
  model?: string;
  /** 生成被用户中断时为 true（内容为已产出的部分） */
  interrupted?: boolean;
}

/** 会话持久化的单一真相；完整保留 pi toolCall/toolResult 以便恢复工具上下文 */
export interface ChatTranscriptEntry {
  id: string;
  message: Message;
  interrupted?: boolean;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ChatSessionState {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  /** 自动取首条用户消息前缀，可改 */
  title?: string;
  provider: ChatProvider;
  model: string;
  transcript: ChatTranscriptEntry[];
}

export interface ChatSessionSummary {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  provider: ChatProvider;
  model: string;
  messageCount: number;
}

// =============================================================================
// 流式事件
// =============================================================================

interface BaseChatEvent {
  timestamp: number;
}

export interface ChatMessageStartEvent extends BaseChatEvent {
  type: 'message_start';
  messageId: string;
}

/** token 级增量（与桌面方案的 message_delta 语义一致） */
export interface ChatMessageDeltaEvent extends BaseChatEvent {
  type: 'message_delta';
  messageId: string;
  text: string;
}

export type ChatFinishReason =
  'stop' | 'length' | 'content-filter' | 'interrupted' | 'error' | 'other';

export interface ChatMessageCompleteEvent extends BaseChatEvent {
  type: 'message_complete';
  message: ChatMessage;
  finishReason: ChatFinishReason;
  usage?: ChatUsage;
}

export interface ChatErrorEvent extends BaseChatEvent {
  type: 'error';
  error: string;
  retryable: boolean;
}

/** 记忆召回结果（仅在引擎配置了记忆层时出现，UI 可显示"已回忆起相关内容"） */
export interface ChatMemoryRecallEvent extends BaseChatEvent {
  type: 'memory_recall';
  hasContext: boolean;
  estimatedTokens?: number;
}

export interface ChatReasoningDeltaEvent extends BaseChatEvent {
  type: 'reasoning_delta';
  text: string;
}

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

export type ChatEvent =
  | ChatMessageStartEvent
  | ChatMessageDeltaEvent
  | ChatMessageCompleteEvent
  | ChatMemoryRecallEvent
  | ChatReasoningDeltaEvent
  | ChatToolCallEvent
  | ChatToolUpdateEvent
  | ChatToolResultEvent
  | ChatErrorEvent;

// =============================================================================
// 引擎配置
// =============================================================================

export interface ChatEngineConfig {
  /** 会话存储目录（如 ~/.tachikoma/chats） */
  dataDir: string;
  model: ChatModelConfig;
  /** 覆盖默认系统提示词（默认 buildChatSystemPrompt()） */
  systemPrompt?: string;
  /** 单次请求携带的最大历史消息数（取最近的），默认 40 */
  maxHistoryMessages?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** 显式开启 pi coding tools；该目录是相对路径解析与命令执行的 cwd */
  workDir?: string;
}
