/**
 * 工厂模块入口
 *
 * 导出工厂注册表、创建函数和 stub 实现
 */

// 注册表
export {
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
} from './registry';

// 创建函数
export {
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
} from './creators';

// Stub 实现
export {
  StubAgent,
  StubSandbox,
  StubContextManager,
  createStubAgent,
  createStubSandbox,
  createStubContextManager,
} from './stubs';

