/**
 * CheckpointManager 实现
 *
 * 提供长时任务检查点保存与恢复功能
 * 复用 SessionFileManager 的目录结构
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
// Note: gzip/gunzip available for future compression feature
// import { gzip, gunzip } from 'node:zlib';
import type {
  CheckpointData,
  CheckpointManagerConfig,
  CheckpointRestoreOptions,
  CheckpointRestoreResult,
  ICheckpointManager,
  ISessionFileManager,
  RecoveryStrategy,
  SubtaskSnapshot,
  WorkerSnapshot,
  WorkerStatusFile,
} from './types';
import { DEFAULT_CHECKPOINT_CONFIG } from './types';
import {
  atomicWriteJson,
  ensureDir,
  fileExists,
  generateTimestampId,
  listDir,
  now,
  readJsonFile,
  safeDeleteFile,
  SessionPathBuilder,
  withFileLock,
} from './utils';

const execAsync = promisify(exec);

// ============================================================================
// CheckpointManager 实现
// ============================================================================

/**
 * CheckpointManager 实现类
 *
 * 管理长时任务的检查点保存与恢复
 * 复用 SessionFileManager 的目录结构进行持久化
 *
 * @example
 * ```ts
 * const checkpointManager = new CheckpointManager('session-001', sessionFileManager, {
 *   autoSave: true,
 *   autoSaveInterval: 30000,
 * });
 *
 * // 保存检查点
 * await checkpointManager.saveCheckpoint({
 *   taskId: 'task-001',
 *   planStatus: 'executing',
 *   currentStep: 2,
 *   totalSteps: 5,
 *   completedSubtaskIds: ['sub-1', 'sub-2'],
 *   failedSubtaskIds: [],
 *   runningSubtaskIds: ['sub-3'],
 *   subtaskSnapshots: [...],
 *   completedResults: {...},
 *   totalRetries: 0,
 *   totalTokens: 1500,
 * });
 *
 * // 恢复检查点
 * const result = await checkpointManager.restore({ strategy: 'resume' });
 * if (result.success) {
 *   console.log('Resumable subtasks:', result.resumableSubtaskIds);
 * }
 * ```
 */
export class CheckpointManager implements ICheckpointManager {
  /** 会话 ID */
  public readonly sessionId: string;

  /** 配置 */
  public readonly config: CheckpointManagerConfig;

  /** 路径构建器 */
  private readonly paths: SessionPathBuilder;

  /** SessionFileManager 引用（用于读取 progress/plan） */
  private readonly sessionManager: ISessionFileManager;

  /** 检查点版本计数器 */
  private checkpointVersion = 0;

  /** 自动保存定时器 */
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  /** 自动保存回调（由外部设置） */
  private autoSaveCallback: (() => Promise<Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'> | null>) | null = null;

  /** 自动保存连续失败计数 */
  private autoSaveFailCount = 0;

  /** 自动保存进行中标记（防止重入） */
  private autoSaveInFlight = false;

  constructor(
    sessionId: string,
    sessionManager: ISessionFileManager,
    config?: Partial<CheckpointManagerConfig>
  ) {
    this.sessionId = sessionId;
    this.sessionManager = sessionManager;
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...config };
    this.paths = new SessionPathBuilder(this.config.rootDir, sessionId);
  }

  // ============================================================================
  // 检查点操作
  // ============================================================================

  /**
   * 获取检查点目录路径
   */
  private get checkpointsDir(): string {
    return join(this.paths.orchestratorDir, 'checkpoints');
  }

  /**
   * 获取检查点文件路径
   */
  private getCheckpointPath(checkpointId: string): string {
    return join(this.checkpointsDir, `${checkpointId}.json`);
  }

  /**
   * 获取最新检查点索引文件路径
   */
  private get latestCheckpointIndexPath(): string {
    return join(this.paths.orchestratorDir, 'checkpoint-latest.json');
  }

  /**
   * 保存检查点
   *
   * 使用文件锁保证并发安全
   */
  async saveCheckpoint(
    data: Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'>
  ): Promise<CheckpointData> {
    // 使用文件锁保证并发安全
    const lockPath = join(this.paths.orchestratorDir, 'checkpoint.lock');
    return withFileLock(lockPath, async () => {
      return this.doSaveCheckpoint(data);
    });
  }

