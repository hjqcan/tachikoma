/**
 * Tachikoma 核心类型定义
 *
 * 基于 PRD 6.3 核心接口定义
 */

// ============================================================================
// JSON Schema 辅助类型
// ============================================================================

/**
 * JSON Schema 类型定义
 */
export type JSONSchema = Record<string, unknown>;

// ============================================================================
// 智能体相关类型
// ============================================================================

/**
 * 智能体类型
 */
export type AgentType = 'orchestrator' | 'worker' | 'planner' | 'memory';

/**
 * 智能体配置
 */
export interface AgentConfig {
  /** 模型提供商 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** 最大 Token 数 */
  maxTokens: number;
  /** 温度参数 */
  temperature?: number;
  /** 额外配置 */
  [key: string]: unknown;
}

/**
 * 智能体基础接口
 */
export interface Agent {
  /** 唯一标识符 */
  id: string;
  /** 智能体类型 */
  type: AgentType;
  /** 智能体配置 */
  config: AgentConfig;

  /** 执行任务 */
  run(task: Task): Promise<TaskResult>;
  /** 停止执行 */
  stop(): Promise<void>;
}

// ============================================================================
// 任务相关类型
// ============================================================================

/**
 * 任务类型
 */
export type TaskType = 'atomic' | 'composite';

/**
 * 任务优先级
 */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * 任务复杂度
 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex';

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'running' | 'success' | 'failure' | 'partial' | 'cancelled';

/**
 * 委托模式
 */
export type DelegationMode = 'communication' | 'shared-memory';

/**
 * 重试策略
 */
export interface RetryPolicy {
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔基数（毫秒） */
  baseDelay: number;
  /** 指数退避因子 */
  backoffFactor?: number;
  /** 最大延迟时间（毫秒） */
  maxDelay?: number;
}

/**
 * 委托配置
 */
export interface DelegationConfig {
  /** 委托模式 */
  mode: DelegationMode;
  /** 工作者数量 */
  workerCount: number;
  /** 超时时间（毫秒） */
  timeout: number;
  /** 重试策略 */
  retryPolicy: RetryPolicy;
}

/**
 * 任务上下文
 */
export interface TaskContext {
  /** 父任务 ID */
  parentTaskId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 追踪 ID */
  traceId?: string;
  /** 额外上下文数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 任务定义
 */
export interface Task {
  /** 唯一标识符 */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 任务目标 */
  objective: string;
  /** 约束条件 */
  constraints: string[];
  /** 输出 Schema */
  outputSchema?: JSONSchema;
  /** 任务上下文 */
  context?: TaskContext;
  /** 委托配置 */
  delegation?: DelegationConfig;
}

/**
 * 产出物
 */
export interface Artifact {
  /** 产出物 ID */
  id: string;
  /** 类型 */
  type: 'file' | 'code' | 'data' | 'log';
  /** 名称 */
  name: string;
  /** 内容或路径 */
  content: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 任务指标
 */
export interface TaskMetrics {
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 持续时间（毫秒） */
  duration: number;
  /** 消耗的 Token 数 */
  tokensUsed: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 重试次数 */
  retryCount: number;
}

/**
 * 追踪数据
 */
export interface TraceData {
  /** 追踪 ID */
  traceId: string;
  /** Span ID */
  spanId: string;
  /** 父 Span ID */
  parentSpanId?: string;
  /** 操作名称 */
  operation: string;
  /** 属性 */
  attributes: Record<string, unknown>;
  /** 事件列表 */
  events: TraceEvent[];
  /** 持续时间（毫秒） */
  duration: number;
}

/**
 * 追踪事件
 */
export interface TraceEvent {
  /** 事件名称 */
  name: string;
  /** 时间戳 */
  timestamp: number;
  /** 属性 */
  attributes?: Record<string, unknown>;
}

/**
 * 任务结果
 */
export interface TaskResult {
  /** 任务 ID */
  taskId: string;
  /** 状态 */
  status: 'success' | 'failure' | 'partial';
  /** 输出数据 */
  output: unknown;
  /** 产出物列表 */
  artifacts: Artifact[];
  /** 任务指标 */
  metrics: TaskMetrics;
  /** 追踪数据 */
  trace: TraceData;
}

// ============================================================================
// 工具相关类型
// ============================================================================

/**
 * 执行上下文
 */
export interface ExecutionContext {
  /** 任务 ID */
  taskId: string;
  /** 智能体 ID */
  agentId: string;
  /** 沙盒 ID */
  sandboxId?: string;
  /** 追踪 ID */
  traceId: string;
  /** 工作目录 */
  workDir: string;
  /** 环境变量 */
  env: Record<string, string>;
}

/**
 * 工具定义
 */
export interface Tool {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 输入 Schema */
  inputSchema: JSONSchema;
  /** 输出 Schema */
  outputSchema: JSONSchema;

