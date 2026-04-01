/**
 * CheckpointResumeEngine
 *
 * 负责把“从 checkpoint 恢复”的旧版行为以独立引擎形式接回新架构：
 * - 定位 checkpoint 所属 sessionId
 * - 调用 CheckpointManager.restoreFromCheckpoint() 读取 checkpoint/runtime
 * - 基于 runtime.json 的 tasks.json 引用重建当前 PlannerOutput（仅 id/依赖/状态，不落盘描述）
 * - 将执行计划裁剪为 resumableSubtaskIds（用于继续执行）
 */

import { join, isAbsolute } from 'node:path';
import type { OrchestratorConfig, OrchestratorTask, PlannerOutput } from '../types';
import type {
  CheckpointData,
  CheckpointManager,
  CheckpointRestoreOptions,
  CheckpointRestoreResult,
  ISessionFileManager,
  RecoveryStrategy,
  RuntimeFile,
} from '../session';
import {
  createAndInitializeSessionFileManager,
  fileExists,
  listDir,
  CheckpointManager as CheckpointManagerImpl,
} from '../session';
import type { SharedKnowledgeData } from '../session';
import type { TaskMasterPlanEngine } from './taskmaster-plan-engine';
import {
  applySessionCompaction,
  type SessionCompactionOptions,
} from '../services/session-compaction-manager';

export interface ResumeFromCheckpointOptions {
  strategy?: RecoveryStrategy;
  skipFailed?: boolean;
  resetRetryCount?: boolean;
  maxRetries?: number;
  /** 取消信号（优先级最高） */
  signal?: AbortSignal;
  /** 超时（毫秒），当未提供 signal 时生效 */
  timeout?: number;
}

export interface CheckpointResumePrepared {
  sessionId: string;
  sessionManager: ISessionFileManager;
  checkpointManager: CheckpointManager;
  restoreResult: CheckpointRestoreResult;
  checkpoint: CheckpointData;
  runtimeData: RuntimeFile;
  workDir: string;
  planResult: Awaited<ReturnType<TaskMasterPlanEngine['executePlanPhase']>>;
  resumePlan: PlannerOutput;
  orchestratorTask: OrchestratorTask;
  signal: AbortSignal;
}

export class CheckpointResumeEngine {
  private readonly orchestratorConfig: OrchestratorConfig;
  private readonly planEngine: TaskMasterPlanEngine;

  constructor(deps: { orchestratorId: string; orchestratorConfig: OrchestratorConfig; planEngine: TaskMasterPlanEngine }) {
    this.orchestratorConfig = deps.orchestratorConfig;
    this.planEngine = deps.planEngine;
  }

