/**
 * 统筹者智能体与规划相关类型定义
 *
 * 基于 PRD 3.3 Layer 2: 统筹与规划层 (System 2 / Slow Thinking)
 */

import type {
  Task,
  TaskResult,
  TaskPriority,
  TaskComplexity,
  DelegationConfig,
  DelegationMode,
  RetryPolicy,
  JSONSchema,
  AgentConfig,
  Agent,
} from '../types';
import type { MemoryConfig } from '../memory';

// ============================================================================
// 统筹者任务类型
// ============================================================================

/**
 * 统筹者任务 - 继承自基础 Task，添加优先级和复杂度
 */
export interface OrchestratorTask extends Task {
  /** 任务优先级 */
  priority: TaskPriority;
  /** 任务复杂度 */
  complexity: TaskComplexity;
  /** 子任务列表（分解后填充） */
  subtasks?: SubTask[];
  /** 计划状态 */
  planStatus?: PlanStatus;
}

/**
 * 子任务定义
 */
export interface SubTask {
  /** 子任务 ID */
  id: string;
  /** 父任务 ID */
  parentId: string;
  /** 子任务目标 */
  objective: string;
  /** 约束条件 */
  constraints: string[];
  /**
   * 期望的执行角色（可选）
   *
   * 由 Planner 在“角色化规划”时生成，Orchestrator/WorkerPool 可据此路由到对应 Worker。
   */
  roleId?: string;
  /**
   * 需要的能力标签（可选）
   *
   * WorkerPool 在分配时会基于 capabilities 过滤可用 Worker。
   * 建议使用稳定的能力字符串（如 "role:frontend" / "frontend" 等）。
   */
  requiredCapabilities?: string[];
  /** 预期输出 Schema */
  outputSchema?: JSONSchema;
  /** 预估执行时间（毫秒） */
  estimatedDuration?: number;
  /** 优先级（继承或覆盖） */
  priority?: TaskPriority;
  /** 依赖的其他子任务 ID */
  dependencies?: string[];
  /** 执行状态 */
  status: SubTaskStatus;
  /** 分配给的 Worker ID */
  assignedWorkerId?: string;
  /** 执行结果 */
  result?: TaskResult;
}

/**
 * Planner 生成的角色定义（每个角色对应一个 Worker）
 */
export interface PlannerRole {
  /** 角色 ID（稳定标识，用于 subtask.roleId 引用） */
  id: string;
  /** 角色名称（如 产品经理/前端/后端/测试 等） */
  name: string;
  /** 角色职责（简短，可作为约束注入到 Worker） */
  responsibilities: string;
  /** 能力标签（用于 WorkerPool capability 过滤） */
  capabilities: string[];
}

/**
 * 任务入口评估（开始执行前的“是否需要澄清”）
 */
export interface TaskIntakeAssessment {
  /** 是否已具备开始执行的必要信息 */
  ready: boolean;
  /** 识别到的用户意图（可选，启发式/模型推断） */
  userIntent?: string;
  /** 情绪/语气（可选，启发式/模型推断） */
  sentiment?: string;
  /** 缺失信息点（ready=false 时常用） */
  missingInfo?: string[];
  /** 需要向用户澄清的问题（ready=false 时常用） */
  questions?: string[];
  /** 建议的角色集合（ready=true 时常用；每个角色≈一个 worker） */
  roles?: PlannerRole[];
}

/**
 * 子任务状态
 */
export type SubTaskStatus =
  | 'pending' // 等待执行
  | 'assigned' // 已分配给 Worker
  | 'running' // 执行中
  | 'success' // 成功完成
  | 'failure' // 执行失败
  | 'retrying' // 重试中
  | 'cancelled'; // 已取消

/**
 * 计划状态
 */
export type PlanStatus =
  | 'draft' // 草稿
  | 'planning' // 规划中
  | 'ready' // 规划完成，准备执行
  | 'executing' // 执行中
  | 'completed' // 全部完成
  | 'failed' // 执行失败
  | 'partial'; // 部分完成

// ============================================================================
// 规划器类型
// ============================================================================

/**
 * 规划器输入
 */
export interface PlannerInput {
  /** 原始任务 */
  task: OrchestratorTask;
  /** 可用工具列表 */
  availableTools?: string[];
  /** 上下文约束 */
  contextConstraints?: ContextConstraints;
  /** 最大子任务数量 */
  maxSubtasks?: number;
  /** 用户偏好 */
  preferences?: PlannerPreferences;
}

