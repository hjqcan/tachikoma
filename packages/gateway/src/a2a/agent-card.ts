/**
 * Agent Card Generator
 *
 * Creates Tachikoma's A2A Agent Card for external discovery.
 * Uses @a2a-js/sdk types for protocol compliance.
 *
 * @module a2a/agent-card
 */

import { A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import type { AgentCard, AgentSkill } from '@a2a-js/sdk';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Agent Card generation configuration
 */
export interface AgentCardConfig {
  /** Base URL for the A2A endpoint */
  baseUrl: string;
  /** Custom skills to advertise (merged with defaults) */
  customSkills?: AgentSkill[];
  /** Override default capabilities */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  /** Provider information (url is required) */
  provider?: {
    organization: string;
    url: string;
  };
}

// ============================================================================
// Default Skills
// ============================================================================

/**
 * Default Tachikoma skills
 */
export const DEFAULT_TACHIKOMA_SKILLS: AgentSkill[] = [
  {
    id: 'code_generation',
    name: 'Code Generation',
    description: 'Generate code based on natural language requirements',
    tags: ['coding', 'generation', 'development'],
    examples: [
      'Create a REST API for user management',
      'Implement a binary search algorithm in TypeScript',
      'Build a React component for a login form',
    ],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  },
  {
    id: 'code_review',
    name: 'Code Review',
    description: 'Review code and provide feedback on quality, bugs, and improvements',
    tags: ['coding', 'review', 'quality'],
    examples: [
      'Review this function for potential bugs',
      'Suggest improvements for this class design',
    ],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  },
  {
    id: 'code_refactoring',
    name: 'Code Refactoring',
    description: 'Refactor existing code to improve structure and maintainability',
    tags: ['coding', 'refactoring', 'maintenance'],
    examples: [
      'Refactor this code to use async/await',
      'Extract common logic into reusable functions',
    ],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  },
  {
    id: 'debugging',
    name: 'Debugging',
    description: 'Identify and fix bugs in code',
    tags: ['coding', 'debugging', 'troubleshooting'],
    examples: [
      'Why is this function returning undefined?',
      'Find the bug causing this test to fail',
    ],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  },
  {
    id: 'documentation',
    name: 'Documentation',
    description: 'Generate or improve code documentation',
    tags: ['coding', 'documentation', 'comments'],
    examples: ['Add JSDoc comments to this module', 'Generate README for this project'],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  },
  {
    id: 'task_orchestration',
    name: 'Task Orchestration',
    description: 'Break down complex tasks and coordinate multi-step execution',
    tags: ['orchestration', 'planning', 'multi-agent'],
    examples: [
      'Implement a complete user authentication system',
      'Create a full-stack CRUD application',
    ],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  },
];

// ============================================================================
// Agent Card Generator
// ============================================================================

/**
 * Create Tachikoma's Agent Card
 *
 * @param config - Configuration options
 * @returns Complete Agent Card conforming to A2A protocol
 *
 * @example
 * ```ts
 * const agentCard = createTachikomaAgentCard({
 *   baseUrl: 'https://api.example.com',
 * });
 * ```
 */
export function createTachikomaAgentCard(config: AgentCardConfig): AgentCard {
  const { baseUrl, customSkills = [], capabilities = {}, provider } = config;

  // Merge custom skills with defaults (custom skills override by id)
  const customSkillIds = new Set(customSkills.map((s) => s.id));
  const mergedSkills = [
    ...DEFAULT_TACHIKOMA_SKILLS.filter((s) => !customSkillIds.has(s.id)),
    ...customSkills,
  ];

  return {
    name: 'Tachikoma',
    description:
      'AI coding assistant with multi-agent orchestration capabilities. ' +
      'Specializes in code generation, review, refactoring, and complex task decomposition.',
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: '',
      },
    ],
    version: '0.1.0',
    capabilities: {
      streaming: capabilities.streaming ?? true,
      pushNotifications: capabilities.pushNotifications ?? false,
      extensions: [],
      extendedAgentCard: false,
    },
    skills: mergedSkills,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    provider: provider ?? {
      organization: 'Tachikoma',
      url: 'https://github.com/your-org/tachikoma',
    },
    securitySchemes: {},
    securityRequirements: [],
    signatures: [],
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Find a skill by ID
 */
export function findSkillById(agentCard: AgentCard, skillId: string): AgentSkill | undefined {
  return agentCard.skills.find((s) => s.id === skillId);
}

/**
 * Check if agent supports a specific skill
 */
export function supportsSkill(agentCard: AgentCard, skillId: string): boolean {
  return agentCard.skills.some((s) => s.id === skillId);
}

/**
 * Get skills by tag
 */
export function getSkillsByTag(agentCard: AgentCard, tag: string): AgentSkill[] {
  return agentCard.skills.filter((s) => s.tags.includes(tag));
}

/**
 * Validate Agent Card structure
 */
export function validateAgentCard(card: unknown): card is AgentCard {
  if (typeof card !== 'object' || card === null) return false;

  const c = card as Record<string, unknown>;

  return (
    typeof c.name === 'string' &&
    typeof c.description === 'string' &&
    typeof c.version === 'string' &&
    typeof c.capabilities === 'object' &&
    Array.isArray(c.supportedInterfaces) &&
    Array.isArray(c.skills) &&
    Array.isArray(c.defaultInputModes) &&
    Array.isArray(c.defaultOutputModes)
  );
}