  /** 执行工具 */
  execute(input: unknown, context: ExecutionContext): Promise<unknown>;
}

// ============================================================================
// 上下文管理相关类型
// ============================================================================

/**
 * 消息角色
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 消息
 */
export interface Message {
  /** 消息 ID */
  id: string;
  /** 角色 */
  role: MessageRole;
  /** 内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 工具调用（如果是工具消息） */
  toolCall?: ToolCallRecord;
}

/**
 * 工具调用记录
 */
export interface ToolCallRecord {
  /** 调用 ID */
  id: string;
  /** 工具名称 */
  tool: string;
  /** 输入 */
  input: {
    full: Record<string, unknown>;
    compact: Record<string, unknown>;
  };
  /** 输出 */
  output: {
    full: string;
    compact: string;
  };
  /** 时间戳 */
  timestamp: number;
}

/**
 * 压缩策略
 */
export type CompactionStrategy = 'aggressive' | 'balanced' | 'conservative';

/**
 * 摘要 Schema
 */
export interface SummarySchema {
  /** 包含修改的文件 */
  includeModifiedFiles: boolean;
  /** 包含用户目标 */
  includeUserGoal: boolean;
  /** 包含关键决策 */
  includeKeyDecisions: boolean;
  /** 包含未解决问题 */
  includeUnresolvedIssues: boolean;
  /** 包含下一步计划 */
  includeNextSteps: boolean;
}

/**
 * 对话摘要
 */
export interface ConversationSummary {
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 用户目标 */
  userGoal: string;
  /** 上次停止点 */
  lastStopPoint: string;
  /** 关键决策 */
  keyDecisions: string[];
  /** 未解决的问题 */
  unresolvedIssues: string[];
  /** 下一步计划 */
  nextSteps: string[];
}

/**
 * 对话上下文
 */
export interface ConversationContext {
  /** 会话 ID */
  sessionId: string;
  /** 消息列表 */
  messages: Message[];
  /** 工具调用记录 */
  toolCalls: ToolCallRecord[];
  /** Token 使用量 */
  tokenCount: number;
  /** 摘要（如果已生成） */
  summary?: ConversationSummary;
}

/**
 * 上下文管理器接口
 */
export interface ContextManager {
  /** 获取当前上下文 */
  getContext(): ConversationContext;
  /** 添加消息 */
  addMessage(message: Message): void;
  /** 执行压缩 */
  compact(strategy: CompactionStrategy): void;
  /** 生成摘要 */
  summarize(schema: SummarySchema): ConversationSummary;
  /** 获取 Token 数量 */
  getTokenCount(): number;
}

// ============================================================================
// 沙盒相关类型
// ============================================================================

/**
 * 沙盒状态
 */
export type SandboxStatus = 'creating' | 'running' | 'stopped' | 'error';

/**
 * 执行选项
 */
export interface ExecutionOptions {
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 执行时间（毫秒） */
  duration: number;
}

/**
 * 命令执行结果
 */
export interface CommandResult extends ExecutionResult {
  /** 执行的命令 */
  command: string;
}

/**
 * 沙盒接口
 */
export interface Sandbox {
  /** 沙盒 ID */
  id: string;
  /** 状态 */
  status: SandboxStatus;

  /** 执行代码 */
  execute(code: string, options?: ExecutionOptions): Promise<ExecutionResult>;
  /** 写入文件 */
  writeFile(path: string, content: string): Promise<void>;
  /** 读取文件 */
  readFile(path: string): Promise<string>;
  /** 运行命令 */
  runCommand(command: string): Promise<CommandResult>;
  /** 销毁沙盒 */
  destroy(): Promise<void>;
}

// ============================================================================
// 配置相关类型
// ============================================================================

/**
 * 模型配置
 */
export interface ModelConfig {
  /** 提供商 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** 最大 Token 数 */
  maxTokens: number;
}

/**
 * 上下文阈值配置
 */
export interface ContextThresholds {
  /** 硬性上限 */
  hardLimit: number;
  /** 腐烂前阈值 */
  rotThreshold: number;
  /** 压缩触发阈值 */
  compactionTrigger: number;
  /** 摘要触发阈值 */
  summarizationTrigger: number;
  /** 保留的最近工具调用数 */
  preserveRecentToolCalls: number;
}

/**
 * 沙盒资源配置
 */
export interface SandboxResources {
  /** CPU 核心数 */
  cpu: string;
  /** 内存限制 */
  memory: string;
  /** 存储限制 */
  storage: string;
}

/**
 * 网络模式
 */
export type NetworkMode = 'none' | 'restricted' | 'full';

/**
 * 沙盒网络配置
 */
export interface SandboxNetworkConfig {
  /** 网络模式 */
  mode: NetworkMode;
  /** 允许列表 */
  allowlist: string[];
}

/**
 * 沙盒配置
 */
export interface SandboxConfig {
  /** 运行时 */
  runtime: string;
  /** 超时时间（毫秒） */
  timeout: number;
  /** 资源配置 */
  resources: SandboxResources;
  /** 网络配置 */
  network: SandboxNetworkConfig;
}

/**
 * AgentOps 追踪配置
 */
export interface TracingConfig {
  /** 是否启用 */
  enabled: boolean;
  /** OTLP 端点 */
  endpoint: string;
  /** 服务名称 */
  serviceName: string;
}

/**
 * 日志级别
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 日志格式
 */
export type LogFormat = 'json' | 'text';

/**
 * 日志配置
 */
export interface LoggingConfig {
  /** 日志级别 */
  level: LogLevel;
  /** 日志格式 */
  format: LogFormat;
}

/**
 * 指标配置
 */
export interface MetricsConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 端点路径 */
  endpoint: string;
}

/**
 * AgentOps 配置
 */
export interface AgentOpsConfig {
  /** 追踪配置 */
  tracing: TracingConfig;
  /** 日志配置 */
  logging: LoggingConfig;
  /** 指标配置 */
  metrics: MetricsConfig;
}

/**
 * 完整配置
 */
export interface Config {
  /** 模型配置 */
  models: {
    orchestrator: ModelConfig;
    worker: ModelConfig;
    planner: ModelConfig;
  };
  /** 上下文配置 */
  context: ContextThresholds;
  /** 沙盒配置 */
  sandbox: SandboxConfig;
  /** AgentOps 配置 */
  agentops: AgentOpsConfig;
}
