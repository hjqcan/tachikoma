/**
 * 会话生命周期管理器
 *
 * 负责 Orchestrator 会话的初始化和关闭
 * 从 Orchestrator 类中提取
 */

import type {
  ISessionFileManager,
  ThinkingRecord,
  ActionRecord,
  PendingApprovalFile,
  SessionFileEvent,
} from '../session';
import {
  createAndInitializeSessionFileManager,
  CheckpointManager,
  generateTimestampId,
} from '../session';
import type { CheckpointConfig, OrchestratorTask } from '../types';
import type { IEventService } from '../interfaces';
import type { IWorkerPool } from '../worker-pool';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 会话生命周期配置
 */
export interface SessionLifecycleConfig {
  rootDir: string;
  enableWatch?: boolean;
  watchPollInterval?: number;
  checkpoint?: CheckpointConfig;
}

/**
 * 协作管理器接口
 */
export interface ICollaborationManagerForLifecycle {
  start(agentId: string, metadata: {
    sessionId: string;
    type: string;
    capabilities: string[];
    status: string;
    priority: number;
  }): Promise<void>;
  stop(): Promise<void>;
}

// ============================================================================
// SessionLifecycleManager 实现
// ============================================================================

/**
 * 会话生命周期管理器
 *
 * 负责：
 * 1. 会话初始化（创建 SessionManager、CheckpointManager）
 * 2. 事件转发器注册
 * 3. 协作管理器启动
 * 4. 会话关闭与清理
 *
 * @example
 * ```ts
 * const manager = new SessionLifecycleManager({
 *   config: { rootDir: '/path/to/sessions' },
 *   eventService,
 *   workerPool,
 * });
 *
 * await manager.initialize(taskId, sessionId);
 * // ... 执行任务 ...
 * await manager.close();
 * ```
 */
export class SessionLifecycleManager {
  private readonly config: SessionLifecycleConfig;
  private readonly eventService: IEventService;
  private readonly workerPool: IWorkerPool;

  // 注入的 SessionManager（可选）
  private injectedSessionManager?: ISessionFileManager;

  // 当前会话状态
  private sessionManager: ISessionFileManager | null = null;
  private checkpointManager: CheckpointManager | null = null;
  private currentSessionId: string | null = null;
  private currentTask: OrchestratorTask | null = null;

  // 协作管理器（可选）
  private collaborationManager?: ICollaborationManagerForLifecycle;
  private collaborationEnabled = false;

  // 事件处理器绑定
  private boundApprovalHandler?: (event: SessionFileEvent<PendingApprovalFile>) => Promise<void>;
  private boundThinkingForwarder?: (event: SessionFileEvent<ThinkingRecord>) => void;
  private boundActionForwarder?: (event: SessionFileEvent<ActionRecord>) => void;

  // 偏离检测控制
  private deviationDetectionStarter?: () => void;
  private deviationDetectionStopper?: () => void;

  // 协作请求处理器注册
  private collaborationRequestHandlerRegistrar?: () => void;

  // 调试标志
  private debugEnabled = false;

  constructor(options: {
    config: SessionLifecycleConfig;
    eventService: IEventService;
    workerPool: IWorkerPool;
    injectedSessionManager?: ISessionFileManager;
    collaborationManager?: ICollaborationManagerForLifecycle;
    collaborationEnabled?: boolean;
  }) {
    this.config = options.config;
    this.eventService = options.eventService;
    this.workerPool = options.workerPool;
    if (options.injectedSessionManager) {
      this.injectedSessionManager = options.injectedSessionManager;
    }
    if (options.collaborationManager) {
      this.collaborationManager = options.collaborationManager;
    }
    this.collaborationEnabled = options.collaborationEnabled ?? false;
  }

  // ============================================================================
  // 配置方法
  // ============================================================================

  /**
   * 设置审批处理器
   */
  setApprovalHandler(
    handler: (event: SessionFileEvent<PendingApprovalFile>) => Promise<void>
  ): void {
    this.boundApprovalHandler = handler;
  }

  /**
   * 设置偏离检测控制器
   */
  setDeviationDetection(starter: () => void, stopper: () => void): void {
    this.deviationDetectionStarter = starter;
    this.deviationDetectionStopper = stopper;
  }

  /**
   * 设置协作请求处理器注册器
   */
  setCollaborationRequestHandlerRegistrar(registrar: () => void): void {
    this.collaborationRequestHandlerRegistrar = registrar;
  }

  /**
   * 设置调试模式
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /**
   * 设置当前任务
   */
  setCurrentTask(task: OrchestratorTask | null): void {
    this.currentTask = task;
  }

  // ============================================================================
  // 访问器
  // ============================================================================

  /**
   * 获取 SessionManager
   */
  getSessionManager(): ISessionFileManager | null {
    return this.sessionManager;
  }

  /**
   * 获取 CheckpointManager
   */
  getCheckpointManager(): CheckpointManager | null {
    return this.checkpointManager;
  }

