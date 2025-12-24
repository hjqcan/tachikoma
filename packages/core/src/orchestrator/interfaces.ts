/**
 * Orchestrator 模块接口定义
 *
 * 用于依赖注入和模块解耦
 */

import type {
  OrchestratorEventType,
  OrchestratorEventHandler,
  SubTask,
  PlannerOutput,
  ExecutionPlan,
  OrchestratorTask,
  AggregatedResult,
} from './types';
import type { TaskResult, RetryPolicy } from '../types';
import type { PlanResult } from '../planner';
import type { ThinkingRecord } from './session';
import type { PendingApprovalFile, SessionFileEvent } from './session';

// ============================================================================
// 事件服务接口
// ============================================================================

/**
 * 事件服务接口
 *
 * 负责 Orchestrator 事件的发布/订阅
 */
export interface IEventService {
  /**
   * 添加事件监听器
   */
  on<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void;

  /**
   * 移除事件监听器
   */
  off<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void;

  /**
   * 发出事件
   */
  emit<T = unknown>(
    type: OrchestratorEventType,
    taskId: string,
    data: T,
    subtaskId?: string
  ): void;

  /**
   * 设置上下文信息（用于事件元数据）
   */
  setContext(context: EventServiceContext): void;
}

/**
 * 事件服务上下文
 */
export interface EventServiceContext {
  sessionId?: string;
  orchestratorId?: string;
}

// ============================================================================
// 偏离检测器接口
// ============================================================================

/**
 * 偏离检测结果
 */
export interface DeviationResult {
  type: 'off_task' | 'inefficient' | 'stuck' | 'repetitive' | 'resource_abuse';
  score: number;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestedSteps: string[];
}

/**
 * 偏离检测器接口
 */
export interface IDeviationDetector {
  /**
   * 启动偏离检测
   */
  start(): void;

  /**
   * 停止偏离检测
   */
  stop(): void;

  /**
   * 评估思考日志
   */
  evaluateLogs(
    logs: ThinkingRecord[],
    currentTaskId?: string
  ): DeviationResult | null;

  /**
   * 向 Worker 发送干预指令
   */
  issueIntervention(
    workerId: string,
    deviation: DeviationResult
  ): Promise<void>;
}

// ============================================================================
// 聚合引擎接口
// ============================================================================

// 注意: AggregatedResult 已从 types.ts 导入，不在此重复定义

/**
 * 聚合引擎接口
 */
export interface IAggregationEngine {
  /**
   * 聚合所有子任务结果
   */
  aggregate(
    subtaskMap: Map<string, SubTask>,
    completedSubtasks: Map<string, TaskResult>,
    failedSubtasks: Map<string, string>
  ): AggregatedResult;

  /**
   * 创建最终结果
   */
  createFinalResult(
    taskId: string,
    aggregatedResult: AggregatedResult,
    startTime: number,
    totalRetries: number
  ): TaskResult;

  /**
   * 创建失败结果
   */
  createFailureResult(
    taskId: string,
    error: string,
    startTime: number,
    tokensUsed: { input: number; output: number }
  ): TaskResult;
}

// ============================================================================
// 审批仲裁接口
// ============================================================================

/**
 * 文件写入仲裁参数
 */
export interface FileWriteArbitrationParams {
  workerId: string;
  approval: PendingApprovalFile;
  action: 'apply_patch' | 'file_write';
  affectedFiles: string[];
}

/**
 * 审批仲裁服务接口
 */
export interface IApprovalArbitration {
  /**
   * 处理待审批请求
   */
  handlePendingApproval(
    event: SessionFileEvent<PendingApprovalFile>
  ): Promise<void>;

  /**
   * 处理文件写入仲裁
   */
  handleFileWriteArbitration(
    params: FileWriteArbitrationParams
  ): Promise<boolean>;

  /**
   * 释放子任务的文件锁
   */
  releaseFileLocksForSubtask(subtaskId: string): Promise<void>;
}

// ============================================================================
// Task Master 适配器接口
// ============================================================================

/**
 * Task Master 引用
 */
export interface TaskMasterRef {
  projectRoot: string;
  tag: string;
  file?: string;
}

/**
 * Task Master 状态
 */
export type TaskMasterTaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'deferred'
  | 'review';

/**
 * Task Master 适配器接口
 */
export interface ITaskMasterAdapter {
  /**
   * 获取元数据
   */
  getMetadata(): { tag?: string; file?: string };

  /**
   * 获取当前任务的 TM 引用
   */
  getRefForCurrentTask(): TaskMasterRef | null;

  /**
   * 执行 Task Master 规划阶段
   */
  executePlanPhase(
    task: OrchestratorTask,
    ref: TaskMasterRef,
    signal: AbortSignal,
    ensureRound?: number
  ): Promise<PlanResult>;

  /**
   * 保存运行时快照到会话
   */
  saveRuntimeToSession(
    taskId: string,
    planOutput: PlannerOutput
  ): Promise<void>;

  /**
   * 获取原始状态
   */
  getOriginalStatus(id: string): TaskMasterTaskStatus;

  /**
   * 写入状态
   */
  writeStatus(id: string, status: TaskMasterTaskStatus): Promise<void>;
}

// ============================================================================
// 执行引擎接口
// ============================================================================

/**
 * 子任务执行结果
 */
export interface SubTaskExecutionResult {
  subtaskId: string;
  success: boolean;
  result?: TaskResult;
  error?: string;
  retryCount: number;
}

/**
 * 执行引擎接口
 */
export interface IExecutionEngine {
  /**
   * 执行分配阶段
   */
  executeAssignPhase(
    taskId: string,
    planOutput: PlannerOutput,
    signal: AbortSignal
  ): Promise<AggregatedResult>;

  /**
   * 执行单个子任务
   */
  executeSubtask(
    taskId: string,
    subtaskId: string,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal
  ): Promise<SubTaskExecutionResult>;

  /**
   * 验证 DAG 有效性
   */
  validatePlanDAG(
    subtasks: SubTask[],
    executionPlan: ExecutionPlan
  ): string | null;
}
