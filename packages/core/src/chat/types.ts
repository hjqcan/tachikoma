import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';

export interface ChatModelRef {
  provider: string;
  model: string;
}

/** 模型发现条目（pi ModelRuntime 目录的薄投影：内建 catalog + models.json 自定义） */
export interface ChatModelListing {
  provider: string;
  model: string;
  reasoning: boolean;
  /** 模型上下文窗口与单次输出上限（tokens）；上下文用量仪表的分母 */
  contextWindow: number;
  maxTokens: number;
}

export type ChatThinkingLevel = ThinkingLevel;

export interface ChatMemoryConfig {
  databasePath?: string;
  userId?: string;
}

export interface ChatEngineConfig {
  dataDir?: string;
  /**
   * 用户级配置目录（当前仅 models.json）。缺省 = dataDir，即零行为变化；
   * per-workspace dataDir 的部署（如每本书一个 sidecar）用它共享模型/凭据配置。
   */
  configDir?: string;
  model?: ChatModelRef;
  thinkingLevel?: ChatThinkingLevel;
  systemPrompt?: string;
  memory?: false | ChatMemoryConfig;
  /**
   * 工作区根目录。设置后启用 pi 工具集（见 toolset），
   * 路径边界由 workspace-guard 强制（canonical root + symlink 检查）。
   * 缺省不设 —— 默认产品保持零工具（第一圈保证不被削弱）。
   */
  workDir?: string;
  /**
   * 'read-only'（默认）：read/grep/find/ls，免审批。
   * 'coding'：额外启用 write/edit/bash，三者逐调用审批
   * （tool_approval_request 事件 + respondToApproval，超时默认拒绝）。
   * 仅在设置了 workDir 时生效。
   */
  toolset?: ChatToolset;
  /** 审批等待超时（毫秒），超时默认拒绝。默认 120000 */
  approvalTimeoutMs?: number;
  /**
   * Skill 授予：SKILL.md 文件或含 skill 的目录路径，显式列举（零环境发现，
   * 缺省零 skill）。skills 依赖 read 工具进入系统提示，因此授予要求 workDir。
   */
  skills?: string[];
}

export type ChatToolset = 'read-only' | 'coding';

/** live 会话的工作区授予状态（不持久化；重开会话需重新授予） */
export interface ChatWorkspaceState {
  root: string;
  toolset: ChatToolset;
  tools: string[];
}

export interface ChatSessionInit {
  title?: string;
  model?: ChatModelRef;
  thinkingLevel?: ChatThinkingLevel;
  /**
   * 本会话的工作区授予，覆盖引擎默认。授予只对这个 live 会话有效，
   * 不写入会话文件——重开（openSession）回到引擎默认，需要重新授予。
   */
  workDir?: string;
  /** 本会话工具集；缺省用引擎配置。仅在（本会话或引擎）设置了 workDir 时生效 */
  toolset?: ChatToolset;
  /**
   * 本会话的 skill 授予，**替换**引擎默认（`[]` = 显式无；undefined = 继承）。
   * 与 workDir/toolset 同为 live 授予：不落盘，重开不恢复。
   */
  skills?: string[];
}

/** 已加载 skill 的展示信息（summary 即真相面：授予但被 pi 丢弃者以缺席可见） */
export interface ChatSkillInfo {
  name: string;
  description: string;
}

/** 图片附件：base64 原文随 send 进 pi（转录是像素的事实源；事件只留元数据） */
export interface ChatImageAttachment {
  name?: string;
  mimeType: string;
  /** base64（不带 data: 前缀） */
  data: string;
}

/** 事件里的附件元数据：重放/回填靠它还原芯片，不搬运像素 */
export interface ChatAttachmentMeta {
  kind: 'image';
  mimeType: string;
  bytes: number;
  name?: string;
}

export interface ChatSendOptions {
  signal?: AbortSignal;
  images?: ChatImageAttachment[];
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
  /** 仅 live 会话携带（server 侧补充）；listSessions 的磁盘摘要没有它 */
  workspace?: ChatWorkspaceState;
  /** 仅 live 会话携带（server 侧补充）：已加载 skills */
  skills?: ChatSkillInfo[];
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

/** 回合首事件：用户输入原文。WAL 重放靠它重建对话的"人"这一侧 */
export interface ChatUserMessageEvent extends BaseChatEvent {
  type: 'user_message';
  text: string;
  /** 增量字段：图片附件元数据（像素在 pi 转录里） */
  attachments?: ChatAttachmentMeta[];
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

/** 本回合召回命中的单条记忆（明细供 UI 展开；preview 为截断内容） */
export interface ChatRecalledMemory {
  id: string;
  type: string;
  preview: string;
  score?: number;
}

export interface ChatMemoryStatusEvent extends BaseChatEvent {
  type: 'memory_status';
  phase: 'session_start' | 'recall' | 'writeback';
  status: ChatMemoryStatus;
  hasContext?: boolean;
  estimatedTokens?: number;
  /** phase 'recall' 且有命中时携带（增量字段） */
  recalled?: ChatRecalledMemory[];
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

/** 需审批的工具调用等待放行；消费者用 respondToApproval(callId, approved) 应答 */
export interface ChatToolApprovalRequestEvent extends BaseChatEvent {
  type: 'tool_approval_request';
  callId: string;
  tool: string;
  input: unknown;
  timeoutMs: number;
}

export interface ChatToolApprovalResolvedEvent extends BaseChatEvent {
  type: 'tool_approval_resolved';
  callId: string;
  approved: boolean;
  reason: 'reply' | 'timeout' | 'aborted';
  /** 'session' = 放行并对该工具在本会话内不再询问（随会话消亡，不落盘）；缺省 'call' */
  scope?: 'call' | 'session';
}

/**
 * 契约演进规则：只做增量扩展（新事件类型），不改既有事件语义；
 * 消费者必须容忍未知事件类型（跳过而非报错），否则圈层推进即破坏性变更。
 */
export type ChatEvent =
  | ChatUserMessageEvent
  | ChatMessageStartEvent
  | ChatMessageDeltaEvent
  | ChatReasoningDeltaEvent
  | ChatRetryEvent
  | ChatCompactionEvent
  | ChatMemoryStatusEvent
  | ChatToolCallEvent
  | ChatToolUpdateEvent
  | ChatToolResultEvent
  | ChatToolApprovalRequestEvent
  | ChatToolApprovalResolvedEvent
  | ChatMessageCompleteEvent;
