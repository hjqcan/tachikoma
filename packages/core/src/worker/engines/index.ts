/**
 * Worker Engines Module
 *
 * 提供 GenericAgentBackend 使用的引擎模块
 */

// Progress Tracking
export {
  ProgressTracker,
  type RoundProgress,
  type DegradationLevel,
  type ProgressTrackerConfig,
  type ProgressDiagnostics,
  DEFAULT_PROGRESS_TRACKER_CONFIG,
  simpleHash,
} from './progress-tracker';

// Tool Call Parsing
export {
  type ParsedToolCall,
  type ClassifiedToolCalls,
  type ToolClassificationConfig,
  type ConcurrencyLimiter,
  MAX_CALLS_PER_RESPONSE,
  DEFAULT_PARALLELIZABLE_TOOLS,
  parseToolCalls,
  parseFunctionCalls,
  containsToolCall,
  classifyToolCalls,
  createConcurrencyLimiter,
} from './tool-call-parser';

// Tool Execution
export {
  type ToolExecutionResult,
  type ParallelExecutionConfig,
  type ToolExecutorCallbacks,
  type ToolExecutorEvent,
  executeParallel,
  executeSequential,
  executeSequentialGenerator,
  filterApprovalRequired,
  computeExecutionStats,
} from './tool-executor';

// Context Helpers
export {
  type LLMMessageFormat,
  createUserMessage,
  createAssistantMessage,
  createToolMessage,
  createSystemMessage,
  contextToLLMMessages,
  filterUserAssistantMessages,
  estimateMessageTokens,
  estimateTotalTokens,
  resetMessageIdCounter,
} from './context-helpers';

// Tool Schema (AI SDK v6 Zod integration)
export {
  type AITool,
  jsonSchemaToZod,
  convertToolToAITool,
  convertToolsToAITools,
  getToolZodSchema,
} from './tool-schema';

// Memory Retriever
export {
  MemoryRetriever,
  type MemoryRetrieverConfig,
  type MemoryRetrieverCallbacks,
  type MemoryRetrievalResultLocal as MemoryEngineRetrievalResult,
  createMemoryRetriever,
} from './memory-retriever';

// LLM Executor
export {
  LLMExecutor,
  createLLMExecutor,
  isRetryableError,
  DEFAULT_LLM_EXECUTOR_CONFIG,
  type LLMExecutorConfig,
} from './llm-executor';

// Skills Manager
export {
  SkillsManager,
  createSkillsManager,
} from './skills-manager';

// Interaction Engine
export {
  InteractionEngine,
} from './interaction-engine';
