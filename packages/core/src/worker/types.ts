/**
 * Worker 模块类型定义
 *
 * 定义 Worker Backend 统一接口、消息类型和配置
 */

import type { Task, Tool, RetryPolicy } from '../types';
import type { Sandbox, SandboxConfig } from '../sandbox';
import type { SandboxSecurityPolicy } from '../sandbox/tool-executor';
import type { LLMClient } from '../planner/types';
import type { InterventionFile } from '../orchestrator/session/types';
import type { PromptContextConfig } from '../prompt';
import type { SkillDiscoveryConfig } from '../skills';
import type { MemoryConfig } from '../memory';

// Re-export for external use
export type { InterventionFile };

// ============================================================================
// Worker 后端类型
// ============================================================================

/**
 * Worker 后端类型
 */
export type WorkerBackendType = 'agent-sdk' | 'generic';

/**
 * Worker 后端选择
 *
 * 显式选择使用哪个后端实现：
 * - 'auto': 根据 provider 自动选择最佳后端
 * - 'generic': 强制使用通用后端（支持所有 LLM）
 * - 'claude-agent-sdk': 使用 Claude Agent SDK（仅 Anthropic）
 * - 'openai-agents': 使用 OpenAI Agents SDK（仅 OpenAI）
 */
export type WorkerBackend = 'auto' | 'generic' | 'claude-agent-sdk' | 'openai-agents';

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
  /** 可选：累计 token 使用量，用于指标收集 */
  tokensUsed?: number;
  timestamp: number;
}

/**
 * 审批请求类别
 */
export type ApprovalCategory =
  | 'key_decision'       // 关键决策点
  | 'high_risk_tool'     // 高风险工具
  | 'dangerous_pattern'  // 危险模式
  | 'file_modify'        // 文件修改（用于 Orchestrator 仲裁：文件锁/串行化）
  | 'file_create'        // 文件创建
  | 'file_delete'        // 文件删除
  | 'multi_file_refactor' // 多文件重构
  | 'external_api_call'  // 外部 API 调用
  | 'dangerous_operation' // 危险操作
  | 'resource_intensive' // 资源密集型操作
  | 'custom';            // 自定义

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
  /** 审批类别 */
  category?: ApprovalCategory;
  /** 超时后默认决策 */
  defaultDecision?: 'approve' | 'reject';
  /** 审批超时时间（毫秒） */
  timeout?: number;
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
  /** 
   * 父任务目标（用于技能匹配上下文传递）
   * 
   * 继承父任务的领域关键词，确保技能激活机制能正确命中相关技能
   */
  parentObjective?: string;
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
  /** 审批回调（优先级高于文件协议） */
  onApprovalRequest?: (request: WorkerApprovalRequestMessage) => Promise<boolean>;
  /** 风险策略配置 */
  riskPolicy?: RiskPolicy;
  /** 资源限制 */
  resourceLimits?: ResourceLimits;
  /**
   * Sandbox 安全策略
   *
   * 用于控制工具执行的隔离级别
   */
  securityPolicy?: SandboxSecurityPolicy;
  /** 关键决策策略 */
  keyDecisionPolicy?: KeyDecisionPolicy;
  /**
   * Intervention 检查回调
   * 返回 InterventionFile 如果有干预，否则 null
   */
  onCheckIntervention?: () => Promise<InterventionFile | null>;
  /**
   * Intervention 确认回调
   */
  onAcknowledgeIntervention?: (interventionId: string) => Promise<void>;

  // === 审批文件协议回调 ===

  /**
   * 写入待审批请求文件
   * 用于基于 SessionFileManager 的审批流程
   */
  onWritePendingApproval?: (approval: PendingApprovalInput) => Promise<void>;

  /**
   * 读取审批响应文件
   * 返回 ApprovalResponseResult 如果有响应，否则 null
   */
  onReadApprovalResponse?: () => Promise<ApprovalResponseResult | null>;

  /**
   * 清除待审批请求文件（审批完成后）
   */
  onClearPendingApproval?: () => Promise<void>;

  // === 安全策略 ===

  /**
   * 未知工具策略
   * - 'approve': 默认批准未知工具
   * - 'reject': 默认拒绝未知工具
   * - 'require_approval': 未知工具需要审批
   */
  unknownToolPolicy?: 'approve' | 'reject' | 'require_approval';

  /**
   * 是否要求 Sandbox 必须可用
   * 如果为 true 且 Sandbox 初始化失败，将拒绝执行高风险工具
   */
  strictSandboxRequired?: boolean;

  // === 并行执行配置 (FAS) ===

  /**
   * 并行执行配置
   * 
   * 控制工具调用的并行执行行为，可显著降低执行延迟
   * 默认关闭，需显式启用
   * 
   * @see https://www.relace.ai/blog/fast-agentic-search
   */
  parallelExecution?: ParallelExecutionConfig;
}

