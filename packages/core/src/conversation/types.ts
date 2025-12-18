/**
 * Conversation Module Types
 *
 * 多轮对话系统的核心类型定义
 */

import type { PlannerRole, SubTask } from '../orchestrator/types';

// =============================================================================
// 用户意图类型
// =============================================================================

/**
 * 用户意图分类
 */
export enum UserIntent {
  /** 全新任务 */
  NEW_TASK = 'new_task',
  /** 继续上一任务 */
  CONTINUE = 'continue',
  /** 修改刚才的结果 */
  MODIFY = 'modify',
  /** 回答 Agent 的问题 */
  CLARIFY = 'clarify',
  /** 撤销操作 */
  UNDO = 'undo',
  /** 询问状态/进度 */
  QUERY = 'query',
}

/**
 * 意图分析结果
 */
export interface IntentAnalysisResult {
  /** 识别的意图 */
  intent: UserIntent;
  /** 置信度 0-1 */
  confidence: number;
  /** 提取的实体/参数 */
  entities: Record<string, unknown>;
  /** 原始消息 */
  originalMessage: string;
}

// =============================================================================
// 反馈循环类型
// =============================================================================

/**
 * 反馈动作类型
 */
export enum FeedbackAction {
  /** 自动重试（如网络错误） */
  AUTO_RETRY = 'auto_retry',
  /** 需要重新规划 */
  REPLAN = 'replan',
  /** 需要用户澄清 */
  ASK_USER = 'ask_user',
  /** 任务完成 */
  COMPLETE = 'complete',
  /** 部分完成，等待下一轮 */
  PARTIAL_COMPLETE = 'partial_complete',
}

/**
 * 反馈分析结果
 */
export interface FeedbackAnalysisResult {
  /** 建议的动作 */
  action: FeedbackAction;
  /** 原因说明 */
  reason: string;
  /** 如果 ASK_USER，要问的问题 */
  question?: string;
  /** 如果 REPLAN，建议的调整 */
  replanSuggestion?: string;
  /** 重试次数（如果 AUTO_RETRY） */
  retryCount?: number;
}

// =============================================================================
// 会话消息类型
// =============================================================================

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * 对话消息
 */
export interface ConversationMessage {
  /** 消息 ID */
  id: string;
  /** 角色 */
  role: MessageRole;
  /** 内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 关联的意图（用户消息） */
  intent?: UserIntent;
  /** 关联的执行结果（助手消息） */
  executionSummary?: ExecutionSummary;
}

/**
 * 执行摘要
 */
export interface ExecutionSummary {
  /** 是否成功 */
  success: boolean;
  /** 完成的子任务数 */
  subtasksCompleted: number;
  /** 失败的子任务数 */
  subtasksFailed: number;
  /** 创建/修改的文件 */
  filesAffected: string[];
  /** 错误信息（如有） */
  error?: string;
}

// =============================================================================
// 检查点类型
// =============================================================================

/**
 * 检查点（用于撤销）
 */
export interface Checkpoint {
  /** 检查点 ID */
  id: string;
  /** 创建时间 */
  timestamp: number;
  /** 描述 */
  description: string;
  /** 消息索引（检查点对应的消息位置） */
  messageIndex: number;
  /** 文件快照路径 */
  snapshotPath?: string;
}

// =============================================================================
// 会话状态类型
// =============================================================================

/**
 * 会话状态
 */
export interface SessionState {
  /** 会话 ID */
  sessionId: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活动时间 */
  lastActiveAt: number;
  /** 工作目录 */
  workDir: string;

  // 对话历史
  /** 消息历史 */
  messages: ConversationMessage[];
  /** 压缩的历史摘要（用于长会话） */
  compressedHistory?: string;

  // 当前执行状态
  /** 当前计划 */
  currentPlan?:
    | {
        subtasks: SubTask[];
        executionOrder: string[];
      }
    | undefined;
  /** 已完成的子任务 ID */
  completedSubtasks: string[];
  /** 待执行的子任务 ID */
  pendingSubtasks: string[];

  // 检查点
  /** 检查点列表 */
  checkpoints: Checkpoint[];

  // 上下文变量
  /** 跨轮次共享的变量 */
  variables: Record<string, unknown>;

  // Agent 状态
  /** Agent 是否在等待用户输入 */
  waitingForUser: boolean;
  /** 待回答的问题 */
  pendingQuestion?: string | undefined;
}

// =============================================================================
// 事件类型（流式输出）
// =============================================================================

/**
 * 流式事件基础类型
 */
interface BaseStreamEvent {
  timestamp: number;
}

/**
 * 思考事件
 */
export interface ThinkingEvent extends BaseStreamEvent {
  type: 'thinking';
  content: string;
}

/**
 * 工具调用事件
 */
export interface ToolCallEvent extends BaseStreamEvent {
  type: 'tool_call';
  tool: string;
  input: unknown;
}

/**
 * 工具结果事件
 */
export interface ToolResultEvent extends BaseStreamEvent {
  type: 'tool_result';
  tool: string;
  success: boolean;
  durationMs?: number;
  error?: string;
  outputPreview?: string;
  result?: unknown;
}

/**
 * 子任务输出事件（Agent 完成任务时的文本输出）
 */
export interface SubtaskOutputEvent extends BaseStreamEvent {
  type: 'subtask_output';
  subtaskId: string;
  content: string;
}

/**
 * 子任务完成事件
 */
export interface SubtaskCompleteEvent extends BaseStreamEvent {
  type: 'subtask_complete';
  subtaskId: string;
  success: boolean;
  error?: string;
}

/**
 * 需要用户输入事件
 */
export interface NeedUserInputEvent extends BaseStreamEvent {
  type: 'need_user_input';
  question: string;
}

/**
 * 完成事件
 */
export interface CompleteEvent extends BaseStreamEvent {
  type: 'complete';
  success: boolean;
  summary: string;
}

/**
 * 错误事件
 */
export interface ErrorEvent extends BaseStreamEvent {
  type: 'error';
  error: string;
  retryable: boolean;
}

/**
 * 计划生成事件（携带详细规划信息）
 */
export interface PlanGeneratedEvent extends BaseStreamEvent {
  type: 'plan_generated';
  subtasks: SubTask[];
  roles?: Pick<PlannerRole, 'id' | 'name' | 'responsibilities'>[];
}

/**
 * 子任务开始事件（携带分配信息）
 */
export interface SubtaskStartEvent extends BaseStreamEvent {
  type: 'subtask_start';
  subtaskId: string;
  subtaskObjective: string;
  workerId: string;
  role?: string;
}

/**
 * 流式事件联合类型
 */
export type StreamEvent =
  | ThinkingEvent
  | PlanGeneratedEvent
  | SubtaskStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubtaskOutputEvent
  | SubtaskCompleteEvent
  | NeedUserInputEvent
  | CompleteEvent
  | ErrorEvent;

// =============================================================================
// Runner 配置类型
// =============================================================================

/**
 * ConversationalRunner 配置
 */
export interface ConversationalRunnerConfig {
  /** 会话存储目录 */
  sessionDir: string;
  /** 工作目录 */
  workDir: string;
  /** LLM 配置 */
  llm: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
  /** 最大历史消息数（超过后压缩） */
  maxHistoryMessages?: number;
  /** 是否启用检查点 */
  enableCheckpoints?: boolean;
  /** 详细日志 */
  verbose?: boolean;
  /** 禁用审批（测试模式） */
  noApproval?: boolean;
}
