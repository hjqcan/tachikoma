/**
 * OrchestratorState - 共享状态管理器
 *
 * 外置 Orchestrator 的内部状态，使模块间可以共享
 */

import type { TaskResult } from '../types';
import type { PlannerOutput, PlannerRole } from './types';
import type { ISessionFileManager, PendingApprovalFile } from './session';
import type { MidExecutionProbe } from './services/mid-execution-probe';

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

  // 审批
  approval: ApprovalState = createApprovalState();

  // 角色定义
  roleDefinitions: PlannerRole[] = [];

  // 标记
  refinedSubtaskIds = new Set<string>();
  observerProbeQueue: MidExecutionProbe[] = [];
  observerProbeSeen = new Set<string>();

  // 偏离检测
  workerInterventionCooldowns = new Map<string, number>();

  /**
   * 重置所有执行期状态
   */
  resetForNewRun(): void {
    this.executionState = null;
    this.currentPlanOutput = null;
    this.refinedSubtaskIds.clear();
    this.observerProbeQueue = [];
    this.observerProbeSeen.clear();
    this.approval = createApprovalState();
  }

  /**
   * 初始化执行状态
   */
  initExecutionState(startTime: number): void {
    this.executionState = createExecutionState(startTime);
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

  enqueueObserverProbe(probe: MidExecutionProbe): boolean {
    if (this.observerProbeSeen.has(probe.id)) return false;
    this.observerProbeSeen.add(probe.id);
    this.observerProbeQueue.push(probe);
    return true;
  }

  dequeueObserverProbe(): MidExecutionProbe | undefined {
    return this.observerProbeQueue.shift();
  }
}

/**
 * 创建状态实例
 */
export function createOrchestratorState(): OrchestratorState {
  return new OrchestratorState();
}
