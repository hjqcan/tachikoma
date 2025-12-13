/**
 * 工厂注册表
 *
 * 提供可扩展的依赖注入和实现注册机制
 */

import type {
  Agent,
  AgentType,
  AgentConfig,
  Tool,
  Sandbox,
  SandboxConfig,
  ConversationContextManager,
  ConversationContextThresholds,
} from '../types';
import type { WorkerBackendConfig, WorkerExecutionOptions } from '../worker';
import type { Planner } from '../planner/planner';
import type { IWorkerPool } from '../orchestrator/worker-pool';
import type { ISessionFileManager } from '../orchestrator/session/types';
import type { OrchestratorConfig } from '../orchestrator/types';
import type { MCPClientManager } from '../mcp';
import type { Logger, Tracer, MetricsCollector } from '../observability';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Agent 创建函数类型
 */
export type AgentFactory = (
  id: string,
  config: AgentConfig,
  options?: AgentFactoryOptions
) => Agent;

/**
 * Agent 工厂选项
 */
export interface AgentFactoryOptions {
  /** 上下文管理器 */
  conversationContextManager?: ConversationContextManager;
  /** 沙盒实例 */
  sandbox?: Sandbox;

  // === Orchestrator 注入（可选）===
  planner?: Planner;
  workerPool?: IWorkerPool;
  sessionManager?: ISessionFileManager;
  config?: Partial<OrchestratorConfig>;

  // === WorkerAgent 注入（可选）===
  workDir?: string;
  tools?: Tool[];
  executionOptions?: Partial<WorkerExecutionOptions>;
  backendConfig?: Partial<WorkerBackendConfig>;
  mcpClient?: MCPClientManager;
  autoRegisterMCPTools?: boolean;
  logger?: Logger;
  tracer?: Tracer;
  metrics?: MetricsCollector;

  /** 额外选项 */
  [key: string]: unknown;
}

/**
 * Sandbox 创建函数类型
 */
export type SandboxFactory = (
  id: string,
  config: SandboxConfig
) => Sandbox;

/**
 * ConversationContextManager 创建函数类型
 */
export type ConversationContextManagerFactory = (
  sessionId: string,
  thresholds: ConversationContextThresholds
) => ConversationContextManager;

/**
 * 注册表配置
 */
export interface RegistryConfig {
  /** 是否允许覆盖已注册的实现 */
  allowOverride?: boolean;
  /** 是否在未找到实现时使用 stub */
  useStubFallback?: boolean;
}

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 注册表错误
 */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * 未注册实现错误
 */
export class NotRegisteredError extends RegistryError {
  constructor(type: string, category: string) {
    super(`No ${category} implementation registered for type: ${type}`);
    this.name = 'NotRegisteredError';
  }
}

/**
 * 重复注册错误
 */
export class DuplicateRegistrationError extends RegistryError {
  constructor(type: string, category: string) {
    super(`${category} implementation already registered for type: ${type}. Use allowOverride option to override.`);
    this.name = 'DuplicateRegistrationError';
  }
}

// ============================================================================
// 工厂注册表类
// ============================================================================

/**
 * 工厂注册表
 *
 * 管理 Agent、Sandbox、ConversationContextManager 的工厂函数注册
 */
export class FactoryRegistry {
  private agentFactories = new Map<AgentType, AgentFactory>();
  private sandboxFactory: SandboxFactory | null = null;
  private conversationContextManagerFactory: ConversationContextManagerFactory | null = null;
  private config: RegistryConfig;

  constructor(config: RegistryConfig = {}) {
    this.config = {
      allowOverride: false,
      useStubFallback: true,
      ...config,
    };
  }

  // ==========================================================================
  // Agent 注册
  // ==========================================================================

  /**
   * 注册 Agent 工厂
   * @param type - Agent 类型
   * @param factory - 创建函数
   */
  registerAgent(type: AgentType, factory: AgentFactory): void {
    if (this.agentFactories.has(type) && !this.config.allowOverride) {
      throw new DuplicateRegistrationError(type, 'Agent');
    }
    this.agentFactories.set(type, factory);
  }

  /**
   * 注销 Agent 工厂
   * @param type - Agent 类型
   */
  unregisterAgent(type: AgentType): boolean {
    return this.agentFactories.delete(type);
  }

  /**
   * 检查 Agent 工厂是否已注册
   * @param type - Agent 类型
   */
  hasAgent(type: AgentType): boolean {
    return this.agentFactories.has(type);
  }

  /**
   * 获取 Agent 工厂
   * @param type - Agent 类型
   */
  getAgentFactory(type: AgentType): AgentFactory | undefined {
    return this.agentFactories.get(type);
  }

  /**
   * 获取所有已注册的 Agent 类型
   */
  getRegisteredAgentTypes(): AgentType[] {
    return Array.from(this.agentFactories.keys());
  }

  // ==========================================================================
  // Sandbox 注册
  // ==========================================================================

  /**
   * 注册 Sandbox 工厂
   * @param factory - 创建函数
   */
  registerSandbox(factory: SandboxFactory): void {
    if (this.sandboxFactory !== null && !this.config.allowOverride) {
      throw new DuplicateRegistrationError('sandbox', 'Sandbox');
    }
    this.sandboxFactory = factory;
  }

  /**
   * 注销 Sandbox 工厂
   */
  unregisterSandbox(): boolean {
    if (this.sandboxFactory === null) return false;
    this.sandboxFactory = null;
    return true;
  }

  /**
   * 检查 Sandbox 工厂是否已注册
   */
  hasSandbox(): boolean {
    return this.sandboxFactory !== null;
  }

  /**
   * 获取 Sandbox 工厂
   */
  getSandboxFactory(): SandboxFactory | null {
    return this.sandboxFactory;
  }

  // ==========================================================================
  // ConversationContextManager 注册
  // ==========================================================================

  /**
   * 注册 ConversationContextManager 工厂
   * @param factory - 创建函数
   */
  registerConversationContextManager(factory: ConversationContextManagerFactory): void {
    if (this.conversationContextManagerFactory !== null && !this.config.allowOverride) {
      throw new DuplicateRegistrationError('conversationContextManager', 'ConversationContextManager');
    }
    this.conversationContextManagerFactory = factory;
  }

  /**
   * 注销 ConversationContextManager 工厂
   */
  unregisterConversationContextManager(): boolean {
    if (this.conversationContextManagerFactory === null) return false;
    this.conversationContextManagerFactory = null;
    return true;
  }

  /**
   * 检查 ConversationContextManager 工厂是否已注册
   */
  hasConversationContextManager(): boolean {
    return this.conversationContextManagerFactory !== null;
  }

  /**
   * 获取 ConversationContextManager 工厂
   */
  getConversationContextManagerFactory(): ConversationContextManagerFactory | null {
    return this.conversationContextManagerFactory;
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 清空所有注册
   */
  clear(): void {
    this.agentFactories.clear();
    this.sandboxFactory = null;
    this.conversationContextManagerFactory = null;
  }

  /**
   * 获取注册表状态
   */
  getStatus(): {
    agents: AgentType[];
    hasSandbox: boolean;
    hasConversationContextManager: boolean;
  } {
    return {
      agents: this.getRegisteredAgentTypes(),
      hasSandbox: this.hasSandbox(),
      hasConversationContextManager: this.hasConversationContextManager(),
    };
  }
}

// ============================================================================
// 全局默认注册表
// ============================================================================

/**
 * 全局默认注册表实例
 */
export const defaultRegistry = new FactoryRegistry({
  allowOverride: true,
  useStubFallback: true,
});
