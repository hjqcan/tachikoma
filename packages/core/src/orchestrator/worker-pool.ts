/**
 * Worker 池管理模块
 *
 * 提供 Worker 池抽象、调度机制、并发控制与超时取消功能
 *
 * @packageDocumentation
 */

import type { RetryPolicy } from '../types';
import type {
  SubTask,
  WorkerInfo,
  WorkerStatus,
  WorkerLoad,
  WorkerPoolConfig,
  AssignPayload,
} from './types';

// ============================================================================
// Worker 池接口定义
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
}

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
   * 分配任务给 Worker
   * @param subtask - 子任务
   * @param timeout - 超时时间（毫秒）
   * @param retryPolicy - 重试策略
   * @param context - 执行上下文
   * @returns 分配结果
   */
  assign(
    subtask: SubTask,
    timeout: number,
    retryPolicy: RetryPolicy,
    context?: Record<string, unknown>
  ): Promise<AssignmentResult>;

  /**
   * 取消任务
   * @param taskId - 任务 ID
   * @returns 是否取消成功
   */
  cancelTask(taskId: string): boolean;

  /**
   * 添加事件监听器
   * @param type - 事件类型
   * @param handler - 事件处理器
   */
  on<T = unknown>(type: WorkerPoolEventType, handler: WorkerPoolEventHandler<T>): void;

  /**
   * 移除事件监听器
   * @param type - 事件类型
   * @param handler - 事件处理器
   */
  off<T = unknown>(type: WorkerPoolEventType, handler: WorkerPoolEventHandler<T>): void;

  /**
   * 关闭 Worker 池
   */
  shutdown(): Promise<void>;
}

// ============================================================================
// 默认 Worker 池实现
// ============================================================================

/**
 * 活跃任务信息
 */
interface ActiveTask {
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
 * 默认 Worker 池实现
 */
export class DefaultWorkerPool implements IWorkerPool {
  /** 配置 */
  private readonly _config: WorkerPoolConfig;

  /** Worker 映射 */
  private readonly workers = new Map<string, WorkerInfo>();

  /** 活跃任务映射 */
  private readonly activeTasks = new Map<string, ActiveTask>();

  /** 事件监听器 */
  private readonly listeners = new Map<
    WorkerPoolEventType,
    Set<WorkerPoolEventHandler>
  >();

  /** 轮询索引（用于 round-robin 策略） */
  private roundRobinIndex = 0;

  /** 是否已关闭 */
  private isShutdown = false;

  constructor(config: WorkerPoolConfig) {
    this._config = { ...config };
  }

  // ============================================================================
  // 属性访问器
  // ============================================================================

  get config(): WorkerPoolConfig {
    return { ...this._config };
  }

  get workerCount(): number {
    return this.workers.size;
  }

  get idleWorkerCount(): number {
    let count = 0;
    for (const worker of this.workers.values()) {
      if (worker.status === 'idle') {
        count++;
      }
    }
    return count;
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  // ============================================================================
  // Worker 管理
  // ============================================================================

  register(worker: WorkerInfo): boolean {
    if (this.isShutdown) {
      return false;
    }

    // 检查是否超过最大 Worker 数
    if (this.workers.size >= this._config.maxWorkers) {
      this.emit('pool:full', { maxWorkers: this._config.maxWorkers });
      return false;
    }

    // 检查是否已存在
    if (this.workers.has(worker.id)) {
      return false;
    }

    // 注册 Worker
    this.workers.set(worker.id, {
      ...worker,
      lastHeartbeat: Date.now(),
    });

    this.emit('worker:registered', { worker }, worker.id);
    return true;
  }

  unregister(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    // 取消该 Worker 上的所有任务
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (task.workerId === workerId) {
        this.cancelTask(taskId);
      }
    }

    // 移除 Worker
    this.workers.delete(workerId);

    this.emit('worker:unregistered', { worker }, workerId);

    // 检查池是否为空
    if (this.workers.size === 0) {
      this.emit('pool:empty', {});
    }

    return true;
  }

  getWorker(workerId: string): WorkerInfo | undefined {
    const worker = this.workers.get(workerId);
    return worker ? { ...worker } : undefined;
  }

  getAllWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values()).map((w) => ({ ...w }));
  }

  updateWorkerStatus(
    workerId: string,
    status: WorkerStatus,
    load?: WorkerLoad
  ): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    const oldStatus = worker.status;
    worker.status = status;
    worker.lastHeartbeat = Date.now();

    if (load) {
      worker.load = { ...load };
    }

    if (oldStatus !== status) {
      this.emit(
        'worker:status-changed',
        { oldStatus, newStatus: status, load },
        workerId
      );
    }

    return true;
  }

  // ============================================================================
  // Worker 选择策略
  // ============================================================================

  selectWorker(capabilities?: string[]): string | undefined {
    const availableWorkers = this.getAvailableWorkers(capabilities);

    if (availableWorkers.length === 0) {
      return undefined;
    }

    switch (this._config.selectionStrategy) {
      case 'round-robin':
        return this.selectRoundRobin(availableWorkers);
      case 'least-loaded':
        return this.selectLeastLoaded(availableWorkers);
      case 'random':
        return this.selectRandom(availableWorkers);
      case 'capability-match':
        return this.selectCapabilityMatch(availableWorkers, capabilities);
      default:
        return this.selectLeastLoaded(availableWorkers);
    }
  }

  /**
   * 获取可用 Worker 列表
   */
  private getAvailableWorkers(capabilities?: string[]): WorkerInfo[] {
    const available: WorkerInfo[] = [];

    for (const worker of this.workers.values()) {
      // 只选择空闲的 Worker
      if (worker.status !== 'idle') {
        continue;
      }

      // 检查能力匹配
      if (capabilities && capabilities.length > 0) {
        const workerCaps = worker.capabilities || [];
        const hasAllCapabilities = capabilities.every((cap) =>
          workerCaps.includes(cap)
        );
        if (!hasAllCapabilities) {
          continue;
        }
      }

      available.push(worker);
    }

    return available;
  }

  /**
   * 轮询选择策略
   */
  private selectRoundRobin(workers: WorkerInfo[]): string {
    const index = this.roundRobinIndex % workers.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % workers.length;
    const worker = workers[index];
    // 由于调用前已验证 workers 非空，这里应该总是有值
    return worker!.id;
  }

  /**
   * 最少负载选择策略
   */
  private selectLeastLoaded(workers: WorkerInfo[]): string {
    // 调用前已验证 workers 非空
    let selected = workers[0]!;
    let minLoad = this.calculateLoadScore(selected);

    for (let i = 1; i < workers.length; i++) {
      const worker = workers[i]!;
      const score = this.calculateLoadScore(worker);
      if (score < minLoad) {
        minLoad = score;
        selected = worker;
      }
    }

    return selected.id;
  }

  /**
   * 计算负载分数（0-100）
   */
  private calculateLoadScore(worker: WorkerInfo): number {
    const load = worker.load;
    if (!load) {
      return 0; // 无负载信息视为最低负载
    }

    // 综合 CPU、内存和队列计算负载分数
    const cpuScore = load.cpu ?? 0;
    const memoryScore = load.memory ?? 0;
    const queueScore = (load.queuedTasks ?? 0) * 10; // 每个队列任务增加 10 分

    // 加权平均
    return cpuScore * 0.4 + memoryScore * 0.3 + queueScore * 0.3;
  }

  /**
   * 随机选择策略
   */
  private selectRandom(workers: WorkerInfo[]): string {
    const index = Math.floor(Math.random() * workers.length);
    const worker = workers[index];
    // 由于调用前已验证 workers 非空，这里应该总是有值
    return worker!.id;
  }

  /**
   * 能力匹配选择策略（优先选择能力最匹配的）
   */
  private selectCapabilityMatch(
    workers: WorkerInfo[],
    capabilities?: string[]
  ): string {
    if (!capabilities || capabilities.length === 0) {
      return this.selectLeastLoaded(workers);
    }

    // 调用前已验证 workers 非空
    let bestMatch = workers[0]!;
    let maxScore = this.calculateCapabilityScore(bestMatch, capabilities);

    for (let i = 1; i < workers.length; i++) {
      const worker = workers[i]!;
      const score = this.calculateCapabilityScore(worker, capabilities);
      if (score > maxScore) {
        maxScore = score;
        bestMatch = worker;
      } else if (score === maxScore) {
        // 同等匹配度下选择负载较低的
        if (
          this.calculateLoadScore(worker) <
          this.calculateLoadScore(bestMatch)
        ) {
          bestMatch = worker;
        }
      }
    }

    return bestMatch.id;
  }

  /**
   * 计算能力匹配分数
   */
  private calculateCapabilityScore(
    worker: WorkerInfo,
    capabilities: string[]
  ): number {
    const workerCaps = worker.capabilities || [];
    let matched = 0;

    for (const cap of capabilities) {
      if (workerCaps.includes(cap)) {
        matched++;
      }
    }

    return matched / capabilities.length;
  }

  // ============================================================================
  // 任务分配与超时控制
  // ============================================================================

  async assign(
    subtask: SubTask,
    timeout: number,
    retryPolicy: RetryPolicy,
    context?: Record<string, unknown>
  ): Promise<AssignmentResult> {
    if (this.isShutdown) {
      return {
        success: false,
        error: 'Worker pool is shutdown',
      };
    }

    // 选择 Worker
    const workerId = this.selectWorker();
    if (!workerId) {
      return {
        success: false,
        error: 'No available workers',
      };
    }

    // 更新 Worker 状态为忙碌
    this.updateWorkerStatus(workerId, 'busy');

    // 更新 Worker 当前任务
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentTaskId = subtask.id;
    }

    // 创建活跃任务记录
    const activeTask: ActiveTask = {
      subtask,
      workerId,
      cancelled: false,
      assignedAt: Date.now(),
    };

    // 设置超时定时器
    if (timeout > 0) {
      activeTask.timeoutTimer = setTimeout(() => {
        this.handleTaskTimeout(subtask.id);
      }, timeout);
    }

    this.activeTasks.set(subtask.id, activeTask);

    // 创建分配消息
    const assignPayload: AssignPayload = {
      subtask,
      timeout,
      retryPolicy,
      ...(context !== undefined && { context }),
    };

    // 发出任务分配事件
    this.emit(
      'task:assigned',
      { subtask, assignPayload },
      workerId,
      subtask.id
    );

    // 返回取消函数
    return {
      success: true,
      workerId,
      cancel: () => this.cancelTask(subtask.id),
    };
  }

  /**
   * 处理任务超时
   */
  private handleTaskTimeout(taskId: string): void {
    const task = this.activeTasks.get(taskId);
    if (!task || task.cancelled) {
      return;
    }

    // 发出超时事件
    this.emit(
      'task:timeout',
      { subtask: task.subtask, duration: Date.now() - task.assignedAt },
      task.workerId,
      taskId
    );

    // 执行取消
    this.cancelTask(taskId);
  }

  cancelTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      return false;
    }

    // 标记为已取消
    task.cancelled = true;

    // 清除超时定时器
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
    }

    // 恢复 Worker 状态
    const worker = this.workers.get(task.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
    }

    // 移除活跃任务
    this.activeTasks.delete(taskId);

    // 发出取消事件
    this.emit('task:cancelled', { subtask: task.subtask }, task.workerId, taskId);

    return true;
  }

  /**
   * 完成任务（由外部调用）
   */
  completeTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      return false;
    }

    // 清除超时定时器
    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
    }

    // 恢复 Worker 状态
    const worker = this.workers.get(task.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
    }

    // 移除活跃任务
    this.activeTasks.delete(taskId);

    return true;
  }

  // ============================================================================
  // 事件系统
  // ============================================================================

  on<T = unknown>(
    type: WorkerPoolEventType,
    handler: WorkerPoolEventHandler<T>
  ): void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler as WorkerPoolEventHandler);
  }

  off<T = unknown>(
    type: WorkerPoolEventType,
    handler: WorkerPoolEventHandler<T>
  ): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler as WorkerPoolEventHandler);
    }
  }

  /**
   * 发出事件
   */
  private emit<T>(
    type: WorkerPoolEventType,
    data: T,
    workerId?: string,
    taskId?: string
  ): void {
    const event: WorkerPoolEvent<T> = {
      type,
      workerId,
      taskId,
      data,
      timestamp: Date.now(),
    };

    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in worker pool event handler [${type}]:`, error);
        }
      }
    }
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  async shutdown(): Promise<void> {
    this.isShutdown = true;

    // 取消所有活跃任务
    for (const taskId of this.activeTasks.keys()) {
      this.cancelTask(taskId);
    }

    // 注销所有 Worker
    for (const workerId of Array.from(this.workers.keys())) {
      this.unregister(workerId);
    }

    // 清除所有事件监听器
    this.listeners.clear();
  }
}

// ============================================================================
// Mock Worker 池实现（用于测试）
// ============================================================================

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

/**
 * Mock Worker 池实现
 *
 * 用于测试，模拟 Worker 行为
 */
export class MockWorkerPool extends DefaultWorkerPool {
  private readonly taskDelay: number;
  private readonly executor?: MockTaskExecutor | undefined;
  private readonly assignedTasks = new Map<string, SubTask>();

  constructor(options: MockWorkerPoolOptions) {
    super(options.config);
    this.taskDelay = options.taskDelay ?? 100;
    this.executor = options.executor;

    // 注册初始 Workers
    const initialCount = options.initialWorkers ?? options.config.minWorkers;
    for (let i = 0; i < initialCount; i++) {
      this.register({
        id: `mock-worker-${i}`,
        status: 'idle',
        capabilities: ['general'],
      });
    }
  }

  /**
   * 重写 assign 方法，添加模拟执行
   */
  override async assign(
    subtask: SubTask,
    timeout: number,
    retryPolicy: RetryPolicy,
    context?: Record<string, unknown>
  ): Promise<AssignmentResult> {
    const result = await super.assign(subtask, timeout, retryPolicy, context);

    if (result.success && result.workerId) {
      this.assignedTasks.set(subtask.id, subtask);

      // 模拟异步执行
      this.simulateExecution(subtask, result.workerId);
    }

    return result;
  }

  /**
   * 模拟任务执行
   */
  private async simulateExecution(
    subtask: SubTask,
    workerId: string
  ): Promise<void> {
    // 等待模拟延迟
    await new Promise((resolve) => setTimeout(resolve, this.taskDelay));

    // 检查任务是否已取消
    const task = this.getActiveTask(subtask.id);
    if (!task || task.cancelled) {
      return;
    }

    // 执行自定义执行器（如果有）
    if (this.executor) {
      try {
        await this.executor(subtask, workerId);
      } catch {
        // 执行器抛出错误，不完成任务
        return;
      }
    }

    // 完成任务
    this.completeTask(subtask.id);
  }

  /**
   * 获取活跃任务（暴露给测试）
   */
  private getActiveTask(taskId: string): ActiveTask | undefined {
    return (this as unknown as { activeTasks: Map<string, ActiveTask> }).activeTasks.get(taskId);
  }

  /**
   * 获取已分配的任务列表（用于测试验证）
   */
  getAssignedTasks(): SubTask[] {
    return Array.from(this.assignedTasks.values());
  }

  /**
   * 获取指定任务（用于测试验证）
   */
  getAssignedTask(taskId: string): SubTask | undefined {
    return this.assignedTasks.get(taskId);
  }

  /**
   * 清除已分配任务记录
   */
  clearAssignedTasks(): void {
    this.assignedTasks.clear();
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Worker 池
 *
 * @param config - Worker 池配置
 * @returns Worker 池实例
 *
 * @example
 * ```ts
 * import { createWorkerPool, DEFAULT_WORKER_POOL_CONFIG } from '@tachikoma/core';
 *
 * const pool = createWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
 *
 * // 注册 Worker
 * pool.register({ id: 'worker-1', status: 'idle' });
 *
 * // 分配任务
 * const result = await pool.assign(subtask, 30000, retryPolicy);
 * ```
 */
export function createWorkerPool(config: WorkerPoolConfig): IWorkerPool {
  return new DefaultWorkerPool(config);
}

/**
 * 创建 Mock Worker 池（用于测试）
 *
 * @param options - Mock 配置
 * @returns Mock Worker 池实例
 *
 * @example
 * ```ts
 * const mockPool = createMockWorkerPool({
 *   config: DEFAULT_WORKER_POOL_CONFIG,
 *   initialWorkers: 3,
 *   taskDelay: 50,
 * });
 * ```
 */
export function createMockWorkerPool(
  options: MockWorkerPoolOptions
): MockWorkerPool {
  return new MockWorkerPool(options);
}
