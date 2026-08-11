/**
 * A2A ↔ Tachikoma Type Converters
 *
 * Converts between @a2a-js/sdk types and Tachikoma Core types.
 *
 * @module a2a/converters
 */

import { Role, TaskState } from '@a2a-js/sdk';
import type { Artifact as A2AArtifact, Message, Part, Task as A2ATask } from '@a2a-js/sdk';
import type { Artifact, Task, TaskResult } from '@tachikoma/core';

export function createTextPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

// ============================================================================
// Message → Task Conversion
// ============================================================================

/**
 * Convert A2A Message to Tachikoma Task
 */
export function messageToTask(message: Message, taskId: string): Task {
  // Extract text from message parts
  const objective = message.parts
    .flatMap((part) => (part.content?.$case === 'text' ? [part.content.value] : []))
    .join('\n');

  const skillId =
    typeof message.metadata?.skillId === 'string' ? message.metadata.skillId : undefined;

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
    description: '',
    parts: [createTextPart(artifact.content)],
    metadata: undefined,
    extensions: [],
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
  const state =
    result.status === 'success' ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_FAILED;

  // Convert artifacts
  const artifacts: A2AArtifact[] = result.artifacts.map(artifactToA2AArtifact);

  // Extract output text
  const outputText =
    typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);

  return {
    id: taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: {
        messageId: `resp-${Date.now()}`,
        contextId,
        taskId,
        role: Role.ROLE_AGENT,
        parts: [createTextPart(outputText)],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
    },
    artifacts,
    history: [],
    metadata: undefined,
  };
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map Tachikoma status to A2A TaskState
 */
export type A2ATaskState = TaskState;

export function mapStatusToA2AState(
  status: 'pending' | 'running' | 'success' | 'failure' | 'partial' | 'cancelled'
): A2ATaskState {
  switch (status) {
    case 'pending':
      return TaskState.TASK_STATE_SUBMITTED;
    case 'running':
      return TaskState.TASK_STATE_WORKING;
    case 'success':
      return TaskState.TASK_STATE_COMPLETED;
    case 'failure':
      return TaskState.TASK_STATE_FAILED;
    case 'partial':
      return TaskState.TASK_STATE_FAILED;
    case 'cancelled':
      return TaskState.TASK_STATE_CANCELED;
    default:
      return TaskState.TASK_STATE_FAILED;
  }
}
