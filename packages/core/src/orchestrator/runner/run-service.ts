import type { Task, TaskResult } from '../../types';
import type { OrchestratorConfig, OrchestratorTask } from '../types';
import type { OrchestratorState } from '../state';
import type { TaskMasterPlanEngine } from '../engines/taskmaster-plan-engine';
import type { TaskMasterAdapter } from '../adapters/taskmaster-adapter';
import type { EmitFn } from './types';
import type { ProgressReporter } from './progress-reporter';
import type { CheckpointService } from './checkpoint-service';
import type { ExecutionLoop } from './execution-loop';
import type { SessionController } from './session-controller';
import type { AggregationEngine } from '../engines/aggregation-engine';
import type { MemoryService } from '../../memory';
// Agent Identity: automatic learning after task success
import { CoreMemoryEvolver, getAgentIdFromEnv } from '../../agent-identity';

export class RunService {
  constructor(
    private readonly orchestratorConfig: OrchestratorConfig,
    private readonly state: OrchestratorState,
    private readonly planEngine: TaskMasterPlanEngine,
    private readonly taskMasterAdapter: TaskMasterAdapter,
    private readonly aggregationEngine: AggregationEngine,
    private readonly emit: EmitFn,
    private readonly progress: ProgressReporter,
    private readonly checkpoints: CheckpointService,
    private readonly execution: ExecutionLoop,
    private readonly session: SessionController,
    private readonly memoryService: MemoryService | undefined
  ) {}

  async run(
    task: Task,
    signal: AbortSignal,
    hooks?: {
      afterSessionOpen?: (args: { taskId: string; workDir: string; sessionId: string; orchestratorTask: OrchestratorTask }) => Promise<void> | void;
    }
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const orchestratorTask = this.toOrchestratorTask(task);

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

    // 每次 run 都重置 TaskMasterAdapter，避免跨 run 污染（refs/originalStatuses/tag/tasksPath 等）
    this.taskMasterAdapter.reset();

    this.state.resetForNewRun();
    this.state.currentRunMetadata = task.context?.metadata ?? null;
    this.state.initExecutionState(startTime);

    try {
      await this.session.open(orchestratorTask, sessionId);
      if (hooks?.afterSessionOpen) {
        await hooks.afterSessionOpen({ taskId: task.id, workDir, sessionId, orchestratorTask });
      }

      this.emit('plan:start', task.id, { task: orchestratorTask });
      const planResult = await this.planEngine.executePlanPhase(
        orchestratorTask,
        { projectRoot: workDir, tag: sessionId },
        signal
      );

      if (!planResult.success || !planResult.output) {
        this.emit('plan:failed', task.id, { error: planResult.error });
        await this.progress.write(task.id, 'failed').catch(() => undefined);
        return this.aggregationEngine.createFailureResult(
          task.id,
          `Planning failed: ${planResult.error}`,
          startTime,
          planResult.tokensUsed
        );
      }

      if (planResult.tasksPath) {
        // 合并原始状态快照（只补齐，不覆盖）：replan 不应覆盖首次快照
        this.taskMasterAdapter.mergeOriginalStatuses(planResult.originalStatuses);

        this.taskMasterAdapter.initialize({
          projectRoot: workDir,
          tasksPath: planResult.tasksPath,
          tag: planResult.effectiveTag ?? sessionId,
        });

        const sm = this.state.sessionManager;
        if (sm) {
          await this.taskMasterAdapter.saveRuntime(sm, task.id, planResult.output).catch(() => undefined);
        }
      }

      this.state.currentPlanOutput = planResult.output;
      if (this.state.executionState) {
        this.state.executionState.totalSteps = planResult.output.executionPlan.steps.length;
      }
      this.state.addTokens(planResult.tokensUsed.input + planResult.tokensUsed.output);

      this.emit('plan:complete', task.id, { plan: planResult.output });

      if (planResult.output.intake?.ready === false) {
        await this.progress.write(task.id, 'paused').catch(() => undefined);
        return this.createNeedInputResult(task.id, startTime, planResult.tokensUsed, planResult.output.intake);
      }

      // shared context
      await this.session
        .ensureSharedContext(orchestratorTask.objective, orchestratorTask.constraints, workDir)
        .catch(() => undefined);

      await this.checkpoints.saveSnapshot(task.id, 'executing', 'plan-ready').catch(() => undefined);
      await this.progress.write(task.id, 'executing').catch(() => undefined);

      const { aggregated } = await this.execution.runPlan(task.id, orchestratorTask, workDir, planResult.output, signal);
      const finalResult = this.createFinalResult(task.id, aggregated, startTime);

      await this.progress.write(task.id, aggregated.status === 'success' ? 'completed' : 'failed').catch(() => undefined);
      await this.saveMemoryBestEffort(orchestratorTask, finalResult, aggregated).catch(() => undefined);

      // Agent Identity: automatic learning on task success
      if (aggregated.status === 'success') {
        await this.learnFromTaskSuccess(orchestratorTask.objective, aggregated.output).catch(() => undefined);
      }

      return finalResult;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.progress.write(task.id, 'failed').catch(() => undefined);
      return this.aggregationEngine.createFailureResult(task.id, msg, startTime, { input: 0, output: 0 });
    } finally {
      await this.session.close().catch(() => undefined);
    }
  }

