/**
 * Worker 模块入口
 *
 * 导出 Worker Backend 相关类型、工厂函数和实现
 */

// 类型导出
export type {
  // 后端类型
  WorkerBackendType,
  WorkerCapability,
  WorkerStatus,
  // 消息类型
  WorkerMessage,
  WorkerThinkingMessage,
  WorkerToolCallMessage,
  WorkerToolResultMessage,
  WorkerOutputMessage,
  WorkerErrorMessage,
  WorkerStatusMessage,
  WorkerApprovalRequestMessage,
  // 任务类型
  WorkerTask,
  // 选项类型
  WorkerExecutionOptions,
  // 配置类型
  WorkerBackendConfig,
  WorkerBackendBaseConfig,
  ClaudeAgentSDKBackendConfig,
  GenericBackendConfig,
  // 接口
  IWorkerBackend,
  // 结果类型
  WorkerExecutionMetrics,
  WorkerExecutionResult,
} from './types';

// 工具函数导出
export {
  createWorkerMessage,
  isClaudeProvider,
  shouldUseAgentSDK,
} from './types';

// 工厂函数导出
export {
  createWorkerBackend,
  createWorkerBackendSync,
  getBackendInfo,
  isAgentSDKInstalled,
  WorkerBackendError,
  AgentSDKNotInstalledError,
} from './backend-factory';
export type { WorkerBackendInfo } from './backend-factory';

// 后端实现导出
export { ClaudeAgentSDKBackend } from './backends/claude-agent-backend';
export { GenericAgentBackend, GenericBackendError } from './backends/generic-agent-backend';
