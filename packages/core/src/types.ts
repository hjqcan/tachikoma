/**
 * Tachikoma 核心类型定义
 *
 * 基于 PRD 6.3 核心接口定义
 */

// ============================================================================
// 导入工具相关类型
// ============================================================================
import type { ToolAnnotations, ToolLayer, ToolCategory } from './tools/types';

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
export type AgentType = 'orchestrator' | 'worker';

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
  /**
   * 中断当前执行（可选）
   *
   * 语义：仅触发当前任务的 AbortSignal，不做 stop/cleanup，不改变可复用性。
   * 对于不支持的实现可忽略。
   */
  interrupt?(): Promise<void>;
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
  /** 工作目录（初始值，只读） */
  workDir: string;
  /**
   * 当前有效工作目录（P1-A）
   *
   * 由 shell_run 等工具在执行 cd 命令后更新。
   * 后续工具调用应优先使用此字段而非 workDir。
   * 如未设置，默认回退到 workDir。
   */
  effectiveCwd?: string;
  /**
   * 更新有效工作目录的回调（P1-A）
   *
   * 工具在成功执行带 cwd 参数的命令后调用此回调。
   */
  updateCwd?: (newCwd: string) => void;
  /** 环境变量 */
  env: Record<string, string>;

  /**
   * 权限上下文（可选）
   * 
   * 控制工具可以执行的操作范围
   * 
   * **默认行为**（未提供时）:
   * - allowed: [] (空白名单，会在校验时使用宽松策略)
   * - denied: [] (无明确拒绝)
   * - requireSandbox: false (不强制沙盒)
   */
  permissions?: {
    /** 允许的权限列表 */
    allowed: string[];
    /** 明确拒绝的权限列表 */
    denied: string[];
    /** 是否强制要求沙盒执行 */
    requireSandbox: boolean;
  };

  /**
   * 资源限制（可选）
   * 
   * 防止工具消耗过多资源
   * 
   * **默认行为**（未提供时）:
   * - maxFileSize: 10MB
   * - maxOutputSize: 1MB
   * - maxExecutionTime: 30000ms (30秒)
   */
  resourceLimits?: {
    /** 最大文件大小（字节） */
    maxFileSize: number;
    /** 最大输出大小（字节） */
    maxOutputSize: number;
    /** 最大执行时间（毫秒） */
    maxExecutionTime: number;
  };
}

/**
 * 工具定义
 * 
 * 完全兼容 MCP (Model Context Protocol) 标准
 * 同时扩展 Tachikoma 特有功能
 */
export interface Tool {
  // ========== MCP 标准字段 ==========
  
  /** 工具名称（唯一标识符） */
  name: string;
  
  /**
   * 工具标题（可选）
   * 
   * 人类可读的工具名称，用于UI显示
   * 如果未提供，默认使用 name
   */
  title?: string;
  
  /** 工具描述 */
  description: string;
  
  /** 输入 Schema */
  inputSchema: JSONSchema;
  
  /**
   * 输出 Schema（可选）
   * 
   * 定义工具返回结果的结构
   * MCP 中为可选字段
   */
  outputSchema?: JSONSchema;
  
  /**
   * 工具注解（可选）
   * 
   * MCP 标准元数据：audience, priority, idempotent 等
   */
  annotations?: ToolAnnotations;

  // ========== Tachikoma 扩展字段 ==========
  
  /**
   * 权限声明（可选，建议填写）
   * 
   * 工具需要的权限列表，执行前会进行校验
   * 
   * **默认行为**（未声明时）:
   * - 视为"无特殊权限要求"
   * - 允许执行，但建议明确声明所需权限
   * - 工具迁移/过渡期间可以暂时不填，后续会强制要求
   * 
   * @example
   * ```ts
   * permissions: [ToolPermission.FileSystemRead, ToolPermission.FileSystemWrite]
   * ```
   */
  permissions?: string[];
  
  /**
   * 工具层级（可选，建议填写）
   * 
   * 指示工具所属的行为空间层级：
   * - Atomic: Layer 1 原子函数
   * - Sandbox: Layer 2 沙盒工具
   * - CodeExecution: Layer 3 代码执行/MCP
   * 
   * **默认行为**（未声明时）:
   * - 根据 isCommandBased 推断：true → Sandbox, false → Atomic
   * - 建议明确声明以避免歧义
   * 
   * @example
   * ```ts
   * layer: ToolLayer.Atomic
   * ```
   */
  layer?: ToolLayer;
  
  /**
   * 工具分类（可选）
   * 
   * 用于工具组织、查询和推荐
   */
  category?: ToolCategory;

  /**
   * 是否为命令型工具（可选，向后兼容）
   *
   * 命令型工具通过 sandbox.runCommand() 执行，提供真正的进程隔离
   * 高风险工具（如 delete, exec）必须设置此标记为 true
   *
   * ⚠️ 非命令型工具的 execute() 会在宿主进程中直接执行，无隔离
   * 
   * @deprecated 使用 layer 字段替代，保留用于向后兼容
   */
  isCommandBased?: boolean;

  /**
   * 动态判断调用是否有副作用（可选）
   * 
   * 允许工具根据具体输入参数判断是否为变更操作。
   * 这对于像 shell_run 这样的工具特别有用，可以识别只读命令（如 ls、cat）
   * 和变更命令（如 rm、mv）。
   * 
   * @param input - 工具输入参数
   * @param context - 执行上下文
   * @returns 返回 true 表示有副作用（可能需要审批），false 表示无副作用（可安全执行）
   *          未定义此方法时，使用静态规则判断
   * 
   * @example
   * ```ts
   * isMutating: (input) => {
   *   const cmd = (input as any).command?.toLowerCase();
   *   return !KNOWN_SAFE_COMMANDS.some(safe => cmd.startsWith(safe));
   * }
   * ```
   */
  isMutating?: (input: unknown, context: ExecutionContext) => boolean | Promise<boolean>;

  // ========== 执行方法 ==========
  
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
 * 对话上下文管理器接口（对外 API）
 *
 * 管理“对话消息 + 工具调用记录 + token 估算 + 压缩/摘要”。
 * 注意：这是会话/对话层的容器，不包含 prompt 级别的上下文工程策略。
 */
export interface ConversationContextManager {
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
export interface ConversationContextThresholds {
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
  /** 对话上下文阈值配置 */
  context: ConversationContextThresholds;
  /** 沙盒配置 */
  sandbox: SandboxConfig;
  /** AgentOps 配置 */
  agentops: AgentOpsConfig;
}
