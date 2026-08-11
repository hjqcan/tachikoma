/**
 * A2A Client (SDK-based)
 *
 * Wrapper around @a2a-js/sdk ClientFactory for calling external A2A agents.
 * Uses the official SDK for protocol compliance.
 *
 * @module a2a/client
 */

import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { Client, ClientConfig, RequestOptions } from '@a2a-js/sdk/client';
import type { AgentCard, Message, SendMessageRequest, Task } from '@a2a-js/sdk';

// ============================================================================
// Re-export SDK types for convenience
// ============================================================================

export type {
  Client as A2AClient,
  ClientConfig as A2AClientConfig,
  RequestOptions as A2ARequestOptions,
  AgentCard,
  Message as A2AMessage,
  Task as A2ATask,
  SendMessageRequest,
};

// ============================================================================
// Client Factory Wrapper
// ============================================================================

/**
 * Create an A2A client for a remote agent using the official SDK
 *
 * @param agentUrl - Base URL of the A2A agent
 * @param config - Optional client configuration
 * @returns Promise resolving to an A2A Client instance
 *
 * @example
 * ```ts
 * const client = await createA2AClient('https://external-agent.example.com');
 * const agentCard = await client.getAgentCard();
 * console.log('Agent skills:', agentCard.skills);
 *
 * const result = await client.sendMessage({
 *   message: {
 *     kind: 'message',
 *     messageId: 'msg-001',
 *     role: 'user',
 *     parts: [{ kind: 'text', text: 'Hello!' }],
 *   },
 * });
 * ```
 */
export async function createA2AClient(agentUrl: string, config?: ClientConfig): Promise<Client> {
  const factory = new ClientFactory(
    config
      ? ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          clientConfig: config,
        })
      : undefined
  );
  return factory.createFromUrl(agentUrl);
}

/**
 * Create an A2A client from an existing Agent Card
 *
 * @param agentCard - The agent's card
 * @param config - Optional client configuration
 * @returns Promise resolving to an A2A Client instance
 */
export async function createA2AClientFromCard(
  agentCard: AgentCard,
  config?: ClientConfig
): Promise<Client> {
  const factory = new ClientFactory(
    config
      ? ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          clientConfig: config,
        })
      : undefined
  );
  return factory.createFromAgentCard(agentCard);
}

// ============================================================================
// Helper utilities
// ============================================================================

/**
 * Fetch an agent card directly without creating a client
 *
 * @param agentUrl - Base URL of the A2A agent
 * @returns Promise resolving to the agent's card
 */
export async function fetchAgentCard(agentUrl: string): Promise<AgentCard> {
  return new DefaultAgentCardResolver().resolve(agentUrl);
}

/**
 * Check if a message/task result is a Task (vs Message)
 */
export function isTask(result: Message | Task): result is Task {
  return 'id' in result;
}

/**
 * Check if a message/task result is a Message
 */
export function isMessage(result: Message | Task): result is Message {
  return 'messageId' in result;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
