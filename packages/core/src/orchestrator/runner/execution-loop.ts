import type { Task, TaskResult, RetryPolicy } from '../../types';
import type { IWorkerPool } from '../worker-pool';
import type { OrchestratorConfig, OrchestratorTask, PlannerOutput, SubTask, ExecutionStep } from '../types';
import type { OrchestratorState } from '../state';
import { generateTimestampId } from '../session';
import { resolveRetryPolicy, calculateRetryDelay, shouldRetry } from '../config';
import type { AggregationEngine } from '../engines/aggregation-engine';
import { ExecutionEngine } from '../engines/execution-engine';
import { TaskMasterPlanEngine } from '../engines/taskmaster-plan-engine';
import { TaskMasterAdapter } from '../adapters/taskmaster-adapter';
import type { ApprovalArbitrationService } from '../services/approval-arbitration';
import type { IntegrationContextService } from '../services/integration-context';
import { VerificationGateService, type VerificationResult } from '../services/verification-gate';
import type { EmitFn } from './types';
import type { ProgressReporter } from './progress-reporter';
import type { CheckpointService } from './checkpoint-service';
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
  verificationGateService?: VerificationGateService;
}



export class ReplanNeededError extends Error {
  constructor(
    public readonly subtaskId: string,
    public readonly reason: string,
    public readonly errorSummary: string
  ) {
    super(`Replan needed for subtask ${subtaskId}: ${reason}`);
    this.name = 'ReplanNeededError';
  }
}

/**
 * Critical tool names that should trigger replan on failure
 */
const CRITICAL_TOOLS = new Set([
  'package_install',
  'shell_run',
  'npm_install',
  'dev_server',
]);

/**
 * Error patterns that indicate critical failures
 */
const CRITICAL_ERROR_PATTERNS = [
  /EACCES/i,
  /ENOENT.*node_modules/i,
  /command not found/i,
  /permission denied/i,
  /npm ERR!/i,
  /pnpm ERR!/i,
  /error installing/i,
];

interface CriticalToolFailure {
  toolName: string;
  error: string;
}

/**
 * Check for critical tool failures in task result
 * 
 * Examines trace events and output for failed tool calls that should
 * prevent the subtask from being marked as successful.
 */
