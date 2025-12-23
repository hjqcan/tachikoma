/**
 * A2A Protocol Module
 *
 * Exports A2A protocol types and utilities using @a2a-js/sdk.
 * This module is opt-in and does not affect existing Tachikoma behavior.
 *
 * @module a2a
 */

// SDK Types (re-exported from types.ts)
export type {
  AgentCard,
  AgentCapabilities,
  AgentSkill,
  Message,
  Task,
  TaskState,
  TaskStatus,
  Artifact,
  MessageSendParams,
  SendMessageResponse,
  A2AConfig,
} from './types';

// SDK Constants
export { AGENT_CARD_PATH, DEFAULT_A2A_CONFIG } from './types';

// Agent Card utilities
export {
  createTachikomaAgentCard,
  findSkillById,
  supportsSkill,
  getSkillsByTag,
  validateAgentCard,
  DEFAULT_TACHIKOMA_SKILLS,
} from './agent-card';
export type { AgentCardConfig } from './agent-card';

// Client utilities (SDK-based)
export {
  createA2AClient,
  createA2AClientFromCard,
  fetchAgentCard,
  isTask,
  isMessage,
  generateMessageId,
  generateTaskId,
} from './client';
export type {
  A2AClient,
  A2AClientConfig,
  A2ARequestOptions,
  A2AMessage,
  A2ATask,
} from './client';

// Server utilities (SDK-based)
export { TachikomaAgentExecutor } from './executor';
export type {
  TachikomaExecutorConfig,
  TaskExecutor,
  TaskExecutionEvent,
} from './executor';

// Converters
export {
  messageToTask,
  taskResultToA2ATask,
  artifactToA2AArtifact,
  mapStatusToA2AState,
} from './converters';

// Direct SDK exports for advanced usage
export { ClientFactory } from '@a2a-js/sdk/client';
export {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
