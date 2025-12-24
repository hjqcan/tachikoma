import type { Task, TaskResult, RetryPolicy } from '../../types';
import type { IWorkerPool } from '../worker-pool';
import type { OrchestratorConfig, OrchestratorTask, PlannerOutput, SubTask, ExecutionStep } from '../types';
import type { OrchestratorState } from '../state';
import { generateTimestampId } from '../session';
import { resolveRetryPolicy, calculateRetryDelay, shouldRetry } from '../config';
import { AggregationEngine } from '../engines/aggregation-engine';
import { ExecutionEngine } from '../engines/execution-engine';
import { TaskMasterPlanEngine } from '../engines/taskmaster-plan-engine';
import { TaskMasterAdapter } from '../adapters/taskmaster-adapter';
import type { ApprovalArbitrationService } from '../services/approval-arbitration';
import type { IntegrationContextService } from '../services/integration-context';
import type { EmitFn } from './types';
import { ProgressReporter } from './progress-reporter';
import { CheckpointService } from './checkpoint-service';
import { WorkerManager } from './worker-manager';

export interface ExecutionLoopDeps {
  orchestratorConfig: OrchestratorConfig;
  state: OrchestratorState;
  workerPool: IWorkerPool;
  workerPoolInjected: boolean;
  aggregationEngine: AggregationEngine;
  executionEngine: ExecutionEngine;
  planEngine: TaskMasterPlanEngine;
  taskMasterAdapter: TaskMasterAdapter;
  emit: EmitFn;
  progress: ProgressReporter;
  checkpoints: CheckpointService;
  workers: WorkerManager;
  getApprovalService: () => ApprovalArbitrationService | null;
  getIntegrationService: () => IntegrationContextService | null;
}

export class ExecutionLoop {
  private readonly orchestratorConfig: OrchestratorConfig;
  private readonly state: OrchestratorState;
  private readonly workerPool: IWorkerPool;
  private readonly workerPoolInjected: boolean;
  private readonly aggregationEngine: AggregationEngine;
  private readonly executionEngine: ExecutionEngine;
  private readonly planEngine: TaskMasterPlanEngine;
  private readonly taskMasterAdapter: TaskMasterAdapter;
  private readonly emit: EmitFn;
  private readonly progress: ProgressReporter;
  private readonly checkpoints: CheckpointService;
  private readonly workers: WorkerManager;
  private readonly getApprovalService: () => ApprovalArbitrationService | null;
  private readonly getIntegrationService: () => IntegrationContextService | null;

  constructor(deps: ExecutionLoopDeps) {
    this.orchestratorConfig = deps.orchestratorConfig;
    this.state = deps.state;
    this.workerPool = deps.workerPool;
    this.workerPoolInjected = deps.workerPoolInjected;
    this.aggregationEngine = deps.aggregationEngine;
    this.executionEngine = deps.executionEngine;
    this.planEngine = deps.planEngine;
    this.taskMasterAdapter = deps.taskMasterAdapter;
    this.emit = deps.emit;
    this.progress = deps.progress;
    this.checkpoints = deps.checkpoints;
    this.workers = deps.workers;
    this.getApprovalService = deps.getApprovalService;
    this.getIntegrationService = deps.getIntegrationService;
  }

