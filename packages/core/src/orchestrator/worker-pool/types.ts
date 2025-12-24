/**
 * Worker 池类型定义
 *
 * @packageDocumentation
 */

import type { RetryPolicy } from '../../types';
import type { BaseAgent } from '../../abstracts/base-agent';
import type {
  SubTask,
  WorkerInfo,
  WorkerStatus,
  WorkerLoad,
  WorkerPoolConfig,
} from '../types';
import type { WorkerSnapshot } from '../session/types';

// ============================================================================
// 事件类型
// ============================================================================

/**
 * Worker 池事件类型
 */
export type WorkerPoolEventType =
  | 'worker:registered'
  | 'worker:unregistered'
  | 'worker:status-changed'
  | 'task:assigned'
  | 'task:timeout'
  | 'task:cancelled'
  | 'pool:full'
  | 'pool:empty';

/**
 * Worker 池事件
 */
export interface WorkerPoolEvent<T = unknown> {
  /** 事件类型 */
  type: WorkerPoolEventType;
  /** Worker ID（如果适用） */
  workerId?: string | undefined;
  /** 任务 ID（如果适用） */
  taskId?: string | undefined;
  /** 事件数据 */
  data: T;
  /** 时间戳 */
  timestamp: number;
}

/**
 * Worker 池事件处理器
 */
export type WorkerPoolEventHandler<T = unknown> = (
  event: WorkerPoolEvent<T>
) => void | Promise<void>;

// ============================================================================
// 分配结果
// ============================================================================

/**
 * 任务分配结果
 */
export interface AssignmentResult {
  /** 是否分配成功 */
  success: boolean;
  /** 分配给的 Worker ID */
  workerId?: string;
  /** 错误消息（如果失败） */
  error?: string;
  /** 取消函数（用于超时取消） */
  cancel?: () => void;
  /** Worker 实例（用于直接执行） */
  agent?: BaseAgent;
}

// ============================================================================
// Worker 池接口
// ============================================================================

/**
 * Worker 池接口
 */
export interface IWorkerPool {
  /** 获取池配置 */
  readonly config: WorkerPoolConfig;

  /** 获取当前 Worker 数量 */
  readonly workerCount: number;

  /** 获取空闲 Worker 数量 */
  readonly idleWorkerCount: number;

  /** 获取活跃任务数量 */
  readonly activeTaskCount: number;

  /**
   * 注册 Worker
   * @param worker - Worker 信息
   * @returns 是否注册成功
   */
  register(worker: WorkerInfo): boolean;

  /**
   * 注销 Worker
   * @param workerId - Worker ID
   * @returns 是否注销成功
   */
  unregister(workerId: string): boolean;

  /**
   * 获取 Worker 信息
   * @param workerId - Worker ID
   * @returns Worker 信息，如不存在返回 undefined
   */
  getWorker(workerId: string): WorkerInfo | undefined;

  /**
   * 获取所有 Worker
   * @returns Worker 信息列表
   */
  getAllWorkers(): WorkerInfo[];

  /**
   * 更新 Worker 状态
   * @param workerId - Worker ID
   * @param status - 新状态
   * @param load - 可选的负载信息
   * @returns 是否更新成功
   */
  updateWorkerStatus(
    workerId: string,
    status: WorkerStatus,
    load?: WorkerLoad
  ): boolean;

  /**
   * 选择最佳 Worker
   * @param capabilities - 可选的能力要求
   * @returns 选中的 Worker ID，如无可用返回 undefined
   */
  selectWorker(capabilities?: string[]): string | undefined;

  /**
   * 按能力筛选可用 Worker（用于协作路由）
   */
  getWorkersByCapability(capabilities?: string[]): WorkerInfo[];

  /**
   * 查找具有指定能力的空闲 Worker（用于懒加载分配）
   */
  findIdleByCapability(capability: string): WorkerInfo | null;

  /**
   * 获取指定角色的所有 Worker
   */
  getWorkersByRole(roleId: string): WorkerInfo[];

  /**
   * 分配任务给 Worker
   */
  assign(
    subtask: SubTask,
    timeout: number,
    retryPolicy: RetryPolicy,
    context?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AssignmentResult>;

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean;

  /**
   * 标记任务完成
   */
  completeTask(taskId: string): boolean;

  /**
   * 添加事件监听器
   */
  on<T = unknown>(type: WorkerPoolEventType, handler: WorkerPoolEventHandler<T>): void;

  /**
   * 移除事件监听器
   */
  off<T = unknown>(type: WorkerPoolEventType, handler: WorkerPoolEventHandler<T>): void;

  /**
   * 从快照重建 Worker 注册状态
   */
  rebuildFromSnapshots?(snapshots: WorkerSnapshot[]): number;

  /**
   * 关闭 Worker 池
   */
  shutdown(): Promise<void>;
}

// ============================================================================
// 内部类型
// ============================================================================

/**
 * 活跃任务信息（内部使用）
 */
export interface ActiveTask {
  /** 子任务 */
  subtask: SubTask;
  /** 分配的 Worker ID */
  workerId: string;
  /** 超时定时器 */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** 是否已取消 */
  cancelled: boolean;
  /** 分配时间 */
  assignedAt: number;
}

/**
 * Mock 任务执行器
 */
export type MockTaskExecutor = (
  subtask: SubTask,
  workerId: string
) => Promise<void>;

/**
 * Mock Worker 池配置
 */
export interface MockWorkerPoolOptions {
  /** 基础配置 */
  config: WorkerPoolConfig;
  /** 初始 Worker 数量 */
  initialWorkers?: number;
  /** 模拟任务执行延迟（毫秒） */
  taskDelay?: number;
  /** 自定义任务执行器 */
  executor?: MockTaskExecutor;
}