  /**
   * 执行实际保存操作（内部方法）
   */
  private async doSaveCheckpoint(
    data: Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'>
  ): Promise<CheckpointData> {
    // 确保目录存在
    await ensureDir(this.checkpointsDir);

    // 增加版本号
    this.checkpointVersion++;

    // 生成完整的检查点数据
    const timestamp = now();
    const checkpointId = generateTimestampId('ckpt');
    const checkpoint: CheckpointData = {
      ...data,
      id: checkpointId,
      sessionId: this.sessionId,
      version: this.checkpointVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // 如果启用 Git 集成，添加 Git 提交点
    if (this.config.enableGitIntegration && !checkpoint.gitCommit) {
      const gitCommit = await this.getCurrentGitCommit();
      if (gitCommit) {
        checkpoint.gitCommit = gitCommit;
      }
    }

    // 保存检查点文件
    const checkpointPath = this.getCheckpointPath(checkpointId);
    await atomicWriteJson(checkpointPath, checkpoint);

    // 更新最新检查点索引
    await atomicWriteJson(this.latestCheckpointIndexPath, {
      latestCheckpointId: checkpointId,
      updatedAt: timestamp,
    });

    // 清理旧检查点
    await this.cleanupOldCheckpoints();

    return checkpoint;
  }

  /**
   * 读取最新检查点
   */
  async loadCheckpoint(): Promise<CheckpointData | null> {
    // 读取索引文件获取最新检查点 ID
    const index = await readJsonFile<{ latestCheckpointId: string }>(
      this.latestCheckpointIndexPath
    );

    if (!index?.latestCheckpointId) {
      return null;
    }

    return this.loadCheckpointById(index.latestCheckpointId);
  }

  /**
   * 读取指定检查点
   */
  async loadCheckpointById(checkpointId: string): Promise<CheckpointData | null> {
    const checkpointPath = this.getCheckpointPath(checkpointId);
    return readJsonFile<CheckpointData>(checkpointPath);
  }

  /**
   * 列出所有检查点
   * 
   * 跳过损坏的 JSON 文件并记录警告
   */
  async listCheckpoints(): Promise<CheckpointData[]> {
    const files = await listDir(this.checkpointsDir);
    const checkpoints: CheckpointData[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const checkpoint = await readJsonFile<CheckpointData>(
            join(this.checkpointsDir, file)
          );
          if (checkpoint) {
            checkpoints.push(checkpoint);
          }
        } catch (error) {
          // 跳过损坏的文件并记录警告
          console.warn(`[CheckpointManager] Skipping corrupted checkpoint file: ${file}`, error);
        }
      }
    }

