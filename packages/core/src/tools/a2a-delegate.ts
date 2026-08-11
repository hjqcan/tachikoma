/**
 * A2A Delegate Tool
 *
 * Tool that allows Tachikoma agents to delegate tasks to external A2A-compatible agents.
 * Uses @a2a-js/sdk ClientFactory for protocol-compliant communication.
 *
 * @module tools/a2a-delegate
 */

import { Role, TaskState } from '@a2a-js/sdk';
import type { Part } from '@a2a-js/sdk';

import type { Tool } from '../types';

function textFromParts(parts: Part[], separator: string): string {
  return parts
    .flatMap((part) => (part.content?.$case === 'text' ? [part.content.value] : []))
    .join(separator);
}

// ============================================================================
// Tool Input/Output Types
// ============================================================================

interface A2ADelegateOutput {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

/**
 * A2A Delegate tool input schema
 */
export const a2aDelegateInputSchema = {
  type: 'object' as const,
  properties: {
    agentUrl: {
      type: 'string',
      description: 'Base URL of the A2A agent to delegate to (e.g., https://agent.example.com)',
    },
    taskDescription: {
      type: 'string',
      description: 'Natural language description of the task to delegate',
    },
    skillId: {
      type: 'string',
      description: 'Optional: Specific skill ID to invoke (discovered from agent card)',
    },
    timeout: {
      type: 'number',
      description: 'Optional: Timeout in milliseconds (default: 30000)',
    },
  },
  required: ['agentUrl', 'taskDescription'],
};

interface A2ADelegateInput {
  agentUrl: string;
  taskDescription: string;
  skillId?: string;
  timeout?: number;
}

// ============================================================================
// Tool Implementation
// ============================================================================

/**
 * A2A Delegate Tool
 *
 * Delegates a task to an external A2A-compatible agent using @a2a-js/sdk.
 *
 * @example
 * ```ts
 * const result = await a2aDelegateTool.execute({
 *   agentUrl: 'https://research-agent.example.com',
 *   taskDescription: 'Research the latest developments in AI coding assistants',
 * }, context);
 * ```
 */
export const a2aDelegateTool: Tool = {
  name: 'a2a_delegate',
  description:
    'Delegate a task to an external A2A-compatible AI agent (LangGraph, CrewAI, Google ADK, etc.). ' +
    "Use this when the task would benefit from another agent's specialized capabilities.",
  inputSchema: a2aDelegateInputSchema,

  async execute(rawInput: unknown, _context?: unknown): Promise<A2ADelegateOutput> {
    const input = rawInput as A2ADelegateInput;
    const { agentUrl, taskDescription, skillId, timeout = 30000 } = input;

    try {
      // Load the network client only when delegation is used.
      const { ClientFactory } = await import('@a2a-js/sdk/client');

      const factory = new ClientFactory();
      const client = await factory.createFromUrl(agentUrl);

      // Get agent card for skill validation and metadata
      const agentCard = await client.getAgentCard();

      // Validate skill if specified
      if (skillId && !agentCard.skills.some((s) => s.id === skillId)) {
        return {
          success: false,
          output: `Agent does not support skill: ${skillId}. Available skills: ${agentCard.skills.map((s) => s.id).join(', ')}`,
        };
      }

      // Send message to agent
      const result = await client.sendMessage(
        {
          tenant: '',
          message: {
            messageId: `tachikoma-${Date.now()}`,
            contextId: '',
            taskId: '',
            role: Role.ROLE_USER,
            parts: [
              {
                content: { $case: 'text', value: taskDescription },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
              },
            ],
            metadata: skillId ? { skillId } : undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          configuration: undefined,
          metadata: undefined,
        },
        { signal: AbortSignal.timeout(timeout) }
      );

      // Process result (could be Message or Task)
      let output = '';
      let success = true;

      if ('messageId' in result) {
        output = textFromParts(result.parts, '\n');
      } else {
        const task = result;
        success = task.status?.state === TaskState.TASK_STATE_COMPLETED;

        if (task.artifacts.length > 0) {
          output = textFromParts(
            task.artifacts.flatMap((artifact) => artifact.parts),
            '\n\n'
          );
        } else if (task.status?.message) {
          output = textFromParts(task.status.message.parts, '\n');
        } else {
          output = `Task ${task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED}`;
        }
      }

      return {
        success,
        output: output || 'No response from agent',
        metadata: {
          agentName: agentCard.name,
          agentVersion: agentCard.version,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        output: `A2A delegation failed: ${errorMessage}`,
      };
    }
  },
};

export default a2aDelegateTool;
