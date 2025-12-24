/**
 * Orchestrator - 精简版统筹者
 *
 * 将所有业务逻辑委托给独立模块，本身只作为协调层
 */

import type { Task, TaskResult, RetryPolicy } from '../types';
import { BaseAgent } from '../abstracts/base-agent';
import { WorkerAgent } from '../agents/worker-agent';
import type {
  OrchestratorTask,
  SubTask,
  PlannerOutput,
  OrchestratorConfig,
  OrchestratorEventType,
  OrchestratorEventHandler,
  AggregatedResult,
  ExecutionStep,
} from './types';
import { createOrchestratorConfig, type PartialOrchestratorConfig, resolveRetryPolicy } from './config';
import { Planner } from '../planner';
import { DefaultWorkerPool, type IWorkerPool } from './worker-pool';
import {
  createAndInitializeSessionFileManager,
  type ISessionFileManager,
  type SessionFileEvent,
  type PendingApprovalFile,
} from './session';
import { MemoryService } from '../memory';
import { CollaborationManager } from '../collaboration';
import type { MCPClientManager } from '../mcp';

// 导入模块
import { createOrchestratorState } from './state';
import type { OrchestratorState } from './state';
import { EventService } from './services/event-service';
import { AggregationEngine } from './engines/aggregation-engine';
import { ExecutionEngine } from './engines/execution-engine';
import { TaskMasterPlanEngine } from './engines/taskmaster-plan-engine';
import { ApprovalArbitrationService } from './services/approval-arbitration';
import { TaskMasterAdapter } from './adapters/taskmaster-adapter';

// ============================================================================
// 选项类型
// ============================================================================

export interface OrchestratorOptions {
  config?: PartialOrchestratorConfig;
  planner?: Planner;
  workerPool?: IWorkerPool;
  sessionManager?: ISessionFileManager;
  mcpClient?: MCPClientManager;
}

// Orchestrator 实现
// ============================================================================

/**
 * Orchestrator - 精简版统筹者
 */
export class Orchestrator extends BaseAgent {
  private readonly orchestratorConfig: OrchestratorConfig;
  private readonly planner: Planner;
  private readonly workerPool: IWorkerPool;
  private readonly workerPoolInjected: boolean;
  private readonly injectedSessionManager: ISessionFileManager | null;
  private readonly mcpClient?: MCPClientManager;

  // 状态（使用不同名称避免与 BaseAgent.state 冲突）
  readonly orchestratorState: OrchestratorState;

  // 模块
  private readonly eventService: EventService;
  private readonly aggregationEngine: AggregationEngine;
  private readonly executionEngine: ExecutionEngine;
  private readonly planEngine: TaskMasterPlanEngine;

  // 可选模块
  private memoryService?: MemoryService;
  private collaborationManager?: CollaborationManager;
  private approvalService?: ApprovalArbitrationService;
  private readonly taskMasterAdapter: TaskMasterAdapter;

  // 事件处理器绑定
  private readonly boundApprovalHandler: (event: SessionFileEvent<PendingApprovalFile>) => Promise<void>;

  constructor(id: string, options: OrchestratorOptions = {}) {
    const orchestratorConfig = createOrchestratorConfig(options.config);
    super(id, 'orchestrator', orchestratorConfig.agent);

    this.orchestratorConfig = orchestratorConfig;
    this.planner = options.planner ?? new Planner({ config: orchestratorConfig.planner });
    this.workerPool = options.workerPool ?? new DefaultWorkerPool(orchestratorConfig.workerPool);
    this.workerPoolInjected = options.workerPool !== undefined;
    this.injectedSessionManager = options.sessionManager ?? null;
    if (options.mcpClient) {
      this.mcpClient = options.mcpClient;
    }
    // 初始化状态
    this.orchestratorState = createOrchestratorState();

    // 初始化核心模块
    this.eventService = new EventService();
    this.aggregationEngine = new AggregationEngine();
    this.taskMasterAdapter = new TaskMasterAdapter();
    this.executionEngine = new ExecutionEngine();
    this.planEngine = new TaskMasterPlanEngine({
      planner: this.planner,
      config: { defaultMaxSubtasks: orchestratorConfig.planner.defaultMaxSubtasks },
    });

    // 绑定事件处理器
    this.boundApprovalHandler = this.handleApproval.bind(this);

    // 初始化可选模块
    if (orchestratorConfig.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(orchestratorConfig.memoryConfig);
    }
    if (orchestratorConfig.collaborationConfig?.enabled) {
      this.collaborationManager = new CollaborationManager({
        backend: orchestratorConfig.collaborationConfig.backend ?? 'file',
        rootDir: orchestratorConfig.session.rootDir,
      });
    }
  }

