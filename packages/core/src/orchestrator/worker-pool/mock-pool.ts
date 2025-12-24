/**
 * Mock Worker 池实现
 *
 * 用于测试，模拟 Worker 行为
 *
 * @packageDocumentation
 */

import type { RetryPolicy } from '../../types';
import type { SubTask } from '../types';
import { DefaultWorkerPool } from './default-pool';
import type { AssignmentResult, ActiveTask, MockTaskExecutor, MockWorkerPoolOptions } from './types';

/**
 * Mock Worker 池实现
 *
 * 用于测试，模拟 Worker 行为
 */
export class MockWorkerPool extends DefaultWorkerPool {
  private readonly taskDelay: number;
  private readonly executor?: MockTaskExecutor | undefined;
  private readonly assignedTasks = new Map<string, SubTask>();
  private readonly runLog: Array<{ workerId: string; taskId: string }> = [];

  constructor(options: MockWorkerPoolOptions) {
    super(options.config);
    this.taskDelay = options.taskDelay ?? 100;
    this.executor = options.executor;

    // 注册初始 Workers
    const initialCount = options.initialWorkers ?? options.config.minWorkers;
    for (let i = 0; i < initialCount; i++) {
      const workerId = `mock-worker-${i}`;
      this.register({
        id: workerId,
        status: 'idle',
        capabilities: ['general'],
        // 提供一个最小可用的 Agent，便于 Orchestrator 走通 "WorkerAgent 驱动" 路径的单测/演示
        agent: {
          id: workerId,
          type: 'worker',
          config: { provider: 'mock', model: 'mock', maxTokens: 0 },
          run: async (task: { id?: unknown; objective?: unknown }) => {
            this.runLog.push({ workerId, taskId: String(task?.id ?? '') });
            return {
              taskId: String(task?.id ?? ''),
              status: 'success' as const,
              output: { objective: task?.objective },
              artifacts: [],
              metrics: {
                startTime: Date.now(),
                endTime: Date.now(),
                duration: 0,
                tokensUsed: 0,
                toolCallCount: 0,
                retryCount: 0,
              },
              trace: {
                traceId: `trace-${Date.now()}`,
                spanId: `span-${Date.now()}`,
                operation: 'mock-worker.run',
                attributes: {},
                events: [],
                duration: 0,
              },
            };
          },
          stop: async () => undefined,
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
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
   * 获取 run 调用记录（用于验证是否真实触发执行）
   */
  getRunLog(): Array<{ workerId: string; taskId: string }> {
    return [...this.runLog];
  }

  /**
   * 清除已分配任务记录
   */
  clearAssignedTasks(): void {
    this.assignedTasks.clear();
  }
}

/**
 * 创建 Mock Worker 池（用于测试）
 */
export function createMockWorkerPool(options: MockWorkerPoolOptions): MockWorkerPool {
  return new MockWorkerPool(options);
}

