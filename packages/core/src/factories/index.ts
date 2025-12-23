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

// 内置实现注册
export { registerBuiltInFactories } from './builtins';

// 默认注册内置实现（允许外部覆盖）
import { defaultRegistry } from './registry';
import { registerBuiltInFactories } from './builtins';
registerBuiltInFactories(defaultRegistry);