/**
 * @tachikoma/core
 *
 * Tachikoma 核心库 - 提供智能体、上下文管理、工具、沙盒、MCP 集成等核心功能
 *
 * @packageDocumentation
 */

// 版本信息
export const VERSION = '0.1.0';

// ============================================================================
// 类型导出
// ============================================================================

export * from './types';

// ============================================================================
// 配置模块
// ============================================================================

export {
  // 默认配置
  DEFAULT_CONFIG,
  DEFAULT_ORCHESTRATOR_MODEL,
  DEFAULT_WORKER_MODEL,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_CONTEXT_THRESHOLDS,
  DEFAULT_SANDBOX_CONFIG,
  DEFAULT_AGENTOPS_CONFIG,
  // 配置加载
  loadConfig,
  loadFromEnv,
  validateConfig,
  deepMerge,
  createConfigBuilder,
  ConfigBuilder,
  ConfigValidationError,
  type ConfigOverrides,
  type DeepPartial,
} from './config';

// ============================================================================
// 工厂模块
// ============================================================================

export {
  // 注册表
  FactoryRegistry,
  defaultRegistry,
  RegistryError,
  NotRegisteredError,
  DuplicateRegistrationError,
  type AgentFactory,
  type AgentFactoryOptions,
  type SandboxFactory,
  type ContextManagerFactory,
  type RegistryConfig,
  // 创建函数
  createAgent,
  createSandbox,
  createContextManager,
  createOrchestrator,
  createWorker,
  createPlanner,
  createMemoryAgent,
  setGlobalConfig,
  resetGlobalConfig,
  type CreateAgentOptions,
  type CreateSandboxOptions,
  type CreateContextManagerOptions,
  // Stub 实现
  StubAgent,
  StubSandbox,
  StubContextManager,
  createStubAgent,
  createStubSandbox,
  createStubContextManager,
} from './factories';

// ============================================================================
// 抽象基类模块
// ============================================================================

export {
  // Agent 基类
  BaseAgent,
  type AgentState,
  type AgentLifecycleHooks,
  type AgentLogContext,
  // Sandbox 基类
  BaseSandbox,
  type SandboxLifecycleHooks,
  type SandboxLogContext,
  // ContextManager 基类
  BaseContextManager,
  SimpleContextManager,
  type ContextManagerHooks,
  type ContextManagerLogContext,
} from './abstracts';

// ============================================================================
// TODO: 后续添加以下模块导出
// ============================================================================

// export * from './agents';      // 具体智能体实现
// export * from './context';     // 上下文管理实现
// export * from './tools';       // 原子工具实现
// export * from './sandbox';     // 沙盒实现
// export * from './mcp';         // MCP 集成
