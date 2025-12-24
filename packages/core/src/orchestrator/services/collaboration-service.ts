/**
 * 协作服务
 *
 * 负责管理多 Agent 之间的协作，包括：
 * - Worker 协作配置构建
 * - 协作请求路由
 *
 * 从 Orchestrator 类中提取
 */

import type { IEventService } from '../interfaces';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 协作配置
 */
export interface CollaborationConfig {
  enabled: boolean;
  backend: 'file' | 'redis';
  rootDir: string;
  redis?: {
    url: string;
    prefix?: string;
  };
}

/**
 * Worker 协作配置
 */
export interface WorkerCollaborationConfig {
  enabled: boolean;
  agentId: string;
  sessionId: string;
  capabilities: string[];
  priority: number;
  backend: 'file' | 'redis';
  rootDir: string;
  redis?: {
    url: string;
    prefix?: string;
  };
}

/**
 * Worker 信息（用于路由）
 */
export interface CollaborationWorkerInfo {
  id: string;
  capabilities?: string[];
  status: 'idle' | 'busy' | 'error';
}

/**
 * Worker 池接口（用于协作）
 */
export interface IWorkerPoolForCollaboration {
  getWorkersByCapability(capabilities?: string[]): CollaborationWorkerInfo[];
}

/**
 * 协作请求
 */
export interface CollaborationRequest {
  id: string;
  fromAgentId: string;
  type: string;
  payload?: {
    kind?: string;
    requiredCapabilities?: string[];
    taskDescription?: string;
    taskPayload?: unknown;
    preferredWorkerId?: string;
    strictPreferredWorker?: boolean;
    // legacy
    description?: string;
    data?: unknown;
    targetAgentId?: string;
  };
}

/**
 * 协作响应
 */
export interface CollaborationResponse {
  success: boolean;
  error?: string;
  payload?: {
    routed?: boolean;
    targetWorkerId?: string;
    targetCapabilities?: string[];
    availableWorkerCount?: number;
    [key: string]: unknown;
  };
}

/**
 * 协作响应（不含自动填充字段）
 */
export type CollaborationResponsePayload = Omit<CollaborationResponse, 'requestId' | 'fromAgentId' | 'respondedAt'>;

/**
 * 协作管理器接口
 * 
 * 使用泛型以兼容 `collaboration/CollaborationManager` 的实际签名（payload: unknown）
 */
export interface ICollaborationManager {
  onRequest(
    handler: (request: { id: string; fromAgentId: string; type: string; payload?: unknown }) => Promise<CollaborationResponsePayload>
  ): void;
}

// ============================================================================
// CollaborationService 实现
// ============================================================================

/**
 * 协作服务
 *
 * 负责协调多个 Agent 之间的协作请求
 *
 * @example
 * ```ts
 * const service = new CollaborationService({
 *   config: { enabled: true, backend: 'file', rootDir: '/path/to/sessions' },
 *   workerPool,
 *   eventService,
 * });
 *
 * service.registerRequestHandler(collaborationManager);
 * ```
 */
export class CollaborationService {
  private readonly config: CollaborationConfig;
  private readonly workerPool: IWorkerPoolForCollaboration;
  private readonly eventService: IEventService;
  private currentTaskId: string | undefined;

  constructor(options: {
    config: CollaborationConfig;
    workerPool: IWorkerPoolForCollaboration;
    eventService: IEventService;
  }) {
    this.config = options.config;
    this.workerPool = options.workerPool;
    this.eventService = options.eventService;
  }

  /**
   * 设置当前任务 ID
   */
  setCurrentTaskId(taskId: string | undefined): void {
    this.currentTaskId = taskId;
  }

  /**
   * 为 Worker 构建协作配置
   */
  buildWorkerCollaborationConfig(
    workerId: string,
    sessionId: string,
    capabilities: string[]
  ): WorkerCollaborationConfig | undefined {
    if (!this.config.enabled) return undefined;

    return {
      enabled: true,
      agentId: workerId,
      sessionId,
      capabilities,
      priority: 5, // Worker 默认优先级
      backend: this.config.backend,
      rootDir: this.config.rootDir,
      ...(this.config.redis && { redis: this.config.redis }),
    };
  }

  /**
   * 注册协作请求处理器
   */
  registerRequestHandler(collaborationManager: ICollaborationManager): void {
    collaborationManager.onRequest(async (request) => {
      // 适配外部 CollaborationRequest（payload: unknown）到本地 CollaborationRequest
      // handleCollaborationRequest 内部会自行解析 payload，这里只需转发原始结构
      return this.handleCollaborationRequest(request as CollaborationRequest);
    });
  }