/**
 * 待审批请求输入（简化版，不含自动生成字段）
 */
export interface PendingApprovalInput {
  requestId: string;
  subtaskId: string;
  type: 'file_deletion' | 'multi_file_refactor' | 'external_api_call' | 'dangerous_operation' | 'resource_intensive';
  description: string;
  details: {
    affectedFiles?: string[];
    impactScope?: 'low' | 'medium' | 'high';
    reversible?: boolean;
    metadata?: Record<string, unknown>;
  };
  timeout: number;
  defaultDecision: 'approve' | 'reject';
}

/**
 * 审批响应结果
 */
export interface ApprovalResponseResult {
  requestId: string;
  approved: boolean;
  reason?: string;
  instructions?: string;
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
  /** 最大工具输入大小（字节） */
  maxToolInputBytes?: number;
}

/**
 * 默认资源限制
 */
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  maxTotalTokens: 990_000,     // 99万 Token 总预算
  maxTokensPerCall: 8_192,     // 单次最大 8K
  maxMessageWindow: 50,        // 保留最近 50 条消息
  maxThinkingRounds: 50,       // 最大 50 轮
  maxToolCalls: 100,           // 最大 100 次工具调用
  maxToolInputBytes: 100 * 1024, // 单次工具输入最大 100KB
};

// ============================================================================
// 并行执行配置 (FAS: Fast Agentic Search)
// ============================================================================

/**
 * 可并行执行的工具列表（无副作用、只读操作）
 * 
 * 这些工具可以安全地并行执行，不会相互干扰：
 * - file_read: 文件读取
 * - code_search: 代码搜索
 * - file_list: 目录列表
 * - web_search: 网页搜索
 * - knowledge_search: 知识库搜索
 * - deep_research: 深度研究
 */
export const PARALLELIZABLE_TOOLS: readonly string[] = [
  'file_read',
  'code_search', 
  'file_list',
  'web_search',
  'knowledge_search',
  'deep_research',
  'grep_search',
  'view_file',
  'list_directory',
] as const;

/**
 * 并行执行配置
 * 
 * 控制工具调用的并行执行行为，可显著降低执行延迟
 * 
 * @see https://www.relace.ai/blog/fast-agentic-search
 */
export interface ParallelExecutionConfig {
  /**
   * 是否启用并行执行
   * @default false
   */
  enabled: boolean;
  
  /**
   * 最大并发数
   * FAS 论文建议 4-12，过高可能导致资源竞争
   * @default 6
   */
  maxConcurrency: number;
  
  /**
   * 需要顺序执行的工具（排除列表）
   * 这些工具有副作用或依赖其他工具结果，必须顺序执行
   */
  excludeTools: string[];
  
  /**
   * 并行工具白名单（可选）
   * 如果提供，只有在此列表中的工具才能并行执行
   * 默认使用 PARALLELIZABLE_TOOLS
   */
  parallelizableTools?: string[];
}

/**
 * 需要顺序执行的工具（有副作用）
 */
export const SEQUENTIAL_TOOLS: readonly string[] = [
  'file_write',
  'file_patch',
  'shell_run',
  'run_command',
  'spawn_subagent',
  'submit_result',
  'delete_file',
  'create_directory',
] as const;

