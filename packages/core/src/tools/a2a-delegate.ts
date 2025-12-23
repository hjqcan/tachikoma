/**
 * A2A Delegate Tool
 *
 * Tool that allows Tachikoma agents to delegate tasks to external A2A-compatible agents.
 * This enables cross-framework collaboration with LangGraph, CrewAI, Google ADK agents, etc.
 *
 * @module tools/a2a-delegate
 */

import type { Tool } from '../types';

// ============================================================================
// Types (self-contained to avoid gateway dependency in core)
// ============================================================================

interface A2AMessage {
  role: 'user' | 'agent';
  parts: ({ type: 'text'; text: string } | { type: 'data'; data: Record<string, unknown> })[];
  attributes?: Record<string, unknown> | undefined;
}

interface A2ATaskSendParams {
  id: string;
  sessionId?: string;
  message: A2AMessage;
  acceptedOutputModes?: string[];
  historyLength?: number;
}

interface A2ATaskResult {
  id: string;
  sessionId?: string;
  status: {
    state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
    message?: A2AMessage;
  };
  artifacts?: {
    name?: string;
    parts: { type: 'text'; text: string }[];
  }[];
}

interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: {
    id: string;
    name: string;
    description: string;
    tags: string[];
  }[];
}

interface A2ARpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: A2ATaskResult;
  error?: { code: number; message: string };
}

// ============================================================================
// Tool Input/Output
// ============================================================================

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
    waitForCompletion: {
      type: 'boolean',
      description: 'Optional: Wait for task completion or return immediately (default: true)',
    },
  },
  required: ['agentUrl', 'taskDescription'],
};

interface A2ADelegateInput {
  agentUrl: string;
  taskDescription: string;
  skillId?: string;
  timeout?: number;
  waitForCompletion?: boolean;
}

interface A2ADelegateOutput {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Tool Implementation
// ============================================================================

/**
 * A2A Delegate Tool
 *
 * Delegates a task to an external A2A-compatible agent and returns the result.
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
    'Use this when the task would benefit from another agent\'s specialized capabilities.',
  inputSchema: a2aDelegateInputSchema,

  async execute(
    rawInput: unknown,
    _context?: unknown
  ): Promise<A2ADelegateOutput> {
    const input = rawInput as A2ADelegateInput;
    const {
      agentUrl,
      taskDescription,
      skillId,
      timeout = 30000,
      waitForCompletion = true,
    } = input;

    try {
      // Step 1: Discover agent capabilities
      const agentCard = await discoverAgent(agentUrl, timeout);

      // Step 2: Validate skill if specified
      if (skillId && !agentCard.skills.some((s) => s.id === skillId)) {
        return {
          success: false,
          output: `Agent does not support skill: ${skillId}. Available skills: ${agentCard.skills.map((s) => s.id).join(', ')}`,
        };
      }

      // Step 3: Build message (only add attributes if skillId is provided)
      const message: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: taskDescription }],
      };
      if (skillId) {
        message.attributes = { skillId };
      }

      // Step 4: Send task
      const taskId = generateTaskId();
      const taskParams: A2ATaskSendParams = {
        id: taskId,
        message,
      };

      const result = await sendTask(agentUrl, taskParams, timeout);

      // Step 5: Poll for completion if requested
      if (waitForCompletion && !isTerminalState(result.status.state)) {
        const finalResult = await pollForCompletion(agentUrl, taskId, timeout);
        return formatResult(agentCard, finalResult);
      }

      return formatResult(agentCard, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        output: `A2A delegation failed: ${errorMessage}`,
      };
    }
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

async function discoverAgent(agentUrl: string, timeout: number): Promise<A2AAgentCard> {
  const cardUrl = new URL('/.well-known/agent.json', agentUrl).toString();

  const response = await fetch(cardUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Agent discovery failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<A2AAgentCard>;
}

async function sendTask(
  agentUrl: string,
  params: A2ATaskSendParams,
  timeout: number
): Promise<A2ATaskResult> {
  const a2aUrl = new URL('/a2a', agentUrl).toString();

  const response = await fetch(a2aUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tasks/send',
      params,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Task send failed: ${response.status} ${response.statusText}`);
  }

  const rpcResponse = (await response.json()) as A2ARpcResponse;
  if (rpcResponse.error) {
    throw new Error(`RPC error: ${rpcResponse.error.message}`);
  }

  if (!rpcResponse.result) {
    throw new Error('No result in RPC response');
  }

  return rpcResponse.result;
}

async function pollForCompletion(
  agentUrl: string,
  taskId: string,
  timeout: number,
  maxAttempts = 60,
  pollInterval = 2000
): Promise<A2ATaskResult> {
  const a2aUrl = new URL('/a2a', agentUrl).toString();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Intentional sequential polling
    const response = await fetch(a2aUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tasks/get',
        params: { id: taskId },
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      throw new Error(`Task get failed: ${response.status}`);
    }

    // eslint-disable-next-line no-await-in-loop -- Intentional sequential polling
    const rpcResponse = (await response.json()) as A2ARpcResponse;
    if (rpcResponse.error) {
      throw new Error(`RPC error: ${rpcResponse.error.message}`);
    }

    if (!rpcResponse.result) {
      throw new Error('No result in RPC response');
    }

    const result = rpcResponse.result;
    if (isTerminalState(result.status.state)) {
      return result;
    }

    // eslint-disable-next-line no-await-in-loop -- Intentional delay between polls
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error('Task polling timeout - task did not complete in expected time');
}

function isTerminalState(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}

function formatResult(agentCard: A2AAgentCard, result: A2ATaskResult): A2ADelegateOutput {
  const success = result.status.state === 'completed';

  // Extract text output from artifacts or status message
  let output = '';

  if (result.artifacts && result.artifacts.length > 0) {
    output = result.artifacts
      .flatMap((artifact) => artifact.parts)
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n');
  } else if (result.status.message) {
    output = result.status.message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  return {
    success,
    output: output || `Task ${result.status.state}`,
    metadata: {
      agentName: agentCard.name,
      agentVersion: agentCard.version,
      taskId: result.id,
      taskState: result.status.state,
    },
  };
}

function generateTaskId(): string {
  return `tachikoma-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default a2aDelegateTool;
