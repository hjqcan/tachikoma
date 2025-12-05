/**
 * 工厂注册表
 *
 * 提供可扩展的依赖注入和实现注册机制
 */

import type {
  Agent,
  AgentType,
  AgentConfig,
  Sandbox,
  SandboxConfig,
  ContextManager,
  ContextThresholds,
} from '../types';

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
  contextManager?: ContextManager;
  /** 沙盒实例 */
  sandbox?: Sandbox;
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
 * ContextManager 创建函数类型
 */
export type ContextManagerFactory = (
  sessionId: string,
  thresholds: ContextThresholds
) => ContextManager;

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
 * 管理 Agent、Sandbox、ContextManager 的工厂函数注册
 */
export class FactoryRegistry {
  private agentFactories = new Map<AgentType, AgentFactory>();
  private sandboxFactory: SandboxFactory | null = null;
  private contextManagerFactory: ContextManagerFactory | null = null;
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
  // ContextManager 注册
  // ==========================================================================

  /**
   * 注册 ContextManager 工厂
   * @param factory - 创建函数
   */
  registerContextManager(factory: ContextManagerFactory): void {
    if (this.contextManagerFactory !== null && !this.config.allowOverride) {
      throw new DuplicateRegistrationError('contextManager', 'ContextManager');
    }
    this.contextManagerFactory = factory;
  }

  /**
   * 注销 ContextManager 工厂
   */
  unregisterContextManager(): boolean {
    if (this.contextManagerFactory === null) return false;
    this.contextManagerFactory = null;
    return true;
  }

  /**
   * 检查 ContextManager 工厂是否已注册
   */
  hasContextManager(): boolean {
    return this.contextManagerFactory !== null;
  }

  /**
   * 获取 ContextManager 工厂
   */
  getContextManagerFactory(): ContextManagerFactory | null {
    return this.contextManagerFactory;
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
    this.contextManagerFactory = null;
  }

  /**
   * 获取注册表状态
   */
  getStatus(): {
    agents: AgentType[];
    hasSandbox: boolean;
    hasContextManager: boolean;
  } {
    return {
      agents: this.getRegisteredAgentTypes(),
      hasSandbox: this.hasSandbox(),
      hasContextManager: this.hasContextManager(),
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

