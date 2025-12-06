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
 */
export type LLMMessageRole = 'system' | 'user' | 'assistant';

/**
 * LLM 消息
 */
export interface LLMMessage {
  /** 消息角色 */
  role: LLMMessageRole;
  /** 消息内容 */
  content: string;
}

/**
 * LLM 请求参数
 */
export interface LLMRequest {
  /** 系统提示 */
  systemPrompt: string;
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
