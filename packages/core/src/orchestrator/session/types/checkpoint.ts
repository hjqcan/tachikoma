/**
 * 检查点管理类型
 */

import type { ProgressFile, RuntimeFile } from './runtime';

// ============================================================================
// 检查点管理类型
// ============================================================================

/**
 * 检查点存储数据
 *
 * 持久化到 orchestrator/checkpoint.json
 */
export interface CheckpointData {
  /** 检查点 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 任务 ID */
  taskId: string;
  /** 检查点版本 */
  version: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 计划状态 */
  planStatus: 'planning' | 'executing' | 'paused' | 'completed' | 'failed';
  /** 当前执行步骤 */
  currentStep: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 已完成子任务 ID 列表 */
  completedSubtaskIds: string[];
  /** 失败子任务 ID 列表 */
  failedSubtaskIds: string[];
  /** 进行中子任务 ID 列表 */
  runningSubtaskIds: string[];
  /** 子任务状态快照 */
  subtaskSnapshots: SubtaskSnapshot[];
  /** 已完成的子任务结果 */
  completedResults: Record<string, unknown>;
  /** 累计重试次数 */
  totalRetries: number;
  /** 累计 Token 使用量 */
  totalTokens: number;
  /** 执行计划（用于 restart-step 策略） */
  executionPlan?: {
    steps: {
      order: number;
      subtaskIds: string[];
      parallel: boolean;
    }[];
  };
  /** 上下文数据 */
  contextData?: Record<string, unknown>;
  /** Git 提交点（可选） */
  gitCommit?: string;
}

/**
 * 子任务快照
 */
export interface SubtaskSnapshot {
  /** 子任务 ID */
  id: string;
  /** 状态 */
  status: 'pending' | 'assigned' | 'running' | 'success' | 'failure' | 'retrying' | 'cancelled';
  /** 分配的 Worker ID */
  assignedWorkerId?: string | undefined;
  /** 进度 (0-100) */
  progress: number;
  /** 重试次数 */
  retryCount: number;
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

/**
 * Worker 状态快照
 */
export interface WorkerSnapshot {
  /** Worker ID */
  workerId: string;
  /** Worker 状态 */
  status: 'idle' | 'thinking' | 'acting' | 'waiting_approval' | 'error';
  /** 当前子任务 */
  currentSubtask?:
    | {
        id: string;
        objective: string;
        startedAt: number;
      }
    | undefined;
  /** 进度 (0-100) */
  progress: number;
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 错误信息 */
  error?:
    | {
        code: string;
        message: string;
        timestamp: number;
      }
    | undefined;
}

/**
 * 恢复策略
 */
export type RecoveryStrategy =
  | 'resume' // 从最后成功的子任务继续
  | 'retry-failed' // 重试失败的子任务
  | 'restart-step' // 重新开始当前步骤
  | 'restart-all'; // 完全重新开始

/**
 * 检查点恢复选项
 */
export interface CheckpointRestoreOptions {
  /** 恢复策略 */
  strategy: RecoveryStrategy;
  /** 是否跳过失败的子任务 */
  skipFailed?: boolean;
  /** 是否重置重试计数 */
  resetRetryCount?: boolean;
  /** 最大重试次数限制（用于 retry-failed 策略） */
  maxRetries?: number;
}

/**
 * 检查点恢复结果
 */
export interface CheckpointRestoreResult {
  /** 是否成功 */
  success: boolean;
  /** 错误消息 */
  error?: string;
  /** 恢复的检查点数据 */
  checkpoint?: CheckpointData;
  /** 恢复的 Worker 状态 */
  workerSnapshots?: WorkerSnapshot[];
  /** 恢复的运行时数据（runtime.json） */
  runtimeData?: RuntimeFile | null;
  /** 恢复的进度数据 */
  progressData?: ProgressFile | null;
  /** 建议的恢复策略 */
  suggestedStrategy?: RecoveryStrategy;
  /** 实际应用的恢复策略 */
  appliedStrategy?: RecoveryStrategy;
  /** 可恢复的子任务 ID 列表（从这些开始执行） */
  resumableSubtaskIds?: string[];
  /** Git 校验警告（代码版本与检查点不一致时） */
  gitWarning?: string;
}

/**
 * 检查点管理器配置
 */
export interface CheckpointManagerConfig {
  /** 会话根目录 */
  rootDir: string;
  /** 是否启用自动保存 */
  autoSave: boolean;
  /** 自动保存间隔（毫秒） */
  autoSaveInterval: number;
  /** 最大保留检查点数 */
  maxCheckpoints: number;
  /** 是否启用 Git 集成 */
  enableGitIntegration: boolean;
  /** 是否启用压缩（gzip） */
  enableCompression: boolean;
  /** 恢复时是否校验 Git 提交 */
  validateGitOnRestore: boolean;
  /** 自动保存失败最大重试次数 */
  autoSaveMaxRetries: number;
}

/**
 * 默认检查点管理器配置
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointManagerConfig = {
  rootDir: '.tachikoma',
  autoSave: false,
  autoSaveInterval: 30000, // 30 秒
  maxCheckpoints: 5,
  enableGitIntegration: false,
  enableCompression: false,
  validateGitOnRestore: false,
  autoSaveMaxRetries: 3,
};

/**
 * CheckpointManager 接口
 */
export interface ICheckpointManager {
  /** 会话 ID */
  readonly sessionId: string;

