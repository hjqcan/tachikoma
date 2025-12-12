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
  createRegisteredContextManager,
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
// 统筹者模块
// ============================================================================

export * from './orchestrator';

// ============================================================================
// 规划器模块
// ============================================================================

export * from './planner';

// ============================================================================
// 沙盒模块
// ============================================================================

export * as sandbox from './sandbox';

// 同时导出常用类型到顶层（便于使用）
export type {
  SandboxRuntime,
  SandboxCreateOptions,
} from './sandbox';

export {
  createSandboxConfig,
  DEFAULT_SANDBOX_RESOURCES,
  DEFAULT_SANDBOX_NETWORK,
} from './sandbox';

// 注意：BaseSandbox 已在 abstracts 导出中包含
// 但 sandbox 模块中的版本更完善，推荐使用 sandbox.BaseSandbox

// ============================================================================
// 可观测性模块
// ============================================================================

export * as observability from './observability';

// 常用类型顶层导出
export type {
  Logger,
  Tracer,
  Span,
  MetricsCollector,
  LogContext,
  LogLevel,
  SpanOptions,
  MetricsSnapshot,
} from './observability';

export {
  // Logger
  ConsoleLogger,
  NoopLogger,
  createLogger,
  defaultLogger,
  noopLogger,
  // Tracer
  NoopTracer,
  ConsoleTracer,
  createTracer,
  defaultTracer,
  // Metrics
  MemoryMetrics,
  NoopMetrics,
  createMetrics,
  defaultMetrics,
  noopMetrics,
  // 组合工厂
  createObservability,
  noopObservability,
  // 预定义指标
  WORKER_METRICS,
  SANDBOX_METRICS,
} from './observability';

// ============================================================================
// Worker 模块
// ============================================================================

export * as worker from './worker';

// 常用 Worker 类型顶层导出
export type {
  WorkerBackendType,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
  WorkerExecutionResult,
  IWorkerBackend,
} from './worker';

export {
  WorkerExecutor,
  createWorkerExecutor,
  createWorkerBackend,
  GenericAgentBackend,
  isKeyDecision,
  DEFAULT_RISK_POLICY,
  DEFAULT_RESOURCE_LIMITS,
} from './worker';

// ============================================================================
// Tools 模块
// ============================================================================

export * as tools from './tools';

// 常用 Tools 类型顶层导出
export type {
  ToolResult,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  FileWriteOutput,
  FileListInput,
  FileListOutput,
  ShellRunInput,
  ShellRunOutput,
  CodeSearchInput,
  CodeSearchOutput,
} from './tools';

export {
  coreTools,
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
  getToolByName,
  getToolNames,
  getToolDefinitions,
} from './tools';

// ============================================================================
// MVP 模块
// ============================================================================

export * as mvp from './mvp';

export type {
  MVPRunnerConfig,
  ProgressCallback,
  RunMetrics,
} from './mvp';

export {
  MVPRunner,
  runMVP,
} from './mvp';

// ============================================================================
// 多轮对话模块
// ============================================================================

export * as conversation from './conversation';

export type {
  ConversationalRunnerConfig,
  SessionState,
  StreamEvent,
  ConversationMessage,
  ExecutionSummary,
  Checkpoint,
  IntentAnalysisResult,
  FeedbackAnalysisResult,
} from './conversation';

export {
  ConversationalRunner,
  SessionStore,
  IntentAnalyzer,
  FeedbackLoop,
  ConversationContextManager,
  UserIntent,
  FeedbackAction,
} from './conversation';

// ============================================================================
// MCP 模块
// ============================================================================

export * as mcp from './mcp';

// 常用 MCP 类型顶层导出
export type {
  MCPServerConfig,
  MCPCallMode,
  MCPToolInfo,
  MCPToolCallResult,
  MCPConfig,
  MCPCallOptions,
  MCPRouterConfig,
  MCPToolRegistrarConfig,
} from './mcp';

export {
  MCPClientManager,
  MCPModeRouter,
  MCPToolRegistrar,
  ToolDiscovery,
  loadMCPConfig,
  parseStandardMCPConfig,
  createMCPModeRouter,
  createMCPToolRegistrar,
  createToolDiscovery,
} from './mcp';

// ============================================================================
// 上下文工程模块 (Task 8)
// ============================================================================

export * as context from './context';

// 常用 Context 类型顶层导出
export type {
  ContextMessage,
  ContextState,
  ContextThresholds,
  ContextManagerConfig,
  IContextManager,
  CompactionResult,
  SummarizationResult,
  StructuredSummary,
  AgentNotes,
} from './context';

export {
  // 上下文管理器核心类
  ContextManager,
  createContextManager,
  createDefaultContextConfig,
  createModelAwareConfig,
  DEFAULT_THRESHOLDS,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_SUMMARIZATION_CONFIG,
  MODEL_CONTEXT_LIMITS,
  getModelContextLimit,
  computeModelAwareThresholds,
  validateThresholds,
  NoteManager,
  createNoteManager,
  PrefixOptimizer,
  createPrefixOptimizer,
  // Token 估算
  SimpleTokenEstimator,
  CharacterBasedEstimator,
  CachedTokenEstimator,
  createTokenEstimator,
  defaultTokenEstimator,
  estimateTokens,
} from './context';

// Token 估算类型导出
export type { TokenEstimator, TokenEstimatorType } from './context';

// ============================================================================
// Skills 模块
// ============================================================================

export * as skills from './skills';

// 常用 Skills 类型顶层导出
export type {
  SkillMetadata,
  SkillContent,
  SkillError,
  SkillLoadOutcome,
  SkillDiscoveryConfig,
  SkillExecutionOptions,
  SkillExecutionResult,
} from './skills';

export {
  loadSkills,
  loadSkillContent,
  parseSkillFile,
  renderSkillsSection,
  renderSkillContentPrompt,
  executeSkillScript,
  hasExecutableScripts,
  listSkillScripts,
  SKILL_FILENAME,
  DEFAULT_GLOBAL_SKILLS_DIR,
} from './skills';

// ============================================================================
// Memory 模块 (Task 9)
// ============================================================================

export * as memory from './memory';

// 常用 Memory 类型顶层导出
export type {
  MemoryScope,
  MemoryEntry,
  MemoryRetrievalResult,
  MemoryProvider,
  EmbeddingService,
  MemoryConfig,
} from './memory';

export {
  MemoryService,
  InMemoryMemoryProvider,
  OpenRouterEmbeddingService,
  MockEmbeddingService,
} from './memory';
