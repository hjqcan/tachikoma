/**
 * SessionFileManager 实现
 *
 * 提供共享文件系统协调机制，管理 .tachikoma 目录结构
 * 支持原子写入、文件监控、审批流程等功能
 */

import { watch, type FSWatcher } from 'node:fs';
import type {
  SessionConfig,
  ISessionFileManager,
  PlanFile,
  ProgressFile,
  DecisionRecord,
  WorkerStatusFile,
  PendingApprovalFile,
  ApprovalResponseFile,
  InterventionFile,
  ThinkingRecord,
  ActionRecord,
  SharedContextFile,
  MessageRecord,
  SessionFileEventType,
  SessionFileEventHandler,
  SessionFileEvent,
} from './types';
import { DEFAULT_SESSION_CONFIG } from './types';
import {
  SessionPathBuilder,
  atomicWriteJson,
  readJsonFile,
  appendJsonlRecord,
  readJsonlRecords,
  readJsonlTail,
  ensureDir,
  removeDir,
  fileExists,
  safeDeleteFile,
  generateTimestampId,
  now,
} from './utils';

// ============================================================================
// SessionFileManager 实现
// ============================================================================

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

/**
 * SessionFileManager 实现类
 *
 * 管理会话目录结构，提供文件读写和监控功能
 *
 * @example
 * ```ts
 * const manager = new SessionFileManager('session-001', {
 *   rootDir: '.tachikoma',
 *   enableWatch: true,
 * });
 *
 * await manager.initializeSession();
 * await manager.registerWorker('worker-001');
 *
 * // 监听审批请求
 * manager.on('pending_approval_created', (event) => {
 *   console.log('New approval request:', event.data);
 * });
 *
 * await manager.startWatching();
 * ```
 */
export class SessionFileManager implements ISessionFileManager {
  /** 会话 ID */
  public readonly sessionId: string;

  /** 配置 */
  public readonly config: SessionConfig;

  /** 路径构建器 */
  private readonly paths: SessionPathBuilder;

  /** 事件监听器 */
  private readonly listeners = new Map<SessionFileEventType, Set<SessionFileEventHandler>>();

  /** 监控状态 */
  private watchState: WatchState = {
    watchedWorkers: new Set(),
    watchers: new Map(),
    isWatching: false,
    lastFileStates: new Map(),
  };

  /** 已注册的 Worker ID 集合 */
  private readonly registeredWorkers = new Set<string>();

  constructor(sessionId: string, config?: Partial<SessionConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    this.paths = new SessionPathBuilder(this.config.rootDir, sessionId);
  }

  // ============================================================================
  // 目录管理
  // ============================================================================

  /**
   * 获取会话根目录路径
   */
  getSessionPath(): string {
    return this.paths.sessionRoot;
  }

  /**
   * 获取 Worker 目录路径
   */
  getWorkerPath(workerId: string): string {
    return this.paths.workerDir(workerId);
  }

  /**
   * 初始化会话目录结构
   */
  async initializeSession(): Promise<void> {
    if (!this.config.autoCreateDirs) {
      return;
    }

    // 创建基础目录结构
    const dirs = this.paths.getAllDirs();
    for (const dir of dirs) {
      await ensureDir(dir);
    }

    // 初始化共享上下文文件（如果不存在）
    if (!fileExists(this.paths.sharedContextFile)) {
      const initialContext: SharedContextFile = {
        sessionId: this.sessionId,
        objective: '',
        constraints: [],
        sharedKnowledge: {
          data: {},
          updatedAt: now(),
        },
      };
      await atomicWriteJson(this.paths.sharedContextFile, initialContext);
    }
  }

  /**
   * 注册 Worker 目录
   */
  async registerWorker(workerId: string): Promise<void> {
    if (this.registeredWorkers.has(workerId)) {
      return; // 已注册
    }

    // 创建 Worker 目录
    const dirs = this.paths.getWorkerDirs(workerId);
    for (const dir of dirs) {
      await ensureDir(dir);
    }

    // 初始化 Worker 状态文件
    const initialStatus: WorkerStatusFile = {
      workerId,
      status: 'idle',
      progress: 0,
      lastHeartbeat: now(),
    };
    await atomicWriteJson(this.paths.workerStatusFile(workerId), initialStatus);

    this.registeredWorkers.add(workerId);

    // 如果正在监控，添加对新 Worker 的监控
    if (this.watchState.isWatching) {
      await this.watchWorker(workerId);
    }
  }

  // ============================================================================
  // Orchestrator 文件操作
  // ============================================================================

