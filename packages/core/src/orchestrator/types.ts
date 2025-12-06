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
} from '../types';

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
  /** 规划推理（Chain-of-Thought） */
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
}

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
  | 'aggregate:start'
  | 'aggregate:complete'
  | 'checkpoint:created'
  | 'checkpoint:restored';

/**
 * Orchestrator 事件
 */
export interface OrchestratorEvent<T = unknown> {
  /** 事件类型 */
  type: OrchestratorEventType;
  /** 任务 ID */
  taskId: string;
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