  // ============================================================================
  // 公共方法
  // ============================================================================

  getOrchestratorConfig(): OrchestratorConfig {
    return { ...this.orchestratorConfig };
  }

  getSessionId(): string | null {
    return this.orchestratorState.sessionId;
  }

  /** @deprecated Use getSessionId() instead */
  getCurrentSessionId(): string | null {
    return this.getSessionId();
  }

  getPlanner(): Planner {
    return this.planner;
  }

  getWorkerPool(): IWorkerPool {
    return this.workerPool;
  }

  /**
   * 从检查点恢复执行
   *
   * @deprecated 检查点恢复功能已移至 CheckpointResumeEngine
   */
  async resumeFrom(
    checkpointId: string,
    _options: { strategy?: 'resume' | 'retry-failed' | 'restart-step' | 'restart-all' } = {}
  ): Promise<TaskResult> {
    // TODO: 委托给 CheckpointResumeEngine
    console.warn(`[Orchestrator] resumeFrom(${checkpointId}) called - checkpoint resume not yet fully integrated`);
    return {
      taskId: checkpointId,
      status: 'failure',
      output: { error: 'Checkpoint resume not yet implemented in refactored Orchestrator' },
      artifacts: [],
      metrics: { startTime: Date.now(), endTime: Date.now(), duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 },
      trace: { traceId: '', spanId: '', operation: 'resumeFrom', attributes: {}, events: [], duration: 0 },
    };
  }

  // ============================================================================
  // 事件方法
  // ============================================================================

  on<T = unknown>(type: OrchestratorEventType, handler: OrchestratorEventHandler<T>): void {
    this.eventService.on(type, handler);
  }

  off<T = unknown>(type: OrchestratorEventType, handler: OrchestratorEventHandler<T>): void {
    this.eventService.off(type, handler);
  }

  private emit<T>(type: OrchestratorEventType, taskId: string, data: T, subtaskId?: string): void {
    const sessionId = this.orchestratorState.sessionId;
    this.eventService.setContext({
      ...(sessionId ? { sessionId } : {}),
      orchestratorId: this.id,
    });
    this.eventService.emit(type, taskId, data, subtaskId);
  }

  // ============================================================================
  // 核心执行
  // ============================================================================