  /**
   * 处理协作请求
   */
  async handleCollaborationRequest(
    request: CollaborationRequest
  ): Promise<CollaborationResponsePayload> {
    const taskId = this.currentTaskId ?? 'unknown';

    // 发出请求接收事件
    this.eventService.emit('collaboration:request_received', taskId, {
      requestId: request.id,
      fromAgent: request.fromAgentId,
      type: request.type,
    });

    // 解析请求参数
    const payload = request.payload;
    const requiredCapabilities = Array.isArray(payload?.requiredCapabilities)
      ? payload!.requiredCapabilities.filter(
          (c): c is string => typeof c === 'string' && c.length > 0
        )
      : undefined;

    const taskDescription =
      typeof payload?.taskDescription === 'string' && payload.taskDescription.trim()
        ? payload.taskDescription.trim()
        : typeof payload?.description === 'string' && payload.description.trim()
        ? payload.description.trim()
        : undefined;

    const taskPayload =
      payload?.taskPayload !== undefined ? payload.taskPayload : payload?.data;

    const preferredWorkerId =
      typeof payload?.preferredWorkerId === 'string' && payload.preferredWorkerId.trim()
        ? payload.preferredWorkerId.trim()
        : typeof payload?.targetAgentId === 'string' && payload.targetAgentId.trim()
        ? payload.targetAgentId.trim()
        : undefined;

    const strictPreferredWorker = payload?.strictPreferredWorker === true;

    // 查找可用 Worker
    const availableWorkers = this.workerPool.getWorkersByCapability(requiredCapabilities);

    if (availableWorkers.length === 0) {
      console.debug(
        `[CollaborationService] No available workers for request: ${request.id}`
      );
      this.eventService.emit('collaboration:request_completed', taskId, {
        requestId: request.id,
        workerId: undefined,
        success: false,
      });
      return {
        success: false,
        error: 'No available workers matching the required capabilities',
        payload: {
          requestId: request.id,
          ...(requiredCapabilities && { requiredCapabilities }),
          ...(preferredWorkerId && { preferredWorkerId }),
        },
      };
    }

    // 选择 Worker
    const preferredMatch = preferredWorkerId
      ? availableWorkers.find((w) => w.id === preferredWorkerId) ?? null
      : null;

    if (!preferredMatch && preferredWorkerId && strictPreferredWorker) {
      this.eventService.emit('collaboration:request_completed', taskId, {
        requestId: request.id,
        workerId: undefined,
        success: false,
      });
      return {
        success: false,
        error: `Preferred worker ${preferredWorkerId} is not available`,
        payload: {
          requestId: request.id,
          ...(requiredCapabilities && { requiredCapabilities }),
          preferredWorkerId,
          strictPreferredWorker: true,
        },
      };
    }

    const selectedWorker = preferredMatch ?? availableWorkers[0];

    // 发出路由事件
    this.eventService.emit('collaboration:request_routed', taskId, {
      requestId: request.id,
      targetWorkerId: selectedWorker?.id,
      workerCount: availableWorkers.length,
    });

    console.debug(
      `[CollaborationService] Routed request ${request.id} to worker ${selectedWorker?.id}`
    );

    // 发出完成事件
    this.eventService.emit('collaboration:request_completed', taskId, {
      requestId: request.id,
      workerId: selectedWorker?.id,
      success: true,
    });

    return {
      success: true,
      payload: {
        routed: true,
        availableWorkerCount: availableWorkers.length,
        ...(selectedWorker?.id ? { targetWorkerId: selectedWorker.id } : {}),
        ...(selectedWorker?.capabilities ? { targetCapabilities: selectedWorker.capabilities } : {}),
        ...(requiredCapabilities ? { requiredCapabilities } : {}),
        ...(taskDescription ? { taskDescription } : {}),
        ...(taskPayload !== undefined ? { taskPayload } : {}),
        ...(preferredWorkerId ? { preferredWorkerId } : {}),
        ...(preferredWorkerId ? {
          preferredMatched: selectedWorker?.id === preferredWorkerId,
        } : {}),
      },
    };
  }
}

/**
 * 创建协作服务实例
 */
export function createCollaborationService(options: {
  config: CollaborationConfig;
  workerPool: IWorkerPoolForCollaboration;
  eventService: IEventService;
}): CollaborationService {
  return new CollaborationService(options);
}