  /** 配置 */
  readonly config: CheckpointManagerConfig;

  // === 检查点操作 ===

  /**
   * 保存检查点
   * @param data - 要保存的检查点数据（部分字段自动生成）
   */
  saveCheckpoint(
    data: Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'>
  ): Promise<CheckpointData>;

  /**
   * 读取最新检查点
   */
  loadCheckpoint(): Promise<CheckpointData | null>;

  /**
   * 读取指定检查点
   * @param checkpointId - 检查点 ID
   */
  loadCheckpointById(checkpointId: string): Promise<CheckpointData | null>;

  /**
   * 列出所有检查点
   */
  listCheckpoints(): Promise<CheckpointData[]>;

  /**
   * 删除检查点
   * @param checkpointId - 检查点 ID
   */
  deleteCheckpoint(checkpointId: string): Promise<boolean>;

  /**
   * 清理旧检查点（保留最新的 maxCheckpoints 个）
   */
  cleanupOldCheckpoints(): Promise<number>;

  // === 恢复操作 ===

  /**
   * 从检查点恢复
   * @param options - 恢复选项
   */
  restore(options?: Partial<CheckpointRestoreOptions>): Promise<CheckpointRestoreResult>;

  /**
   * 从指定检查点恢复
   * @param checkpointId - 检查点 ID
   * @param options - 恢复选项
   */
  restoreFromCheckpoint(
    checkpointId: string,
    options?: Partial<CheckpointRestoreOptions>
  ): Promise<CheckpointRestoreResult>;

  /**
   * 分析恢复策略
   *
   * 根据检查点状态和 Worker 状态，建议最佳恢复策略
   */
  analyzeRecoveryStrategy(checkpoint: CheckpointData): Promise<{
    suggestedStrategy: RecoveryStrategy;
    reason: string;
    resumableSubtaskIds: string[];
    failedSubtaskIds: string[];
  }>;

  // === Worker 状态收集 ===

  /**
   * 收集所有 Worker 状态快照
   */
  collectWorkerSnapshots(): Promise<WorkerSnapshot[]>;

  /**
   * 收集指定 Worker 状态
   * @param workerId - Worker ID
   */
  getWorkerSnapshot(workerId: string): Promise<WorkerSnapshot | null>;

  // === Git 集成（可选） ===

  /**
   * 获取当前 Git 提交点
   */
  getCurrentGitCommit(): Promise<string | null>;

  /**
   * 创建 Git 检查点（tag 或 commit）
   * @param message - 提交/标签消息
   */
  createGitCheckpoint(message: string): Promise<string | null>;

  // === 生命周期 ===

  /**
   * 启动自动保存（如果启用）
   */
  startAutoSave(): void;

  /**
   * 停止自动保存
   */
  stopAutoSave(): void;

  /**
   * 关闭管理器
   */
  close(): Promise<void>;
}


