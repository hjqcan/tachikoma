/**
 * Planner 模块类型定义
 *
 * 定义 LLM 客户端、Prompt 模板、解析器相关类型
 */

import type { AgentConfig } from '../types';

// ============================================================================
// LLM 客户端类型
// ============================================================================

/**
 * LLM 提供商类型
 */
export type LLMProvider = 'anthropic' | 'openai' | 'mock';

/**
 * LLM 消息角色
 *
 * 注意：虽然定义了 'tool' 角色，但在当前架构中，
 * PromptContextEngine 会将 tool 消息转换为 user 消息，
 * 因此 LLMClient 实际上不会收到 tool 角色消息。
 * 保留此定义是为了将来可能的原生 tool calling 支持。
 */
export type LLMMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * LLM 消息
 */
export interface LLMMessage {
  /** 消息角色 */
  role: LLMMessageRole;
  /** 消息内容 */
  content: string;
  /** 工具调用 ID (仅 tool 角色需要) */
  toolCallId?: string | undefined;
}

// ============================================================================
// Function Calling 类型
// ============================================================================

/**
 * JSON Schema 类型（简化版）
 */
export interface JSONSchemaType {
  type?: string | undefined;
  properties?: Record<string, JSONSchemaType> | undefined;
  required?: string[] | undefined;
  items?: JSONSchemaType | undefined;
  description?: string | undefined;
  enum?: unknown[] | undefined;
  [key: string]: unknown;
}

/**
 * LLM 工具定义（用于原生 Function Calling）
 */
export interface LLMToolDefinition {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 JSON Schema */
  parameters: JSONSchemaType;
}

/**
 * LLM 工具调用（LLM 返回的工具调用请求）
 */
export interface LLMToolCall {
  /** 调用 ID（用于匹配结果） */
  id: string;
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * LLM 工具集合（AI SDK tools 记录）
 *
 * 兼容 Record<string, Tool> 的结构，不在此处绑定具体 SDK 类型。
 */
export type LLMToolSet = Record<string, unknown>;

/**
 * LLM 工具选择策略
 *
 * - auto: 模型自主决定是否/调用哪个工具
 * - required: 必须调用工具（可自主选择工具）
 * - none: 禁止调用工具
 * - { type: 'tool', toolName }: 指定必须调用某个工具（AI SDK v6）
 * - { name }: 兼容旧格式（将映射为 type:'tool'）
 */
export type LLMToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'tool'; toolName: string }
  | { name: string };

/**
 * LLM 请求参数
 */
export interface LLMRequest {
  /** 系统提示（可选；缺省时不发送 system 消息） */
  systemPrompt?: string | undefined;
  /** 用户消息 */
  messages: LLMMessage[];
  /** 最大 Token 数 */
  maxTokens?: number | undefined;
  /** 温度参数 */
  temperature?: number | undefined;
  /** 停止序列 */
  stopSequences?: string[] | undefined;
  /** 外部取消信号（优先于客户端配置的 timeout） */
  abortSignal?: AbortSignal | undefined;
  /** 工具定义（原生 Function Calling） */
  tools?: LLMToolDefinition[] | LLMToolSet | undefined;
  /** 工具选择策略 */
  toolChoice?: LLMToolChoice | undefined;
}

/**
 * LLM 响应
 */
export interface LLMResponse {
  /** 响应内容 */
  content: string;
  /** 使用的 Token 数 */
  usage: {
    /** 输入 Token */
    inputTokens: number;
    /** 输出 Token */
    outputTokens: number;
  };
  /** 停止原因 */
  stopReason?: string | undefined;
  /** 模型 ID */
  model: string;
  /** 工具调用（原生 Function Calling 响应） */
  toolCalls?: LLMToolCall[] | undefined;
}

/**
 * LLM 客户端配置
 */
export interface LLMClientConfig extends AgentConfig {
  /** API 密钥 */
  apiKey?: string;
  /** API 端点 URL（可选，用于自定义端点） */
  baseUrl?: string;
  /** 请求超时（毫秒） */
  timeout?: number;
  /**
   * 是否启用 Prompt Caching (P0)
   *
   * 当启用时，系统提示将被标记为 cache_control: ephemeral
   * 可节省90%的输入token成本（Anthropic服务端缓存）
   *
   * @default true (Anthropic)
   */
  enablePromptCache?: boolean;
  /**
   * 是否启用 Extended Context Beta (P1)
   *
   * 当启用时， Claude 4/4.5 模型将支持最多 1M tokens
   * 需要发送 anthropic-beta: extended-context 头部
   *
   * 出于兼容性考虑建议显式开启（beta 头部可能随时间变化）
   *
   * @default false
   */
  enableExtendedContext?: boolean;
  /**
   * Extended Context Beta Header 值（Anthropic）
   *
   * 仅在 enableExtendedContext=true 且模型匹配时生效。
   *
   * @default "extended-context-2025-04-14"
   */
  extendedContextBetaHeader?: string;
}

/**
 * LLM 客户端接口
 */
export interface LLMClient {
  /** 提供商类型 */
  readonly provider: LLMProvider;

  /**
   * 发送请求到 LLM
   * @param request - 请求参数
   * @returns LLM 响应
   */
  complete(request: LLMRequest): Promise<LLMResponse>;

  /**
   * 检查客户端是否可用
   * @returns 是否可用
   */
  isAvailable(): boolean;
}

// ============================================================================
// 解析器类型
// ============================================================================

/**
 * 解析结果
 */
export interface ParseResult<T> {
  /** 是否成功 */
  success: boolean;
  /** 解析后的数据（成功时存在） */
  data?: T;
  /** 错误信息（失败时存在） */
  error?: string;
  /** 原始内容 */
  rawContent: string;
}

/**
 * 重试配置
 */
export interface ParseRetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 是否在重试时包含错误反馈 */
  includeErrorFeedback: boolean;
}

// ============================================================================
// Prompt 模板类型
// ============================================================================

/**
 * Prompt 模板变量
 */
export interface PromptVariables {
  /** 任务目标 */
  objective: string;
  /** 约束条件 */
  constraints: string[];
  /** 可用工具列表 */
  availableTools?: string[] | undefined;
  /** 最大子任务数量 */
  maxSubtasks?: number | undefined;
  /** 输出 Schema */
  outputSchema?: string | undefined;
  /** 额外上下文 */
  additionalContext?: string | undefined;
}

/**
 * Patch 规划 Prompt 变量
 *
 * 用于“增量修改/补丁规划”：基于已有工作产出生成最小 delta 计划。
 */
export interface PatchPromptVariables extends PromptVariables {
  /** 之前的计划/产出上下文（结构化摘要） */
  previousContext?: string | undefined;
}

/**
 * Subtask refinement Prompt 变量
 *
 * 用于在执行前复审单个子任务是否需要拆分。
 */
export interface SubtaskRefinePromptVariables {
  /** 子任务目标 */
  objective: string;
  /** 约束条件 */
  constraints: string[];
  /** 可用工具列表 */
  availableTools?: string[] | undefined;
  /** 最大子任务数量 */
  maxSubtasks?: number | undefined;
  /** 最大思考轮次 */
  maxThinkingRounds?: number | undefined;
  /** 预估执行时间（分钟） */
  estimatedMinutes?: number | undefined;
}

/**
 * 错误反馈变量
 */
export interface ErrorFeedbackVariables {
  /** 原始响应 */
  originalResponse: string;
  /** 解析错误信息 */
  parseError: string;
  /** 重试次数 */
  retryCount: number;
}
