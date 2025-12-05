/**
 * 工厂创建函数
 *
 * 提供 Agent、Sandbox、ContextManager 的创建方法
 */

import type {
  Agent,
  AgentType,
  AgentConfig,
  Sandbox,
  ContextManager,
  Config,
  ModelConfig,
} from '../types';
import { loadConfig } from '../config';
import {
  defaultRegistry,
  NotRegisteredError,
  type FactoryRegistry,
  type AgentFactoryOptions,
} from './registry';
import {
  createStubAgent,
  createStubSandbox,
  createStubContextManager,
} from './stubs';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Agent 创建选项
 */
export interface CreateAgentOptions extends AgentFactoryOptions {
  /** 自定义 ID（可选，默认自动生成） */
  id?: string;
  /** 使用的配置（可选，默认使用全局配置） */
  config?: Config;
  /** 使用的注册表（可选，默认使用全局注册表） */
  registry?: FactoryRegistry;
  /** 是否在未找到注册实现时使用 stub（默认 true） */
  useStub?: boolean;
}

/**
 * Sandbox 创建选项
 */
export interface CreateSandboxOptions {
  /** 自定义 ID（可选，默认自动生成） */
  id?: string;
  /** 使用的配置（可选，默认使用全局配置） */
  config?: Config;
  /** 使用的注册表（可选，默认使用全局注册表） */
  registry?: FactoryRegistry;
  /** 是否在未找到注册实现时使用 stub（默认 true） */
  useStub?: boolean;
}

/**
 * ContextManager 创建选项
 */
export interface CreateContextManagerOptions {
  /** 会话 ID（可选，默认自动生成） */
  sessionId?: string;
  /** 使用的配置（可选，默认使用全局配置） */
  config?: Config;
  /** 使用的注册表（可选，默认使用全局注册表） */
  registry?: FactoryRegistry;
  /** 是否在未找到注册实现时使用 stub（默认 true） */
  useStub?: boolean;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成唯一 ID
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 将 ModelConfig 转换为 AgentConfig
 */
function toAgentConfig(modelConfig: ModelConfig): AgentConfig {
  return {
    provider: modelConfig.provider,
    model: modelConfig.model,
    maxTokens: modelConfig.maxTokens,
  };
}

/**
 * 根据 Agent 类型获取模型配置
 */
function getAgentConfig(type: AgentType, config: Config): AgentConfig {
  switch (type) {
    case 'orchestrator':
      return toAgentConfig(config.models.orchestrator);
    case 'worker':
      return toAgentConfig(config.models.worker);
    case 'planner':
      return toAgentConfig(config.models.planner);
    case 'memory':
      // Memory Agent 使用 planner 配置作为默认
      return toAgentConfig(config.models.planner);
  }
}

// ============================================================================
// 全局配置缓存
// ============================================================================

let globalConfig: Config | null = null;

/**
 * 获取或加载全局配置
 */
function getGlobalConfig(): Config {
  if (globalConfig === null) {
    globalConfig = loadConfig();
  }
  return globalConfig;
}

/**
 * 设置全局配置
 */
export function setGlobalConfig(config: Config): void {
  globalConfig = config;
}

/**
 * 重置全局配置（强制下次重新加载）
 */
export function resetGlobalConfig(): void {
  globalConfig = null;
}

// ============================================================================
// 创建函数
// ============================================================================

/**
 * 创建 Agent
 *
 * @param type - Agent 类型
 * @param options - 创建选项
 * @returns Agent 实例
 *
 * @example
 * ```ts
 * // 创建 orchestrator agent
 * const agent = createAgent('orchestrator');
 *
 * // 使用自定义配置
 * const agent = createAgent('worker', {
 *   config: customConfig,
 *   id: 'custom-worker-1'
 * });
 * ```
 */
export function createAgent(
  type: AgentType,
  options: CreateAgentOptions = {}
): Agent {
  const {
    id = generateId(type),
    config = getGlobalConfig(),
    registry = defaultRegistry,
    useStub = true,
    ...factoryOptions
  } = options;

  // 获取对应类型的模型配置
  const agentConfig = getAgentConfig(type, config);

  // 尝试从注册表获取工厂
  const factory = registry.getAgentFactory(type);

  if (factory) {
    return factory(id, agentConfig, factoryOptions);
  }

  // 如果允许使用 stub，返回 stub 实现
  if (useStub) {
    return createStubAgent(id, type, agentConfig);
  }

  // 否则抛出错误
  throw new NotRegisteredError(type, 'Agent');
}

/**
 * 创建 Sandbox
 *
 * @param options - 创建选项
 * @returns Sandbox 实例
 *
 * @example
 * ```ts
 * // 创建沙盒
 * const sandbox = createSandbox();
 *
 * // 使用自定义配置
 * const sandbox = createSandbox({
 *   config: customConfig,
 *   id: 'custom-sandbox-1'
 * });
 * ```
 */
export function createSandbox(options: CreateSandboxOptions = {}): Sandbox {
  const {
    id = generateId('sandbox'),
    config = getGlobalConfig(),
    registry = defaultRegistry,
    useStub = true,
  } = options;

  // 尝试从注册表获取工厂
  const factory = registry.getSandboxFactory();

  if (factory) {
    return factory(id, config.sandbox);
  }

  // 如果允许使用 stub，返回 stub 实现
  if (useStub) {
    return createStubSandbox(id, config.sandbox);
  }

  // 否则抛出错误
  throw new NotRegisteredError('sandbox', 'Sandbox');
}

/**
 * 创建 ContextManager
 *
 * @param options - 创建选项
 * @returns ContextManager 实例
 *
 * @example
 * ```ts
 * // 创建上下文管理器
 * const contextManager = createContextManager();
 *
 * // 使用自定义会话 ID
 * const contextManager = createContextManager({
 *   sessionId: 'session-123'
 * });
 * ```
 */
export function createContextManager(
  options: CreateContextManagerOptions = {}
): ContextManager {
  const {
    sessionId = generateId('session'),
    config = getGlobalConfig(),
    registry = defaultRegistry,
    useStub = true,
  } = options;

  // 尝试从注册表获取工厂
  const factory = registry.getContextManagerFactory();

  if (factory) {
    return factory(sessionId, config.context);
  }

  // 如果允许使用 stub，返回 stub 实现
  if (useStub) {
    return createStubContextManager(sessionId, config.context);
  }

  // 否则抛出错误
  throw new NotRegisteredError('contextManager', 'ContextManager');
}

// ============================================================================
// 便捷创建函数
// ============================================================================

/**
 * 创建 Orchestrator Agent
 */
export function createOrchestrator(options?: Omit<CreateAgentOptions, 'type'>): Agent {
  return createAgent('orchestrator', options);
}

/**
 * 创建 Worker Agent
 */
export function createWorker(options?: Omit<CreateAgentOptions, 'type'>): Agent {
  return createAgent('worker', options);
}

/**
 * 创建 Planner Agent
 */
export function createPlanner(options?: Omit<CreateAgentOptions, 'type'>): Agent {
  return createAgent('planner', options);
}

/**
 * 创建 Memory Agent
 */
export function createMemoryAgent(options?: Omit<CreateAgentOptions, 'type'>): Agent {
  return createAgent('memory', options);
}

