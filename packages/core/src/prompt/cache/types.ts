/**
 * Provider-Agnostic 缓存类型定义
 *
 * 支持多种 LLM Provider（Anthropic/OpenAI/Google）的缓存策略
 *
 * @module prompt/cache/types
 */

import type { ContextMessage } from '../types';

// ============================================================================
// Provider 缓存能力
// ============================================================================

/**
 * Provider 缓存能力描述
 */
export interface ProviderCacheCapability {
  /** Provider 名称 */
  readonly provider: string;

  /** 是否支持原生 prompt caching */
  readonly supportsNativeCache: boolean;

  /**
   * 缓存控制字段名
   *
   * - Anthropic: 'cache_control'
   * - Google: 'cached_content'
   * - OpenAI: undefined (自动处理)
   */
  readonly cacheControlField?: string | undefined;

  /** 缓存 TTL（秒），0 表示不限制 */
  readonly cacheTTL: number;

  /** 是否支持缓存计费统计 */
  readonly supportsCacheMetrics: boolean;

  /** 是否支持扩展 TTL（付费） */
  readonly supportsExtendedTTL?: boolean;

  /** 最大可缓存 token 数 */
  readonly maxCacheableTokens?: number;
}

/**
 * 缓存控制类型
 */
export type CacheControlType = 'ephemeral' | 'persistent' | 'none';

/**
 * 带缓存标记的消息
 */
export interface CachedMessage extends ContextMessage {
  /**
   * Provider 特定的缓存控制
   *
   * 例如 Anthropic: { type: 'ephemeral' }
   */
  cacheControl?: {
    type: CacheControlType;
    [key: string]: unknown;
  } | undefined;

  /** 是否建议缓存此消息（用于本地决策） */
  shouldCache?: boolean;

  /** 预估的 token 数量 */
  estimatedTokens?: number;
}

// ============================================================================
// 缓存策略接口
// ============================================================================

/**
 * 缓存策略接口
 */
export interface ICacheStrategy {
  /** 策略名称 */
  readonly name: string;

  /**
   * 准备缓存控制
   *
   * 根据 Provider 能力，为消息添加缓存标记
   *
   * @param messages - 原始消息列表
   * @param capability - Provider 缓存能力
   * @returns 带缓存标记的消息列表
   */
  prepareCacheControl(
    messages: ContextMessage[],
    capability: ProviderCacheCapability
  ): CachedMessage[];

  /**
   * 计算缓存键
   *
   * 用于本地缓存的唯一标识
   *
   * @param messages - 消息列表
   * @returns 缓存键（hash）
   */
  computeCacheKey(messages: ContextMessage[]): string;

  /**
   * 估算缓存命中率
   *
   * 基于前后消息的前缀稳定性估算
   *
   * @param previousKey - 上次缓存键
   * @param currentKey - 当前缓存键
   * @returns 估算的命中率 (0-1)
   */
  estimateHitRate(previousKey: string | null, currentKey: string): number;
}

// ============================================================================
// 本地缓存类型
// ============================================================================

/**
 * 本地缓存配置
 */
export interface LocalCacheConfig {
  /** 最大缓存条目数 */
  maxSize: number;

  /** 缓存 TTL（毫秒） */
  ttlMs: number;

  /** 是否启用摘要缓存 */
  enableSummaryCache: boolean;

  /** 是否启用压缩结果缓存 */
  enableCompactionCache: boolean;

  /** 是否启用 token 估算缓存 */
  enableTokenCache: boolean;
}

/**
 * 默认本地缓存配置
 */
export const DEFAULT_LOCAL_CACHE_CONFIG: LocalCacheConfig = {
  maxSize: 100,
  ttlMs: 5 * 60 * 1000, // 5 分钟
  enableSummaryCache: true,
  enableCompactionCache: true,
  enableTokenCache: true,
};

/**
 * 缓存条目
 */
export interface CacheEntry<T> {
  /** 缓存值 */
  value: T;

  /** 创建时间 */
  createdAt: number;

  /** 过期时间 */
  expiresAt: number;

  /** 访问次数 */
  accessCount: number;

  /** 最后访问时间 */
  lastAccessedAt: number;
}

// ============================================================================
// 缓存指标
// ============================================================================

/**
 * 缓存指标
 */
export interface CacheMetrics {
  /** 本地缓存命中率 */
  localHitRate: number;

  /** Provider 缓存估算命中率 */
  providerHitRateEstimate: number;

  /** 本地缓存大小 */
  localCacheSize: number;

  /** 本地缓存命中次数 */
  localHits: number;

  /** 本地缓存未命中次数 */
  localMisses: number;

  /** 估算节省的 token 数 */
  estimatedTokensSaved: number;

  /** 估算节省的成本（美元） */
  estimatedCostSaved: number;
}

/**
 * 创建空的缓存指标
 */
export function createEmptyCacheMetrics(): CacheMetrics {
  return {
    localHitRate: 0,
    providerHitRateEstimate: 0,
    localCacheSize: 0,
    localHits: 0,
    localMisses: 0,
    estimatedTokensSaved: 0,
    estimatedCostSaved: 0,
  };
}
