/**
 * SessionFileManager: 文件监控实现（拆分自 session-file-manager.ts）
 */

import { watch, type FSWatcher } from 'node:fs';
import type {
  ActionRecord,
  ApprovalResponseFile,
  InterventionFile,
  PendingApprovalFile,
  SessionConfig,
  SessionFileEventType,
  WorkerStatusFile,
} from './types';
import {
  atomicWriteJson,
  fileExists,
  getFileStats,
  now,
  safeReadJsonFileWithRetry,
  safeReadJsonlTailWithRetry,
  type SessionPathBuilder,
} from './utils';

/**
 * 文件监控状态
 */
interface WatchState {
  /** 监控的 Worker ID 列表 */
  watchedWorkers: Set<string>;
  /** FSWatcher 实例映射 */
  watchers: Map<string, FSWatcher>;
  /** 是否正在监控 */
  isWatching: boolean;
  /** 轮询定时器 */
  pollTimer?: ReturnType<typeof setInterval> | undefined;
  /** 上次文件状态缓存（用于检测变化） */
  lastFileStates: Map<string, number>;
}

export interface SessionWatcherDeps {
  config: SessionConfig;
  paths: SessionPathBuilder;
  registeredWorkers: Set<string>;
  emit: <T>(type: SessionFileEventType, data: T, workerId?: string, filePath?: string) => void;
  readPendingApproval: (workerId: string) => Promise<PendingApprovalFile | null>;
  readWorkerStatus: (workerId: string) => Promise<WorkerStatusFile | null>;
  readIntervention: (workerId: string) => Promise<InterventionFile | null>;
  readApprovalResponse: (workerId: string) => Promise<ApprovalResponseFile | null>;
}

export class SessionWatcher {
  private readonly config: SessionConfig;
  private readonly paths: SessionPathBuilder;
  private readonly registeredWorkers: Set<string>;
  private readonly emit: SessionWatcherDeps['emit'];
  private readonly readPendingApproval: SessionWatcherDeps['readPendingApproval'];
  private readonly readWorkerStatus: SessionWatcherDeps['readWorkerStatus'];
  private readonly readIntervention: SessionWatcherDeps['readIntervention'];
  private readonly readApprovalResponse: SessionWatcherDeps['readApprovalResponse'];

  private readonly state: WatchState = {
    watchedWorkers: new Set(),
    watchers: new Map(),
    isWatching: false,
    lastFileStates: new Map(),
  };

  constructor(deps: SessionWatcherDeps) {
    this.config = deps.config;
    this.paths = deps.paths;
    this.registeredWorkers = deps.registeredWorkers;
    this.emit = deps.emit;
    this.readPendingApproval = deps.readPendingApproval;
    this.readWorkerStatus = deps.readWorkerStatus;
    this.readIntervention = deps.readIntervention;
    this.readApprovalResponse = deps.readApprovalResponse;
  }

  get isWatching(): boolean {
    return this.state.isWatching;
  }

  /**
   * 启动文件监控
   */
  async start(): Promise<void> {
    if (!this.config.enableWatch) return;
    if (this.state.isWatching) return;
    this.state.isWatching = true;

    // 监控所有已注册的 Worker
    for (const workerId of this.registeredWorkers) {
      await this.watchWorker(workerId);
    }

    // 启动轮询检查（作为 fs.watch 的补充）
    this.startPolling();
  }

  /**
   * 停止文件监控
   */
  stop(): void {
    this.state.isWatching = false;

    // 停止所有 FSWatcher
    for (const watcher of this.state.watchers.values()) {
      watcher.close();
    }
    this.state.watchers.clear();
    this.state.watchedWorkers.clear();

    // 停止轮询
    if (this.state.pollTimer) {
      clearInterval(this.state.pollTimer);
      this.state.pollTimer = undefined;
    }
  }

