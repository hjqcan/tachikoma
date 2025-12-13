/**
 * 缓存模块
 *
 * 提供 Provider-Agnostic 的 Prompt 缓存能力
 *
 * @module prompt/cache
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  ProviderCacheCapability,
  CacheControlType,
  CachedMessage,
  ICacheStrategy,
  LocalCacheConfig,
  CacheEntry,
  CacheMetrics,
} from './types';

export {
  DEFAULT_LOCAL_CACHE_CONFIG,
  createEmptyCacheMetrics,
} from './types';

// ============================================================================
// Provider 适配器
// ============================================================================

export {
  PROVIDER_CACHE_CAPABILITIES,
  getProviderCacheCapability,
  inferProviderFromModel,
  adaptMessages,
  adaptForAnthropic,
  adaptForOpenAI,
  adaptForGoogle,
  adaptForGeneric,
} from './provider-adapters';

// ============================================================================
// 本地缓存
// ============================================================================

export {
  LocalPromptCache,
  createLocalPromptCache,
} from './local-cache';

// ============================================================================
// 缓存策略
// ============================================================================

export {
  DefaultCacheStrategy,
  SmartCacheStrategy,
  createDefaultCacheStrategy,
  createSmartCacheStrategy,
  type DefaultCacheStrategyOptions,
  type SmartCacheStrategyOptions,
} from './strategies';

// ============================================================================
// 前缀优化器（向后兼容）
// ============================================================================

export {
  PrefixOptimizer,
  createPrefixOptimizer,
  CACHE_BREAKPOINT_MARKER,
} from './prefix-optimizer';
