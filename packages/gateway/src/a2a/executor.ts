/**
 * Tachikoma Agent Executor
 *
 * Implements @a2a-js/sdk AgentExecutor interface to bridge A2A requests
 * with Tachikoma Core's WorkerAgent/WorkerExecutor.
 *
 * @module a2a/executor
 */

import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import type { Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { messageToTask, mapStatusToA2AState } from './converters';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for TachikomaAgentExecutor
 */
export interface TachikomaExecutorConfig {
  /**
   * Function to execute a task (integration point with Tachikoma Core)
   *
   * This should be provided by the caller to connect to WorkerAgent or Orchestrator.
   * Returns an async iterator of status updates and a final result.
   */
  executeTask?: TaskExecutor;

  /**
   * Function to cancel a running task
   */
  cancelTask?: (taskId: string) => Promise<void>;
}

/**
 * Task execution function type
 *
 * Receives a Tachikoma Task and returns an async generator of execution events.
 */
export type TaskExecutor = (task: {
  id: string;
  objective: string;
  constraints: string[];
  context?: { sessionId?: string; traceId?: string };
}) => AsyncIterable<TaskExecutionEvent>;

/**
 * Task execution events from Tachikoma
 */
export type TaskExecutionEvent =
  | { type: 'status'; status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled' }
  | { type: 'thinking'; content: string }
  | { type: 'output'; content: string }
  | { type: 'error'; error: string };

// ============================================================================
// Default (Stub) Executor
// ============================================================================

const defaultTaskExecutor: TaskExecutor = async function* (task) {
  yield { type: 'status', status: 'running' };
  yield { type: 'thinking', content: `Processing task: ${task.objective}` };

  // Stub response
  yield {
    type: 'output',
    content: 'A2A task execution not yet connected to Tachikoma Core. ' +
      'Implement TaskExecutor to connect to WorkerAgent or Orchestrator.',
  };

  yield { type: 'status', status: 'success' };
};

// ============================================================================
// Agent Executor Implementation
// ============================================================================

/**
 * Tachikoma implementation of A2A AgentExecutor
 *
 * Bridges A2A SDK's request handling with Tachikoma's task execution.
 *
 * @example
 * ```ts
 * import { WorkerAgent } from '@tachikoma/core';
 *
 * const agent = new WorkerAgent(config);
 *
 * const executor = new TachikomaAgentExecutor({
 *   executeTask: async function* (task) {
 *     const result = await agent.run(task);
 *     yield { type: 'output', content: result.output };
 *     yield { type: 'status', status: result.status };
 *   },
 * });
 * ```
 */
export class TachikomaAgentExecutor implements AgentExecutor {
  private readonly taskExecutor: TaskExecutor;
  private readonly taskCanceller: (taskId: string) => Promise<void>;
  private readonly runningTasks = new Map<string, AbortController>();

  constructor(config: TachikomaExecutorConfig = {}) {
    this.taskExecutor = config.executeTask ?? defaultTaskExecutor;
    this.taskCanceller = config.cancelTask ?? (async () => { /* noop */ });
  }

  /**
   * Execute a task from A2A request
   */
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;

    // Convert A2A message to Tachikoma task
    const task = messageToTask(userMessage, taskId);

    // Track for cancellation
    const abortController = new AbortController();
    this.runningTasks.set(taskId, abortController);

    try {
      // Publish initial status
      const workingUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'working',
          timestamp: new Date().toISOString(),
        },
        final: false,
      };
      eventBus.publish(workingUpdate);

      // Execute task and stream events
      let finalOutput = '';
      let finalStatus: 'success' | 'failure' = 'success';

      for await (const event of this.taskExecutor(task)) {
        // Check for cancellation
        if (abortController.signal.aborted) {
          break;
        }

        switch (event.type) {
          case 'thinking': {
            // Publish thinking as status update
            const thinkingUpdate: TaskStatusUpdateEvent = {
              kind: 'status-update',
              taskId,
              contextId,
              status: {
                state: 'working',
                timestamp: new Date().toISOString(),
                message: {
                  kind: 'message',
                  messageId: `think-${Date.now()}`,
                  role: 'agent',
                  parts: [{ kind: 'text', text: event.content }],
                },
              },
              final: false,
            };
            eventBus.publish(thinkingUpdate);
            break;
          }

          case 'output':
            finalOutput = event.content;
            break;

          case 'status':
            if (event.status === 'failure' || event.status === 'cancelled') {
              finalStatus = 'failure';
            }
            break;

          case 'error':
            finalOutput = `Error: ${event.error}`;
            finalStatus = 'failure';
            break;
        }
      }

      // Check if cancelled
      if (abortController.signal.aborted) {
        const cancelUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'canceled',
            timestamp: new Date().toISOString(),
          },
          final: true,
        };
        eventBus.publish(cancelUpdate);
      } else {
        // Publish final result as message
        const finalMessage: Message = {
          kind: 'message',
          messageId: `resp-${Date.now()}`,
          role: 'agent',
          parts: [{ kind: 'text', text: finalOutput || 'Task completed' }],
          contextId,
        };
        eventBus.publish(finalMessage);

        // Publish final status
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: mapStatusToA2AState(finalStatus),
            timestamp: new Date().toISOString(),
          },
          final: true,
        };
        eventBus.publish(finalUpdate);
      }
    } finally {
      this.runningTasks.delete(taskId);
      eventBus.finished();
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    // Signal abort to running task
    const controller = this.runningTasks.get(taskId);
    if (controller) {
      controller.abort();
    }

    // Call external canceller
    await this.taskCanceller(taskId);

    // The execute loop will handle publishing the cancelled status
  }
}
