/**
 * 事件服务实现
 *
 * 负责 Orchestrator 事件的发布/订阅
 * 从 Orchestrator 类中提取，实现 IEventService 接口
 */

import type {
  OrchestratorEventType,
  OrchestratorEvent,
  OrchestratorEventHandler,
} from '../types';
import type { IEventService, EventServiceContext } from '../interfaces';

/**
 * 事件服务实现
 *
 * @example
 * ```ts
 * const eventService = new EventService();
 * eventService.setContext({ sessionId: 'session-123', orchestratorId: 'orch-001' });
 *
 * eventService.on('subtask:complete', (event) => {
 *   console.log(`Subtask ${event.subtaskId} completed`);
 * });
 *
 * eventService.emit('subtask:complete', 'task-001', { output: 'success' }, 'subtask-1');
 * ```
 */
export class EventService implements IEventService {
  private readonly eventListeners = new Map<
    OrchestratorEventType,
    Set<OrchestratorEventHandler>
  >();

  private context: EventServiceContext = {};

  /**
   * 设置上下文信息
   *
   * 用于在事件中自动附加 sessionId 和 traceId
   */
  setContext(context: EventServiceContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * 获取当前上下文
   */
  getContext(): EventServiceContext {
    return { ...this.context };
  }

  /**
   * 添加事件监听器
   */
  on<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void {
    let handlers = this.eventListeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.eventListeners.set(type, handlers);
    }
    handlers.add(handler as OrchestratorEventHandler);
  }

  /**
   * 移除事件监听器
   */
  off<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void {
    const handlers = this.eventListeners.get(type);
    if (handlers) {
      handlers.delete(handler as OrchestratorEventHandler);
    }
  }

  /**
   * 发出事件（带上下文信息）
   */
  emit<T = unknown>(
    type: OrchestratorEventType,
    taskId: string,
    data: T,
    subtaskId?: string
  ): void {
    const event: OrchestratorEvent<T> = {
      type,
      taskId,
      // 从上下文添加会话和追踪信息
      ...(this.context.sessionId && { sessionId: this.context.sessionId }),
      ...(this.context.orchestratorId && {
        traceId: `orch-${this.context.orchestratorId}`,
      }),
      ...(subtaskId !== undefined && { subtaskId }),
      data,
      timestamp: Date.now(),
    };

    const handlers = this.eventListeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            result.catch((error) => {
              console.error(
                `Error in orchestrator event handler [${type}]:`,
                error
              );
            });
          }
        } catch (error) {
          console.error(
            `Error in orchestrator event handler [${type}]:`,
            error
          );
        }
      }
    }
  }

  /**
   * 检查是否有监听器
   */
  hasListeners(type: OrchestratorEventType): boolean {
    const handlers = this.eventListeners.get(type);
    return handlers !== undefined && handlers.size > 0;
  }

  /**
   * 获取监听器数量
   */
  getListenerCount(type: OrchestratorEventType): number {
    const handlers = this.eventListeners.get(type);
    return handlers?.size ?? 0;
  }

  /**
   * 移除所有监听器
   */
  removeAllListeners(type?: OrchestratorEventType): void {
    if (type) {
      this.eventListeners.delete(type);
    } else {
      this.eventListeners.clear();
    }
  }
}

/**
 * 创建事件服务实例
 */
export function createEventService(): IEventService {
  return new EventService();
}