function checkCriticalToolFailures(result: TaskResult): CriticalToolFailure[] {
  const failures: CriticalToolFailure[] = [];

  // Check trace events for tool call failures
  if (result.trace?.events) {
    for (const event of result.trace.events) {
      const attrs = event.attributes as Record<string, unknown> | undefined;
      if (!attrs) continue;

      const toolName = attrs.toolName as string | undefined;
      const success = attrs.success as boolean | undefined;
      const error = attrs.error as string | undefined;
      const output = attrs.output as string | undefined;

      // Check if this is a critical tool with failure
      if (toolName && CRITICAL_TOOLS.has(toolName)) {
        if (success === false && error) {
          failures.push({ toolName, error });
        }
        // Also check output for error patterns
        if (output) {
          for (const pattern of CRITICAL_ERROR_PATTERNS) {
            if (pattern.test(output)) {
              failures.push({ toolName, error: `Detected error pattern in output: ${output.slice(0, 200)}` });
              break;
            }
          }
        }
      }
    }
  }

  // Check output for error indicators
  const outputObj = result.output as Record<string, unknown> | undefined;
  if (outputObj && typeof outputObj === 'object') {
    // Check for direct error field
    if (outputObj.error && typeof outputObj.error === 'string') {
      for (const pattern of CRITICAL_ERROR_PATTERNS) {
        if (pattern.test(outputObj.error)) {
          failures.push({ toolName: 'unknown', error: outputObj.error });
          break;
        }
      }
    }

    // Check for toolResults array (some agents track this)
    const toolResults = outputObj.toolResults as Record<string, unknown>[] | undefined;
    if (Array.isArray(toolResults)) {
      for (const tr of toolResults) {
        const toolName = tr.name as string || tr.toolName as string;
        const success = tr.success as boolean;
        const error = tr.error as string;

        if (toolName && CRITICAL_TOOLS.has(toolName) && success === false && error) {
          failures.push({ toolName, error });
        }
      }
    }
  }

  return failures;
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
  private readonly verificationGateService: VerificationGateService | undefined;

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
    this.verificationGateService = deps.verificationGateService;
  }

  async runPlan(
    taskId: string,
    orchestratorTask: OrchestratorTask,
    workDir: string,
    planOutput: PlannerOutput,
    signal: AbortSignal
  ): Promise<{ aggregated: ReturnType<AggregationEngine['aggregate']>; verificationResult?: VerificationResult }> {
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
    
    // Run Verification Gate check after plan completion - HARD GATE
    let verificationResult: VerificationResult | undefined;
    if (this.verificationGateService) {
      verificationResult = await this.verificationGateService.verify(workDir, {
        preset: 'full',
      });
      if (!verificationResult.passed) {
        const errorSummary = VerificationGateService.formatErrorsForWorker(verificationResult);
        console.error(`[VerificationGate] FINAL CHECK FAILED with errors`);
        console.error(errorSummary);
        
        // Update TaskMaster statuses to reflect failure (undo 'done' status)
        for (const [subtaskId, subtask] of subtaskMap) {
          if (subtask.status === 'success') {
            subtask.status = 'failure';
            this.state.markSubtaskFailed(subtaskId, `Final Verification Gate failed`);
            await this.taskMasterAdapter.restoreStatus(subtaskId).catch(() => undefined);
          }
        }
        
        // Trigger replan so the planner can repair the failed verification
        throw new ReplanNeededError(
          taskId,
          `Final Verification Gate FAILED: ${verificationResult.summary}`,
          errorSummary
        );
      }
    }
    
    return { aggregated, ...(verificationResult && { verificationResult }) };
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
      // Parallel execution: run all subtasks then do ONE verification gate check
      await Promise.all(step.subtaskIds.map((id) => this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal, true)));
      
      // Step-level Verification Gate check after ALL parallel subtasks complete
      // NOTE: Uses fix loop just like sequential subtasks
      if (this.verificationGateService) {
        const runWorkDir = (this.state.currentRunMetadata as Record<string, unknown> | undefined)?.workDir;
        const effectiveWorkDir = typeof runWorkDir === 'string' ? runWorkDir : (this.orchestratorConfig.workDir ?? process.cwd());
        
        let fixAttempts = 0;
        const MAX_PARALLEL_FIX_ATTEMPTS = 2;
        
        while (fixAttempts <= MAX_PARALLEL_FIX_ATTEMPTS) {
          const verifyResult = await this.verificationGateService.verify(effectiveWorkDir, {
            preset: 'fast',
          });
          
          if (verifyResult.passed) {
            break; // Verification passed
          }
          
          if (fixAttempts >= MAX_PARALLEL_FIX_ATTEMPTS) {
            const errorSummary = VerificationGateService.formatErrorsForWorker(verifyResult);
            console.error(`[VerificationGate] PARALLEL STEP FAILED after ${MAX_PARALLEL_FIX_ATTEMPTS} fix attempts`);
            
            // Mark all subtasks as failed
            for (const subtaskId of step.subtaskIds) {
              const subtask = subtaskMap.get(subtaskId);
              if (subtask) {
                subtask.status = 'failure';
                this.state.markSubtaskFailed(subtaskId, `Verification Gate failed after parallel step`);
                await this.taskMasterAdapter.restoreStatus(subtaskId).catch(() => undefined);
              }
            }
            
            throw new ReplanNeededError(
              step.subtaskIds.join(','),
              `Parallel step Verification Gate FAILED: ${verifyResult.summary}. Consider running these subtasks sequentially.`,
              errorSummary
            );
          }
          
          fixAttempts++;
          const _errorSummary = VerificationGateService.formatErrorsForWorker(verifyResult);
          console.warn(`[VerificationGate] Parallel step failed verification (fix attempt ${fixAttempts}/${MAX_PARALLEL_FIX_ATTEMPTS}). Errors:\n${_errorSummary}`);
          
          // Try auto-fix first
          const autoFixResult = await this.tryAutoFix(effectiveWorkDir, verifyResult);
          if (autoFixResult.fixed > 0) {
            console.info(`[VerificationGate] Auto-fixed ${autoFixResult.fixed} issues`);
            continue; // Re-verify
          }
          
          // Auto-fix didn't work, log errors for next retry
          console.warn(`[VerificationGate] Auto-fix unsuccessful, will retry verification`);
        }
      }
      return;
    }
    // Sequential execution: each subtask gets its own build gate check
    for (const id of step.subtaskIds) {
      if (signal.aborted) break;
      await this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal, false);
    }
  }

  private async executeSubtask(
    taskId: string,
    subtaskId: string,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal,
    isParallelStep = false
  ): Promise<void> {
    const subtask = subtaskMap.get(subtaskId);
    if (!subtask) {
      this.state.markSubtaskFailed(subtaskId, `Subtask ${subtaskId} not found`);
      return;
    }

    const execState = this.state.executionState;
    if (subtask.dependencies && execState) {
      // 诊断日志：检查依赖状态
      const depStatuses = subtask.dependencies.map(depId => ({
        id: depId,
        completed: execState.completedSubtasks.has(depId),
        failed: execState.failedSubtasks.has(depId),
        running: execState.runningSubtasks.has(depId),
      }));
      console.debug(`[ExecutionLoop] Checking dependencies for subtask ${subtaskId}:`, depStatuses);
      
      for (const depId of subtask.dependencies) {
        if (!execState.completedSubtasks.has(depId)) {
          console.warn(`[ExecutionLoop] DEPENDENCY VIOLATION: Subtask ${subtaskId} requires ${depId} which is not completed`);
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
    let buildGateFixAttempts = 0;
    const MAX_BUILD_GATE_FIX_ATTEMPTS = 3;

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

        // Derive language constraints from role capabilities
        const roleConstraints = this.deriveConstraintsFromRole(activeSubtask.roleId);
        
        const workerTask: Task = {
          id: activeSubtask.id,
          type: 'atomic',
          objective: activeSubtask.objective,
          ...(activeSubtask.parentObjective !== undefined && { parentObjective: activeSubtask.parentObjective }),
          constraints: [...(activeSubtask.constraints ?? []), ...roleConstraints],
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

        // Check for critical tool failures even if subtask status is 'success'
        // This catches cases like npm install EACCES where agent continues despite failure
        const criticalFailures = checkCriticalToolFailures(result);
        if (criticalFailures.length > 0) {
          const failureMessages = criticalFailures.map(f => `${f.toolName}: ${f.error}`).join('; ');
          console.error(`[ExecutionLoop] Critical tool failures detected: ${failureMessages}`);
          throw new ReplanNeededError(
            subtaskId,
            `Critical tool failures: ${failureMessages}`,
            criticalFailures.map(f => `❌ ${f.toolName}: ${f.error}`).join('\n')
          );
        }

        // Verification Gate: check for errors before marking complete
        // NOTE: For parallel steps, this is SKIPPED - gate runs at step level instead
        // NOTE: This is a HARD GATE - subtask will FAIL if max fix attempts reached
        // NOTE: Uses inner loop to avoid re-running entire subtask on fix
        if (this.verificationGateService && !isParallelStep) {
          const runWorkDir = (this.state.currentRunMetadata as Record<string, unknown> | undefined)?.workDir;
          const effectiveWorkDir = typeof runWorkDir === 'string' ? runWorkDir : (this.orchestratorConfig.workDir ?? process.cwd());
          
          // Inner fix-verify loop: only runs fix tasks, doesn't re-run original subtask
          while (buildGateFixAttempts <= MAX_BUILD_GATE_FIX_ATTEMPTS) {
            const verifyResult = await this.verificationGateService.verify(effectiveWorkDir, {
              preset: 'fast',
            });
            
            if (verifyResult.passed) {
              break; // Verification passed, exit fix loop
            }
            
            if (buildGateFixAttempts >= MAX_BUILD_GATE_FIX_ATTEMPTS) {
              const errorSummary = VerificationGateService.formatErrorsForWorker(verifyResult);
              const failureMessage = `Verification Gate FAILED after ${MAX_BUILD_GATE_FIX_ATTEMPTS} fix attempts. ${verifyResult.summary}`;
              console.error(`[VerificationGate] REPLAN NEEDED: ${failureMessage}`);
              
              throw new ReplanNeededError(subtaskId, failureMessage, errorSummary);
            }
            
            buildGateFixAttempts++;
            const failedLayer = verifyResult.layers.find(l => !l.passed);
            console.warn(
              `[VerificationGate] Subtask ${subtaskId} failed ${failedLayer?.layer ?? 'check'} (fix attempt ${buildGateFixAttempts}/${MAX_BUILD_GATE_FIX_ATTEMPTS})`
            );
            
            // Create fix task with error details and proper verification command
            const errorSummary = VerificationGateService.formatErrorsForWorker(verifyResult);
            const verifyCommand = this.mapToShellCommand(failedLayer?.command);
            
            // Phase 2: Try auto-fix for common patterns (unused imports) before LLM retry
            const autoFixResult = await this.tryAutoFix(effectiveWorkDir, verifyResult);
            if (autoFixResult.fixed > 0) {
              console.info(`[VerificationGate] Auto-fixed ${autoFixResult.fixed} issues via eslint --fix`);
              // Re-verify after auto-fix - might resolve all issues
              continue;
            }
            
            const fixTask = this.createBuildFixTask(workerTask, errorSummary, verifyCommand);
            
            // Run ONLY the fix task (not re-running original subtask)
            try {
              const fixResult = await agent.run(fixTask);
              if (fixResult.status !== 'success') {
                console.warn(`[VerificationGate] Fix task failed with status: ${fixResult.status}`);
              }
              // Continue inner loop to re-check
            } catch (fixError) {
              console.warn(`[VerificationGate] Fix attempt threw error: ${(fixError as Error).message}`);
              // Continue inner loop to re-check
            }
          }
        }

        this.state.markSubtaskCompleted(subtaskId, result);
        activeSubtask.status = 'success';
        console.info(`[ExecutionLoop] Subtask ${subtaskId} completed successfully`);
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
        if (error instanceof ReplanNeededError) {
          lastError = error.reason;
          this.state.markSubtaskFailed(subtaskId, lastError);
          activeSubtask.status = 'failure';
          await this.taskMasterAdapter.restoreStatus(subtaskId).catch(() => undefined);
          await this.getApprovalService()?.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);
          this.emit('subtask:failed', taskId, { subtask: activeSubtask, error: lastError, retryCount }, subtaskId);
          await this.progress.write(taskId, 'executing').catch(() => undefined);
          await this.checkpoints.saveSnapshot(taskId, 'executing', 'subtask-failed').catch(() => undefined);
          throw error;
        }
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

  /**
   * Derive language constraints from role capabilities
   * 
   * Maps role capabilities like 'react', 'vue', 'python' to constraint strings
   * that deriveConstraintPolicy() can parse to allow corresponding languages.
   * 
   * NOTE: To avoid CONSTRAINT_CONFLICT, we only take the FIRST match per family.
   * This prevents conflicts when a role accidentally has multiple frameworks.
   */
  private deriveConstraintsFromRole(roleId?: string): string[] {
    if (!roleId) return [];
    
    const planOutput = this.state.currentPlanOutput;
    const role = planOutput?.roles?.find(r => r.id === roleId);
    if (!role?.capabilities) return [];
    
    const constraints: string[] = [];
    const capabilities = role.capabilities;
    
    // Framework definitions
    const frontendFrameworks = ['react', 'vue', 'angular', 'svelte', 'astro', 'nextjs', 'nuxtjs'];
    const cssFrameworks = ['tailwindcss', 'tailwind', 'bootstrap', 'material-ui', 'mui', 'chakra', 'antd'];
    const backendFrameworks = ['fastapi', 'flask', 'django', 'express', 'nestjs', 'spring', 'gin'];
    
    // Track first match per family to avoid conflicts
    let foundFrontend = false;
    let foundCss = false;
    let foundBackend = false;
    
    for (const cap of capabilities) {
      const lowerCap = cap.toLowerCase();
      
      // Only take first frontend framework to avoid conflicts
      if (!foundFrontend && frontendFrameworks.some(f => lowerCap.includes(f))) {
        constraints.push(`Use ${cap}`);
        foundFrontend = true;
      }
      // Only take first CSS framework
      if (!foundCss && cssFrameworks.some(f => lowerCap.includes(f))) {
        constraints.push(`Use ${cap}`);
        foundCss = true;
      }
      // Only take first backend framework
      if (!foundBackend && backendFrameworks.some(f => lowerCap.includes(f))) {
        constraints.push(`Use ${cap}`);
        foundBackend = true;
      }
    }
    
    // Log derived constraints for debugging
    if (constraints.length > 0) {
      console.debug(`[ExecutionLoop] Derived constraints from role '${roleId}':`, constraints);
    }
    
    return constraints;
  }

  /**
   * Create a fix task from build errors
   * 
   * Generates a new task that instructs the Worker to fix the build errors
   * from the previous execution. Uses the actual command for verification.
   */
  private createBuildFixTask(originalTask: Task, errorSummary: string, command?: string): Task {
    // Determine verification command based on what was used
    const verifyCommand = command ?? 'npx tsc --noEmit';
    
    // Parse error patterns to provide targeted fix instructions
    const fixInstructions: string[] = [];
    
    // Detect common error patterns and add specific instructions
    if (errorSummary.includes('is declared but its value is never read') ||
        errorSummary.includes('is declared but never used')) {
      fixInstructions.push('UNUSED IMPORTS: Remove the unused import statements. For React 17+, you do NOT need `import React`.');
    }
    
    if (errorSummary.includes('Cannot find name') || 
        errorSummary.includes('is not defined')) {
      fixInstructions.push('MISSING TYPE/VARIABLE: Define or import the missing type/variable. Check if you need to create an interface or import from another file.');
    }
    
    if (errorSummary.includes('is not assignable to type') ||
        errorSummary.includes('Type mismatch')) {
      fixInstructions.push('TYPE MISMATCH: Ensure function parameters and return types match. Consider using `typeof` to infer types from existing values.');
    }
    
    if (errorSummary.includes('Module') || 
        errorSummary.includes('module')) {
      fixInstructions.push('MODULE ERROR: Check import paths. Use relative paths for local files, ensure package is installed for external modules.');
    }
    
    // Build the enhanced objective
    const patternGuidance = fixInstructions.length > 0
      ? `\n\n## Fix Strategies\n${fixInstructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')}`
      : '';
    
    return {
      ...originalTask,
      id: `${originalTask.id}-fix-${Date.now()}`,
      objective: `## FIX REQUIRED: TypeScript/Build Errors

The following errors MUST be fixed before proceeding:

${errorSummary}
${patternGuidance}

## Instructions
1. Fix ALL errors listed above - do not skip any
2. For each error, identify the root cause and apply the appropriate fix
3. Do NOT add new features or refactor - ONLY fix the listed errors
4. After fixing, run \`${verifyCommand}\` to confirm no errors remain

## CRITICAL
- Focus ONLY on the files mentioned in the errors
- Do NOT modify unrelated files
- Each fix should be minimal and targeted`,
      constraints: [
        'Fix all listed errors without introducing new ones',
        'Do NOT add new features or refactor code',
        'Focus only on files with errors',
        `Verify fixes by running: ${verifyCommand}`,
        ...(originalTask.constraints ?? []).filter(c => !c.includes('Verify fixes')),
      ],
    };
  }

  /**
   * Map build gate command to actual shell command
   * 
   * Converts internal commands (like 'lsp_diagnostics') to real shell commands
   * that workers can run for verification.
   */
  private mapToShellCommand(command?: string): string {
    if (!command) return 'npx tsc --noEmit';
    if (command === 'lsp_diagnostics') return 'npx tsc --noEmit';
    return command;
  }

  /**
   * Try to auto-fix common issues before LLM retry
   * 
   * Runs eslint --fix on files with errors to automatically resolve:
   * - Unused imports (very common LLM pattern)
   * - Formatting issues
   * - Simple code style errors
   * 
   * Guards:
   * - Only runs if ESLint config exists in project
   * - Proper timeout with process kill
   * - Only counts exit code 0 as successful fix
   */
  private async tryAutoFix(
    workDir: string,
    verifyResult: VerificationResult
  ): Promise<{ fixed: number; errors: string[] }> {
    const { spawn } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    
    // Gate: Only run if ESLint config exists in project
    const eslintConfigFiles = [
      '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    ];
    const hasEslintConfig = eslintConfigFiles.some(f => existsSync(join(workDir, f)));
    if (!hasEslintConfig) {
      console.debug('[AutoFix] Skipping - no ESLint config found');
      return { fixed: 0, errors: [] };
    }
    
    // Extract unique file paths from errors
    const errorFiles = new Set<string>();
    for (const layer of verifyResult.layers) {
      if (layer.errors) {
        for (const error of layer.errors) {
          if (error.file && (error.file.endsWith('.tsx') || error.file.endsWith('.ts'))) {
            errorFiles.add(error.file);
          }
        }
      }
    }

    if (errorFiles.size === 0) {
      return { fixed: 0, errors: [] };
    }

    const filesArray = Array.from(errorFiles);
    console.info(`[AutoFix] Running eslint --fix on ${filesArray.length} files`);

    const TIMEOUT_MS = 30000;

    try {
      const result = await new Promise<{ fixed: number; errors: string[] }>((resolve) => {
        const eslintProcess = spawn('npx', ['eslint', '--fix', ...filesArray], {
          cwd: workDir,
          shell: true,
        });

        let stdout = '';
        let stderr = '';
        let killed = false;
        
        // Manual timeout with process kill
        const timeoutId = setTimeout(() => {
          killed = true;
          eslintProcess.kill('SIGTERM');
          console.warn('[AutoFix] Timeout - killing eslint process');
          resolve({ fixed: 0, errors: ['ESLint timed out after 30s'] });
        }, TIMEOUT_MS);

        eslintProcess.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        
        eslintProcess.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        eslintProcess.on('close', (code) => {
          clearTimeout(timeoutId);
          if (killed) return; // Already resolved by timeout
          
          // Only exit code 0 means all issues were fixed
          // Exit code 1 means eslint ran but errors remain - NOT a fix
          if (code === 0) {
            console.info('[AutoFix] ESLint completed successfully');
            resolve({ fixed: filesArray.length, errors: [] });
          } else {
            // Exit code 1 or higher = eslint found issues it couldn't fix
            console.debug(`[AutoFix] ESLint exited with code ${code} - no auto-fix applied`);
            resolve({ fixed: 0, errors: [] });
          }
        });

        eslintProcess.on('error', (err) => {
          clearTimeout(timeoutId);
          if (killed) return;
          console.warn(`[AutoFix] eslint not available: ${err.message}`);
          resolve({ fixed: 0, errors: [err.message] });
        });
      });

      return result;
    } catch (error) {
      console.warn(`[AutoFix] Auto-fix failed: ${(error as Error).message}`);
      return { fixed: 0, errors: [(error as Error).message] };
    }
  }
}
