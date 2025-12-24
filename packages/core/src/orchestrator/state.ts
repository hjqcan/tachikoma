/**
 * OrchestratorState - 共享状态管理器
 *
 * 外置 Orchestrator 的内部状态，使模块间可以共享
 */

import type { TaskResult } from '../types';
import type { PlannerOutput, PlannerRole } from './types';
import type { ISessionFileManager, PendingApprovalFile } from './session';
import type { TaskStatus as TaskMasterTaskStatus } from '../taskmaster-compat';

// ============================================================================
// 执行状态
// ============================================================================

/**
 * 执行状态
 */
export interface ExecutionState {
  currentStep: number;
  totalSteps: number;
  completedSubtasks: Map<string, TaskResult>;
  failedSubtasks: Map<string, string>;
  runningSubtasks: Set<string>;
  startTime: number;
  totalTokens: number;
  totalRetries: number;
}

/**
 * 创建初始执行状态
 */
export function createExecutionState(startTime: number): ExecutionState {
  return {
    currentStep: 0,
    totalSteps: 0,
    completedSubtasks: new Map(),
    failedSubtasks: new Map(),
    runningSubtasks: new Set(),
    startTime,
    totalTokens: 0,
    totalRetries: 0,
  };
}

// ============================================================================
// TaskMaster 状态
// ============================================================================

/**
 * TaskMaster 引用
 */
export interface TaskMasterRef {
  projectRoot: string;
  file: string;
  tag: string;
}

/**
 * TaskMaster 运行时状态
 */
export interface TaskMasterState {
  projectRoot: string | null;
  tasksPath: string | null;
  tag: string;
  originalStatuses: Record<string, TaskMasterTaskStatus>;
  refsByTaskId: Map<string, TaskMasterRef>;
}

/**
 * 创建初始 TaskMaster 状态
 */
export function createTaskMasterState(): TaskMasterState {
  return {
    projectRoot: null,
    tasksPath: null,
    tag: 'master',
    originalStatuses: {},
    refsByTaskId: new Map(),
  };
}

// ============================================================================
// 审批仲裁状态
// ============================================================================

/**
 * 延迟审批
 */
export interface DelayedApproval {
  workerId: string;
  approval: PendingApprovalFile;
  reason: string;
}

/**
 * 审批状态
 */
export interface ApprovalState {
  fileLocks: Map<string, string>;
  fileWaitQueues: Map<string, string[]>;
  subtaskWriteFiles: Map<string, Set<string>>;
  processedRequests: Map<string, number>;
  delayedApprovals: Map<string, DelayedApproval>;
}

/**
 * 创建初始审批状态
 */
export function createApprovalState(): ApprovalState {
  return {
    fileLocks: new Map(),
    fileWaitQueues: new Map(),
    subtaskWriteFiles: new Map(),
    processedRequests: new Map(),
    delayedApprovals: new Map(),
  };
}

// ============================================================================
// OrchestratorState 主类
// ============================================================================

/**
 * OrchestratorState
 *
 * 集中管理 Orchestrator 运行时状态
 */
export class OrchestratorState {
  // 会话
  sessionId: string | null = null;
  sessionManager: ISessionFileManager | null = null;

  // 执行状态
  executionState: ExecutionState | null = null;

  // 当前任务
  currentPlanOutput: PlannerOutput | null = null;
  currentRunMetadata: Record<string, unknown> | null = null;

  // TaskMaster
  taskMaster: TaskMasterState = createTaskMasterState();

  // 审批
  approval: ApprovalState = createApprovalState();

  // 角色定义
  roleDefinitions: PlannerRole[] = [];

  // 标记
  pendingReplan = false;
  expandedSubtaskIds = new Set<string>();
  refinedSubtaskIds = new Set<string>();

  // 偏离检测
  workerInterventionCooldowns = new Map<string, number>();

  /**
   * 重置所有执行期状态
   */
  resetForNewRun(): void {
    this.executionState = null;
    this.currentPlanOutput = null;
    this.pendingReplan = false;
    this.expandedSubtaskIds.clear();
    this.refinedSubtaskIds.clear();
    this.taskMaster = createTaskMasterState();
    this.approval = createApprovalState();
  }

  /**
   * 初始化执行状态
   */
  initExecutionState(startTime: number): void {
    this.executionState = createExecutionState(startTime);
  }

  /**
   * 获取 TaskMaster 引用
   */
  getTaskMasterRef(taskId: string): TaskMasterRef | null {
    return this.taskMaster.refsByTaskId.get(taskId) ?? null;
  }

  /**
   * 设置 TaskMaster 引用
   */
  setTaskMasterRef(taskId: string, ref: TaskMasterRef): void {
    this.taskMaster.refsByTaskId.set(taskId, ref);
  }

  /**
   * 记录原始状态
   */
  recordOriginalStatus(id: string, status: TaskMasterTaskStatus): void {
    if (this.taskMaster.originalStatuses[id] === undefined) {
      this.taskMaster.originalStatuses[id] = status;
    }
  }

  /**
   * 获取原始状态
   */
  getOriginalStatus(id: string): TaskMasterTaskStatus {
    return this.taskMaster.originalStatuses[id] ?? 'pending';
  }

  /**
   * 标记子任务完成
   */
  markSubtaskCompleted(subtaskId: string, result: TaskResult): void {
    if (this.executionState) {
      this.executionState.completedSubtasks.set(subtaskId, result);
      this.executionState.runningSubtasks.delete(subtaskId);
    }
  }

  /**
   * 标记子任务失败
   */
  markSubtaskFailed(subtaskId: string, error: string): void {
    if (this.executionState) {
      this.executionState.failedSubtasks.set(subtaskId, error);
      this.executionState.runningSubtasks.delete(subtaskId);
    }
  }

  /**
   * 标记子任务开始
   */
  markSubtaskRunning(subtaskId: string): void {
    if (this.executionState) {
      this.executionState.runningSubtasks.add(subtaskId);
    }
  }

  /**
   * 增加 token 使用
   */
  addTokens(count: number): void {
    if (this.executionState) {
      this.executionState.totalTokens += count;
    }
  }

  /**
   * 增加重试次数
   */
  addRetry(): void {
    if (this.executionState) {
      this.executionState.totalRetries++;
    }
  }
}

/**
 * 创建状态实例
 */
export function createOrchestratorState(): OrchestratorState {
  return new OrchestratorState();
}