/**
 * 上下文约束
 */
export interface ContextConstraints {
  /** 最大 Token 预算 */
  maxTokenBudget?: number;
  /** 最大执行时间（毫秒） */
  maxExecutionTime?: number;
  /** 禁止使用的工具 */
  disallowedTools?: string[];
  /** 必须使用的工具 */
  requiredTools?: string[];
}

/**
 * 规划器偏好
 */
export interface PlannerPreferences {
  /** 是否倾向并行执行 */
  preferParallel?: boolean;
  /** 是否启用详细日志 */
  verboseLogging?: boolean;
  /** 是否启用保守模式（更少的子任务） */
  conservativeMode?: boolean;
}

/**
 * 规划器输出
 */
export interface PlannerOutput {
  /** 任务 ID */
  taskId: string;
  /** 生成的子任务列表 */
  subtasks: SubTask[];
  /** 委托配置 */
  delegation: DelegationConfig;
  /** 执行计划（子任务执行顺序） */
  executionPlan: ExecutionPlan;
  /** 任务入口评估（可选：用于澄清/角色化 worker） */
  intake?: TaskIntakeAssessment;
  /** 角色列表（可选：每个角色对应一个 Worker） */
  roles?: PlannerRole[];
  /** 规划依据（简要说明） */
  reasoning?: string | undefined;
  /** 预估总执行时间 */
  estimatedTotalDuration?: number | undefined;
  /** 预估 Token 消耗 */
  estimatedTokens?: number | undefined;
}

/**
 * 执行计划 - 定义子任务的执行顺序和并行关系
 */
export interface ExecutionPlan {
  /** 执行步骤列表 */
  steps: ExecutionStep[];
  /** 是否可并行 */
  isParallel: boolean;
  /** 关键路径（最长执行路径上的子任务 ID） */
  criticalPath?: string[];
}

/**
 * 执行步骤
 */
export interface ExecutionStep {
  /** 步骤序号 */
  order: number;
  /** 该步骤包含的子任务 ID（同一步骤可并行执行） */
  subtaskIds: string[];
  /** 该步骤是否可并行执行 */
  parallel: boolean;
}

// ============================================================================
// Worker 池类型
// ============================================================================

/**
 * Worker 信息
 */
export interface WorkerInfo {
  /** Worker ID */
  id: string;
  /** Worker 状态 */
  status: WorkerStatus;
  /** 当前执行的子任务 ID */
  currentTaskId?: string | undefined;
  /** 负载指标 */
  load?: WorkerLoad;
  /** 能力标签（可执行的任务类型） */
  capabilities?: string[];
  /**
   * Worker 优先级（用于协作路由，数值越大优先级越高，默认 5）
   */
  priority?: number;
  /**
   * 绑定的 WorkerAgent（或兼容 Agent）
   *
   * 说明：WorkerPool “管理 + 调度”，执行由绑定的 Agent 负责。
   */
  agent?: Agent;
  /** 上次心跳时间 */
  lastHeartbeat?: number;
}

/**
 * Worker 状态
 */
export type WorkerStatus =
  | 'idle' // 空闲
  | 'busy' // 忙碌
  | 'draining' // 排空中（不接受新任务）
  | 'offline'; // 离线

/**
 * Worker 负载
 */
export interface WorkerLoad {
  /** CPU 使用率（0-100） */
  cpu?: number;
  /** 内存使用率（0-100） */
  memory?: number;
  /** 队列中的任务数 */
  queuedTasks?: number;
}

/**
 * Worker 池配置
 */
export interface WorkerPoolConfig {
  /** 最小 Worker 数量 */
  minWorkers: number;
  /** 最大 Worker 数量 */
  maxWorkers: number;
  /** Worker 空闲超时（毫秒） */
  idleTimeout: number;
  /** Worker 健康检查间隔（毫秒） */
  healthCheckInterval: number;
  /** Worker 选择策略 */
  selectionStrategy: WorkerSelectionStrategy;
  /**
   * 是否启用降级路由（默认 true）
   *
   * 当角色专用 Worker 不可用时，回退到任意空闲 Worker
   */
  fallbackToGeneral?: boolean;
  /**
   * 等待队列超时（毫秒，默认 0 = 不等待）
   *
   * 当没有可用 Worker 时，任务可以排队等待直到超时
   */
  waitQueueTimeout?: number;
  /**
   * 等待队列轮询间隔（毫秒，默认 500）
   */
  waitQueuePollInterval?: number;
}

