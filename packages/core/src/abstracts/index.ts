/**
 * 抽象基类模块入口
 *
 * 导出 Agent、Sandbox、ContextManager 的抽象基类
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

// ContextManager 抽象基类
export {
  BaseContextManager,
  SimpleContextManager,
  defaultTokenEstimator,
  type ContextManagerHooks,
  type ContextManagerLogContext,
  type TokenEstimator,
  type ContextManagerOptions,
} from './base-context-manager';


