/**
 * Worker 模块类型定义
 *
 * 定义 Worker Backend 统一接口、消息类型和配置
 */

import type { Task, Tool, RetryPolicy } from '../types';
import type { Sandbox, SandboxConfig } from '../sandbox';
import type { LLMClient } from '../planner/types';

// ============================================================================
// Worker 后端类型
// ============================================================================

/**
 * Worker 后端类型
 */
export type WorkerBackendType = 'agent-sdk' | 'generic';

/**
 * Worker 能力
 */
export type WorkerCapability =
  | 'code-execution'
  | 'file-operations'
  | 'shell-commands'
  | 'web-search'
  | 'browser-automation'
  | 'mcp-tools';

/**
 * Worker 状态
 */
export type WorkerStatus =
  | 'idle'
  | 'initializing'
  | 'thinking'
  | 'acting'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'interrupted';

// ============================================================================
// Worker 消息类型
// ============================================================================

/**
 * Worker 思考消息
 */
export interface WorkerThinkingMessage {
  type: 'thinking';
  content: string;
  timestamp: number;
}

/**
 * Worker 工具调用消息
 */
export interface WorkerToolCallMessage {
  type: 'tool_call';
  tool: string;
  input: unknown;
  callId: string;
  timestamp: number;
}

/**
 * Worker 工具结果消息
 */
export interface WorkerToolResultMessage {
  type: 'tool_result';
  tool: string;
  callId: string;
  result: unknown;
  success: boolean;
  duration: number;
  timestamp: number;
}

/**
 * Worker 输出消息
 */
export interface WorkerOutputMessage {
  type: 'output';
  content: string;
  timestamp: number;
}

/**
 * Worker 错误消息
 */
export interface WorkerErrorMessage {
  type: 'error';
  error: string;
  code?: string;
  retryable: boolean;
  timestamp: number;
}

/**
 * Worker 状态消息
 */
export interface WorkerStatusMessage {
  type: 'status';
  status: WorkerStatus;
  progress?: number;
  timestamp: number;
}

/**
 * Worker 审批请求消息
 */
export interface WorkerApprovalRequestMessage {
  type: 'approval_request';
  requestId: string;
  action: string;
  description: string;
  details: Record<string, unknown>;
  timestamp: number;
}

/**
 * 统一的 Worker 消息类型
 */
export type WorkerMessage =
  | WorkerThinkingMessage
  | WorkerToolCallMessage
  | WorkerToolResultMessage
  | WorkerOutputMessage
  | WorkerErrorMessage
  | WorkerStatusMessage
  | WorkerApprovalRequestMessage;

// ============================================================================
// Worker 任务类型
// ============================================================================

/**
 * Worker 任务
 *
 * 继承 Task 并添加 Worker 特有字段
 */
export interface WorkerTask extends Task {
  /** 父任务 ID（如果是子任务） */
  parentTaskId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 优先级 */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** 复杂度 */
  complexity?: 'simple' | 'moderate' | 'complex';
}

// ============================================================================
// Worker 执行选项
// ============================================================================

/**
 * Worker 执行选项
 */
export interface WorkerExecutionOptions {
  /** 工作目录 */
  workDir?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 中断信号 */
  abortSignal?: AbortSignal;
  /** 重试策略 */
  retryPolicy?: RetryPolicy;
  /** 是否需要审批高风险操作 */
  requireApproval?: boolean;
  /** 审批回调 */
  onApprovalRequest?: (request: WorkerApprovalRequestMessage) => Promise<boolean>;
  /** 风险策略配置 */
  riskPolicy?: RiskPolicy;
  /** 资源限制 */
  resourceLimits?: ResourceLimits;
}

// ============================================================================
// 风险策略配置
// ============================================================================

/**
 * 风险策略配置
 *
 * 可配置的高风险操作检测策略
 */
export interface RiskPolicy {
  /** 高风险工具名称列表 */
  highRiskTools?: string[];
  /** 危险模式列表（在输入中检测） */
  dangerousPatterns?: string[];
  /** 自定义风险评估函数 */
  customEvaluator?: (toolName: string, input: unknown) => boolean;
}

/**
 * 默认风险策略
 */
export const DEFAULT_RISK_POLICY: Required<Pick<RiskPolicy, 'highRiskTools' | 'dangerousPatterns'>> = {
  highRiskTools: ['delete_file', 'rm', 'execute_shell', 'run_command', 'remove_directory'],
  dangerousPatterns: ['rm -rf', 'delete', 'drop database', 'truncate', 'format'],
};

// ============================================================================
// 资源限制配置
// ============================================================================

/**
 * 资源限制配置
 *
 * 防止 Token 消耗和执行时间失控
 */
