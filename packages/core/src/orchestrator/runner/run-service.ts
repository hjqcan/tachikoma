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
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLLMClient, type LLMClientConfig } from '../../planner';
// Agent Identity: automatic learning after task success
import { CoreMemoryEvolver, getAgentIdFromEnv } from '../../agent-identity';
// Skill Learning: learn skills from trajectory
import {
  learnSkillFromTrajectory,
  thinkingRecordToTrajectory,
  actionRecordToTrajectory,
  type TrajectoryRecord,
} from '../../skills/learning';

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
        const duration = Date.now() - startTime;
        await this.learnFromTaskSuccess(orchestratorTask.objective, aggregated.output, duration, {
          workDir,
          startTime,
        }).catch(() => undefined);
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
   * Learn from successful task completion (Agent Identity + Skill Learning)
   *
   * 1. Always updates Agent Identity stats
   * 2. If skillLearning is enabled and triggers are met, learns skills from trajectory
   *
   * @param objective - Task objective
   * @param output - Task output
   * @param duration - Task duration in ms
   */
  private async learnFromTaskSuccess(
    objective: string,
    output: unknown,
    duration: number,
    ctx: { workDir: string; startTime: number }
  ): Promise<void> {
    try {
      // 1. Always update agent identity stats
      const agentId = getAgentIdFromEnv();
      const evolver = new CoreMemoryEvolver();
      const summary = typeof output === 'string'
        ? output.slice(0, 200)
        : JSON.stringify(output).slice(0, 200);
      await evolver.onTaskSuccess(objective, [summary], agentId);
      console.debug('[RunService] Agent identity updated after task success');

      // 2. Check if skill learning is enabled and triggers are met
      const skillConfig = this.orchestratorConfig.skillLearning;
      if (!skillConfig?.enabled) {
        return;
      }

      const minDuration = skillConfig.minDuration ?? 300000; // 5 min default
      if (duration < minDuration) {
        console.debug(
          `[RunService] Skipping skill learning: duration ${duration}ms < threshold ${minDuration}ms`
        );
        return;
      }

      // 3. Collect trajectory from all workers (both thinking and action logs)
      const { thinkingLogs, actionLogs } = await this.session.getTrajectoryForAllWorkers(2000);

      // 3.1 Filter by this run time window to avoid mixing trajectories
      const endTime = ctx.startTime + duration;
      const filteredThinking = thinkingLogs.filter((t) => t.timestamp >= ctx.startTime && t.timestamp <= endTime);
      const filteredActions = actionLogs.filter((a) => a.timestamp >= ctx.startTime && a.timestamp <= endTime);

      // P0 fix: minToolCalls should count actual tool calls from actionLogs
      const toolCallCount = filteredActions.filter((a) => a.type === 'tool_call').length;
      const minToolCalls = skillConfig.minToolCalls ?? 8;
      if (toolCallCount < minToolCalls) {
        console.debug(
          `[RunService] Skipping skill learning: toolCallCount ${toolCallCount} < threshold ${minToolCalls}`
        );
        return;
      }

      // Convert logs to trajectory records
      const trajectory: TrajectoryRecord[] = [];
      for (const log of filteredThinking) {
        trajectory.push(thinkingRecordToTrajectory(log));
      }
      for (const action of filteredActions) {
        trajectory.push(actionRecordToTrajectory(action));
      }

      if (trajectory.length === 0) {
        console.debug('[RunService] No trajectory to learn from');
        return;
      }

      // Sort by timestamp
      trajectory.sort((a, b) => a.timestamp - b.timestamp);

      // 4. Learn skill from trajectory
      console.debug(`[RunService] Learning skill from ${trajectory.length} trajectory records (${toolCallCount} tool calls)`);

      const skillsDirRaw = skillConfig.skillsDir ?? '.tachikoma/skills';
      const skillsDir = path.isAbsolute(skillsDirRaw) ? skillsDirRaw : path.join(ctx.workDir, skillsDirRaw);
      const maxSkills = skillConfig.maxSkills ?? 5;
      const stableSkillName = deriveStableSkillName(objective);

      const similarity = skillConfig.similarity ?? { minLen: 12, levenshteinRatio: 0.2 };

      const llmCall = (() => {
        const plannerCfg = this.orchestratorConfig.planner.agent as unknown as LLMClientConfig;
        const override = skillConfig.llmConfig;

        const provider = (override?.provider ?? plannerCfg.provider) as LLMClientConfig['provider'];
        const model = override?.model ?? plannerCfg.model;
        const maxTokens = override?.maxTokens ?? plannerCfg.maxTokens ?? 2048;
        const temperature = override?.temperature ?? plannerCfg.temperature ?? 0.2;
        const baseUrl = override?.baseUrl ?? plannerCfg.baseUrl;
        const timeout = override?.timeout ?? plannerCfg.timeout;

        const apiKey =
          override?.apiKey ??
          plannerCfg.apiKey ??
          (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);

        const cfg: LLMClientConfig = {
          ...plannerCfg,
          provider,
          model,
          maxTokens,
          temperature,
          ...(apiKey ? { apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(timeout ? { timeout } : {}),
        };

        const client = createLLMClient(cfg);
        if (!client.isAvailable()) {
          console.debug('[RunService] Skipping skill learning: LLM client not available (missing apiKey)');
          return null;
        }

        return async (prompt: string) => {
          const resp = await client.complete({
            systemPrompt: '',
            messages: [{ role: 'user', content: prompt }],
            maxTokens,
            temperature,
          });
          return resp.content;
        };
      })();

      if (!llmCall) return;

      const result = await learnSkillFromTrajectory(trajectory, {
        llmCall,
        skillsDir,
        taskDescription: objective,
        skillName: stableSkillName,
        overwrite: true,
        autoUpdateSimilar: true,
        maxSkills,
        similarity,
        source: 'auto',
        feedback: {
          success: true,
          metrics: {
            duration,
            toolCalls: toolCallCount,
          },
        },
      });

      if (result.success && result.skill) {
        console.log(`[RunService] Learned new skill: ${result.skill.name}`);
        // P0 fix: onSkillLearned(skillName, skillSummary, agentId) - correct param order
        await evolver.onSkillLearned(result.skill.name, result.skill.summary, agentId);
      } else {
        console.debug(`[RunService] Skill learning skipped: ${result.error ?? 'no patterns found'}`);
      }
    } catch {
      // Identity/skill learning is best-effort, don't fail the task
    }
  }
}

function deriveStableSkillName(taskDescription: string): string {
  const normalized = taskDescription.trim().toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  const hash = createHash('sha1').update(taskDescription).digest('hex').slice(0, 8);
  const base = slug.length > 0 ? slug : 'skill';
  return `auto-${base}-${hash}`;
}


