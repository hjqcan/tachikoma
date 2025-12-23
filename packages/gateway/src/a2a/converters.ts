/**
 * A2A ↔ Tachikoma Type Converters
 *
 * Converts between @a2a-js/sdk types and Tachikoma Core types.
 *
 * @module a2a/converters
 */

import type { Message, Task as A2ATask, Artifact as A2AArtifact } from '@a2a-js/sdk';
import type { Task, TaskResult, Artifact } from '@tachikoma/core';

// ============================================================================
// Message → Task Conversion
// ============================================================================

/**
 * Convert A2A Message to Tachikoma Task
 */
export function messageToTask(message: Message, taskId: string): Task {
  // Extract text from message parts
  const objective = message.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');

  // Extract skill ID from task attributes if present
  const skillId = (message as { attributes?: { skillId?: string } }).attributes?.skillId;

  const task: Task = {
    id: taskId,
    type: 'atomic',
    objective,
    constraints: skillId ? [`Use skill: ${skillId}`] : [],
  };

  if (message.contextId) {
    task.context = {
      sessionId: message.contextId,
      traceId: `a2a-${taskId}`,
    };
  }

  return task;
}

// ============================================================================
// TaskResult → A2A Artifact Conversion
// ============================================================================

/**
 * Convert Tachikoma Artifact to A2A Artifact
 */
export function artifactToA2AArtifact(artifact: Artifact): A2AArtifact {
  return {
    artifactId: artifact.id,
    name: artifact.name,
    parts: [
      {
        kind: 'text',
        text: artifact.content,
      },
    ],
  };
}

/**
 * Convert Tachikoma TaskResult to A2A Task
 */
export function taskResultToA2ATask(
  taskId: string,
  contextId: string,
  result: TaskResult
): A2ATask {
  const state = result.status === 'success' ? 'completed' : 'failed';

  // Convert artifacts
  const artifacts: A2AArtifact[] = result.artifacts.map(artifactToA2AArtifact);

  // Extract output text
  const outputText =
    typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output, null, 2);

  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: {
        kind: 'message',
        messageId: `resp-${Date.now()}`,
        role: 'agent',
        parts: [{ kind: 'text', text: outputText }],
      },
    },
    artifacts,
  };
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map Tachikoma status to A2A TaskState
 */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export function mapStatusToA2AState(
  status: 'pending' | 'running' | 'success' | 'failure' | 'partial' | 'cancelled'
): A2ATaskState {
  switch (status) {
    case 'pending':
      return 'submitted';
    case 'running':
      return 'working';
    case 'success':
      return 'completed';
    case 'failure':
      return 'failed';
    case 'partial':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'failed';
  }
}
