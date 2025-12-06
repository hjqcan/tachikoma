/**
 * 统筹者智能体模块
 *
 * 提供统筹者（Orchestrator）智能体、规划器（Planner）、Worker 池等核心功能
 *
 * @packageDocumentation
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 统筹者任务类型
  OrchestratorTask,
  SubTask,
  SubTaskStatus,
  PlanStatus,
  // 规划器类型
  PlannerInput,
  PlannerOutput,
  ContextConstraints,
  PlannerPreferences,
  ExecutionPlan,
  ExecutionStep,
  // Worker 池类型
  WorkerInfo,
  WorkerStatus,
  WorkerLoad,
  WorkerPoolConfig,
  WorkerSelectionStrategy,
  // 委托与通信类型
  WorkerMessageType,
  WorkerMessage,
  AssignPayload,
  ProgressPayload,
  CompletePayload,
  ErrorPayload,
  // 结果聚合类型
  AggregationStrategy,
  AggregationConfig,
  AggregatedResult,
  // 检查点与恢复类型
  CheckpointState,
  SubTaskSnapshot,
  CheckpointConfig,
  LongRunningTaskFiles,
  // 配置类型
  OrchestratorConfig,
  PlannerConfig,
  DelegationDefaults,
  // 事件类型
  OrchestratorEventType,
  OrchestratorEvent,
  OrchestratorEventHandler,
} from './types';

// ============================================================================
// 配置导出
// ============================================================================

export {
  // 默认配置
  DEFAULT_RETRY_POLICY,
  CONSERVATIVE_RETRY_POLICY,
  AGGRESSIVE_RETRY_POLICY,
  DEFAULT_WORKER_POOL_CONFIG,
  HIGH_CONCURRENCY_WORKER_POOL_CONFIG,
  DEFAULT_DELEGATION_DEFAULTS,
  DEFAULT_AGGREGATION_CONFIG,
  DEFAULT_CHECKPOINT_CONFIG,
  GIT_ENABLED_CHECKPOINT_CONFIG,
  DEFAULT_PLANNER_CONFIG,
  DEFAULT_ORCHESTRATOR_CONFIG,
  // 配置构建器
  createOrchestratorConfig,
  type PartialOrchestratorConfig,
  // 配置验证
  validateOrchestratorConfig,
  OrchestratorConfigError,
  // 工具函数
  calculateRetryDelay,
  shouldRetry,
} from './config';

// ============================================================================
// Worker 池导出
// ============================================================================

export {
  // 接口与类型
  type IWorkerPool,
  type WorkerPoolEvent,
  type WorkerPoolEventType,
  type WorkerPoolEventHandler,
  type AssignmentResult,
  type MockWorkerPoolOptions,
  type MockTaskExecutor,
  // 实现类
  DefaultWorkerPool,
  MockWorkerPool,
  // 工厂函数
  createWorkerPool,
  createMockWorkerPool,
} from './worker-pool';

// ============================================================================
// Session 文件管理导出
// ============================================================================

export {
  // 类型
  type SessionConfig,
  type PlanFile,
  type ProgressFile,
  type DecisionType,
  type DecisionRecord,
  type WorkerStatusFile,
  type ThinkingRecord,
  type ActionType,
  type ActionRecord,
  type ApprovalRequestType,
  type PendingApprovalFile,
  type ApprovalResponseFile,
  type InterventionType,
  type InterventionFile,
  type SharedContextFile,
  type MessageDirection,
  type MessageRecord,
  type SessionFileEventType,
  type SessionFileEvent,
  type SessionFileEventHandler,
  type ISessionFileManager,
  // 常量
  DEFAULT_SESSION_CONFIG,
  // 类
  SessionFileManager,
  SessionPathBuilder,
  FileLock,
  // 工厂函数
  createSessionFileManager,
  createAndInitializeSessionFileManager,
  // 工具函数
  generateId,
  generateTimestampId,
  atomicWriteFile,
  atomicWriteJson,
  appendJsonlRecord,
  readJsonlRecords,
  readJsonlTail,
  readJsonFile,
  ensureDir,
  fileExists,
  safeDeleteFile,
  removeDir,
  listDir,
  getFileStats,
  withFileLock,
  sleep,
  now,
} from './session';

// ============================================================================
// Orchestrator 导出
// ============================================================================

export {
  // Orchestrator 类
  Orchestrator,
  // 工厂函数
  createOrchestrator,
  // 类型
  type OrchestratorOptions,
} from './orchestrator';

// ============================================================================
// TODO: 后续导出实现模块
// ============================================================================

// export { CheckpointManager } from './checkpoint';
// export { CommunicationDelegation } from './delegation/communication';
