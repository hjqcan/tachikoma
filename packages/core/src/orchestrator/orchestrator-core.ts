/**
 * OrchestratorCore - 核心模块组合器
 *
 * 整合所有重构后的模块，为 Orchestrator 提供核心功能
 * 采用组合模式，将各个独立模块组合在一起
 */

import type { TaskResult } from '../types';
import type {
  OrchestratorConfig,
  SubTask,
  ExecutionPlan,
  OrchestratorEventType,
  OrchestratorEventHandler,
} from './types';
import type { ISessionFileManager } from './session';
import type { IWorkerPool } from './worker-pool';

// 导入重构后的模块
import { EventService } from './services/event-service';
import { AggregationEngine } from './engines/aggregation-engine';
import { ExecutionEngine } from './engines/execution-engine';
import { WorkerCoordinator } from './managers/worker-coordinator';
import { TaskMasterAdapter, type TaskMasterTaskStatus } from './adapters/taskmaster-adapter';

// ============================================================================
// OrchestratorCore 实现
// ============================================================================

/**
 * OrchestratorCore
 *
 * 核心模块组合器，整合所有重构后的模块
 */
export class OrchestratorCore {
  // 基础配置
  readonly orchestratorId: string;
  readonly config: OrchestratorConfig;

  // 核心模块
  readonly eventService: EventService;
  readonly aggregationEngine: AggregationEngine;
  readonly executionEngine: ExecutionEngine;
  readonly taskMasterAdapter: TaskMasterAdapter;
  readonly workerCoordinator: WorkerCoordinator;

  // 会话管理
  private _sessionManager: ISessionFileManager | null = null;

  constructor(
    orchestratorId: string,
    config: OrchestratorConfig,
    workerPool: IWorkerPool
  ) {
    this.orchestratorId = orchestratorId;
    this.config = config;

    // 初始化核心模块
    this.eventService = new EventService();
    this.aggregationEngine = new AggregationEngine();
    this.executionEngine = new ExecutionEngine();
    this.taskMasterAdapter = new TaskMasterAdapter();
    this.workerCoordinator = new WorkerCoordinator({ workerPool });
  }

  // ============================================================================
  // 事件服务代理
  // ============================================================================

  on<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void {
    this.eventService.on(type, handler);
  }

  off<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void {
    this.eventService.off(type, handler);
  }

  emit<T = unknown>(
    type: OrchestratorEventType,
    taskId: string,
    data: T,
    subtaskId?: string
  ): void {
    this.eventService.emit(type, taskId, data, subtaskId);
  }

  setEventContext(context: { sessionId?: string; orchestratorId?: string }): void {
    this.eventService.setContext(context);
  }

  // ============================================================================
  // 聚合引擎代理
  // ============================================================================

  createFailureResult(
    taskId: string,
    error: string,
    startTime: number,
    tokensUsed: { input: number; output: number }
  ): TaskResult {
    return this.aggregationEngine.createFailureResult(
      taskId,
      error,
      startTime,
      tokensUsed
    );
  }

  // ============================================================================
  // 执行引擎代理
  // ============================================================================

  validatePlanDAG(
    subtasks: SubTask[],
    executionPlan: ExecutionPlan
  ): { valid: boolean; error?: string } {
    return this.executionEngine.validatePlanDAG(subtasks, executionPlan);
  }

  buildSubtaskMap(subtasks: SubTask[]): Map<string, SubTask> {
    return this.executionEngine.buildSubtaskMap(subtasks);
  }

  isBarrierSubtask(subtask: SubTask): boolean {
    return this.executionEngine.isBarrierSubtask(subtask);
  }

  // ============================================================================
  // TaskMaster 适配器代理
  // ============================================================================

  initializeTaskMaster(options: {
    projectRoot: string;
    tasksPath: string;
    tag?: string;
  }): void {
    this.taskMasterAdapter.initialize(options);
  }

  async writeTaskMasterStatus(id: string, status: TaskMasterTaskStatus): Promise<void> {
    await this.taskMasterAdapter.writeStatus(id, status);
  }

  async restoreTaskMasterStatus(id: string): Promise<void> {
    await this.taskMasterAdapter.restoreStatus(id);
  }

  recordTaskMasterOriginalStatus(id: string, status: TaskMasterTaskStatus): void {
    this.taskMasterAdapter.recordOriginalStatus(id, status);
  }

  getTaskMasterOriginalStatus(id: string): TaskMasterTaskStatus {
    return this.taskMasterAdapter.getOriginalStatus(id);
  }

  // ============================================================================
  // Worker 协调器代理
  // ============================================================================

  setRoleDefinitions(roles: { id: string; name: string; capabilities: string[] }[]): void {
    this.workerCoordinator.setRoleDefinitions(roles.map(r => ({ ...r, responsibilities: '' })));
  }

  getRoleCapabilities(roleId: string): string[] {
    return this.workerCoordinator.getRoleCapabilities(roleId);
  }

  generateWorkerId(roleId: string): string {
    return this.workerCoordinator.generateWorkerId(roleId);
  }

  canCreateWorker(maxWorkers: number): boolean {
    return this.workerCoordinator.canCreateWorker(maxWorkers);
  }

  // ============================================================================
  // 会话管理
  // ============================================================================

  setSessionManager(sessionManager: ISessionFileManager | null): void {
    this._sessionManager = sessionManager;
  }

  getSessionManager(): ISessionFileManager | null {
    return this._sessionManager;
  }

  // ============================================================================
  // 清理
  // ============================================================================

  cleanup(): void {
    this.taskMasterAdapter.reset();
    this.workerCoordinator.reset();
  }
}

/**
 * 创建 OrchestratorCore 实例
 */
export function createOrchestratorCore(
  orchestratorId: string,
  config: OrchestratorConfig,
  workerPool: IWorkerPool
): OrchestratorCore {
  return new OrchestratorCore(orchestratorId, config, workerPool);
}