  protected async executeTask(task: Task, signal: AbortSignal): Promise<TaskResult> {
    const startTime = Date.now();
    const orchestratorTask = this.toOrchestratorTask(task);

    // 验证必要参数
    const workDir = this.extractWorkDir(task);
    const sessionId = task.context?.sessionId;
    if (!workDir || !sessionId) {
      return this.aggregationEngine.createFailureResult(
        task.id,
        'task.context.metadata.workDir and sessionId are required',
        startTime,
        { input: 0, output: 0 }
      );
    }

    // 重置状态
    this.orchestratorState.resetForNewRun();
    this.orchestratorState.currentRunMetadata = task.context?.metadata ?? null;
    this.orchestratorState.initExecutionState(startTime);

    try {
      // 初始化会话
      await this.initSession(sessionId);

      // 开始执行循环 (This is a placeholder for the existing logic, assuming it's refactored into a loop)
      // The original planning and execution logic will be moved or wrapped.
      // For now, I'll integrate the new calls and keep the existing logic.

      // 阶段 1: 规划
      this.emit('plan:start', task.id, { task: orchestratorTask });

      const planResult = await this.planEngine.executePlanPhase(
        orchestratorTask,
        { projectRoot: workDir, tag: sessionId },
        signal
      );

      if (!planResult.success || !planResult.output) {
        this.emit('plan:failed', task.id, { error: planResult.error });
        return this.aggregationEngine.createFailureResult(
          task.id,
          `Planning failed: ${planResult.error}`,
          startTime,
          planResult.tokensUsed
        );
      }

      // 保存规划元数据
      if (planResult.tasksPath) {
        this.orchestratorState.taskMaster.tasksPath = planResult.tasksPath;
        this.orchestratorState.taskMaster.tag = planResult.effectiveTag ?? sessionId;
        this.orchestratorState.taskMaster.originalStatuses = planResult.originalStatuses ?? {};

        // P0-2: 初始化 TaskMasterAdapter 用于状态回写
        this.taskMasterAdapter.initialize({
          projectRoot: workDir,
          tasksPath: planResult.tasksPath,
          tag: planResult.effectiveTag ?? sessionId,
        });

        // P0-3: 保存 runtime.json (如果 SessionManager 可用)
        const sm = this.orchestratorState.sessionManager;
        if (sm) {
          await this.taskMasterAdapter.saveRuntime(sm, task.id, planResult.output);
        }
      }

      this.orchestratorState.currentPlanOutput = planResult.output;
      const execState = this.orchestratorState.executionState;
      if (execState) {
        execState.totalSteps = planResult.output.executionPlan.steps.length;
      }
      this.orchestratorState.addTokens(planResult.tokensUsed.input + planResult.tokensUsed.output);

      this.emit('plan:complete', task.id, { plan: planResult.output });

      // 入口评估
      if (planResult.output.intake?.ready === false) {
        return this.createNeedInputResult(task.id, startTime, planResult.tokensUsed, planResult.output.intake);
      }

      // 初始化 Workers（仅默认池自动创建；注入 WorkerPool 的情况由调用方负责注册）
      if (!this.workerPoolInjected) {
        await this.initializeWorkers(workDir, planResult.output);
      }

      // 阶段 2: 执行
      const aggregatedResult = await this.executeAssignPhase(task.id, planResult.output, signal);

      // 阶段 3: 聚合
      return this.createFinalResult(task.id, aggregatedResult, startTime);
    } finally {
      await this.closeSession();
    }
  }

  // ============================================================================
  // 执行阶段
  // ============================================================================

  private async executeAssignPhase(
    taskId: string,
    planOutput: PlannerOutput,
    signal: AbortSignal
  ): Promise<AggregatedResult> {
    const subtaskMap = this.executionEngine.buildSubtaskMap(planOutput.subtasks);

    // 验证 DAG
    const validation = this.executionEngine.validatePlanDAG(planOutput.subtasks, planOutput.executionPlan);
    if (!validation.valid) {
      throw new Error(`DAG validation failed: ${validation.error}`);
    }

    // 按步骤执行
    for (const step of planOutput.executionPlan.steps) {
      if (signal.aborted) break;

      const execState = this.orchestratorState.executionState;
      if (execState) {
        execState.currentStep = step.order;
      }

      const retryPolicy = resolveRetryPolicy(
        planOutput.delegation.retryPolicy,
        this.orchestratorConfig.delegation.retryPolicy,
        this.orchestratorConfig.delegation.retryPolicyMode ?? 'config'
      );

      await this.executeStep(taskId, step, subtaskMap, planOutput.delegation.timeout, retryPolicy, signal);
    }

    // 聚合结果
    this.emit('aggregate:start', taskId, {});
    const execState = this.orchestratorState.executionState;
    const completedSubtasks = execState?.completedSubtasks ?? new Map();
    const failedSubtasks = execState?.failedSubtasks ?? new Map();
    const result = this.aggregationEngine.aggregate(subtaskMap, completedSubtasks, failedSubtasks);
    this.emit('aggregate:complete', taskId, { result });

    return result;
  }

