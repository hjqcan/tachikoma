/**
 * Collaboration protocol payloads
 *
 * Keep payload schemas centralized to avoid drift between tools and orchestrator.
 *
 * @module collaboration/protocol
 */

/**
 * Peer-assist request payload sent via CollaborationManager.request().
 *
 * Design notes:
 * - Requests are routed via an orchestrator (hub) by default.
 * - `preferredWorkerId` is a routing constraint/hint (not a direct P2P address).
 */
export interface PeerAssistRequestPayload {
  kind: 'peer_assist';
  requiredCapabilities?: string[];
  taskDescription: string;
  taskPayload?: unknown;
  /**
   * Preferred Worker ID for routing (best-effort unless `strictPreferredWorker` is true).
   * This is NOT the Collaboration "toAgentId".
   */
  preferredWorkerId?: string;
  /**
   * If true, routing must pick `preferredWorkerId` or fail.
   * Defaults to false (best-effort).
   */
  strictPreferredWorker?: boolean;
}

/**
 * Peer-assist routed result returned by orchestrator.
 *
 * The orchestrator is responsible for selecting a worker and returning `targetWorkerId`;
 * the caller coordinates actual execution.
 */
export interface PeerAssistRoutedResultPayload {
  routed: true;
  targetWorkerId?: string;
  targetCapabilities?: string[];
  availableWorkerCount: number;
  requiredCapabilities?: string[];
  taskDescription?: string;
  taskPayload?: unknown;
  preferredWorkerId?: string;
  preferredMatched?: boolean;
}

