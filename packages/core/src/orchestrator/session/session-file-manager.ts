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
  RuntimeFile,
  DistributiveOmit,
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
  PeerReadOptions,
} from './types';
import { DEFAULT_SESSION_CONFIG, DEFAULT_PEER_READ_OPTIONS } from './types';
import type { SubTask } from '../types';
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
  getFileStats,
  listDir,
  safeReadJsonFileWithRetry,
  safeReadJsonlTailWithRetry,
  now,
} from './utils';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

// 注：旧实现曾在 runtime.json 内归档“细分后的 subtasks”并更新 executionPlan。
// 现在 runtime.json 永远是脱敏引用格式（不包含 plannerOutput），细分/expand 必须写回 tasks.json。

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
  private readonly watchState: WatchState = {
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
    // 已注册时，验证目录和状态文件仍然存在
    if (this.registeredWorkers.has(workerId)) {
      const workerDir = this.paths.workerDir(workerId);
      const statusFile = this.paths.workerStatusFile(workerId);
      if (!fileExists(workerDir) || !fileExists(statusFile)) {
        // 目录或状态文件被外部删除，需要重新创建
        this.registeredWorkers.delete(workerId);
        console.warn(`[SessionFileManager] Worker ${workerId} directory/status missing, re-registering`);
      } else {
        return; // 已注册且目录存在
      }
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
   * 写入运行时文件
   */
  async writeRuntime(
    runtime: DistributiveOmit<RuntimeFile, 'sessionId' | 'updatedAt'>
  ): Promise<void> {
    const fullRuntime: RuntimeFile = {
      ...runtime,
      sessionId: this.sessionId,
      updatedAt: now(),
    };
    await atomicWriteJson(this.paths.runtimeFile, fullRuntime);
  }

  /**
   * 读取运行时文件
   */
  async readRuntime(): Promise<RuntimeFile | null> {
    return readJsonFile<RuntimeFile>(this.paths.runtimeFile);
  }

  /**
   * 追加细分子任务到计划文件
   *
   * 当 Orchestrator 动态细分子任务时，调用此方法将细分后的子任务归档到 runtime.json
   *
   * @param params - 细分后的子任务与父任务信息
   */
  async appendRefinedSubtasks(_params: { parentId: string; refinedSubtasks: SubTask[] }): Promise<void> {
    // runtime.json 永远是脱敏引用格式（不包含任务描述/子任务列表），因此不支持在此处归档 refined subtasks。
    // 细分/expand 必须写回 tasks.json（由 Orchestrator/taskmaster-compat 负责）。
    console.debug(
      '[SessionFileManager] appendRefinedSubtasks is a no-op under sanitized runtime.json; use tasks.json expansion instead.'
    );
    // no-op
  }

  /**
   * 更新子任务状态
   *
   * @param subtaskId - 子任务 ID
   * @param status - 新状态
   * @param result - 可选的结果数据
   */
  async updateSubtaskStatus(
    _subtaskId: string,
    _status: 'pending' | 'running' | 'success' | 'failure',
    _result?: unknown
  ): Promise<void> {
    // runtime.json 不落盘任务描述/子任务列表；子任务状态由 tasks.json 作为唯一真相。
    // 这里保留接口以兼容历史调用，但不做任何写入。
    // no-op
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
    this.emit('progress_updated', fullProgress, undefined, this.paths.progressFile);
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
    this.emit('worker_status_changed', fullStatus, workerId, this.paths.workerStatusFile(workerId));
  }

  /**
   * 读取待审批请求
   */
  async readPendingApproval(workerId: string): Promise<PendingApprovalFile | null> {
    return readJsonFile<PendingApprovalFile>(this.paths.workerPendingApprovalFile(workerId));
  }

  /**
   * 写入审批响应
   *
   * 幂等处理：检查现有响应的 requestId，避免重复记录决策
   */
  async writeApprovalResponse(workerId: string, response: ApprovalResponseFile): Promise<void> {
    const responsePath = this.paths.workerApprovalResponseFile(workerId);

    // 幂等检查：如果已存在相同 requestId 的响应，跳过重复写入
    const existingResponse = await this.readApprovalResponse(workerId);
    if (existingResponse && existingResponse.requestId === response.requestId) {
      console.warn(`[SessionFileManager] Approval response for requestId ${response.requestId} already exists, skipping`);
      return;
    }

    await atomicWriteJson(responsePath, response);

    // 删除待审批文件（表示已处理）
    await safeDeleteFile(this.paths.workerPendingApprovalFile(workerId));

    // 发出审批处理完成事件
    this.emit('pending_approval_removed', response, workerId, responsePath);

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
        requestId: response.requestId, // 添加 requestId 用于幂等追踪
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
    const interventionPath = this.paths.workerInterventionFile(workerId);
    const fullIntervention: InterventionFile = {
      ...intervention,
      interventionId: generateTimestampId('intervention'),
      createdAt: now(),
      acknowledged: false,
    };
    await atomicWriteJson(interventionPath, fullIntervention);

    // 发出干预事件
    this.emit('intervention_created', fullIntervention, workerId, interventionPath);

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
        interventionId: fullIntervention.interventionId, // 添加 interventionId 用于幂等追踪
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

  /**
   * 追加 Worker 思考记录
   *
   * @param workerId - Worker ID
   * @param record - 思考记录（不含 id）
   */
  async appendThinking(
    workerId: string,
    record: Omit<ThinkingRecord, 'id'>
  ): Promise<void> {
    const fullRecord: ThinkingRecord = {
      ...record,
      id: generateTimestampId('thinking'),
    };
    await appendJsonlRecord(this.paths.workerThinkingFile(workerId), fullRecord);

    // 发出思考更新事件
    this.emit('thinking_updated', fullRecord, workerId, this.paths.workerThinkingFile(workerId));
  }

  /**
   * 追加 Worker 行动记录
   *
   * @param workerId - Worker ID
   * @param record - 行动记录（不含 id）
   */
  async appendAction(
    workerId: string,
    record: Omit<ActionRecord, 'id'>
  ): Promise<void> {
    const fullRecord: ActionRecord = {
      ...record,
      id: generateTimestampId('action'),
    };
    await appendJsonlRecord(this.paths.workerActionsFile(workerId), fullRecord);

    // 发出行动完成事件
    this.emit('action_completed', fullRecord, workerId, this.paths.workerActionsFile(workerId));
  }

  /**
   * 写入待审批请求文件
   *
   * @param workerId - Worker ID
   * @param approval - 待审批请求
   */
  async writePendingApproval(workerId: string, approval: PendingApprovalFile): Promise<void> {
    const approvalPath = this.paths.workerPendingApprovalFile(workerId);
    await atomicWriteJson(approvalPath, approval);

    // 发出审批请求事件
    this.emit('pending_approval_created', approval, workerId, approvalPath);
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
  // Peer 读取方法
  // ============================================================================

  /**
   * 列出所有已注册的 Worker ID
   *
   * 基于 sessions/{sessionId}/workers 目录
   */
  async listPeerWorkers(): Promise<string[]> {
    const workersDir = this.paths.workersDir;
    const entries = await listDir(workersDir);
    // 过滤出目录（排除文件）
    const workers: string[] = [];
    for (const entry of entries) {
      const stats = await getFileStats(join(workersDir, entry));
      if (stats?.isDirectory) {
        workers.push(entry);
      }
    }
    return workers;
  }

  /**
   * 读取其他 Worker 的状态
   *
   * @param workerId - Worker ID
   * @param opts - 重试选项
   */
  async readPeerStatus(
    workerId: string,
    opts?: PeerReadOptions
  ): Promise<WorkerStatusFile | null> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonFileWithRetry<WorkerStatusFile>(
      this.paths.workerStatusFile(workerId),
      { retries: options.retries, delay: options.backoffDelay }
    );
  }

  /**
   * 读取其他 Worker 的思考日志
   *
   * @param workerId - Worker ID
   * @param limit - 最大条数（默认 20）
   * @param opts - 重试选项
   */
  async readPeerThinking(
    workerId: string,
    limit = 20,
    opts?: PeerReadOptions
  ): Promise<ThinkingRecord[]> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonlTailWithRetry<ThinkingRecord>(
      this.paths.workerThinkingFile(workerId),
      limit,
      { retries: options.retries, delay: options.backoffDelay }
    );
  }

  /**
   * 读取其他 Worker 的行动日志
   *
   * @param workerId - Worker ID
   * @param limit - 最大条数（默认 20）
   * @param opts - 重试选项
   */
  async readPeerActions(
    workerId: string,
    limit = 20,
    opts?: PeerReadOptions
  ): Promise<ActionRecord[]> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonlTailWithRetry<ActionRecord>(
      this.paths.workerActionsFile(workerId),
      limit,
      { retries: options.retries, delay: options.backoffDelay }
    );
  }

  /**
   * 列出 Worker 的 artifacts 文件名
   *
   * @param workerId - Worker ID
   */
  async listPeerArtifacts(workerId: string): Promise<string[]> {
    const artifactsDir = this.paths.workerArtifactsDir(workerId);
    const entries = await listDir(artifactsDir);
    // 返回文件名列表（排除目录）
    const files: string[] = [];
    for (const entry of entries) {
      const stats = await getFileStats(join(artifactsDir, entry));
      if (stats?.isFile) {
        files.push(entry);
      }
    }
    return files;
  }

  /**
   * 读取 Worker 的单个 artifact 文件内容
   *
   * @param workerId - Worker ID
   * @param filename - 文件名
   */
  async readPeerArtifact(
    workerId: string,
    filename: string
  ): Promise<string | null> {
    const filePath = join(this.paths.workerArtifactsDir(workerId), filename);
    try {
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 读取 Orchestrator 运行时快照（别名方法）
   *
   * 用于 Worker 读取当前执行顺序/运行信息
   *
   * @param opts - 重试选项
   */
  async readOrchestratorRuntime(opts?: PeerReadOptions): Promise<RuntimeFile | null> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonFileWithRetry<RuntimeFile>(
      this.paths.runtimeFile,
      { retries: options.retries, delay: options.backoffDelay }
    );
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
   * @param type - 事件类型
   * @param data - 事件数据
   * @param workerId - Worker ID（可选）
   * @param filePath - 相关文件路径（可选）
   */
  private emit<T>(type: SessionFileEventType, data: T, workerId?: string, filePath?: string): void {
    const event: SessionFileEvent<T> = {
      type,
      sessionId: this.sessionId,
      ...(workerId !== undefined && { workerId }),
      filePath: filePath || '',
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
   *
   * 注意：所有读取操作都用 try/catch 包装，防止 JSON 解析错误导致 watcher 崩溃
   */
  private async handleFileChange(
    workerId: string,
    filename: string,
    _eventType: string
  ): Promise<void> {
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
        if (intervention) {
          if (intervention.acknowledged) {
            this.emit('intervention_acknowledged', intervention, workerId, filePath);
          }
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
   *
   * 使用时间戳对比检测所有监控文件的变化，防止 fs.watch 漏事件
   */
  private async checkWorkerFileChanges(workerId: string): Promise<void> {
    try {
      // 检查 pending_approval.json
      await this.checkFileByTimestamp(
        workerId,
        'pending_approval',
        this.paths.workerPendingApprovalFile(workerId),
        async (filePath) => {
          const approval = await this.readPendingApproval(workerId);
          if (approval) {
            this.emit('pending_approval_created', approval, workerId, filePath);
          }
        }
      );

      // 检查 status.json
      await this.checkFileByTimestamp(
        workerId,
        'status',
        this.paths.workerStatusFile(workerId),
        async (filePath) => {
          const status = await this.readWorkerStatus(workerId);
          if (status) {
            this.emit('worker_status_changed', status, workerId, filePath);
          }
        }
      );

      // 检查 intervention.json
      await this.checkFileByTimestamp(
        workerId,
        'intervention',
        this.paths.workerInterventionFile(workerId),
        async (filePath) => {
          const intervention = await this.readIntervention(workerId);
          if (intervention?.acknowledged) {
            this.emit('intervention_acknowledged', intervention, workerId, filePath);
          }
        }
      );

      // 检查 approval_response.json
      await this.checkFileByTimestamp(
        workerId,
        'approval_response',
        this.paths.workerApprovalResponseFile(workerId),
        async (filePath) => {
          const response = await this.readApprovalResponse(workerId);
          if (response) {
            this.emit('pending_approval_removed', response, workerId, filePath);
          }
        }
      );

      // Stale detection: if a worker stops updating heartbeat, mark it as error to avoid a permanently stuck status.
      await this.maybeMarkStaleWorker(workerId);
    } catch (error) {
      console.warn(`[SessionFileManager] Error polling worker ${workerId}:`, error);
    }
  }

  private async maybeMarkStaleWorker(workerId: string): Promise<void> {
    const statusPath = this.paths.workerStatusFile(workerId);
    const status = await safeReadJsonFileWithRetry<WorkerStatusFile>(statusPath, {
      retries: 1,
      delay: 20,
    });
    if (!status) return;

    if (status.status === 'idle' || status.status === 'error' || status.status === 'waiting_approval') {
      return;
    }

    const currentTime = now();
    const heartbeatAge = currentTime - status.lastHeartbeat;
    if (heartbeatAge <= this.config.staleWorkerTimeoutMs) return;

    // If actions are still being appended, treat the worker as active even if heartbeat isn't updated.
    const actionsPath = this.paths.workerActionsFile(workerId);
    const tail = await safeReadJsonlTailWithRetry<ActionRecord>(actionsPath, 1, {
      retries: 1,
      delay: 20,
    });
    const lastAction = tail.at(-1);
    const lastActionAge = lastAction ? currentTime - lastAction.timestamp : Number.POSITIVE_INFINITY;
    if (lastAction && lastActionAge <= this.config.staleWorkerActionGraceMs) return;

    // CAS check: re-read status to avoid race condition where worker resumed heartbeat
    // between our first read and this write. Abort if heartbeat was updated.
    const recheck = await safeReadJsonFileWithRetry<WorkerStatusFile>(statusPath, {
      retries: 1,
      delay: 20,
    });
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
    const lastMtime = this.watchState.lastFileStates.get(cacheKey) || 0;

    if (currentMtime > 0 && currentMtime !== lastMtime) {
      // 文件已更新，触发回调
      await onChanged(filePath);
    }

    this.watchState.lastFileStates.set(cacheKey, currentMtime);
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
   *
   * 安全检查：确保 sessionRoot 路径合法，防止配置错误导致误删
   */
  async cleanup(): Promise<void> {
    const sessionRoot = this.paths.sessionRoot;
    const expectedPrefix = `${this.config.rootDir}/sessions/`;

    // 安全检查：确保路径包含正确的前缀和 sessionId
    if (!sessionRoot.includes(expectedPrefix) || !sessionRoot.includes(this.sessionId)) {
      throw new Error(
        `[SessionFileManager] Refusing to cleanup invalid path: ${sessionRoot}. ` +
        `Expected path to contain '${expectedPrefix}' and sessionId '${this.sessionId}'`
      );
    }

    await removeDir(sessionRoot);
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