  /**
   * 写入计划文件
   */
  async writePlan(plan: Omit<PlanFile, 'sessionId' | 'updatedAt'>): Promise<void> {
    const fullPlan: PlanFile = {
      ...plan,
      sessionId: this.sessionId,
      updatedAt: now(),
    };
    await atomicWriteJson(this.paths.planFile, fullPlan);
  }

  /**
   * 读取计划文件
   */
  async readPlan(): Promise<PlanFile | null> {
    return readJsonFile<PlanFile>(this.paths.planFile);
  }

  /**
   * 更新进度文件
   */
  async writeProgress(progress: Omit<ProgressFile, 'sessionId' | 'updatedAt'>): Promise<void> {
    const fullProgress: ProgressFile = {
      ...progress,
      sessionId: this.sessionId,
      updatedAt: now(),
    };
    await atomicWriteJson(this.paths.progressFile, fullProgress);

    // 发出进度更新事件
    this.emit('progress_updated', fullProgress);
  }

  /**
   * 读取进度文件
   */
  async readProgress(): Promise<ProgressFile | null> {
    return readJsonFile<ProgressFile>(this.paths.progressFile);
  }

  /**
   * 追加决策记录
   */
  async appendDecision(decision: Omit<DecisionRecord, 'id' | 'timestamp'>): Promise<void> {
    const record: DecisionRecord = {
      ...decision,
      id: generateTimestampId('decision'),
      timestamp: now(),
    };
    await appendJsonlRecord(this.paths.decisionsFile, record);
  }

  /**
   * 读取决策日志
   */
  async readDecisions(limit?: number): Promise<DecisionRecord[]> {
    if (limit) {
      return readJsonlTail<DecisionRecord>(this.paths.decisionsFile, limit);
    }
    return readJsonlRecords<DecisionRecord>(this.paths.decisionsFile);
  }

  // ============================================================================
  // Worker 文件操作
  // ============================================================================

  /**
   * 读取 Worker 状态
   */
  async readWorkerStatus(workerId: string): Promise<WorkerStatusFile | null> {
    return readJsonFile<WorkerStatusFile>(this.paths.workerStatusFile(workerId));
  }

  /**
   * 写入 Worker 状态
   */
  async writeWorkerStatus(
    workerId: string,
    status: Omit<WorkerStatusFile, 'workerId'>
  ): Promise<void> {
    const fullStatus: WorkerStatusFile = {
      ...status,
      workerId,
    };
    await atomicWriteJson(this.paths.workerStatusFile(workerId), fullStatus);

    // 发出状态变化事件
    this.emit('worker_status_changed', fullStatus, workerId);
  }

  /**
   * 读取待审批请求
   */
  async readPendingApproval(workerId: string): Promise<PendingApprovalFile | null> {
    return readJsonFile<PendingApprovalFile>(this.paths.workerPendingApprovalFile(workerId));
  }

  /**
   * 写入审批响应
   */
  async writeApprovalResponse(workerId: string, response: ApprovalResponseFile): Promise<void> {
    await atomicWriteJson(this.paths.workerApprovalResponseFile(workerId), response);

    // 删除待审批文件（表示已处理）
    await safeDeleteFile(this.paths.workerPendingApprovalFile(workerId));

    // 发出审批处理完成事件
    this.emit('pending_approval_removed', response, workerId);

    // 记录决策
    await this.appendDecision({
      type: 'approval',
      workerId,
      // subtaskId 可选，不设置时不包含
      decision: {
        approved: response.approved,
        reason: response.reason || (response.approved ? 'Approved' : 'Rejected'),
        ...(response.instructions !== undefined && { instructions: response.instructions }),
      },
      trigger: {
        source: response.respondedBy === 'human' ? 'manual' : 'system',
      },
    });
  }

  /**
   * 读取审批响应
   */
  async readApprovalResponse(workerId: string): Promise<ApprovalResponseFile | null> {
    return readJsonFile<ApprovalResponseFile>(this.paths.workerApprovalResponseFile(workerId));
  }

  /**
   * 写入干预指令
   */
  async writeIntervention(
    workerId: string,
    intervention: Omit<InterventionFile, 'interventionId' | 'createdAt' | 'acknowledged'>
  ): Promise<void> {
    const fullIntervention: InterventionFile = {
      ...intervention,
      interventionId: generateTimestampId('intervention'),
      createdAt: now(),
      acknowledged: false,
    };
    await atomicWriteJson(this.paths.workerInterventionFile(workerId), fullIntervention);

    // 发出干预事件
    this.emit('intervention_created', fullIntervention, workerId);

    // 记录决策
    await this.appendDecision({
      type: 'intervention',
      workerId,
      decision: {
        reason: intervention.reason,
        instructions: intervention.instructions,
      },
      trigger: {
        source: 'periodic_check',
      },
    });
  }