  private async executeStep(
    taskId: string,
    step: ExecutionStep,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal
  ): Promise<void> {
    if (step.parallel) {
      await Promise.all(
        step.subtaskIds.map((id) => this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal))
      );
    } else {
      for (const id of step.subtaskIds) {
        if (signal.aborted) break;
        await this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal);
      }
    }
  }

  private async executeSubtask(
    taskId: string,
    subtaskId: string,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal
  ): Promise<void> {
    const subtask = subtaskMap.get(subtaskId);
    if (!subtask) {
      this.orchestratorState.markSubtaskFailed(subtaskId, `Subtask ${subtaskId} not found`);
      return;
    }

    // 检查依赖
    const execState = this.orchestratorState.executionState;
    if (subtask.dependencies && execState) {
      for (const depId of subtask.dependencies) {
        if (!execState.completedSubtasks.has(depId)) {
          this.orchestratorState.markSubtaskFailed(subtaskId, `Dependency ${depId} not completed`);
          return;
        }
      }
    }

    if (signal.aborted) {
      this.orchestratorState.markSubtaskFailed(subtaskId, 'Aborted');
      return;
    }

    // Barrier 节点
    if (this.executionEngine.isBarrierSubtask(subtask)) {
      const result: TaskResult = {
        taskId: subtaskId,
        status: 'success',
        output: { text: `Barrier completed: ${subtask.objective}` },
        artifacts: [],
        metrics: { startTime: Date.now(), endTime: Date.now(), duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 },
        trace: { traceId: '', spanId: '', operation: 'barrier', attributes: {}, events: [], duration: 0 },
      };
      this.orchestratorState.markSubtaskCompleted(subtaskId, result);
      this.emit('subtask:complete', taskId, { result }, subtaskId);
      return;
    }

    try {
      // 1) 分配 Worker（按 role/capabilities 路由）
      const requiredCapabilities =
        Array.isArray(subtask.requiredCapabilities) && subtask.requiredCapabilities.length > 0
          ? subtask.requiredCapabilities
          : subtask.roleId
            ? [`role:${subtask.roleId}`]
            : undefined;

      const preferredWorkerId =
        typeof subtask.assignedWorkerId === 'string' && subtask.assignedWorkerId.length > 0
          ? subtask.assignedWorkerId
          : undefined;

      const assignContext: Record<string, unknown> = {};
      if (preferredWorkerId) assignContext.preferredWorkerId = preferredWorkerId;
      if (requiredCapabilities) assignContext.requiredCapabilities = requiredCapabilities;

      const assignment = await this.workerPool.assign(
        subtask,
        timeout,
        retryPolicy,
        Object.keys(assignContext).length > 0 ? assignContext : undefined,
        signal
      );
      if (!assignment.success || !assignment.workerId) {
        throw new Error(assignment.error ?? 'Assignment failed');
      }

      const { workerId, agent } = assignment;

      // P0 Fix：必须获取 Agent 实例以触发执行
      if (!agent) {
        throw new Error(`Worker ${workerId} has no attached Agent instance`);
      }

      // 2) 记录分配信息并标记执行中
      subtask.assignedWorkerId = workerId;
      this.emit('subtask:assigned', taskId, { subtask, workerId }, subtaskId);
      this.orchestratorState.markSubtaskRunning(subtaskId);
      await this.taskMasterAdapter.writeStatus(subtaskId, 'in-progress');

      // 3) 构造 Task 对象 (SubTask -> Task)
      const runMeta = this.orchestratorState.currentRunMetadata;
      const noApproval = runMeta?.noApproval === true;

      const workerMetadata: Record<string, unknown> = {};
      if (noApproval) workerMetadata.noApproval = true;
      if (runMeta && typeof runMeta === 'object' && 'workDir' in runMeta) {
        const wd = (runMeta as Record<string, unknown>).workDir;
        if (typeof wd === 'string') workerMetadata.workDir = wd;
      }

      const workerTask: Task = {
        id: subtask.id,
        type: 'atomic',
        objective: subtask.objective,
        ...(subtask.parentObjective !== undefined && { parentObjective: subtask.parentObjective }),
        constraints: subtask.constraints ?? [],
        ...(subtask.outputSchema !== undefined && { outputSchema: subtask.outputSchema }),
        context: {
          parentTaskId: taskId,
          ...(this.orchestratorState.sessionId ? { sessionId: this.orchestratorState.sessionId } : {}),
          traceId: `trace-${this.orchestratorState.sessionId ?? taskId}`,
          ...(Object.keys(workerMetadata).length > 0 ? { metadata: workerMetadata } : {}),
        },
      };

      // 4) 执行任务（Orchestrator 直接驱动 Agent.run；支持 abort 时 best-effort cancel）
      const onAbort = () => assignment.cancel?.();
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      let result: TaskResult;
      try {
        result = await agent.run(workerTask);
      } finally {
        signal.removeEventListener('abort', onAbort);
        // 通知 WorkerPool 任务完成（如果已取消则可能是 no-op）
        this.workerPool.completeTask(subtaskId);
      }

      // 5) 处理结果
      if (result.status === 'success') {
        this.orchestratorState.markSubtaskCompleted(subtaskId, result);
        subtask.status = 'success';
        // P0-2: 更新状态为 done
        await this.taskMasterAdapter.writeStatus(subtaskId, 'done');
        this.emit('subtask:complete', taskId, { result }, subtaskId);
      } else {
        const output =
          result.output && typeof result.output === 'object'
            ? (result.output as Record<string, unknown>)
            : undefined;
        const errorMsg = output && typeof output.error === 'string' ? output.error : 'Task failed';
        this.orchestratorState.markSubtaskFailed(subtaskId, String(errorMsg));
        subtask.status = 'pending';
        // P0-2: 失败回滚为 pending（符合 Task Master 语义）
        await this.taskMasterAdapter.writeStatus(subtaskId, 'pending');
        this.emit('subtask:failed', taskId, { subtask, error: String(errorMsg) }, subtaskId);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.orchestratorState.markSubtaskFailed(subtaskId, errorMsg);
      subtask.status = 'pending';
      // P0-2: 失败回滚为 pending
      await this.taskMasterAdapter.writeStatus(subtaskId, 'pending');
      this.emit('subtask:failed', taskId, { subtask, error: errorMsg }, subtaskId);
    }
  }

  /**
   * 初始化 Workers (根据委托配置创建)
   */
  private async initializeWorkers(workDir: string, planOutput: PlannerOutput): Promise<void> {
    // 如果外部已经注入/注册了 Worker，则尊重调用方配置（避免单测/集成环境被污染）
    if (this.workerPool.workerCount > 0) return;

    const delegation = planOutput.delegation;
    const desiredCount = Math.max(1, delegation.workerCount);
    const roles = Array.isArray(planOutput.roles) && planOutput.roles.length > 0 ? planOutput.roles : [];

    // 若无 roles，则回退到 general（不阻塞执行）
    const rolePool =
      roles.length > 0
        ? roles
        : [
            {
              id: 'general',
              name: 'Generalist',
              responsibilities: '通用执行者',
              capabilities: ['general'],
            },
          ];

    const perRoleSeq = new Map<string, number>();

    for (let i = 0; i < Math.max(desiredCount, rolePool.length); i++) {
      const role = rolePool[i % rolePool.length];
      if (!role) continue;
      const seq = perRoleSeq.get(role.id) ?? 0;
      perRoleSeq.set(role.id, seq + 1);

      const workerId = `worker-${role.id}-${seq}`;
      if (this.workerPool.getWorker(workerId)) continue;

      const sessionManager = this.orchestratorState.sessionManager ?? undefined;
      const agent = new WorkerAgent(workerId, this.orchestratorConfig.agent, {
        workDir,
        ...(sessionManager ? { sessionManager } : {}),
        ...(this.mcpClient ? { mcpClient: this.mcpClient } : {}),
      });

      const caps = Array.from(new Set([...role.capabilities, `role:${role.id}`]));
      this.workerPool.register({
        id: workerId,
        status: 'idle',
        agent,
        capabilities: caps,
      });
    }
  }



  // ============================================================================
  // 会话管理
  // ============================================================================

  private async initSession(sessionId: string): Promise<void> {
    this.orchestratorState.sessionId = sessionId;

    if (this.injectedSessionManager) {
      this.orchestratorState.sessionManager = this.injectedSessionManager;
    } else {
      this.orchestratorState.sessionManager = await createAndInitializeSessionFileManager(sessionId, {
        rootDir: this.orchestratorConfig.session.rootDir,
        enableWatch: true,
        autoCreateDirs: true,
      });
    }

    // 注册审批处理器
    const sm = this.orchestratorState.sessionManager;
    if (sm) {
      sm.on('pending_approval_created', this.boundApprovalHandler);
      this.approvalService = new ApprovalArbitrationService({
        sessionManager: sm,
        eventService: this.eventService,
        policy: this.orchestratorConfig.approval,
        taskMasterCallbacks: {
          getRefForCurrentTask: () => {
            return this.taskMasterAdapter.getRef();
          },
          addDependency: async (subtaskId: string, predecessor: string) => {
            await this.taskMasterAdapter.addDependency(subtaskId, predecessor);
          },
          expandSubtask: async (targetId, subtasks, options) => {
            await this.taskMasterAdapter.expandSubtask(
              targetId,
              subtasks,
              {
                strategy: options.strategy,
                ...(options.force !== undefined ? { force: options.force } : {}),
              }
            );
          },
          markPendingReplan: () => {
             // TODO: 触发重新规划
             // P2: 实现完整的重新规划触发逻辑
          },
          addExpandedSubtask: (_subtaskId: string) => {
            // TODO: 跟踪展开的子任务
            // P2: 实现子任务跟踪
          },
          getRoleAssignment: (_targetId: string) => {
            // TODO: 获取角色分配
            // P2: 从 tasks.json 或 taskmeta 读取角色分配
            return null;
          },
          writeRoleAssignment: async (_tag: string, _subtaskId: string, _roleId: string, _caps: string[]) => {
            // TODO: 写入角色分配
            // P2: 实现角色分配写入
          },
          recordOriginalStatus: (subtaskId: string, status: string) => {
            //这是TaskMasterTaskStatus到string的映射，如果类型不匹配需要转换，但这里status仅用于记录
            // TaskMasterAdapter.recordOriginalStatus expect specific string union
            // approval-arbitration pass string.
            // cast to any or specific type
            this.taskMasterAdapter.recordOriginalStatus(subtaskId, status as any);
          }
        },
      });
    }
  }

  private async closeSession(): Promise<void> {
    const sm = this.orchestratorState.sessionManager;
    if (sm) {
      sm.off('pending_approval_created', this.boundApprovalHandler);
      if (!this.injectedSessionManager) {
        await sm.close();
      }
    }
    this.orchestratorState.sessionManager = null;
    this.orchestratorState.sessionId = null;
  }

  private async handleApproval(event: SessionFileEvent<PendingApprovalFile>): Promise<void> {
    await this.approvalService?.handlePendingApproval(event);
  }

  // ============================================================================
  // 工具方法
  // ============================================================================

  private toOrchestratorTask(task: Task): OrchestratorTask {
    const meta = task.context?.metadata as Record<string, unknown> | undefined;
    return {
      ...task,
      type: 'composite',
      priority: (meta?.priority as string) ?? 'medium',
      complexity: (meta?.complexity as string) ?? 'moderate',
    } as OrchestratorTask;
  }

  private extractWorkDir(task: Task): string | undefined {
    const meta = task.context?.metadata;
    if (meta && typeof meta === 'object' && 'workDir' in meta) {
      return String((meta as Record<string, unknown>).workDir);
    }
    return undefined;
  }

  private createFinalResult(taskId: string, aggregated: AggregatedResult, startTime: number): TaskResult {
    const execState = this.orchestratorState.executionState;
    return {
      taskId,
      status: aggregated.status === 'success' ? 'success' : 'failure',
      output: aggregated.output,
      artifacts: [],
      metrics: {
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
        tokensUsed: execState?.totalTokens ?? 0,
        toolCallCount: 0,
        retryCount: execState?.totalRetries ?? 0,
      },
      trace: {
        traceId: `trace-${taskId}`,
        spanId: `span-${taskId}`,
        operation: 'orchestrate',
        attributes: {},
        events: [],
        duration: Date.now() - startTime,
      },
    };
  }

  private createNeedInputResult(
    taskId: string,
    startTime: number,
    tokensUsed: { input: number; output: number },
    intake: { questions?: string[]; missingInfo?: string[] }
  ): TaskResult {
    const questions = intake.questions ?? [];
    const question = questions.length > 0
      ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
      : '请补充关键需求信息后再继续。';

    return {
      taskId,
      status: 'partial',
      output: { text: question, missingInfo: intake.missingInfo ?? [] },
      artifacts: [],
      metrics: {
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
        tokensUsed: tokensUsed.input + tokensUsed.output,
        toolCallCount: 0,
        retryCount: 0,
      },
      trace: {
        traceId: `trace-${taskId}`,
        spanId: `span-${taskId}`,
        operation: 'intake',
        attributes: {},
        events: [],
        duration: Date.now() - startTime,
      },
    };
  }

  // ============================================================================
  // 清理
  // ============================================================================

  async cleanup(): Promise<void> {
    await this.closeSession();
    await this.workerPool.shutdown();
    if (this.memoryService) {
      await this.memoryService.close();
    }
    if (this.collaborationManager) {
      await this.collaborationManager.stop();
    }
    await super.cleanup();
  }
}

/**
 * 创建 Orchestrator 实例
 */
export function createOrchestrator(id: string, options?: OrchestratorOptions): Orchestrator {
  return new Orchestrator(id, options);
}
