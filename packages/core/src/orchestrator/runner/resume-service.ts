import type { TaskResult } from '../../types';
import type { OrchestratorState } from '../state';
import type { OrchestratorTask } from '../types';
import type { EmitFn, ResumeFromOptions } from './types';
import { CheckpointResumeEngine } from '../engines/checkpoint-resume-engine';
import { TaskMasterAdapter } from '../adapters/taskmaster-adapter';
import type { AggregationEngine } from '../engines/aggregation-engine';
import type { ExecutionLoop } from './execution-loop';
import type { SessionController } from './session-controller';
import type { ProgressReporter } from './progress-reporter';
import type { PendingApprovalFile, SessionFileEventHandler } from '../session';

export class ResumeService {
  constructor(
    private readonly state: OrchestratorState,
    private readonly checkpointResumeEngine: CheckpointResumeEngine,
    private readonly taskMasterAdapter: TaskMasterAdapter,
    private readonly execution: ExecutionLoop,
    private readonly aggregationEngine: AggregationEngine,
    private readonly emit: EmitFn,
    _session: SessionController, // 保留用于未来扩展（如 resumeFrom 需要复用 session 资源）
    private readonly progress: ProgressReporter
  ) {}

  async resumeFrom(
    checkpointId: string,
    options: ResumeFromOptions = {},
    hooks?: {
      afterSessionReady?: (args: { taskId: string; workDir: string; sessionId: string }) => Promise<void> | void;
      onPendingApproval?: SessionFileEventHandler<PendingApprovalFile>;
    }
  ): Promise<TaskResult> {
    const startTime = Date.now();
    let prepared: Awaited<ReturnType<CheckpointResumeEngine['prepare']>> | null = null;

    try {
      prepared = await this.checkpointResumeEngine.prepare(checkpointId, {
        ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
        ...(options.skipFailed !== undefined ? { skipFailed: options.skipFailed } : {}),
        ...(options.resetRetryCount !== undefined ? { resetRetryCount: options.resetRetryCount } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });

      const { sessionId, sessionManager, checkpoint, restoreResult, planResult, resumePlan, orchestratorTask, workDir, signal } =
        prepared;

      // 每次 resume 都重置 TaskMasterAdapter，避免跨 run 污染（refs/originalStatuses/tag/tasksPath 等）
      this.taskMasterAdapter.reset();

      this.state.resetForNewRun();
      this.state.sessionId = sessionId;
      this.state.sessionManager = sessionManager;
      this.state.currentRunMetadata = checkpoint.contextData ?? null;
      this.state.initExecutionState(startTime);

      if (planResult.tasksPath) {
        this.taskMasterAdapter.initialize({
          projectRoot: workDir,
          tasksPath: planResult.tasksPath,
          tag: planResult.effectiveTag ?? sessionId,
        });
      }

      // originalStatuses：以 checkpoint runtime.json 为优先来源（执行起始快照），再用 planResult 补齐新任务
      if (restoreResult.runtimeData?.kind === 'taskmaster') {
        this.taskMasterAdapter.mergeOriginalStatuses(restoreResult.runtimeData.originalStatuses);
      }
      this.taskMasterAdapter.mergeOriginalStatuses(planResult.originalStatuses);
      // 注意：originalStatuses 现在由 TaskMasterAdapter 持有（避免状态双写漂移）

      const execState = this.state.executionState;
      if (execState) {
        execState.totalTokens = checkpoint.totalTokens;
        execState.totalRetries = checkpoint.totalRetries;
        execState.totalSteps = resumePlan.executionPlan.steps.length;
        execState.currentStep = 0;

        const resumableSet = new Set(restoreResult.resumableSubtaskIds ?? []);
        for (const id of checkpoint.failedSubtaskIds.filter((x) => !resumableSet.has(x))) {
          execState.failedSubtasks.set(id, 'Previously failed');
        }
        for (const id of checkpoint.runningSubtaskIds.filter((x) => !resumableSet.has(x))) {
          execState.failedSubtasks.set(id, 'Previously running');
        }

        for (const id of checkpoint.completedSubtaskIds) {
          const output = checkpoint.completedResults?.[id];
          execState.completedSubtasks.set(id, {
            taskId: id,
            status: 'success',
            output,
            artifacts: [],
            metrics: {
              startTime: checkpoint.createdAt,
              endTime: checkpoint.createdAt,
              duration: 0,
              tokensUsed: 0,
              toolCallCount: 0,
              retryCount: 0,
            },
            trace: {
              traceId: `trace-${sessionId}`,
              spanId: `span-${sessionId}`,
              operation: 'resumeFrom.checkpoint',
              attributes: { restored: true, checkpointId },
              events: [],
              duration: 0,
            },
          });
        }
      }

      this.state.currentPlanOutput = resumePlan;

      this.emit('checkpoint:restored', checkpoint.taskId, {
        checkpointId,
        strategy: restoreResult.appliedStrategy ?? options.strategy ?? 'resume',
        resumableCount: restoreResult.resumableSubtaskIds?.length ?? 0,
      });

      // resume：不启用 watch，但仍需要审批仲裁（文件锁/expand_commit）
      if (hooks?.afterSessionReady) {
        await hooks.afterSessionReady({ taskId: checkpoint.taskId, workDir, sessionId });
      }
      if (hooks?.onPendingApproval) {
        sessionManager.on<PendingApprovalFile>('pending_approval_created', hooks.onPendingApproval);
      }

      await this.progress.write(checkpoint.taskId, 'executing').catch(() => undefined);
      const { aggregated } = await this.execution.runPlan(
        checkpoint.taskId,
        orchestratorTask as OrchestratorTask,
        workDir,
        resumePlan,
        signal
      );

      const now = Date.now();
      return {
        taskId: checkpoint.taskId,
        status: aggregated.status === 'success' ? 'success' : 'failure',
        output: aggregated.output,
        artifacts: [],
        metrics: {
          startTime,
          endTime: now,
          duration: now - startTime,
          tokensUsed: execState?.totalTokens ?? 0,
          toolCallCount: 0,
          retryCount: execState?.totalRetries ?? 0,
        },
        trace: { traceId: `trace-${checkpoint.taskId}`, spanId: `span-${checkpoint.taskId}`, operation: 'resumeFrom', attributes: {}, events: [], duration: now - startTime },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return this.aggregationEngine.createFailureResult(checkpointId, msg, startTime, { input: 0, output: 0 });
    } finally {
      // 关闭 CheckpointResumeEngine 返回的资源
      await prepared?.checkpointManager?.close().catch(() => undefined);
      if (prepared?.sessionManager) {
        if (hooks?.onPendingApproval) {
          prepared.sessionManager.off<PendingApprovalFile>('pending_approval_created', hooks.onPendingApproval);
        }
        // 重要：关闭 sessionManager 避免资源泄漏
        await prepared.sessionManager.close().catch(() => undefined);
      }
      // 注意：这里不调用 this.session.close()，因为 resumeFrom 使用的是 prepared.sessionManager
      // 而不是 SessionController 管理的 session
    }
  }
}