  /**
   * 获取当前会话 ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  // ============================================================================
  // 生命周期方法
  // ============================================================================

  /**
   * 初始化会话
   */
  async initialize(_taskId: string, sessionId?: string): Promise<void> {
    this.currentSessionId = sessionId ?? generateTimestampId('session');

    // 使用注入的 SessionManager 或创建新的
    if (this.injectedSessionManager) {
      this.sessionManager = this.injectedSessionManager;
    } else {
      this.sessionManager = await createAndInitializeSessionFileManager(
        this.currentSessionId,
        {
          rootDir: this.config.rootDir,
          enableWatch: this.config.enableWatch ?? true,
          watchPollInterval: this.config.watchPollInterval ?? 500,
        }
      );
    }

    // 创建 CheckpointManager
    if (this.sessionManager && this.config.checkpoint) {
      this.checkpointManager = new CheckpointManager(
        this.currentSessionId,
        this.sessionManager,
        {
          ...this.config.checkpoint,
          rootDir: this.config.rootDir,
        }
      );
    }

    // 注册事件处理器
    if (this.boundApprovalHandler) {
      this.sessionManager.on<PendingApprovalFile>(
        'pending_approval_created',
        this.boundApprovalHandler
      );
    }

    // 设置思考和行动事件转发器
    this.boundThinkingForwarder = (event) => this.forwardThinkingEvent(event);
    this.boundActionForwarder = (event) => this.forwardActionEvent(event);

    this.sessionManager.on<ThinkingRecord>('thinking_updated', this.boundThinkingForwarder);
    this.sessionManager.on<ActionRecord>('action_completed', this.boundActionForwarder);

    // 启动文件监控
    if (!this.injectedSessionManager) {
      await this.sessionManager.startWatching();
    }

    // 启动偏离检测
    if (this.deviationDetectionStarter) {
      this.deviationDetectionStarter();
    }

    // 启动协作管理器
    if (this.collaborationManager && this.collaborationEnabled) {
      try {
        await this.collaborationManager.start(`orchestrator-lifecycle`, {
          sessionId: this.currentSessionId,
          type: 'orchestrator',
          capabilities: ['planning', 'coordination'],
          status: 'online',
          priority: 10,
        });

        if (this.collaborationRequestHandlerRegistrar) {
          this.collaborationRequestHandlerRegistrar();
        }

        console.debug('[SessionLifecycle] Collaboration started');
      } catch (error) {
        console.warn('[SessionLifecycle] Failed to start collaboration:', error);
      }
    }
  }

  /**
   * 关闭会话
   */
  async close(): Promise<void> {
    // 重置 Worker 状态
    for (const worker of this.workerPool.getAllWorkers()) {
      if (worker.status === 'busy') {
        if (worker.currentTaskId) {
          this.workerPool.completeTask(worker.currentTaskId);
        } else {
          this.workerPool.updateWorkerStatus(worker.id, 'idle');
        }
      }
    }

    // 停止偏离检测
    if (this.deviationDetectionStopper) {
      this.deviationDetectionStopper();
    }

    // 停止协作管理器
    if (this.collaborationManager) {
      await this.collaborationManager.stop();
    }

    // 取消事件监听
    if (this.sessionManager) {
      if (this.boundApprovalHandler) {
        this.sessionManager.off<PendingApprovalFile>(
          'pending_approval_created',
          this.boundApprovalHandler
        );
      }
      if (this.boundThinkingForwarder) {
        this.sessionManager.off<ThinkingRecord>('thinking_updated', this.boundThinkingForwarder);
      }
      if (this.boundActionForwarder) {
        this.sessionManager.off<ActionRecord>('action_completed', this.boundActionForwarder);
      }
    }

    // 关闭 SessionManager
    if (this.sessionManager && !this.injectedSessionManager) {
      this.sessionManager.stopWatching();
      await this.sessionManager.close();
    }

    // 关闭 CheckpointManager
    if (this.checkpointManager) {
      await this.checkpointManager.close().catch(() => undefined);
      this.checkpointManager = null;
    }

    this.sessionManager = null;
    this.currentSessionId = null;
  }

  // ============================================================================
  // 事件转发方法
  // ============================================================================

  /**
   * 转发思考事件
   */
  private forwardThinkingEvent(event: SessionFileEvent<ThinkingRecord>): void {
    const workerId = this.deriveWorkerIdFromEvent(event) ?? 'unknown';
    const taskId = this.currentTask?.id ?? '';
    this.eventService.emit(
      'worker:thinking',
      taskId,
      { workerId, record: event.data },
      event.data.subtaskId
    );
  }

  /**
   * 转发行动事件
   */
  private forwardActionEvent(event: SessionFileEvent<ActionRecord>): void {
    const workerId = this.deriveWorkerIdFromEvent(event) ?? 'unknown';
    const taskId = this.currentTask?.id ?? '';

    if (this.debugEnabled && event.data.description?.startsWith('Calling tool:')) {
      console.debug(`[SessionLifecycle] Forwarding worker:action: ${event.data.description}`);
    }

    this.eventService.emit(
      'worker:action',
      taskId,
      { workerId, record: event.data },
      event.data.subtaskId
    );
  }

  /**
   * 从事件中推导 Worker ID
   */
  private deriveWorkerIdFromEvent(event: {
    workerId?: string;
    filePath?: string;
  }): string | undefined {
    if (event.workerId) return event.workerId;
    if (!event.filePath) return undefined;
    const m = event.filePath.match(/[\\/]+workers[\\/]+([^\\/]+)[\\/]+/);
    return m?.[1];
  }
}

/**
 * 创建会话生命周期管理器
 */
export function createSessionLifecycleManager(options: {
  config: SessionLifecycleConfig;
  eventService: IEventService;
  workerPool: IWorkerPool;
}): SessionLifecycleManager {
  return new SessionLifecycleManager(options);
}
