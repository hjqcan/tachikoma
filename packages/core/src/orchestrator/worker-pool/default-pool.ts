/**
 * 默认 Worker 池实现
 *
 * @packageDocumentation
 */

import type { SubTask, WorkerInfo, WorkerStatus, WorkerLoad, WorkerPoolConfig, AssignPayload } from '../types';
import type { RetryPolicy } from '../../types';
import type { WorkerSnapshot } from '../session/types';
import type {
  IWorkerPool,
  WorkerPoolEventType,
  WorkerPoolEventHandler,
  WorkerPoolEvent,
  AssignmentResult,
  ActiveTask,
} from './types';

/**
 * 默认 Worker 池实现
 */
export class DefaultWorkerPool implements IWorkerPool {
  /** 配置 */
  private readonly _config: WorkerPoolConfig;

  /** Worker 映射 */
  protected readonly workers = new Map<string, WorkerInfo>();

  /** 活跃任务映射 */
  protected readonly activeTasks = new Map<string, ActiveTask>();

  /** 事件监听器 */
  private readonly listeners = new Map<WorkerPoolEventType, Set<WorkerPoolEventHandler>>();

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

  updateWorkerStatus(workerId: string, status: WorkerStatus, load?: WorkerLoad): boolean {
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
      this.emit('worker:status-changed', { oldStatus, newStatus: status, load }, workerId);
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

  getWorkersByCapability(capabilities?: string[]): WorkerInfo[] {
    const available = this.getAvailableWorkers(capabilities);
    return [...available].map((w) => ({ ...w })).sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5));
  }

  findIdleByCapability(capability: string): WorkerInfo | null {
    for (const worker of this.workers.values()) {
      if (worker.status === 'idle' && worker.capabilities?.includes(capability)) {
        return { ...worker };
      }
    }
    return null;
  }

  getWorkersByRole(roleId: string): WorkerInfo[] {
    const cap = `role:${roleId}`;
    return Array.from(this.workers.values())
      .filter((w) => w.capabilities?.includes(cap))
      .map((w) => ({ ...w }));
  }

  private getAvailableWorkers(capabilities?: string[]): WorkerInfo[] {
    const available: WorkerInfo[] = [];

    for (const worker of this.workers.values()) {
      if (worker.status !== 'idle') {
        continue;
      }

      if (capabilities && capabilities.length > 0) {
        const workerCaps = worker.capabilities || [];
        const hasAllCapabilities = capabilities.every((cap) => workerCaps.includes(cap));
        if (!hasAllCapabilities) {
          continue;
        }
      }

      available.push(worker);
    }

    return available;
  }

  private selectRoundRobin(workers: WorkerInfo[]): string {
    const index = this.roundRobinIndex % workers.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % workers.length;
    return workers[index]!.id;
  }

  private selectLeastLoaded(workers: WorkerInfo[]): string {
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

  private calculateLoadScore(worker: WorkerInfo): number {
    const load = worker.load;
    if (!load) {
      return 0;
    }

    const cpuScore = load.cpu ?? 0;
    const memoryScore = load.memory ?? 0;
    const queueScore = (load.queuedTasks ?? 0) * 10;

    return cpuScore * 0.4 + memoryScore * 0.3 + queueScore * 0.3;
  }

  private selectRandom(workers: WorkerInfo[]): string {
    const index = Math.floor(Math.random() * workers.length);
    return workers[index]!.id;
  }

  private selectCapabilityMatch(workers: WorkerInfo[], capabilities?: string[]): string {
    if (!capabilities || capabilities.length === 0) {
      return this.selectLeastLoaded(workers);
    }

    let bestMatch = workers[0]!;
    let maxScore = this.calculateCapabilityScore(bestMatch, capabilities);

    for (let i = 1; i < workers.length; i++) {
      const worker = workers[i]!;
      const score = this.calculateCapabilityScore(worker, capabilities);
      if (score > maxScore) {
        maxScore = score;
        bestMatch = worker;
      } else if (score === maxScore) {
        if (this.calculateLoadScore(worker) < this.calculateLoadScore(bestMatch)) {
          bestMatch = worker;
        }
      }
    }

    return bestMatch.id;
  }

  private calculateCapabilityScore(worker: WorkerInfo, capabilities: string[]): number {
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
    context?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AssignmentResult> {
    if (this.isShutdown) {
      return { success: false, error: 'Worker pool is shutdown' };
    }

    if (signal?.aborted) {
      return { success: false, error: 'Assignment aborted' };
    }

    const preferredWorkerId =
      context && typeof context.preferredWorkerId === 'string' ? (context.preferredWorkerId as string) : undefined;
    const requiredCapabilities =
      context && Array.isArray(context.requiredCapabilities)
        ? (context.requiredCapabilities as unknown[]).filter((c): c is string => typeof c === 'string' && c.length > 0)
        : undefined;

    const workerId = await this.selectWorkerWithQueue(requiredCapabilities, preferredWorkerId, signal);

    if (!workerId) {
      return { success: false, error: signal?.aborted ? 'Assignment aborted' : 'No available workers' };
    }

    if (signal?.aborted) {
      this.updateWorkerStatus(workerId, 'idle');
      return { success: false, error: 'Assignment aborted' };
    }

    this.updateWorkerStatus(workerId, 'busy');

    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentTaskId = subtask.id;
    }

    const activeTask: ActiveTask = {
      subtask,
      workerId,
      cancelled: false,
      assignedAt: Date.now(),
    };

    if (timeout > 0) {
      activeTask.timeoutTimer = setTimeout(() => {
        this.handleTaskTimeout(subtask.id);
      }, timeout);
    }

    this.activeTasks.set(subtask.id, activeTask);

    const assignPayload: AssignPayload = {
      subtask,
      timeout,
      retryPolicy,
      ...(context !== undefined && { context }),
    };

    this.emit('task:assigned', { subtask, assignPayload }, workerId, subtask.id);

    const workerInfo = this.workers.get(workerId);
    return {
      success: true,
      workerId,
      cancel: () => this.cancelTask(subtask.id),
      ...(workerInfo?.agent ? { agent: workerInfo.agent } : {}),
    };
  }

  private async selectWorkerWithQueue(
    requiredCapabilities?: string[],
    preferredWorkerId?: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const waitQueueTimeout = this._config.waitQueueTimeout ?? 0;
    const waitQueuePollInterval = this._config.waitQueuePollInterval ?? 500;
    const fallbackToGeneral = this._config.fallbackToGeneral !== false;

    const startTime = Date.now();

    while (true) {
      if (signal?.aborted) {
        return undefined;
      }

      const tryReserve = (wId: string | undefined): string | undefined => {
        if (!wId) return undefined;
        const w = this.workers.get(wId);
        if (!w || w.status !== 'idle') {
          return undefined;
        }
        this.updateWorkerStatus(wId, 'busy');
        return wId;
      };

      if (preferredWorkerId) {
        const w = this.workers.get(preferredWorkerId);
        if (w && w.status === 'idle') {
          if (!requiredCapabilities || requiredCapabilities.every((cap) => (w.capabilities ?? []).includes(cap))) {
            const reserved = tryReserve(preferredWorkerId);
            if (reserved) return reserved;
          }
        }
      }

      let workerId = this.selectWorker(requiredCapabilities);
      if (workerId) {
        const reserved = tryReserve(workerId);
        if (reserved) return reserved;
      }

      if (fallbackToGeneral && requiredCapabilities && requiredCapabilities.length > 0) {
        workerId = this.selectWorker();
        if (workerId) {
          const reserved = tryReserve(workerId);
          if (reserved) {
            console.debug(
              `[WorkerPool] Fallback: no worker with capabilities [${requiredCapabilities.join(', ')}], using ${reserved}`
            );
            return reserved;
          }
        }
      }

      if (waitQueueTimeout <= 0) {
        return undefined;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= waitQueueTimeout) {
        console.debug(
          `[WorkerPool] Wait queue timeout after ${elapsed}ms for capabilities [${requiredCapabilities?.join(', ') ?? 'any'}]`
        );
        return undefined;
      }

      await this.sleepWithSignal(waitQueuePollInterval, signal);

      if (this.isShutdown) {
        return undefined;
      }
    }
  }

  private sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private handleTaskTimeout(taskId: string): void {
    const task = this.activeTasks.get(taskId);
    if (!task || task.cancelled) {
      return;
    }

    this.emit('task:timeout', { subtask: task.subtask, duration: Date.now() - task.assignedAt }, task.workerId, taskId);

    this.cancelTask(taskId);
  }

  cancelTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      return false;
    }

    task.cancelled = true;

    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
    }

    const worker = this.workers.get(task.workerId);
    const agent = worker?.agent;
    if (agent) {
      const interrupt = agent.interrupt?.bind(agent);
      if (interrupt) {
        void interrupt().catch(() => undefined);
      } else {
        void agent.stop().catch(() => undefined);
      }
    }

    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
    }

    this.activeTasks.delete(taskId);

    this.emit('task:cancelled', { subtask: task.subtask }, task.workerId, taskId);

    return true;
  }

  completeTask(taskId: string): boolean {
    const task = this.activeTasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
    }

    const worker = this.workers.get(task.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
    }

    this.activeTasks.delete(taskId);

    return true;
  }

  // ============================================================================
  // 事件系统
  // ============================================================================

  on<T = unknown>(type: WorkerPoolEventType, handler: WorkerPoolEventHandler<T>): void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler as WorkerPoolEventHandler);
  }

  off<T = unknown>(type: WorkerPoolEventType, handler: WorkerPoolEventHandler<T>): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler as WorkerPoolEventHandler);
    }
  }

  private emit<T>(type: WorkerPoolEventType, data: T, workerId?: string, taskId?: string): void {
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

  rebuildFromSnapshots(snapshots: WorkerSnapshot[]): number {
    let updatedCount = 0;

    for (const snapshot of snapshots) {
      const existingWorker = this.workers.get(snapshot.workerId);
      if (!existingWorker) continue;

      existingWorker.status = 'idle';
      existingWorker.lastHeartbeat = snapshot.lastHeartbeat;
      existingWorker.currentTaskId = undefined;
      updatedCount++;
    }

    console.debug(`[WorkerPool] Updated ${updatedCount} workers from snapshots`);
    return updatedCount;
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;

    for (const taskId of this.activeTasks.keys()) {
      this.cancelTask(taskId);
    }

    for (const workerId of Array.from(this.workers.keys())) {
      const worker = this.workers.get(workerId);
      if (worker?.agent) {
        await worker.agent.stop().catch(() => undefined);
      }
      this.unregister(workerId);
    }

    this.listeners.clear();
  }
}

/**
 * 创建 Worker 池
 */
export function createWorkerPool(config: WorkerPoolConfig): IWorkerPool {
  return new DefaultWorkerPool(config);
}