  /**
   * 读取干预指令
   */
  async readIntervention(workerId: string): Promise<InterventionFile | null> {
    return readJsonFile<InterventionFile>(this.paths.workerInterventionFile(workerId));
  }

  /**
   * 确认干预指令
   */
  async acknowledgeIntervention(workerId: string): Promise<void> {
    const intervention = await this.readIntervention(workerId);
    if (intervention && !intervention.acknowledged) {
      intervention.acknowledged = true;
      intervention.acknowledgedAt = now();
      await atomicWriteJson(this.paths.workerInterventionFile(workerId), intervention);

      // 发出确认事件
      this.emit('intervention_acknowledged', intervention, workerId);
    }
  }

  /**
   * 读取 Worker 思考日志
   */
  async readThinkingLogs(workerId: string, limit?: number): Promise<ThinkingRecord[]> {
    if (limit) {
      return readJsonlTail<ThinkingRecord>(this.paths.workerThinkingFile(workerId), limit);
    }
    return readJsonlRecords<ThinkingRecord>(this.paths.workerThinkingFile(workerId));
  }

  /**
   * 读取 Worker 行动日志
   */
  async readActionLogs(workerId: string, limit?: number): Promise<ActionRecord[]> {
    if (limit) {
      return readJsonlTail<ActionRecord>(this.paths.workerActionsFile(workerId), limit);
    }
    return readJsonlRecords<ActionRecord>(this.paths.workerActionsFile(workerId));
  }

  // ============================================================================
  // 共享文件操作
  // ============================================================================

  /**
   * 读取共享上下文
   */
  async readSharedContext(): Promise<SharedContextFile | null> {
    return readJsonFile<SharedContextFile>(this.paths.sharedContextFile);
  }

  /**
   * 更新共享上下文
   */
  async writeSharedContext(context: Omit<SharedContextFile, 'sessionId'>): Promise<void> {
    const fullContext: SharedContextFile = {
      ...context,
      sessionId: this.sessionId,
      sharedKnowledge: {
        ...context.sharedKnowledge,
        updatedAt: now(),
      },
    };
    await atomicWriteJson(this.paths.sharedContextFile, fullContext);
  }

  /**
   * 追加消息记录
   */
  async appendMessage(message: Omit<MessageRecord, 'id' | 'timestamp'>): Promise<void> {
    const record: MessageRecord = {
      ...message,
      id: generateTimestampId('msg'),
      timestamp: now(),
    };
    await appendJsonlRecord(this.paths.messagesFile, record);
  }

  /**
   * 读取消息日志
   */
  async readMessages(limit?: number): Promise<MessageRecord[]> {
    if (limit) {
      return readJsonlTail<MessageRecord>(this.paths.messagesFile, limit);
    }
    return readJsonlRecords<MessageRecord>(this.paths.messagesFile);
  }

  // ============================================================================
  // 事件监控
  // ============================================================================