/**
 * 默认并行执行配置
 */
export const DEFAULT_PARALLEL_EXECUTION_CONFIG: ParallelExecutionConfig = {
  enabled: false,               // 默认关闭，需显式启用
  maxConcurrency: 6,            // FAS 建议值
  excludeTools: [...SEQUENTIAL_TOOLS],
  parallelizableTools: [...PARALLELIZABLE_TOOLS],
};

// ============================================================================
// 关键决策策略
// ============================================================================

/**
 * 关键决策触发条件
 */
export interface KeyDecisionTriggers {
  /** 大文件修改阈值（行数），默认 100 */
  maxLinesThreshold?: number;
  /** 多文件操作阈值，默认 3 */
  multiFileThreshold?: number;
  /** 检测外部 API 调用 */
  detectExternalApi?: boolean;
  /** 检测不可逆操作 */
  detectIrreversible?: boolean;
}

/**
 * 关键决策策略配置
 */
export interface KeyDecisionPolicy {
  /** 启用关键决策检测 */
  enabled?: boolean;
  /** 审批超时时间（毫秒），默认 5 分钟 */
  approvalTimeout?: number;
  /** 超时后默认决策，默认 reject */
  defaultDecision?: 'approve' | 'reject';
  /** 触发关键决策的条件 */
  triggers?: KeyDecisionTriggers;
}

/**
 * 默认关键决策触发条件
 */
export const DEFAULT_KEY_DECISION_TRIGGERS: Required<KeyDecisionTriggers> = {
  maxLinesThreshold: 100,
  multiFileThreshold: 3,
  detectExternalApi: true,
  detectIrreversible: true,
};

/**
 * 默认关键决策策略
 */
export const DEFAULT_KEY_DECISION_POLICY: Required<Omit<KeyDecisionPolicy, 'triggers'>> & { triggers: Required<KeyDecisionTriggers> } = {
  enabled: true,
  approvalTimeout: 300_000, // 5 分钟
  defaultDecision: 'reject',
  triggers: DEFAULT_KEY_DECISION_TRIGGERS,
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
  /**
   * 显式后端选择
   *
   * 优先级: backend 显式 > provider 默认 > generic 兜底
   * - 'auto': 根据 provider 自动选择最佳后端（默认）
   * - 'generic': 强制使用通用后端
   * - 'claude-agent-sdk': 使用 Claude Agent SDK（仅 Anthropic）
   * - 'openai-agents': 使用 OpenAI Agents SDK（OpenAI 及兼容 API）
   */
  backend?: WorkerBackend;
  /**
   * OpenAI API 兼容性标记
   *
   * 设为 true 表示该 provider 使用 OpenAI API 格式（如 OpenRouter、自建端点）
   * 启用后将优先使用 OpenAI Agents SDK 后端
   */
  openaiCompatible?: boolean;
  /**
   * Skills 发现配置
   *
   * 如果提供，将在启动时加载 Skills 并注入到 system prompt
   */
  skillsConfig?: SkillDiscoveryConfig;

  /**
   * Agent Identity 配置
   *
   * - 默认启用（即：未配置时也会尝试读取 identity 并注入 coreMemory；identity 不存在则跳过）
   * - 可通过 `enabled:false` 显式关闭
   * - 可通过 `agentsDir` 指定 identity 存储目录（用于测试或自定义）
   */
  identityConfig?: {
    /** 是否启用 Identity（默认 true） */
    enabled?: boolean;
    /** Agent ID（默认从环境变量或 'default'） */
    agentId?: string;
    /** Agents 目录（默认 ~/.tachikoma/agents） */
    agentsDir?: string;
    /** Identity 文件最大大小（字节，默认 100KB） */
    maxFileSize?: number;
  };
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
  /**
   * Memory 系统配置
   *
   * 如果提供，将支持跨会话记忆和自动检索/保存
   */
  memoryConfig?: MemoryConfig;
}

/**
 * 协作集成配置
 *
 * 用于在 Worker 中启用 Multi-Agent 协作功能
 */