  async runPlan(
    taskId: string,
    orchestratorTask: OrchestratorTask,
    workDir: string,
    planOutput: PlannerOutput,
    signal: AbortSignal
  ): Promise<{ aggregated: ReturnType<AggregationEngine['aggregate']> }> {
    const subtaskMap = new Map<string, SubTask>();
    const mergeSubtasks = (subs: SubTask[]): void => {
      for (const st of subs) subtaskMap.set(st.id, st);
    };

    let activePlan = planOutput;
    mergeSubtasks(activePlan.subtasks);

    while (true) {
      const validation = this.executionEngine.validatePlanDAG(activePlan.subtasks, activePlan.executionPlan);
      if (!validation.valid) {
        throw new Error(`DAG validation failed: ${validation.error}`);
      }

      if (this.state.executionState) {
        this.state.executionState.totalSteps = activePlan.executionPlan.steps.length;
        this.state.executionState.currentStep = 0;
      }
      await this.progress.write(taskId, 'executing').catch(() => undefined);

      if (!this.workerPoolInjected) {
        this.workers.storeRoleDefinitions(workDir, activePlan);
      }

      for (const step of activePlan.executionPlan.steps) {
        if (signal.aborted) break;

        if (this.state.executionState) {
          this.state.executionState.currentStep = step.order;
        }
        await this.progress.write(taskId, 'executing').catch(() => undefined);

        const retryPolicy = resolveRetryPolicy(
          activePlan.delegation.retryPolicy,
          this.orchestratorConfig.delegation.retryPolicy,
          this.orchestratorConfig.delegation.retryPolicyMode ?? 'config'
        );

        await this.executeStep(taskId, step, subtaskMap, activePlan.delegation.timeout, retryPolicy, signal);
        await this.checkpoints.saveSnapshot(taskId, 'executing', `step-${step.order}`).catch(() => undefined);

        if (this.state.pendingReplan) {
          break;
        }
      }

      if (signal.aborted) break;
      if (!this.state.pendingReplan) break;

      this.state.pendingReplan = false;

      const ref = this.taskMasterAdapter.getRef();
      const sessionTag = ref?.tag ?? this.state.sessionId ?? 'master';
      const file = ref?.file;

      const replanned = await this.planEngine.executePlanPhase(
        orchestratorTask,
        { projectRoot: workDir, tag: sessionTag, ...(file ? { file } : {}) },
        signal
      );
      if (!replanned.success || !replanned.output) {
        throw new Error(`Replan failed: ${replanned.error ?? 'unknown error'}`);
      }

      if (replanned.tasksPath) {
        // 只补齐新增项，避免覆盖 run 开始时记录的 originalStatuses
        this.taskMasterAdapter.mergeOriginalStatuses(replanned.originalStatuses);
        this.taskMasterAdapter.initialize({
          projectRoot: workDir,
          tasksPath: replanned.tasksPath,
          tag: replanned.effectiveTag ?? sessionTag,
        });
      }

      const sm = this.state.sessionManager;
      if (sm) {
        await this.taskMasterAdapter.saveRuntime(sm, taskId, replanned.output).catch(() => undefined);
      }

      activePlan = replanned.output;
      mergeSubtasks(activePlan.subtasks);
      this.state.currentPlanOutput = activePlan;
    }

    this.emit('aggregate:start', taskId, {});
    const completed = this.state.executionState?.completedSubtasks ?? new Map();
    const failed = this.state.executionState?.failedSubtasks ?? new Map();
    const aggregated = this.aggregationEngine.aggregate(subtaskMap, completed, failed);
    this.emit('aggregate:complete', taskId, { result: aggregated });
    return { aggregated };
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
      await Promise.all(step.subtaskIds.map((id) => this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal)));
      return;
    }
    for (const id of step.subtaskIds) {
      if (signal.aborted) break;
      await this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal);
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
      this.state.markSubtaskFailed(subtaskId, `Subtask ${subtaskId} not found`);
      return;
    }

    const execState = this.state.executionState;
    if (subtask.dependencies && execState) {
      for (const depId of subtask.dependencies) {
        if (!execState.completedSubtasks.has(depId)) {
          this.state.markSubtaskFailed(subtaskId, `Dependency ${depId} not completed`);
          return;
        }
      }
    }

    if (signal.aborted) {
      this.state.markSubtaskFailed(subtaskId, 'Aborted');
      await this.taskMasterAdapter.restoreStatus(subtaskId).catch(() => undefined);
      await this.getApprovalService()?.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);
      return;
    }

    if (this.executionEngine.isBarrierSubtask(subtask)) {
      const now = Date.now();
      const result: TaskResult = {
        taskId: subtaskId,
        status: 'success',
        output: { text: `Barrier completed: ${subtask.objective}` },
        artifacts: [],
        metrics: { startTime: now, endTime: now, duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 },
        trace: {
          traceId: generateTimestampId('trace'),
          spanId: generateTimestampId('span'),
          operation: 'barrier',
          attributes: { subtaskId },
          events: [],
          duration: 0,
        },
      };
      this.state.markSubtaskCompleted(subtaskId, result);
      await this.taskMasterAdapter.writeStatus(subtaskId, 'done').catch(() => undefined);
      this.emit('subtask:complete', taskId, { result }, subtaskId);
      await this.progress.write(taskId, 'executing').catch(() => undefined);
      await this.checkpoints.saveSnapshot(taskId, 'executing', 'barrier-complete').catch(() => undefined);
      return;
    }

    const integration = this.getIntegrationService();
    const activeSubtask = integration
      ? await integration.enhanceSubtaskForIntegration(subtask).catch(() => subtask)
      : subtask;
    if (activeSubtask !== subtask) {
      subtaskMap.set(subtaskId, activeSubtask);
    }

    this.state.markSubtaskRunning(subtaskId);
    activeSubtask.status = 'running';
    await this.taskMasterAdapter.writeStatus(subtaskId, 'in-progress').catch(() => undefined);
    await this.progress.write(taskId, 'executing').catch(() => undefined);

    let retryCount = 0;
    let lastError: string | undefined;

    while (true) {
      if (signal.aborted) {
        this.state.executionState?.runningSubtasks.delete(subtaskId);
        await this.taskMasterAdapter.restoreStatus(subtaskId).catch(() => undefined);
        await this.getApprovalService()?.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);
        return;
      }

      try {
        const roleId =
          typeof activeSubtask.roleId === 'string' && activeSubtask.roleId.length > 0
            ? activeSubtask.roleId
            : 'generalist';

        const requiredCapabilities =
          Array.isArray(activeSubtask.requiredCapabilities) && activeSubtask.requiredCapabilities.length > 0
            ? activeSubtask.requiredCapabilities
            : [`role:${roleId}`];

        // 懒加载模式：先确保有匹配角色的 Worker（优先复用空闲的，没有才创建）
        let preferredWorkerId =
          typeof activeSubtask.assignedWorkerId === 'string' && activeSubtask.assignedWorkerId.length > 0
            ? activeSubtask.assignedWorkerId
            : undefined;

        if (!preferredWorkerId && !this.workerPoolInjected) {
          // 尝试找到或创建匹配角色的 Worker
          const foundOrCreated = await this.workers.findOrCreateWorkerForRole(roleId);
          if (foundOrCreated) {
            preferredWorkerId = foundOrCreated;
          }
        }

        const context: Record<string, unknown> = {};
        if (preferredWorkerId) context.preferredWorkerId = preferredWorkerId;
        if (requiredCapabilities) context.requiredCapabilities = requiredCapabilities;

        const assignment = await this.workerPool.assign(
          activeSubtask,
          timeout,
          retryPolicy,
          Object.keys(context).length > 0 ? context : undefined,
          signal
        );

        if (!assignment.success || !assignment.workerId) {
          lastError = assignment.error ?? 'Assignment failed';
          if (shouldRetry(retryPolicy, retryCount)) {
            retryCount++;
            this.state.addRetry();
            activeSubtask.status = 'retrying';
            this.emit('subtask:retrying', taskId, { retryCount, error: lastError }, subtaskId);
            await this.sleep(calculateRetryDelay(retryPolicy, retryCount), signal);
            continue;
          }
          throw new Error(lastError);
        }

        const { workerId, agent } = assignment;
        activeSubtask.assignedWorkerId = workerId;
        activeSubtask.status = 'assigned';
        // 与旧实现保持一致：data 对象包含 subtaskId，第四个参数也传 subtaskId
        this.emit('subtask:assigned', taskId, { subtaskId, subtask: activeSubtask, workerId }, subtaskId);

        if (!agent) {
          throw new Error(`Worker ${workerId} has no attached Agent instance`);
        }

        const runMeta = this.state.currentRunMetadata;
        const noApproval = runMeta?.noApproval === true;
        const workerMetadata: Record<string, unknown> = {};
        if (noApproval) workerMetadata.noApproval = true;
        if (runMeta && typeof runMeta === 'object' && 'workDir' in runMeta) {
          const wd = (runMeta as Record<string, unknown>).workDir;
          if (typeof wd === 'string') workerMetadata.workDir = wd;
        }

        const workerTask: Task = {
          id: activeSubtask.id,
          type: 'atomic',
          objective: activeSubtask.objective,
          ...(activeSubtask.parentObjective !== undefined && { parentObjective: activeSubtask.parentObjective }),
          constraints: activeSubtask.constraints ?? [],
          ...(activeSubtask.outputSchema !== undefined && { outputSchema: activeSubtask.outputSchema }),
          context: {
            parentTaskId: taskId,
            ...(this.state.sessionId ? { sessionId: this.state.sessionId } : {}),
            traceId: `trace-${this.state.sessionId ?? taskId}`,
            ...(Object.keys(workerMetadata).length > 0 ? { metadata: workerMetadata } : {}),
          },
        };

        const onAbort = () => assignment.cancel?.();
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        let result: TaskResult;
        try {
          result = await agent.run(workerTask);
        } finally {
          signal.removeEventListener('abort', onAbort);
          this.workerPool.completeTask(subtaskId);
        }

        await integration?.syncAfterSubtaskCompletion(workerId, activeSubtask, result).catch(() => undefined);

        if (this.state.expandedSubtaskIds.has(subtaskId)) {
          this.state.expandedSubtaskIds.delete(subtaskId);
          this.state.pendingReplan = true;
          this.state.executionState?.runningSubtasks.delete(subtaskId);
          activeSubtask.status = 'pending';
          delete activeSubtask.assignedWorkerId;
          await this.getApprovalService()?.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);
          this.emit('subtask:complete', taskId, { result }, subtaskId);
          await this.progress.write(taskId, 'executing').catch(() => undefined);
          await this.checkpoints.saveSnapshot(taskId, 'executing', 'expanded').catch(() => undefined);
          return;
        }

        if (result.status !== 'success') {
          const out = result.output && typeof result.output === 'object' ? (result.output as Record<string, unknown>) : {};
          const errMsg = typeof out.error === 'string' ? out.error : 'Worker execution failed';
          throw new Error(errMsg);
        }

        this.state.markSubtaskCompleted(subtaskId, result);
        activeSubtask.status = 'success';
        await this.taskMasterAdapter.writeStatus(subtaskId, 'done').catch(() => undefined);
        await this.getApprovalService()?.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);

        if (result.metrics?.tokensUsed) {
          this.state.addTokens(result.metrics.tokensUsed);
        }

        this.emit('subtask:complete', taskId, { result }, subtaskId);
        await this.progress.write(taskId, 'executing').catch(() => undefined);
        await this.checkpoints.saveSnapshot(taskId, 'executing', 'subtask-complete').catch(() => undefined);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (shouldRetry(retryPolicy, retryCount)) {
          retryCount++;
          this.state.addRetry();
          activeSubtask.status = 'retrying';
          this.emit('subtask:retrying', taskId, { retryCount, error: lastError }, subtaskId);
          await this.sleep(calculateRetryDelay(retryPolicy, retryCount), signal);
          continue;
        }

        this.state.markSubtaskFailed(subtaskId, lastError);
        activeSubtask.status = 'failure';
        await this.taskMasterAdapter.restoreStatus(subtaskId).catch(() => undefined);
        await this.getApprovalService()?.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);
        this.emit('subtask:failed', taskId, { subtask: activeSubtask, error: lastError, retryCount }, subtaskId);
        await this.progress.write(taskId, 'executing').catch(() => undefined);
        await this.checkpoints.saveSnapshot(taskId, 'executing', 'subtask-failed').catch(() => undefined);
        return;
      }
    }
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      const timer = setTimeout(() => resolve(), ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}