    // 按创建时间排序（最新的在前）
    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 删除检查点
   */
  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpointPath = this.getCheckpointPath(checkpointId);
    return safeDeleteFile(checkpointPath);
  }

  /**
   * 清理旧检查点
   */
  async cleanupOldCheckpoints(): Promise<number> {
    const checkpoints = await this.listCheckpoints();

    if (checkpoints.length <= this.config.maxCheckpoints) {
      return 0;
    }

    // 删除多余的旧检查点
    const toDelete = checkpoints.slice(this.config.maxCheckpoints);
    let deletedCount = 0;

    for (const checkpoint of toDelete) {
      if (await this.deleteCheckpoint(checkpoint.id)) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  // ============================================================================
  // 恢复操作
  // ============================================================================

  /**
   * 从检查点恢复
   */
  async restore(
    options?: Partial<CheckpointRestoreOptions>
  ): Promise<CheckpointRestoreResult> {
    // 加载最新检查点
    const checkpoint = await this.loadCheckpoint();

    if (!checkpoint) {
      return {
        success: false,
        error: 'No checkpoint found',
      };
    }

    return this.performRestore(checkpoint, options);
  }

  /**
   * 从指定检查点恢复
   */
  async restoreFromCheckpoint(
    checkpointId: string,
    options?: Partial<CheckpointRestoreOptions>
  ): Promise<CheckpointRestoreResult> {
    const checkpoint = await this.loadCheckpointById(checkpointId);

    if (!checkpoint) {
      return {
        success: false,
        error: `Checkpoint ${checkpointId} not found`,
      };
    }

    return this.performRestore(checkpoint, options);
  }

  /**
   * 执行恢复操作
   */
  private async performRestore(
    checkpoint: CheckpointData,
    options?: Partial<CheckpointRestoreOptions>
  ): Promise<CheckpointRestoreResult> {
    const defaultOptions: CheckpointRestoreOptions = {
      strategy: 'resume',
      skipFailed: false,
      resetRetryCount: false,
      maxRetries: 3,
    };

    const restoreOptions = { ...defaultOptions, ...options };

    try {
      // 收集 Worker 状态
      const workerSnapshots = await this.collectWorkerSnapshots();

      // 读取运行时和进度文件
      const runtimeData = await this.sessionManager.readRuntime();
      const progressData = await this.sessionManager.readProgress();

      // Git 提交校验（如果启用）
      let gitWarning: string | undefined;
      if (this.config.validateGitOnRestore && checkpoint.gitCommit) {
        const currentCommit = await this.getCurrentGitCommit();
        if (currentCommit && currentCommit !== checkpoint.gitCommit) {
          gitWarning = `Code has changed since checkpoint: checkpoint=${checkpoint.gitCommit.slice(0, 7)}, current=${currentCommit.slice(0, 7)}`;
          console.warn(`[CheckpointManager] ${gitWarning}`);
        }
      }

      // 分析恢复策略
      const analysis = await this.analyzeRecoveryStrategy(checkpoint);

      // 如果没有指定策略，使用建议的策略
      const strategy = options?.strategy || analysis.suggestedStrategy;

      // 根据策略计算可恢复的子任务
      let resumableSubtaskIds: string[];

      switch (strategy) {
        case 'resume':
          // 从最后成功的子任务继续，跳过已完成的
          resumableSubtaskIds = this.calculateResumableSubtasks(
            checkpoint,
            restoreOptions.skipFailed
          );
          break;

        case 'retry-failed':
          // 重试失败的子任务
          resumableSubtaskIds = [...checkpoint.failedSubtaskIds];
          if (!restoreOptions.skipFailed) {
            // 也包括还在进行中的
            resumableSubtaskIds.push(...checkpoint.runningSubtaskIds);
          }
          break;

        case 'restart-step':
          // 重新开始当前步骤的所有子任务
          resumableSubtaskIds = this.getSubtasksForStep(
            checkpoint,
            checkpoint.currentStep
          );
          break;

        case 'restart-all':
          // 重新开始所有子任务
          resumableSubtaskIds = checkpoint.subtaskSnapshots.map(s => s.id);
          break;

        default:
          resumableSubtaskIds = analysis.resumableSubtaskIds;
      }

      // 更新检查点版本
      this.checkpointVersion = checkpoint.version;

      return {
        success: true,
        checkpoint,
        workerSnapshots,
        runtimeData,
        progressData,
        suggestedStrategy: analysis.suggestedStrategy,
        appliedStrategy: strategy,
        resumableSubtaskIds,
        ...(gitWarning && { gitWarning }),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        checkpoint,
      };
    }
  }

  /**
   * 计算可恢复的子任务
   */
  private calculateResumableSubtasks(
    checkpoint: CheckpointData,
    skipFailed?: boolean
  ): string[] {
    const resumable: string[] = [];

    for (const snapshot of checkpoint.subtaskSnapshots) {
      // 跳过已完成的
      if (snapshot.status === 'success') {
        continue;
      }

      // 根据选项决定是否跳过失败的
      if (skipFailed && snapshot.status === 'failure') {
        continue;
      }

      // 跳过已取消的
      if (snapshot.status === 'cancelled') {
        continue;
      }

      resumable.push(snapshot.id);
    }

    return resumable;
  }

  /**
   * 获取指定步骤的子任务
   *
   * 如果检查点包含执行计划，则精确解析步骤；否则返回所有未完成的子任务
   */
  private getSubtasksForStep(
    checkpoint: CheckpointData,
    step: number
  ): string[] {
    // 如果有执行计划，精确获取该步骤的子任务
    if (checkpoint.executionPlan?.steps) {
      const stepData = checkpoint.executionPlan.steps.find(s => s.order === step);
      if (stepData) {
        return stepData.subtaskIds;
      }
    }

    // 降级：返回所有未完成的子任务
    return checkpoint.subtaskSnapshots
      .filter(s => s.status !== 'success' && s.status !== 'cancelled')
      .map(s => s.id);
  }

  /**
   * 分析恢复策略
   */
  async analyzeRecoveryStrategy(checkpoint: CheckpointData): Promise<{
    suggestedStrategy: RecoveryStrategy;
    reason: string;
    resumableSubtaskIds: string[];
    failedSubtaskIds: string[];
  }> {
    const completedCount = checkpoint.completedSubtaskIds.length;
    const failedCount = checkpoint.failedSubtaskIds.length;
    const runningCount = checkpoint.runningSubtaskIds.length;
    const totalCount = checkpoint.subtaskSnapshots.length;
    const pendingCount = totalCount - completedCount - failedCount - runningCount;

    // 收集当前 Worker 状态以判断是否有进行中的任务
    const workerSnapshots = await this.collectWorkerSnapshots();
    const hasActiveWorkers = workerSnapshots.some(
      w => w.status === 'thinking' || w.status === 'acting'
    );

    // 决策逻辑
    let suggestedStrategy: RecoveryStrategy;
    let reason: string;

    // 1. 如果没有任何成功完成的子任务，建议完全重新开始
    if (completedCount === 0) {
      suggestedStrategy = 'restart-all';
      reason = '没有成功完成的子任务，建议重新开始';
    }
    // 2. 如果有大量失败且重试次数已耗尽
    else if (failedCount > 0 && checkpoint.totalRetries >= 3 * failedCount) {
      if (pendingCount > 0) {
        suggestedStrategy = 'resume';
        reason = `有 ${failedCount} 个失败子任务，但还有 ${pendingCount} 个待执行，建议跳过失败继续执行`;
      } else {
        suggestedStrategy = 'restart-step';
        reason = `所有子任务已尝试，${failedCount} 个失败，建议重新开始当前步骤`;
      }
    }
    // 3. 如果有运行中的任务但 Worker 已不活跃
    else if (runningCount > 0 && !hasActiveWorkers) {
      suggestedStrategy = 'retry-failed';
      reason = `有 ${runningCount} 个子任务被标记为运行中但 Worker 已不活跃，建议重试`;
    }
    // 4. 如果有失败但重试次数不多
    else if (failedCount > 0 && checkpoint.totalRetries < 3 * failedCount) {
      suggestedStrategy = 'retry-failed';
      reason = `有 ${failedCount} 个失败子任务，重试次数未耗尽，建议重试`;
    }
    // 5. 正常情况，从最后成功的继续
    else if (completedCount > 0 && pendingCount > 0) {
      suggestedStrategy = 'resume';
      reason = `已完成 ${completedCount}/${totalCount}，建议从最后成功的子任务继续`;
    }
    // 6. 默认继续
    else {
      suggestedStrategy = 'resume';
      reason = '默认策略：从当前状态继续';
    }

    // 计算可恢复的子任务
    const resumableSubtaskIds = this.calculateResumableSubtasks(checkpoint, false);

    return {
      suggestedStrategy,
      reason,
      resumableSubtaskIds,
      failedSubtaskIds: checkpoint.failedSubtaskIds,
    };
  }

  // ============================================================================
  // Worker 状态收集
  // ============================================================================

  /**
   * 收集所有 Worker 状态快照
   *
   * 只遍历有 status.json 的目录，过滤无效条目
   */
  async collectWorkerSnapshots(): Promise<WorkerSnapshot[]> {
    const snapshots: WorkerSnapshot[] = [];
    const workersDir = this.paths.workersDir;

    // 列出所有 Worker 目录
    const workerDirs = await listDir(workersDir);

    for (const workerId of workerDirs) {
      // 过滤：只处理有 status.json 的目录
      const statusPath = this.paths.workerStatusFile(workerId);
      if (!fileExists(statusPath)) {
        continue; // 跳过无效的条目（非 worker 目录或隐藏文件）
      }

      const snapshot = await this.getWorkerSnapshot(workerId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }

  /**
   * 收集指定 Worker 状态
   */
  async getWorkerSnapshot(workerId: string): Promise<WorkerSnapshot | null> {
    const statusPath = this.paths.workerStatusFile(workerId);

    if (!fileExists(statusPath)) {
      return null;
    }

    const status = await readJsonFile<WorkerStatusFile>(statusPath);

    if (!status) {
      return null;
    }

    return {
      workerId: status.workerId,
      status: status.status,
      currentSubtask: status.currentSubtask,
      progress: status.progress,
      lastHeartbeat: status.lastHeartbeat,
      error: status.error,
    };
  }

  // ============================================================================
  // Git 集成
  // ============================================================================

  /**
   * 获取当前 Git 提交点
   */
  async getCurrentGitCommit(): Promise<string | null> {
    if (!this.config.enableGitIntegration) {
      return null;
    }

    try {
      const { stdout } = await execAsync('git rev-parse HEAD', {
        cwd: this.config.rootDir,
      });
      return stdout.trim();
    } catch {
      // Git 不可用或不是 Git 仓库
      return null;
    }
  }

  /**
   * 创建 Git 检查点
   *
   * 处理 tag 冲突并记录警告
   *
   * @param message - 标签消息
   * @param tagPrefix - 标签前缀（默认 'checkpoint')
   */
  async createGitCheckpoint(message: string, tagPrefix = 'checkpoint'): Promise<string | null> {
    if (!this.config.enableGitIntegration) {
      return null;
    }

    try {
      // 获取当前提交
      const currentCommit = await this.getCurrentGitCommit();
      if (!currentCommit) {
        return null;
      }

      // 创建标签（包含随机后缀避免冲突）
      const tagName = `${tagPrefix}-${generateTimestampId()}`;
      await execAsync(`git tag -a ${tagName} -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: this.config.rootDir,
      });

      return tagName;
    } catch (error) {
      console.warn('[CheckpointManager] Failed to create Git checkpoint:', error);
      return null;
    }
  }

  // ============================================================================
  // 自动保存
  // ============================================================================

  /**
   * 设置自动保存回调
   *
   * @param callback - 返回要保存的检查点数据，返回 null 表示跳过此次保存
   */
  setAutoSaveCallback(
    callback: () => Promise<Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'> | null>
  ): void {
    this.autoSaveCallback = callback;
  }

  /**
   * 启动自动保存
   */
  startAutoSave(): void {
    if (!this.config.autoSave || this.autoSaveTimer) {
      return;
    }

    this.autoSaveTimer = setInterval(async () => {
      await this.performAutoSave();
    }, this.config.autoSaveInterval);
  }

  /**
   * 停止自动保存
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * 执行自动保存（带重试机制和节流）
   */
  private async performAutoSave(): Promise<void> {
    if (!this.autoSaveCallback) {
      return;
    }

    // 防止重入：如果上一次保存还在进行中，跳过本次
    if (this.autoSaveInFlight) {
      console.warn('[CheckpointManager] Skipping auto-save: previous save still in progress');
      return;
    }

    this.autoSaveInFlight = true;
    try {
      const data = await this.autoSaveCallback();
      if (data) {
        await this.saveCheckpoint(data);
        // 成功后重置失败计数
        this.autoSaveFailCount = 0;
      }
    } catch (error) {
      this.autoSaveFailCount++;
      console.error(
        `[CheckpointManager] Auto-save failed (attempt ${this.autoSaveFailCount}/${this.config.autoSaveMaxRetries}):`,
        error
      );

      // 如果超过最大重试次数，停止自动保存
      if (this.autoSaveFailCount >= this.config.autoSaveMaxRetries) {
        console.error('[CheckpointManager] Auto-save disabled due to repeated failures');
        this.stopAutoSave();
      }
    } finally {
      this.autoSaveInFlight = false;
    }
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  /**
   * 关闭管理器
   */
  async close(): Promise<void> {
    this.stopAutoSave();
    this.autoSaveCallback = null;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 CheckpointManager 实例
 *
 * @param sessionId - 会话 ID
 * @param sessionManager - SessionFileManager 实例
 * @param config - 可选配置
 * @returns CheckpointManager 实例
 *
 * @example
 * ```ts
 * const checkpointManager = createCheckpointManager(
 *   'session-001',
 *   sessionFileManager,
 *   { autoSave: true }
 * );
 * ```
 */
export function createCheckpointManager(
  sessionId: string,
  sessionManager: ISessionFileManager,
  config?: Partial<CheckpointManagerConfig>
): CheckpointManager {
  return new CheckpointManager(sessionId, sessionManager, config);
}

/**
 * 从子任务列表创建快照
 *
 * 辅助函数，用于从 SubTask[] 创建 SubtaskSnapshot[]
 *
 * @param subtasks - 子任务列表（来自 PlannerOutput）
 * @returns 子任务快照列表
 */
export function createSubtaskSnapshots(
  subtasks: {
    id: string;
    status: SubtaskSnapshot['status'];
    assignedWorkerId?: string;
  }[],
  executionState?: {
    completedSubtasks: Map<string, unknown>;
    failedSubtasks: Map<string, string>;
    runningSubtasks: Set<string>;
  }
): SubtaskSnapshot[] {
  const timestamp = now();

  return subtasks.map(subtask => {
    let status = subtask.status;
    let progress = 0;
    const retryCount = 0;

    // 如果有执行状态，从中获取更准确的状态
    if (executionState) {
      if (executionState.completedSubtasks.has(subtask.id)) {
        status = 'success';
        progress = 100;
      } else if (executionState.failedSubtasks.has(subtask.id)) {
        status = 'failure';
      } else if (executionState.runningSubtasks.has(subtask.id)) {
        status = 'running';
        progress = 50; // 默认 50%
      }
    }

    return {
      id: subtask.id,
      status,
      assignedWorkerId: subtask.assignedWorkerId,
      progress,
      retryCount,
      lastUpdatedAt: timestamp,
    };
  });
}