export interface ResourceLimits {
  /** 最大 Token 预算（输入+输出总计） */
  maxTotalTokens?: number;
  /** 单次 LLM 调用最大 Token */
  maxTokensPerCall?: number;
  /** 最大消息窗口大小（保留最近 N 条消息） */
  maxMessageWindow?: number;
  /** 最大思考轮次 */
  maxThinkingRounds?: number;
  /** 最大工具调用次数 */
  maxToolCalls?: number;
}

/**
 * 默认资源限制
 */
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  maxTotalTokens: 500_000,     // 50万 Token 总预算
  maxTokensPerCall: 8_192,     // 单次最大 8K
  maxMessageWindow: 50,        // 保留最近 50 条消息
  maxThinkingRounds: 50,       // 最大 50 轮
  maxToolCalls: 100,           // 最大 100 次工具调用
};

// ============================================================================
// Worker 后端配置
// ============================================================================

/**
 * Worker 后端基础配置
 */
export interface WorkerBackendBaseConfig {
  /** LLM 提供商 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API Key */
  apiKey?: string;
  /** Base URL（用于自定义端点） */
  baseUrl?: string;
  /** 最大 Token 数 */
  maxTokens?: number;
  /** 温度参数 */
  temperature?: number;
}

/**
 * Claude Agent SDK 后端配置
 */
export interface ClaudeAgentSDKBackendConfig extends WorkerBackendBaseConfig {
  provider: 'anthropic';
  /** 是否使用 Agent SDK（默认 true） */
  useAgentSDK?: boolean;
  /** Claude Agent SDK 特有配置 */
  sdkOptions?: {
    /** 权限模式 */
    permissionMode?: 'default' | 'auto' | 'bypassPermissions';
    /** 额外目录 */
    additionalDirectories?: string[];
    /** 系统提示 */
    systemPrompt?: string;
  };
}

/**
 * 通用后端配置
 */
export interface GenericBackendConfig extends WorkerBackendBaseConfig {
  /** LLM 客户端实例 */
  llmClient?: LLMClient;
  /** 沙盒配置 */
  sandboxConfig?: Partial<SandboxConfig>;
  /** 沙盒实例 */
  sandbox?: Sandbox;
}

/**
 * Worker 后端配置
 */
export type WorkerBackendConfig = ClaudeAgentSDKBackendConfig | GenericBackendConfig;

// ============================================================================
// Worker 后端接口
// ============================================================================

/**
 * Worker 后端接口
 *
 * 统一的后端抽象，屏蔽 Claude Agent SDK 和通用后端的差异
 */
export interface IWorkerBackend {
  /** 提供商 */
  readonly provider: string;
  /** 后端类型 */
  readonly backendType: WorkerBackendType;

  /**
   * 执行任务
   *
   * @param task - Worker 任务
   * @param tools - 可用工具列表
   * @param options - 执行选项
   * @returns 异步消息流
   */
  execute(
    task: WorkerTask,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage>;

  /**
   * 获取后端支持的能力
   */
  getCapabilities(): WorkerCapability[];

  /**
   * 检查后端是否可用
   */
  isAvailable(): boolean;

  /**
   * 中断当前执行
   */
  interrupt(): Promise<void>;

  /**
   * 释放资源
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Worker 执行结果
// ============================================================================

/**
 * Worker 执行统计
 */
export interface WorkerExecutionMetrics {
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 持续时间（毫秒） */
  duration: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 成功的工具调用次数 */
  successfulToolCalls: number;
  /** 失败的工具调用次数 */
  failedToolCalls: number;
  /** 重试次数 */
  retryCount: number;
  /** Token 使用量 */
  tokensUsed: number;
  /** 思考轮次 */
  thinkingRounds: number;
}

/**
 * Worker 执行结果
 */
export interface WorkerExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 所有消息 */
  messages: WorkerMessage[];
  /** 执行统计 */
  metrics: WorkerExecutionMetrics;
  /** 错误信息（如果失败） */
  error?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 创建 Worker 消息
 */
export function createWorkerMessage<T extends WorkerMessage['type']>(
  type: T,
  data: Omit<Extract<WorkerMessage, { type: T }>, 'type' | 'timestamp'>
): Extract<WorkerMessage, { type: T }> {
  return {
    type,
    timestamp: Date.now(),
    ...data,
  } as Extract<WorkerMessage, { type: T }>;
}

/**
 * 判断是否为 Claude 提供商
 */
export function isClaudeProvider(config: WorkerBackendConfig): config is ClaudeAgentSDKBackendConfig {
  return config.provider.toLowerCase() === 'anthropic';
}

/**
 * 判断是否应该使用 Agent SDK
 */
export function shouldUseAgentSDK(config: WorkerBackendConfig): boolean {
  if (!isClaudeProvider(config)) {
    return false;
  }
  // 默认使用 Agent SDK（除非明确禁用）
  return config.useAgentSDK !== false;
}
