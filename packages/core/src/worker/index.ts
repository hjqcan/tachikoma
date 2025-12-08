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

// 执行器导出
export { WorkerExecutor, createWorkerExecutor } from './worker-executor';
export type { WorkerExecutorConfig, ExecutionResult } from './worker-executor';

// 类型重导出
export type { RiskPolicy, ResourceLimits, KeyDecisionPolicy, KeyDecisionTriggers, ApprovalCategory, InterventionFile } from './types';
export { DEFAULT_RISK_POLICY, DEFAULT_RESOURCE_LIMITS, DEFAULT_KEY_DECISION_POLICY, DEFAULT_KEY_DECISION_TRIGGERS } from './types';

// 关键决策检测
export type { KeyDecisionResult, RiskLevel } from './key-decision';
export { isKeyDecision, isDeleteOperation, isLargeModification, isMultiFileOperation, isExternalApiCall, isHighRiskTool, getRiskScore } from './key-decision';