  /**
   * 监控单个 Worker 目录
   */
  async watchWorker(workerId: string): Promise<void> {
    if (!this.state.isWatching) return;
    if (this.state.watchedWorkers.has(workerId)) return;

    const workerDir = this.paths.workerDir(workerId);

    try {
      // 使用 fs.watch 监控目录
      const watcher = watch(workerDir, { persistent: false }, (eventType, filename) => {
        if (filename) {
          void this.handleFileChange(workerId, filename, eventType);
        }
      });

      watcher.on('error', (error) => {
        console.error(`Watch error for worker ${workerId}:`, error);
      });

      this.state.watchers.set(workerId, watcher);
      this.state.watchedWorkers.add(workerId);

      // 初始化文件状态缓存
      await this.updateFileStateCache(workerId);
    } catch (error) {
      console.error(`Failed to watch worker ${workerId}:`, error);
    }
  }

  /**
   * 处理文件变化
   *
   * 注意：所有读取操作都用 try/catch 包装，防止 JSON 解析错误导致 watcher 崩溃
   */
  private async handleFileChange(workerId: string, filename: string, _eventType: string): Promise<void> {
    try {
      // 处理 pending_approval.json
      if (filename === 'pending_approval.json') {
        const filePath = this.paths.workerPendingApprovalFile(workerId);
        const approval = await this.readPendingApproval(workerId);
        if (approval) {
          this.emit('pending_approval_created', approval, workerId, filePath);
        }
      }

      // 处理 status.json
      if (filename === 'status.json') {
        const filePath = this.paths.workerStatusFile(workerId);
        const status = await this.readWorkerStatus(workerId);
        if (status) {
          this.emit('worker_status_changed', status, workerId, filePath);
        }
      }

      // 处理 intervention.json
      if (filename === 'intervention.json') {
        const filePath = this.paths.workerInterventionFile(workerId);
        const intervention = await this.readIntervention(workerId);
        if (intervention?.acknowledged) {
          this.emit('intervention_acknowledged', intervention, workerId, filePath);
        }
      }
    } catch (error) {
      // 捕获 JSON 解析错误或其他读取错误，记录警告但不终止监听
      console.warn(`[SessionFileManager] Error handling file change for worker ${workerId}, file ${filename}:`, error);
    }
  }

  /**
   * 启动轮询检查
   *
   * 作为 fs.watch 的补充，定期检查文件变化
   * 某些文件系统（如网络文件系统）可能不支持 fs.watch
   */
  private startPolling(): void {
    if (this.state.pollTimer) return;
    this.state.pollTimer = setInterval(() => {
      void this.pollForChanges();
    }, this.config.watchPollInterval);
  }

  /**
   * 轮询检查文件变化
   */
  private async pollForChanges(): Promise<void> {
    for (const workerId of this.registeredWorkers) {
      await this.checkWorkerFileChanges(workerId);
    }
  }

  /**
   * 检查单个 Worker 的文件变化
   *
   * 使用时间戳对比检测所有监控文件的变化，防止 fs.watch 漏事件
   */
  private async checkWorkerFileChanges(workerId: string): Promise<void> {
    try {
      // 检查 pending_approval.json
      await this.checkFileByTimestamp(workerId, 'pending_approval', this.paths.workerPendingApprovalFile(workerId), async (filePath) => {
        const approval = await this.readPendingApproval(workerId);
        if (approval) {
          this.emit('pending_approval_created', approval, workerId, filePath);
        }
      });

      // 检查 status.json
      await this.checkFileByTimestamp(workerId, 'status', this.paths.workerStatusFile(workerId), async (filePath) => {
        const status = await this.readWorkerStatus(workerId);
        if (status) {
          this.emit('worker_status_changed', status, workerId, filePath);
        }
      });

      // 检查 intervention.json
      await this.checkFileByTimestamp(workerId, 'intervention', this.paths.workerInterventionFile(workerId), async (filePath) => {
        const intervention = await this.readIntervention(workerId);
        if (intervention?.acknowledged) {
          this.emit('intervention_acknowledged', intervention, workerId, filePath);
        }
      });

      // 检查 approval_response.json
      await this.checkFileByTimestamp(workerId, 'approval_response', this.paths.workerApprovalResponseFile(workerId), async (filePath) => {
        const response = await this.readApprovalResponse(workerId);
        if (response) {
          this.emit('pending_approval_removed', response, workerId, filePath);
        }
      });

      // Stale detection: if a worker stops updating heartbeat, mark it as error to avoid a permanently stuck status.
      await this.maybeMarkStaleWorker(workerId);
    } catch (error) {
      console.warn(`[SessionFileManager] Error polling worker ${workerId}:`, error);
    }
  }

