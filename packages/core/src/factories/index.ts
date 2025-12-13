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
  type ConversationContextManagerFactory,
  type RegistryConfig,
} from './registry';

// 创建函数
export {
  createAgent,
  createSandbox,
  createRegisteredConversationContextManager,
  createOrchestrator,
  createWorker,
  createPlanner,
  createMemoryAgent,
  setGlobalConfig,
  resetGlobalConfig,
  type CreateAgentOptions,
  type CreateSandboxOptions,
  type CreateConversationContextManagerOptions,
} from './creators';

// Stub 实现
export {
  StubAgent,
  StubSandbox,
  StubConversationContextManager,
  createStubAgent,
  createStubSandbox,
  createStubConversationContextManager,
} from './stubs';