  private async saveMemoryBestEffort(
    task: OrchestratorTask,
    finalResult: TaskResult,
    aggregated: { output: unknown; status: 'success' | 'failure' | 'partial' }
  ): Promise<void> {
    if (!this.memoryService || this.orchestratorConfig.memoryConfig?.autoSave === false) return;
    const outputSummary =
      typeof aggregated.output === 'string'
        ? aggregated.output.slice(0, 500)
        : JSON.stringify(aggregated.output).slice(0, 500);
    const content = `Task: ${task.objective}\nStatus: ${finalResult.status}\nResult: ${outputSummary}`;
    await this.memoryService.save({
      content,
      scope: 'procedural',
      metadata: {
        source: `orchestrator:${this.orchestratorConfig.agent.name ?? 'orchestrator'}`,
        taskId: task.id,
        status: finalResult.status,
      },
    });
  }

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

  private createFinalResult(
    taskId: string,
    aggregated: { status: 'success' | 'failure' | 'partial'; output: unknown },
    startTime: number
  ): TaskResult {
    const execState = this.state.executionState;
    const now = Date.now();
    return {
      taskId,
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
      trace: {
        traceId: `trace-${taskId}`,
        spanId: `span-${taskId}`,
        operation: 'orchestrate',
        attributes: {},
        events: [],
        duration: now - startTime,
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
    const question =
      questions.length > 0
        ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
        : '请补充关键需求信息后再继续。';
    const now = Date.now();
    return {
      taskId,
      status: 'partial',
      output: { text: question, missingInfo: intake.missingInfo ?? [] },
      artifacts: [],
      metrics: {
        startTime,
        endTime: now,
        duration: now - startTime,
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
        duration: now - startTime,
      },
    };
  }

  /**
   * Learn from successful task completion (Agent Identity automatic learning)
   *
   * Calls CoreMemoryEvolver.onTaskSuccess() to update agent stats and
   * potentially evolve the system prompt based on patterns observed.
   */
  private async learnFromTaskSuccess(objective: string, output: unknown): Promise<void> {
    try {
      const agentId = getAgentIdFromEnv();
      const evolver = new CoreMemoryEvolver();
      const summary = typeof output === 'string'
        ? output.slice(0, 200)
        : JSON.stringify(output).slice(0, 200);
      // onTaskSuccess expects (taskDescription, learnings[], agentId)
      // For automatic learning, we pass the summary as a single-item learnings array
      await evolver.onTaskSuccess(objective, [summary], agentId);
      console.debug('[RunService] Agent identity updated after task success');
    } catch {
      // Identity learning is best-effort, don't fail the task
    }
  }
}


