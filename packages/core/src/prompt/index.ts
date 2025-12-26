/**
 * Prompt 上下文工程模块（内部）
 *
 * 提供智能体上下文的管理、压缩、摘要和卸载功能
 *
 * 核心功能：
 * - 压缩（可逆）：移除大内容，保留恢复标识符
 * - 摘要（不可逆）：使用 LLM 生成结构化摘要
 * - 卸载：将大内容卸载到文件系统
 * - 缓存优化：提高 KV 缓存命中率
 * - 笔记系统：通过复述操控注意力
 *
 * @module prompt
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 消息类型
  ContextMessage,
  ContextMessageRole,
  MessageFormat,

  // 状态类型
  ContextState,
  ContextThresholds,

  // 压缩类型
  CompactionConfig,
  CompactionResult,
  ToolResultCompactionRule,

  // 摘要类型
  SummarizationConfig,
  SummarizationResult,
  StructuredSummary,

  // 卸载类型
  OffloadConfig,
  OffloadResult,

  // 缓存优化类型
  CacheOptimizationConfig,

  // 笔记系统类型
  TodoItem,
  TodoStatus,
  AgentNotes,

  // 管理器类型
  PromptContextConfig,
  IPromptContextEngine,
} from './types';

// ============================================================================
// Language utilities
// ============================================================================

export type { LanguageCode } from './language';
export { detectLanguageFromText, detectUserLanguage } from './language';

// ============================================================================
// 默认配置导出
// ============================================================================

export {
  DEFAULT_THRESHOLDS,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_SUMMARIZATION_CONFIG,
  MODEL_CONTEXT_LIMITS,
  createDefaultPromptConfig,
  createModelAwarePromptConfig,
  getModelContextLimit,
  computeModelAwareThresholds,
  validateThresholds,
} from './types';

// ============================================================================
// 核心管理器
// ============================================================================

export {
  PromptContextEngine,
  createPromptContextEngine,
  type PromptContextEngineDependencies,
} from './prompt-engine';

// ============================================================================
// 策略导出
// ============================================================================

export {
  CompactionStrategy,
  createCompactionStrategy,
  SummarizationStrategy,
  createSummarizationStrategy,
  DEFAULT_SUMMARY_SCHEMA,
  OffloadStrategy,
  createOffloadStrategy,
  type SummarizationLLMClient,
  type SummarizationLogger,
  type StructuredSummarySchema,
  type OffloadFileManager,
} from './strategies';

// ============================================================================
// 缓存优化
// ============================================================================

// 缓存类型
export type {
  ProviderCacheCapability,
  CacheControlType,
  CachedMessage,
  ICacheStrategy,
  LocalCacheConfig,
  CacheEntry,
  CacheMetrics,
} from './cache';

// 缓存配置和工具
export {
  DEFAULT_LOCAL_CACHE_CONFIG,
  createEmptyCacheMetrics,
  PROVIDER_CACHE_CAPABILITIES,
  getProviderCacheCapability,
  inferProviderFromModel,
  adaptMessages,
  LocalPromptCache,
  createLocalPromptCache,
  DefaultCacheStrategy,
  SmartCacheStrategy,
  createDefaultCacheStrategy,
  createSmartCacheStrategy,
  // 向后兼容
  PrefixOptimizer,
  createPrefixOptimizer,
  CACHE_BREAKPOINT_MARKER,
} from './cache';

// ============================================================================
// 自动上下文管理
// ============================================================================

export {
  AutoContextManager,
  SmartCompactionDecider,
  createAutoContextManager,
  createSmartCompactionDecider,
  DEFAULT_AUTO_CONTEXT_CONFIG,
  type AutoContextConfig,
  type AutoContextMetrics,
} from './auto-manager';

// ============================================================================
// 记忆系统
// ============================================================================

export { NoteManager, createNoteManager } from './memory';

// ============================================================================
// Token 估算器
// ============================================================================

export {
  type TokenEstimator,
  type TokenEstimatorType,
  SimpleTokenEstimator,
  CharacterBasedEstimator,
  CachedTokenEstimator,
  createTokenEstimator,
  defaultTokenEstimator,
  estimateTokens,
} from './token-estimator';

// ============================================================================
// 项目上下文
// ============================================================================

export {
  // 类型
  PROJECT_CONTEXT_FILES,
  type ContextLevel,
  type ProjectContextFile,
  type ProjectContext,
  type ProjectContextMetadata,
  type ProjectContextLoaderConfig,
  type ProjectContextConfig,
  DEFAULT_PROJECT_CONTEXT_CONFIG,
  // 类
  ProjectContextLoader,
  ProjectContextInjector,
  // 工厂函数
  createProjectContextLoader,
  createProjectContextInjector,
} from './project';
