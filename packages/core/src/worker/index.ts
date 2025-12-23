/**
 * Worker 模块入口
 *
 * 导出 Worker Backend 相关类型、工厂函数和实现
 */

// 类型导出
export type {
  // 后端类型
  WorkerBackendType,
  WorkerBackend,
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
  OpenAIAgentsBackendConfig,
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
  isOpenAIProvider,
  shouldUseOpenAIAgents,
} from './types';

// 工厂函数导出
export {
  createWorkerBackend,
  createWorkerBackendSync,
  getBackendInfo,
  isAgentSDKInstalled,
  isOpenAIAgentsSDKInstalled,
  WorkerBackendError,
  AgentSDKNotInstalledError,
  OpenAIAgentsSDKNotInstalledError,
} from './backend-factory';
export type { WorkerBackendInfo } from './backend-factory';

// 后端实现导出
export { ClaudeAgentSDKBackend } from './backends/claude-agent-backend';
export { GenericAgentBackend, GenericBackendError } from './backends/generic-agent-backend';
export { OpenAIAgentsBackend } from './backends/openai-agent-backend';
export { BaseWorkerBackend } from './backends/base-backend';

// 执行器导出
export { WorkerExecutor, createWorkerExecutor } from './worker-executor';
export type { WorkerExecutorConfig, ExecutionResult } from './worker-executor';

// 类型重导出
export type { RiskPolicy, ResourceLimits, KeyDecisionPolicy, KeyDecisionTriggers, ApprovalCategory, InterventionFile, ParallelExecutionConfig } from './types';
export { 
  DEFAULT_RISK_POLICY, 
  DEFAULT_RESOURCE_LIMITS, 
  DEFAULT_KEY_DECISION_POLICY, 
  DEFAULT_KEY_DECISION_TRIGGERS,
  // 并行执行配置 (FAS)
  PARALLELIZABLE_TOOLS,
  SEQUENTIAL_TOOLS,
  DEFAULT_PARALLEL_EXECUTION_CONFIG,
} from './types';

// 关键决策检测
export type { KeyDecisionResult, RiskLevel } from './key-decision';
export { isKeyDecision, isDeleteOperation, isLargeModification, isMultiFileOperation, isExternalApiCall, isHighRiskTool, getRiskScore } from './key-decision';

// 工具调用追踪器（防循环）
export { ToolCallTracker } from './tool-call-tracker';
export type { TrackedCall, FailurePattern, DuplicateCheckResult, ToolCallTrackerConfig, TrackerMetrics } from './tool-call-tracker';

// 工具输入验证器（参数预检）
export { validateToolInput, generateValidationError } from './tool-input-validator';
export type { ValidationResult, JSONSchemaDefinition } from './tool-input-validator';

// 失败记忆系统（上下文注入）
export { FailureMemory } from './failure-memory';
export type { DetectedPattern, FailureMemoryConfig, FailurePatternType } from './failure-memory';

// 工作区结构缓存（上下文注入）
export { WorkspaceStructureCache, parseFileListOutput } from './workspace-cache';
export type { CachedDirectory, WorkspaceCacheConfig } from './workspace-cache';