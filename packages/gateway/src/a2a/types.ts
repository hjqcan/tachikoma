/**
 * A2A Protocol Types
 *
 * Re-exports types from @a2a-js/sdk for use within Tachikoma.
 * Custom types are only added when SDK doesn't provide them.
 *
 * @module a2a/types
 */

// ============================================================================
// Re-export all SDK types
// ============================================================================

export type {
  // Agent Card
  AgentCard,
  AgentCapabilities,
  AgentSkill,
  AgentProvider,
  AgentInterface,
  AgentExtension,
  // Messages
  Message,
  Part,
  TextPart,
  FilePart,
  DataPart,
  FileWithBytes,
  FileWithUri,
  // Tasks
  Task,
  TaskState,
  TaskStatus,
  TaskIdParams,
  TaskQueryParams,
  Artifact,
  // Push Notifications
  PushNotificationConfig,
  TaskPushNotificationConfig,
  PushNotificationAuthenticationInfo,
  // Security
  SecurityScheme,
  OAuth2SecurityScheme,
  HTTPAuthSecurityScheme,
  APIKeySecurityScheme,
  // Requests/Responses
  MessageSendParams,
  MessageSendConfiguration,
  SendMessageResponse,
  SendStreamingMessageResponse,
  GetTaskResponse,
  CancelTaskResponse,
  // JSON-RPC
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCErrorResponse,
  JSONRPCError,
  // Extensions
  Extensions,
} from '@a2a-js/sdk';

export {
  AGENT_CARD_PATH,
  HTTP_EXTENSION_HEADER,
} from '@a2a-js/sdk';

// ============================================================================
// Tachikoma-specific A2A configuration
// ============================================================================

/**
 * A2A module configuration for Tachikoma
 */
export interface A2AConfig {
  /** Enable A2A server (expose Tachikoma as A2A agent) */
  enableServer?: boolean;
  /** Enable A2A client (call external A2A agents) */
  enableClient?: boolean;
  /** Base URL for Agent Card */
  baseUrl?: string;
  /** Custom skills to advertise (in addition to defaults) */
  customSkills?: {
    id: string;
    name: string;
    description: string;
    tags: string[];
  }[];
  /** Allowed external A2A agent hosts (for client) */
  allowedAgentHosts?: string[];
}

/**
 * Default A2A configuration
 */
export const DEFAULT_A2A_CONFIG: A2AConfig = {
  enableServer: false, // Disabled by default - no impact on existing code
  enableClient: false,
};
