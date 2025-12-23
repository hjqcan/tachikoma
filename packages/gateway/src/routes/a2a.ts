/**
 * A2A Server Routes (SDK-based)
 *
 * Implements A2A protocol endpoints using @a2a-js/sdk server utilities.
 * Bridges external A2A requests to Tachikoma Core via TachikomaAgentExecutor.
 *
 * Endpoints:
 * - GET  /.well-known/agent-card.json - Agent Card discovery
 * - POST /a2a                         - JSON-RPC endpoint (via SDK)
 *
 * @module routes/a2a
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import type { AppEnv } from '../types';
import { logger } from '../middleware/logger';
import { createTachikomaAgentCard, type AgentCardConfig } from '../a2a/agent-card';
import { TachikomaAgentExecutor, type TachikomaExecutorConfig } from '../a2a/executor';
import type { A2AConfig } from '../a2a/types';

// ============================================================================
// Types
// ============================================================================

/**
 * A2A route configuration
 */
export interface A2ARouteConfig {
  /** Base URL for Agent Card (auto-detected if not provided) */
  baseUrl?: string;
  /** A2A module configuration */
  a2aConfig?: A2AConfig;
  /** Executor configuration (connect to Tachikoma Core) */
  executorConfig?: TachikomaExecutorConfig;
}

// ============================================================================
// Route Factory
// ============================================================================

/**
 * Create A2A protocol routes using SDK
 *
 * @param config - Route configuration
 * @returns Hono app with A2A routes
 *
 * @example
 * ```ts
 * import { WorkerAgent } from '@tachikoma/core';
 *
 * const agent = new WorkerAgent(config);
 *
 * const a2aRoutes = createA2ARoutes({
 *   baseUrl: 'https://api.example.com',
 *   executorConfig: {
 *     executeTask: async function* (task) {
 *       const result = await agent.run(task);
 *       yield { type: 'output', content: result.output };
 *       yield { type: 'status', status: result.status };
 *     },
 *   },
 * });
 *
 * app.route('/', a2aRoutes);
 * ```
 */
export function createA2ARoutes(config: A2ARouteConfig = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Lazily created handler (needs baseUrl from request)
  let cachedHandler: DefaultRequestHandler | null = null;
  let cachedTransport: JsonRpcTransportHandler | null = null;

  function getHandler(baseUrl: string): {
    handler: DefaultRequestHandler;
    transport: JsonRpcTransportHandler;
  } {
    if (cachedHandler && cachedTransport) {
      return { handler: cachedHandler, transport: cachedTransport };
    }

    // Create Agent Card
    const agentCardConfig: AgentCardConfig = { baseUrl };
    if (config.a2aConfig?.customSkills) {
      agentCardConfig.customSkills = config.a2aConfig.customSkills.map((s) => ({
        ...s,
        examples: [],
      }));
    }
    const agentCard = createTachikomaAgentCard(agentCardConfig);

    // Create Executor
    const executor = new TachikomaAgentExecutor(config.executorConfig);

    // Create SDK Handler
    cachedHandler = new DefaultRequestHandler(
      agentCard,
      new InMemoryTaskStore(),
      executor
    );

    cachedTransport = new JsonRpcTransportHandler(cachedHandler);

    return { handler: cachedHandler, transport: cachedTransport };
  }

  // =========================================================================
  // Agent Card Discovery
  // =========================================================================

  app.get(`/${AGENT_CARD_PATH}`, (c) => {
    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('host') || 'localhost:3000';
    const baseUrl = config.baseUrl || `${protocol}://${host}`;

    const { handler } = getHandler(baseUrl);

    logger.info('A2A Agent Card requested', {
      traceId: c.get('traceId'),
      requestId: c.get('requestId'),
    });

    // Use handler's getAgentCard for consistency
    return handler.getAgentCard().then((card) => c.json(card));
  });

  // =========================================================================
  // JSON-RPC Endpoint (via SDK)
  // =========================================================================

  app.post('/a2a', async (c) => {
    const protocol = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('host') || 'localhost:3000';
    const baseUrl = config.baseUrl || `${protocol}://${host}`;

    const { transport } = getHandler(baseUrl);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        },
        400
      );
    }

    const method = (body as { method?: string }).method;

    logger.info('A2A JSON-RPC request', {
      traceId: c.get('traceId'),
      requestId: c.get('requestId'),
      ...(method && { method }),
    });

    try {
      const result = await transport.handle(body);

      // Check if result is a generator (streaming)
      if (typeof result === 'object' && Symbol.asyncIterator in result) {
        // SSE streaming response
        return streamSSE(c, async (stream) => {
          for await (const event of result) {
            await stream.writeSSE({
              event: 'message',
              data: JSON.stringify(event),
            });
          }
        });
      }

      // Regular JSON-RPC response
      return c.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Internal error';
      logger.error('A2A JSON-RPC error', {
        traceId: c.get('traceId'),
        error: errorMessage,
      });
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32603, message: errorMessage },
          id: null,
        },
        500
      );
    }
  });

  return app;
}