/**
 * Worker 选择策略
 */
export type WorkerSelectionStrategy =
  | 'round-robin' // 轮询
  | 'least-loaded' // 最少负载
  | 'random' // 随机
  | 'capability-match'; // 能力匹配

// ============================================================================
// 委托与通信类型
// ============================================================================

/**
 * Worker 消息类型
 */
export type WorkerMessageType =
  | 'assign' // 分配任务
  | 'progress' // 进度更新
  | 'complete' // 任务完成
  | 'error' // 错误报告
  | 'cancel' // 取消任务
  | 'heartbeat'; // 心跳

/**
 * Worker 消息
 */
export interface WorkerMessage<T = unknown> {
  /** 消息 ID */
  id: string;
  /** 消息类型 */
  type: WorkerMessageType;
  /** 发送者 ID */
  senderId: string;
  /** 接收者 ID */
  receiverId: string;
  /** 相关任务 ID */
  taskId?: string;
  /** 消息负载 */
  payload: T;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 任务分配负载
 */
export interface AssignPayload {
  /** 子任务 */
  subtask: SubTask;
  /** 超时时间 */
  timeout: number;
  /** 重试策略 */
  retryPolicy: RetryPolicy;
  /** 执行上下文 */
  context?: Record<string, unknown>;
}

/**
 * 进度更新负载
 */
export interface ProgressPayload {
  /** 进度百分比（0-100） */
  progress: number;
  /** 当前阶段描述 */
  stage?: string;
  /** 附加信息 */
  details?: string;
}

/**
 * 完成负载
 */
export interface CompletePayload {
  /** 任务结果 */
  result: TaskResult;
}

/**
 * 错误负载
 */
export interface ErrorPayload {
  /** 错误代码 */
  code: string;
  /** 错误消息 */
  message: string;
  /** 是否可重试 */
  retryable: boolean;
  /** 错误堆栈 */
  stack?: string;
}

// ============================================================================
// 结果聚合类型
// ============================================================================

/**
 * 聚合策略
 */
export type AggregationStrategy =
  | 'merge' // 合并所有结果
  | 'select-best' // 选择最佳结果
  | 'vote' // 投票
  | 'custom'; // 自定义

/**
 * 聚合配置
 */
export interface AggregationConfig {
  /** 聚合策略 */
  strategy: AggregationStrategy;
  /** 是否允许部分成功 */
  allowPartialSuccess: boolean;
  /** 部分成功的最低成功率 */
  partialSuccessThreshold?: number;
  /** 自定义聚合函数（当 strategy 为 custom 时使用） */
  customAggregator?: (results: TaskResult[]) => TaskResult;
}

/**
 * 聚合结果
 */
export interface AggregatedResult {
  /** 最终状态 */
  status: 'success' | 'failure' | 'partial';
  /** 聚合后的输出 */
  output: unknown;
  /** 各子任务结果 */
  subtaskResults: Map<string, TaskResult>;
  /** 成功数量 */
  successCount: number;
  /** 失败数量 */
  failureCount: number;
  /** 聚合元数据 */
  metadata?: {
    /** 总执行时间 */
    totalDuration: number;
    /** 总 Token 消耗 */
    totalTokens: number;
    /** 重试次数 */
    totalRetries: number;
  };
}

// ============================================================================
// 检查点与恢复类型
// ============================================================================

/**
 * 检查点状态
 */
export interface CheckpointState {
  /** 检查点 ID */
  id: string;
  /** 任务 ID */
  taskId: string;
  /** 创建时间 */
  createdAt: number;
  /** 检查点版本 */
  version: number;
  /** 当前计划状态 */
  planStatus: PlanStatus;
  /** 子任务状态快照 */
  subtaskSnapshots: SubTaskSnapshot[];
  /** 已完成的子任务结果 */
  completedResults: Map<string, TaskResult> | Record<string, TaskResult>;
  /** 重试计数 */
  retryCount: number;
  /** 上下文数据 */
  contextData?: Record<string, unknown>;
  /** Git 提交点（可选） */
  gitCommit?: string;
}

/**
 * 子任务快照
 */
export interface SubTaskSnapshot {
  /** 子任务 ID */
  id: string;
  /** 状态 */
  status: SubTaskStatus;
  /** 分配的 Worker ID */
  assignedWorkerId?: string;
  /** 重试次数 */
  retries: number;
}

/**
 * 检查点管理器配置
 */
export interface CheckpointConfig {
  /** 是否启用检查点 */
  enabled: boolean;
  /** 检查点存储目录 */
  storageDir: string;
  /** 检查点间隔（毫秒），0 表示仅在关键节点创建 */
  interval: number;
  /** 最大保留检查点数 */
  maxCheckpoints: number;
  /** 是否启用 Git 集成 */
  gitIntegration: boolean;
}

/**
 * 长时任务初始化文件
 */
export interface LongRunningTaskFiles {
  /** 功能需求列表 */
  featuresFile: string;
  /** 初始化脚本 */
  initScript: string;
  /** 进度日志 */
  progressLog: string;
}

// ============================================================================
// Orchestrator 配置类型
// ============================================================================

/**
 * 审批请求类型（从 session/types 复用）
 */
export type ApprovalRequestType =
  | 'file_deletion'       // 文件删除
  | 'multi_file_refactor' // 多文件重构
  | 'external_api_call'   // 外部 API 调用
  | 'dangerous_operation' // 危险操作
  | 'resource_intensive'; // 资源密集型操作

/**
 * 审批策略配置
 *
 * 定义 Orchestrator 如何处理 Worker 的审批请求
 */
export interface ApprovalPolicy {
  /** 默认决策（当无特定策略匹配时） */
  defaultDecision: 'approve' | 'reject';
  /** 自动批准的请求类型 */
  autoApproveTypes: ApprovalRequestType[];
  /** 自动拒绝的请求类型 */
  autoRejectTypes: ApprovalRequestType[];
  /** 审批超时时间（毫秒），超时后使用 defaultDecision */
  timeout: number;
  /** 低影响操作自动批准 */
  lowImpactAutoApprove: boolean;
  /** 可逆操作自动批准 */
  reversibleAutoApprove: boolean;
}

/**
 * 偏离类型
 */
export type DeviationType = 
  | 'off_task'           // 偏离任务目标
  | 'inefficient'        // 效率低下
  | 'stuck'              // 卡住/无进展
  | 'repetitive'         // 重复操作
  | 'resource_abuse';    // 资源滥用

/**
 * 偏离检测配置
 *
 * 定义 Orchestrator 如何检测 Worker 的偏离行为
 */
export interface DeviationDetectionConfig {
  /** 是否启用偏离检测 */
  enabled: boolean;
  /** 检测间隔（毫秒），默认 10000ms (10秒) */
  checkInterval: number;
  /** 每次检查读取的思考日志条数 */
  thinkingLogLimit: number;
  /** 偏离检测阈值（0-1），高于此值认为偏离 */
  deviationThreshold: number;
  /** 同一 Worker 的干预冷却时间（毫秒），避免频繁干预 */
  interventionCooldown: number;
  /** 自动进入干预的严重程度阈值 */
  autoInterventionSeverity: 'low' | 'medium' | 'high' | 'critical';
  /** 是否启用规则检测（轻量运算） */
  enableRuleBasedDetection: boolean;
  /** 是否启用模型评估（重模型，用于可疑情况） */
  enableModelEvaluation: boolean;