export interface CollaborationIntegrationConfig {
  /** 是否启用协作 */
  enabled: boolean;
  /** Agent ID（必须唯一） */
  agentId?: string;
  /** Session ID */
  sessionId?: string;
  /** Agent 能力列表 */
  capabilities?: string[];
  /** Agent 优先级（0-10） */
  priority?: number;
  /** 协作后端类型 */
  backend?: 'file' | 'redis';
  /** 协作根目录（file 后端使用） */
  rootDir?: string;
  /** Redis 配置（redis 后端使用） */
  redis?: { url: string; prefix?: string };
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
  /** 工作目录（用于上下文卸载等） */
  workDir?: string;
  /**
   * Prompt 上下文工程配置（内部能力）
   *
   * 如果提供，将配置 PromptContextEngine 的阈值、压缩策略等
   * 支持自动压缩/摘要、KV 缓存优化和笔记系统
   */
  promptConfig?: PromptContextConfig;
  /**
   * Memory 系统配置
   *
   * 如果提供，将支持跨会话记忆和自动检索
   */
  memoryConfig?: MemoryConfig;
  /**
   * 协作配置
   *
   * 如果提供，将启用 Multi-Agent 协作功能
   * 会自动注入 request_peer_assist 工具
   */
  collaborationConfig?: CollaborationIntegrationConfig;
}

/**
 * OpenAI Agents SDK 后端配置
 *
 * 使用 @openai/agents 实现，获得 OpenAI 官方 Agent 运行时能力
 */
export interface OpenAIAgentsBackendConfig extends WorkerBackendBaseConfig {
  provider: 'openai';
  /**
   * Memory 系统配置
   *
   * 如果提供，将支持跨会话记忆和自动检索/保存
   */
  memoryConfig?: MemoryConfig;
}

/**
 * Worker 后端配置
 */
export type WorkerBackendConfig = ClaudeAgentSDKBackendConfig | GenericBackendConfig | OpenAIAgentsBackendConfig;

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
 * 判断是否应该使用 Claude Agent SDK
 *
 * 条件（按优先级）：
 * 1. backend 显式指定为 'claude-agent-sdk'
 * 2. provider = 'anthropic' 且 backend != 'generic' 且 useAgentSDK != false
 */
export function shouldUseAgentSDK(config: WorkerBackendConfig): boolean {
  // 显式指定使用 Claude Agent SDK
  if (config.backend === 'claude-agent-sdk') {
    return true;
  }
  // 显式指定使用其他后端
  if (config.backend && config.backend !== 'auto') {
    return false;
  }
  // 自动模式：Anthropic provider 且未禁用
  if (!isClaudeProvider(config)) {
    return false;
  }
  // 默认使用 Agent SDK（除非明确禁用）
  return config.useAgentSDK !== false;
}

/**
 * 判断是否为 OpenAI 提供商
 */
export function isOpenAIProvider(config: WorkerBackendConfig): config is OpenAIAgentsBackendConfig {
  return config.provider.toLowerCase() === 'openai';
}

/**
 * 判断是否应该使用 OpenAI Agents SDK
 *
 * 条件（按优先级）：
 * 1. backend 显式指定为 'openai-agents'
 * 2. openaiCompatible = true 且 backend != 'generic'
 * 3. provider = 'openai' 且 backend != 'generic'
 */
export function shouldUseOpenAIAgents(config: WorkerBackendConfig): boolean {
  // 1. 显式指定使用 OpenAI Agents SDK
  if (config.backend === 'openai-agents') {
    return true;
  }
  // 2. 显式指定使用 generic 或 Claude SDK，不使用 OpenAI
  if (config.backend === 'generic' || config.backend === 'claude-agent-sdk') {
    return false;
  }
  // 3. openaiCompatible 标记：优先级高于 provider 检测
  if (config.openaiCompatible) {
    return true;
  }
  // 4. provider = 'openai' 且 backend = 'auto' 或未指定
  if (isOpenAIProvider(config)) {
    return config.backend === 'auto' || config.backend === undefined;
  }
  return false;
}