  async prepare(
    checkpointId: string,
    options: ResumeFromCheckpointOptions = {}
  ): Promise<CheckpointResumePrepared> {
    const startSignal =
      options.signal ??
      (typeof options.timeout === 'number' && Number.isFinite(options.timeout) && options.timeout > 0
        ? AbortSignal.timeout(options.timeout)
        : new AbortController().signal);

    const rootDir = this.orchestratorConfig.session.rootDir;

    let sessionManager: ISessionFileManager | null = null;
    let checkpointManager: CheckpointManager | null = null;

    try {
      const sessionId = await this.findSessionIdForCheckpoint(checkpointId, rootDir);
      if (!sessionId) {
        throw new Error(`Checkpoint not found: ${checkpointId}`);
      }

      // 只读恢复：不启用 watch，避免额外开销；不自动创建目录（checkpoint/session 应当已存在）
      sessionManager = await createAndInitializeSessionFileManager(sessionId, {
        rootDir,
        enableWatch: false,
        autoCreateDirs: false,
      });

      checkpointManager = new CheckpointManagerImpl(sessionId, sessionManager, {
        rootDir,
        autoSave: false,
      });

      const restoreOptions: Partial<CheckpointRestoreOptions> = {
        strategy: options.strategy ?? 'resume',
        ...(options.skipFailed !== undefined ? { skipFailed: options.skipFailed } : {}),
        ...(options.resetRetryCount !== undefined ? { resetRetryCount: options.resetRetryCount } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      };

      const restoreResult = await checkpointManager.restoreFromCheckpoint(checkpointId, restoreOptions);
      if (!restoreResult.success || !restoreResult.checkpoint) {
        throw new Error(`Checkpoint restore failed: ${restoreResult.error ?? 'unknown error'}`);
      }

      const checkpoint = restoreResult.checkpoint;
      const runtimeData = restoreResult.runtimeData;
      if (!runtimeData || runtimeData.kind !== 'taskmaster') {
        throw new Error('Checkpoint session has no taskmaster runtime.json; cannot rebuild plan');
      }

      // workDir 用于作为 projectRoot（同时也是 tachikoma.taskmeta.json 的落盘位置）
      const workDirRaw = checkpoint.contextData?.workDir;
      const workDir =
        typeof workDirRaw === 'string' && workDirRaw.trim().length > 0
          ? workDirRaw.trim()
          : process.cwd();

      const tasksJsonPath = runtimeData.tasksJson?.path;
      const tasksJsonTag = runtimeData.tasksJson?.tag ?? 'master';
      if (!tasksJsonPath) {
        throw new Error('runtime.json missing tasksJson.path');
      }

      const tasksPathAbs = isAbsolute(tasksJsonPath) ? tasksJsonPath : join(workDir, tasksJsonPath);

      const orchestratorTask: OrchestratorTask = {
        id: checkpoint.taskId,
        type: 'composite',
        objective: '',
        constraints: [],
        priority: 'medium',
        complexity: 'moderate',
      };

      const resumeTask = await this.withTodoSnapshotConstraint(orchestratorTask, sessionManager);
      const planResult = await this.planEngine.executePlanPhase(
        resumeTask,
        { projectRoot: workDir, tag: tasksJsonTag, file: tasksPathAbs },
        startSignal
      );
      if (!planResult.success || !planResult.output) {
        throw new Error(`Rebuild plan failed during resume: ${planResult.error ?? 'unknown error'}`);
      }

      const resumable = new Set(restoreResult.resumableSubtaskIds ?? []);
      const resumePlan = this.filterPlanToResumableSubtasks(planResult.output, resumable);

      return {
        sessionId,
        sessionManager,
        checkpointManager,
        restoreResult,
        checkpoint,
        runtimeData,
        workDir,
        planResult,
        resumePlan,
        orchestratorTask,
        signal: startSignal,
      };
    } catch (error) {
      // best-effort 清理：避免恢复失败时泄漏 session/checkpoint 管理器
      await checkpointManager?.close().catch(() => undefined);
      await sessionManager?.close().catch(() => undefined);
      throw error;
    }
  }

  private async findSessionIdForCheckpoint(checkpointId: string, rootDir: string): Promise<string | null> {
    const sessionsDir = join(rootDir, 'sessions');
    const sessionIds = await listDir(sessionsDir).catch(() => []);

    for (const sessionId of sessionIds) {
      const p = join(sessionsDir, sessionId, 'orchestrator', 'checkpoints', `${checkpointId}.json`);
      if (fileExists(p)) return sessionId;
    }

    return null;
  }

  private filterPlanToResumableSubtasks(planOutput: PlannerOutput, resumableIds: Set<string>): PlannerOutput {
    const filteredSteps = (planOutput.executionPlan.steps ?? [])
      .map((step) => ({
        ...step,
        subtaskIds: (step.subtaskIds ?? []).filter((id) => resumableIds.has(id)),
      }))
      .filter((step) => step.subtaskIds.length > 0);

    return {
      ...planOutput,
      executionPlan: {
        ...planOutput.executionPlan,
        steps: filteredSteps,
        isParallel: filteredSteps.some((s) => s.parallel),
      },
    };
  }

  private async withTodoSnapshotConstraint(
    task: OrchestratorTask,
    sessionManager: ISessionFileManager
  ): Promise<OrchestratorTask> {
    if (this.orchestratorConfig.sessionCompaction.todoGuardEnabled === false) return task;

    const shared = await sessionManager.readSharedContext().catch(() => null);
    if (!shared) return task;

    const data = (shared.sharedKnowledge?.data ?? {}) as SharedKnowledgeData;
    const compactionOptions = this.buildSessionCompactionOptions();
    const compacted = applySessionCompaction({
      constraints: task.constraints ?? [],
      data,
      ...(compactionOptions ? { options: compactionOptions } : {}),
    });
    const snapshot = compacted.contract.todoState;
    if (!snapshot) return task;

    if (compacted.mismatch) {
      const previous = compacted.previousTodoHashes
        .filter((hash) => hash !== snapshot.hash);
      if (
        compacted.previousSummaryTodoHash &&
        compacted.previousSummaryTodoHash !== snapshot.hash &&
        !previous.includes(compacted.previousSummaryTodoHash)
      ) {
        previous.push(compacted.previousSummaryTodoHash);
      }
      console.warn(
        `[CheckpointResumeEngine] todoSnapshotHash mismatch detected during resume: expected=${snapshot.hash}, previous=${previous.join(',')}`
      );
    }
    if (compacted.contractUpdated) {
      await sessionManager.writeSharedContext({
        objective: shared.objective,
        constraints: shared.constraints,
        sharedKnowledge: {
          data: {
            ...data,
            ...(snapshot ? { todoState: snapshot } : {}),
            executionStateContract: compacted.contract,
          },
          updatedAt: Date.now(),
        },
        ...(shared.workspace ? { workspace: shared.workspace } : {}),
      }).catch(() => undefined);
    }
    if (!compacted.updated) return task;

    return {
      ...task,
      constraints: compacted.constraints,
    };
  }

  private buildSessionCompactionOptions(): SessionCompactionOptions | null {
    const config = this.orchestratorConfig.sessionCompaction;
    if (!config) return null;

    if (config.enabled === false) {
      return {
        maxConstraintChars: Number.MAX_SAFE_INTEGER,
        keepLastConstraints: Number.MAX_SAFE_INTEGER,
      };
    }

    return {
      maxConstraintChars: config.maxConstraintChars,
      keepLastConstraints: config.keepLastConstraints,
      maxSummaryItems: config.maxSummaryItems,
      maxSummaryChars: config.maxSummaryChars,
    };
  }
}