  // ===== 检测阈值配置（用于规则检测） =====

  /** 重复模式检测阈值（0-1），默认 0.85 */
  repetitiveThreshold: number;
  /** 卡住检测阈值（信心下降幅度），默认 0.75 */
  stuckThreshold: number;
  /** 偏离任务检测阈值，默认 0.70 */
  offTaskThreshold: number;
  /** 效率低下检测阈值（反思/行动比例），默认 0.65 */
  inefficientThreshold: number;

  // ===== 模型评估配置 =====

  /** 评估用 LLM 配置（仅当 enableModelEvaluation 为 true 时需要） */
  evaluationLLMConfig?: {
    provider: 'anthropic' | 'openai' | 'mock';
    apiKey?: string;
    model: string;
    maxTokens?: number;
  };
}

/**
 * Orchestrator 配置
 */
export interface OrchestratorConfig {
  /** Agent 配置 */
  agent: AgentConfig;
  /** 规划器配置 */
  planner: PlannerConfig;
  /** Worker 池配置 */
  workerPool: WorkerPoolConfig;
  /** 委托默认配置 */
  delegation: DelegationDefaults;
  /** 聚合配置 */
  aggregation: AggregationConfig;
  /** 检查点配置 */
  checkpoint: CheckpointConfig;
  /** Session 配置（共享文件系统） */
  session: SessionDirConfig;
  /** 审批策略配置 */
  approval: ApprovalPolicy;
  /** 偏离检测配置 */
  deviationDetection: DeviationDetectionConfig;
  /**
   * Memory 系统配置
   *
   * 如果提供，Orchestrator 将在聚合后保存结果到记忆，
   * 并支持跨会话知识复用
   */
  memoryConfig?: MemoryConfig;
  /**
   * 协作配置
   *
   * 如果提供，Orchestrator 将启用 Multi-Agent 协作功能
   * 会自动注册为 orchestrator 类型的 Agent
   * 并协调 Worker 间的协作
   */
  collaborationConfig?: {
    enabled: boolean;
    backend?: 'file' | 'redis';
    redis?: { url: string; prefix?: string };
  };
}

/**
 * Session 目录配置
 */
export interface SessionDirConfig {
  /** Session 根目录（默认 .tachikoma） */
  rootDir: string;
  /** 是否启用文件监控（默认 true） */
  enableWatch?: boolean;
  /** 文件监控轮询间隔（毫秒，默认 500） */
  watchPollInterval?: number;
}

/**
 * 规划器配置
 */
export interface PlannerConfig {
  /** 使用的 Agent 配置 */
  agent: AgentConfig;
  /** 默认最大子任务数 */
  defaultMaxSubtasks: number;
  /** 解析失败最大重试次数 */
  maxParseRetries: number;
  /** 是否启用详细推理 */
  enableReasoning: boolean;
  /**
   * Memory 系统配置
   *
   * 如果提供，Planner 将在规划前检索相关 declarative/procedural 记忆
   * 作为规划上下文
   */
  memoryConfig?: MemoryConfig;
}

/**
 * 重试策略来源模式
 */
export type RetryPolicyMode = 'config' | 'planner' | 'guardrail';

/**
 * 委托默认配置
 */
export interface DelegationDefaults {
  /** 默认委托模式 */
  mode: DelegationMode;
  /** 默认 Worker 数量 */
  workerCount: number;
  /** 默认超时（毫秒） */
  timeout: number;
  /** 默认重试策略 */
  retryPolicy: RetryPolicy;
  /**
   * 重试策略来源
   *
   * - config: 始终使用 Orchestrator 配置
   * - planner: 使用 Planner 输出（缺省字段回退配置）
   * - guardrail: Planner 输出 + 配置作为上限/下限保护
   */
  retryPolicyMode?: RetryPolicyMode;
}

// ============================================================================
// 事件类型
// ============================================================================

/**
 * Orchestrator 事件类型
 */
export type OrchestratorEventType =
  | 'plan:start'
  | 'plan:complete'
  | 'plan:failed'
  | 'subtask:assigned'
  | 'subtask:progress'
  | 'subtask:complete'
  | 'subtask:failed'
  | 'subtask:retrying'
  | 'worker:thinking'
  | 'worker:action'
  | 'aggregate:start'
  | 'aggregate:complete'
  | 'checkpoint:created'
  | 'checkpoint:restored'
  | 'approval:received'           // 收到审批请求
  | 'approval:complete'           // 审批处理完成
  | 'deviation:detected'          // 检测到偏离
  | 'deviation:intervention'      // 发送干预指令
  | 'collaboration:request_received'  // 收到协作请求
  | 'collaboration:request_routed'    // 协作请求已路由
  | 'collaboration:request_completed'; // 协作请求处理完成

/**
 * Orchestrator 事件
 */
export interface OrchestratorEvent<T = unknown> {
  /** 事件类型 */
  type: OrchestratorEventType;
  /** 任务 ID */
  taskId: string;
  /** 会话 ID（用于调试和关联） */
  sessionId?: string;
  /** 追踪 ID（用于分布式追踪） */
  traceId?: string;
  /** 子任务 ID（如果适用） */
  subtaskId?: string;
  /** 事件数据 */
  data: T;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 事件处理器
 */
export type OrchestratorEventHandler<T = unknown> = (
  event: OrchestratorEvent<T>
) => void | Promise<void>;
