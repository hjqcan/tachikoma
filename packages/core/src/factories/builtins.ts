/**
 * Built-in factory registrations.
 *
 * 目标：
 * - 默认可用（无需用户手动 register），但仍允许外部覆盖扩展
 * - 仅注册“稳定对外抽象”的实现：Agent 与 ConversationContextManager
 */

import type { Agent, AgentConfig, ConversationContextThresholds } from '../types';
import type { ConversationContextManager } from '../types';

import { Orchestrator, type OrchestratorOptions } from '../orchestrator/orchestrator';
import { WorkerAgent, type WorkerAgentOptions } from '../agents';
import { SimpleConversationContextManager } from '../abstracts/base-conversation-context-manager';

import type { FactoryRegistry, AgentFactoryOptions } from './registry';

function pickOrchestratorOptions(options?: AgentFactoryOptions): OrchestratorOptions {
  const o = options;
  if (!o) return {};
  return {
    planner: o.planner,
    workerPool: o.workerPool,
    sessionManager: o.sessionManager,
    config: o.config,
  };
}

function pickWorkerAgentOptions(options?: AgentFactoryOptions): WorkerAgentOptions {
  const o = options;
  if (!o) return {};
  return {
    workDir: o.workDir,
    tools: o.tools,
    executionOptions: o.executionOptions,
    backendConfig: o.backendConfig,
    sessionManager: o.sessionManager,
    mcpClient: o.mcpClient,
    autoRegisterMCPTools: o.autoRegisterMCPTools,
    logger: o.logger,
    tracer: o.tracer,
    metrics: o.metrics,
  };
}

/**
 * 注册内置实现到指定 registry。
 *
 * 该函数应保持幂等：重复调用不会破坏行为（defaultRegistry 允许覆盖）。
 */
export function registerBuiltInFactories(registry: FactoryRegistry): void {
  // Orchestrator Agent
  registry.registerAgent('orchestrator', (id: string, config: AgentConfig, options?: AgentFactoryOptions): Agent => {
    const orchestratorOptions = pickOrchestratorOptions(options);
    return new Orchestrator(id, {
      ...orchestratorOptions,
      config: {
        ...(orchestratorOptions.config ?? {}),
        agent: config,
      },
    });
  });

  // Worker Agent
  registry.registerAgent('worker', (id: string, config: AgentConfig, options?: AgentFactoryOptions): Agent => {
    const workerOptions = pickWorkerAgentOptions(options);
    return new WorkerAgent(id, config, workerOptions);
  });

  // Conversation context container (public API)
  registry.registerConversationContextManager(
    (sessionId: string, thresholds: ConversationContextThresholds): ConversationContextManager => {
      return new SimpleConversationContextManager(sessionId, thresholds);
    }
  );
}
