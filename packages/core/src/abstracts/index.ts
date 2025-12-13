/**
 * 抽象基类模块入口
 *
 * 导出 Agent、Sandbox、ConversationContextManager 的抽象基类
 */

// Agent 抽象基类
export {
  BaseAgent,
  type AgentState,
  type AgentLifecycleHooks,
  type AgentLogContext,
} from './base-agent';

// Sandbox 抽象基类
export {
  BaseSandbox,
  type SandboxLifecycleHooks,
  type SandboxLogContext,
} from './base-sandbox';

// ConversationContextManager 抽象基类
export {
  BaseConversationContextManager,
  SimpleConversationContextManager,
  defaultTokenEstimator,
  type ConversationContextManagerHooks,
  type ConversationContextManagerLogContext,
  type TokenEstimator,
  type ConversationContextManagerOptions,
} from './base-conversation-context-manager';