  /**
   * 添加事件监听器
   */
  on<T = unknown>(type: SessionFileEventType, handler: SessionFileEventHandler<T>): void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler as SessionFileEventHandler);
  }

  /**
   * 移除事件监听器
   */
  off<T = unknown>(type: SessionFileEventType, handler: SessionFileEventHandler<T>): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler as SessionFileEventHandler);
    }
  }

  /**
   * 发出事件
   */
  private emit<T>(type: SessionFileEventType, data: T, workerId?: string): void {
    const event: SessionFileEvent<T> = {
      type,
      sessionId: this.sessionId,
      ...(workerId !== undefined && { workerId }),
      filePath: '', // 由具体方法填充
      data,
      timestamp: now(),
    };

    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          // 如果返回 Promise，不等待
          if (result instanceof Promise) {
            result.catch((error) => {
              console.error(`Error in session file event handler [${type}]:`, error);
            });
          }
        } catch (error) {
          console.error(`Error in session file event handler [${type}]:`, error);
        }
      }
    }
  }

  /**
   * 启动文件监控
   */
  async startWatching(): Promise<void> {
    if (!this.config.enableWatch) {
      return;
    }

    if (this.watchState.isWatching) {
      return; // 已经在监控
    }

    this.watchState.isWatching = true;

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
  stopWatching(): void {
    this.watchState.isWatching = false;

    // 停止所有 FSWatcher
    for (const watcher of this.watchState.watchers.values()) {
      watcher.close();
    }
    this.watchState.watchers.clear();
    this.watchState.watchedWorkers.clear();

    // 停止轮询
    if (this.watchState.pollTimer) {
      clearInterval(this.watchState.pollTimer);
      this.watchState.pollTimer = undefined;
    }
  }

  /**
   * 监控单个 Worker 目录
   */
  private async watchWorker(workerId: string): Promise<void> {
    if (this.watchState.watchedWorkers.has(workerId)) {
      return;
    }

    const workerDir = this.paths.workerDir(workerId);

    try {
      // 使用 fs.watch 监控目录
      const watcher = watch(workerDir, { persistent: false }, (eventType, filename) => {
        if (filename) {
          this.handleFileChange(workerId, filename, eventType);
        }
      });

      watcher.on('error', (error) => {
        console.error(`Watch error for worker ${workerId}:`, error);
      });

      this.watchState.watchers.set(workerId, watcher);
      this.watchState.watchedWorkers.add(workerId);

      // 初始化文件状态缓存
      await this.updateFileStateCache(workerId);
    } catch (error) {
      console.error(`Failed to watch worker ${workerId}:`, error);
    }
  }

  /**
   * 处理文件变化
   */
  private async handleFileChange(
    workerId: string,
    filename: string,
    _eventType: string
  ): Promise<void> {
    // 处理 pending_approval.json
    if (filename === 'pending_approval.json') {
      const approval = await this.readPendingApproval(workerId);
      if (approval) {
        this.emit('pending_approval_created', approval, workerId);
      }
    }

    // 处理 status.json
    if (filename === 'status.json') {
      const status = await this.readWorkerStatus(workerId);
      if (status) {
        this.emit('worker_status_changed', status, workerId);
      }
    }

    // 处理 intervention.json
    if (filename === 'intervention.json') {
      const intervention = await this.readIntervention(workerId);
      if (intervention) {
        if (intervention.acknowledged) {
          this.emit('intervention_acknowledged', intervention, workerId);
        }
      }
    }
  }

  /**
   * 启动轮询检查
   *
   * 作为 fs.watch 的补充，定期检查文件变化
   * 某些文件系统（如网络文件系统）可能不支持 fs.watch
   */
  private startPolling(): void {
    if (this.watchState.pollTimer) {
      return;
    }

    this.watchState.pollTimer = setInterval(async () => {
      await this.pollForChanges();
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
   */
  private async checkWorkerFileChanges(workerId: string): Promise<void> {
    const pendingApprovalPath = this.paths.workerPendingApprovalFile(workerId);
    const cacheKey = `${workerId}:pending_approval`;

    const currentExists = fileExists(pendingApprovalPath);
    const lastState = this.watchState.lastFileStates.get(cacheKey);

    if (currentExists && !lastState) {
      // 新创建了 pending_approval.json
      const approval = await this.readPendingApproval(workerId);
      if (approval) {
        this.emit('pending_approval_created', approval, workerId);
      }
    }

    this.watchState.lastFileStates.set(cacheKey, currentExists ? 1 : 0);
  }

  /**
   * 更新文件状态缓存
   */
  private async updateFileStateCache(workerId: string): Promise<void> {
    const pendingApprovalPath = this.paths.workerPendingApprovalFile(workerId);
    const cacheKey = `${workerId}:pending_approval`;

    this.watchState.lastFileStates.set(
      cacheKey,
      fileExists(pendingApprovalPath) ? 1 : 0
    );
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  /**
   * 清理会话目录
   */
  async cleanup(): Promise<void> {
    await removeDir(this.paths.sessionRoot);
  }

  /**
   * 关闭 SessionFileManager
   */
  async close(): Promise<void> {
    this.stopWatching();
    this.listeners.clear();
    this.registeredWorkers.clear();
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 SessionFileManager 实例
 *
 * @param sessionId - 会话 ID
 * @param config - 可选配置
 * @returns SessionFileManager 实例
 *
 * @example
 * ```ts
 * const manager = createSessionFileManager('session-001', {
 *   rootDir: '.tachikoma',
 *   enableWatch: true,
 * });
 *
 * await manager.initializeSession();
 * ```
 */
export function createSessionFileManager(
  sessionId: string,
  config?: Partial<SessionConfig>
): SessionFileManager {
  return new SessionFileManager(sessionId, config);
}

/**
 * 创建并初始化 SessionFileManager
 *
 * @param sessionId - 会话 ID
 * @param config - 可选配置
 * @returns 已初始化的 SessionFileManager 实例
 */
export async function createAndInitializeSessionFileManager(
  sessionId: string,
  config?: Partial<SessionConfig>
): Promise<SessionFileManager> {
  const manager = createSessionFileManager(sessionId, config);
  await manager.initializeSession();
  return manager;
}
