/**
 * SessionFileManager 实现
 *
 * 提供共享文件系统协调机制，管理 .tachikoma 目录结构
 * 支持原子写入、文件监控、审批流程等功能
 */

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
import { DEFAULT_SESSION_CONFIG } from './types';
import type { SubTask } from '../types';
import { SessionPeerReader } from './session-file-manager.peer';
import { SessionWatcher } from './session-file-manager.watch';
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

  /** 已注册的 Worker ID 集合 */
  private readonly registeredWorkers = new Set<string>();

  /** Peer 读取器（拆分实现） */
  private readonly peerReader: SessionPeerReader;

  /** 文件监控器（拆分实现） */
  private readonly watcher: SessionWatcher;

  constructor(sessionId: string, config?: Partial<SessionConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    this.paths = new SessionPathBuilder(this.config.rootDir, sessionId);

    this.peerReader = new SessionPeerReader(this.paths);
    this.watcher = new SessionWatcher({
      config: this.config,
      paths: this.paths,
      registeredWorkers: this.registeredWorkers,
      emit: (type, data, workerId, filePath) => this.emit(type, data, workerId, filePath),
      readPendingApproval: (workerId) => this.readPendingApproval(workerId),
      readWorkerStatus: (workerId) => this.readWorkerStatus(workerId),
      readIntervention: (workerId) => this.readIntervention(workerId),
      readApprovalResponse: (workerId) => this.readApprovalResponse(workerId),
    });
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
    if (this.watcher.isWatching) {
      await this.watcher.watchWorker(workerId);
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
    return this.peerReader.listPeerWorkers();
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
    return this.peerReader.readPeerStatus(workerId, opts);
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
    return this.peerReader.readPeerThinking(workerId, limit, opts);
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
    return this.peerReader.readPeerActions(workerId, limit, opts);
  }

  /**
   * 列出 Worker 的 artifacts 文件名
   *
   * @param workerId - Worker ID
   */
  async listPeerArtifacts(workerId: string): Promise<string[]> {
    return this.peerReader.listPeerArtifacts(workerId);
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
    return this.peerReader.readPeerArtifact(workerId, filename);
  }

  /**
   * 读取 Orchestrator 运行时快照（别名方法）
   *
   * 用于 Worker 读取当前执行顺序/运行信息
   *
   * @param opts - 重试选项
   */
  async readOrchestratorRuntime(opts?: PeerReadOptions): Promise<RuntimeFile | null> {
    return this.peerReader.readOrchestratorRuntime(opts);
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
    await this.watcher.start();
  }

  /**
   * 停止文件监控
   */
  stopWatching(): void {
    this.watcher.stop();
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