  private async maybeMarkStaleWorker(workerId: string): Promise<void> {
    const statusPath = this.paths.workerStatusFile(workerId);
    const status = await safeReadJsonFileWithRetry<WorkerStatusFile>(statusPath, { retries: 1, delay: 20 });
    if (!status) return;

    if (status.status === 'idle' || status.status === 'error' || status.status === 'waiting_approval') {
      return;
    }

    const currentTime = now();
    const heartbeatAge = currentTime - status.lastHeartbeat;
    if (heartbeatAge <= this.config.staleWorkerTimeoutMs) return;

    // If actions are still being appended, treat the worker as active even if heartbeat isn't updated.
    const actionsPath = this.paths.workerActionsFile(workerId);
    const tail = await safeReadJsonlTailWithRetry<ActionRecord>(actionsPath, 1, { retries: 1, delay: 20 });
    const lastAction = tail.at(-1);
    const lastActionAge = lastAction ? currentTime - lastAction.timestamp : Number.POSITIVE_INFINITY;
    if (lastAction && lastActionAge <= this.config.staleWorkerActionGraceMs) return;

    // CAS check: re-read status to avoid race condition where worker resumed heartbeat
    // between our first read and this write. Abort if heartbeat was updated.
    const recheck = await safeReadJsonFileWithRetry<WorkerStatusFile>(statusPath, { retries: 1, delay: 20 });
    if (!recheck || recheck.lastHeartbeat !== status.lastHeartbeat) {
      // Heartbeat was updated, worker is alive - abort marking as stale
      return;
    }

    const next: WorkerStatusFile = {
      workerId,
      status: 'error',
      progress: typeof status.progress === 'number' ? status.progress : 0,
      lastHeartbeat: currentTime,
      ...(status.currentSubtask && { currentSubtask: status.currentSubtask }),
      error: {
        code: 'stale_worker',
        message: `Worker heartbeat timed out (${Math.round(heartbeatAge / 1000)}s)`,
        timestamp: currentTime,
      },
    };

    await atomicWriteJson(statusPath, next);
  }

  /**
   * 基于时间戳检查文件变化
   */
  private async checkFileByTimestamp(
    workerId: string,
    fileType: string,
    filePath: string,
    onChanged: (filePath: string) => Promise<void>
  ): Promise<void> {
    const cacheKey = `${workerId}:${fileType}`;
    const stats = await getFileStats(filePath);
    const currentMtime = stats?.mtime.getTime() || 0;
    const lastMtime = this.state.lastFileStates.get(cacheKey) || 0;

    if (currentMtime > 0 && currentMtime !== lastMtime) {
      // 文件已更新，触发回调
      await onChanged(filePath);
    }

    this.state.lastFileStates.set(cacheKey, currentMtime);
  }

  /**
   * 更新文件状态缓存
   */
  private async updateFileStateCache(workerId: string): Promise<void> {
    const pendingApprovalPath = this.paths.workerPendingApprovalFile(workerId);
    const cacheKey = `${workerId}:pending_approval`;

    this.state.lastFileStates.set(cacheKey, fileExists(pendingApprovalPath) ? 1 : 0);
  }
}


