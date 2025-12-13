/**
 * 本地 Prompt 缓存
 *
 * 提供 Provider 无关的本地缓存层，用于：
 * - 缓存已计算的摘要结果
 * - 缓存 token 估算结果
 * - 缓存压缩后的上下文
 *
 * @module prompt/cache/local-cache
 */

import type { ContextMessage, StructuredSummary } from '../types';
import type {
  CacheEntry,
  LocalCacheConfig,
  CacheMetrics,
} from './types';
import { DEFAULT_LOCAL_CACHE_CONFIG, createEmptyCacheMetrics } from './types';

// ============================================================================
// 本地缓存实现
// ============================================================================

/**
 * 本地 Prompt 缓存
 *
 * 即使 Provider 不支持原生缓存，也可以：
 * 1. 缓存已计算的摘要结果（避免重复 LLM 调用）
 * 2. 缓存 token 估算结果（避免重复计算）
 * 3. 缓存压缩后的上下文（避免重复压缩）
 */
export class LocalPromptCache {
  private readonly config: LocalCacheConfig;

  // 分类缓存
  private summaryCache = new Map<string, CacheEntry<StructuredSummary>>();
  private compactionCache = new Map<string, CacheEntry<ContextMessage[]>>();
  private tokenCache = new Map<string, CacheEntry<number>>();

  // 指标
  private hits = 0;
  private misses = 0;

  constructor(config: Partial<LocalCacheConfig> = {}) {
    this.config = { ...DEFAULT_LOCAL_CACHE_CONFIG, ...config };
  }

  // ========================================
  // 摘要缓存
  // ========================================

  /**
   * 获取缓存的摘要
   */
  getSummary(contextHash: string): StructuredSummary | null {
    if (!this.config.enableSummaryCache) return null;

    const entry = this.summaryCache.get(contextHash);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.summaryCache.delete(contextHash);
      this.misses++;
      return null;
    }

    // 更新访问统计
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.hits++;

    return entry.value;
  }

  /**
   * 缓存摘要
   */
  setSummary(contextHash: string, summary: StructuredSummary): void {
    if (!this.config.enableSummaryCache) return;

    this.evictIfNeeded(this.summaryCache);

    const now = Date.now();
    this.summaryCache.set(contextHash, {
      value: summary,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      accessCount: 0,
      lastAccessedAt: now,
    });
  }

  // ========================================
  // 压缩结果缓存
  // ========================================

  /**
   * 获取缓存的压缩结果
   */
  getCompactedContext(contextHash: string): ContextMessage[] | null {
    if (!this.config.enableCompactionCache) return null;

    const entry = this.compactionCache.get(contextHash);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.compactionCache.delete(contextHash);
      this.misses++;
      return null;
    }

    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.hits++;

    return entry.value;
  }

  /**
   * 缓存压缩结果
   */
  setCompactedContext(contextHash: string, messages: ContextMessage[]): void {
    if (!this.config.enableCompactionCache) return;

    this.evictIfNeeded(this.compactionCache);

    const now = Date.now();
    this.compactionCache.set(contextHash, {
      value: messages,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      accessCount: 0,
      lastAccessedAt: now,
    });
  }

  // ========================================
  // Token 估算缓存
  // ========================================

  /**
   * 获取缓存的 token 数
   */
  getTokenCount(contentHash: string): number | null {
    if (!this.config.enableTokenCache) return null;

    const entry = this.tokenCache.get(contentHash);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.tokenCache.delete(contentHash);
      this.misses++;
      return null;
    }

    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    this.hits++;

    return entry.value;
  }

  /**
   * 缓存 token 数
   */
  setTokenCount(contentHash: string, count: number): void {
    if (!this.config.enableTokenCache) return;

    this.evictIfNeeded(this.tokenCache);

    const now = Date.now();
    this.tokenCache.set(contentHash, {
      value: count,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      accessCount: 0,
      lastAccessedAt: now,
    });
  }

  // ========================================
  // Hash 计算
  // ========================================

  /**
   * 计算上下文哈希
   *
   * 使用稳定的序列化 + 快速 hash
   */
  computeContextHash(messages: ContextMessage[]): string {
    const content = messages
      .map((m) => `${m.role}:${m.id}:${m.content.slice(0, 500)}`)
      .join('\n');
    return this.hash(content);
  }

  /**
   * 计算内容哈希（用于单条消息或文本）
   */
  computeContentHash(content: string): string {
    return this.hash(content);
  }

  // ========================================
  // 指标和管理
  // ========================================

  /**
   * 获取缓存指标
   */
  getMetrics(): CacheMetrics {
    const totalRequests = this.hits + this.misses;
    const localHitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      ...createEmptyCacheMetrics(),
      localHitRate,
      localCacheSize: this.size,
      localHits: this.hits,
      localMisses: this.misses,
    };
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return (
      this.summaryCache.size +
      this.compactionCache.size +
      this.tokenCache.size
    );
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.summaryCache.clear();
    this.compactionCache.clear();
    this.tokenCache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 清理过期条目
   */
  cleanup(): number {
    let cleaned = 0;

    cleaned += this.cleanupMap(this.summaryCache);
    cleaned += this.cleanupMap(this.compactionCache);
    cleaned += this.cleanupMap(this.tokenCache);

    return cleaned;
  }

  // ========================================
  // 私有方法
  // ========================================

  private hash(content: string): string {
    // 简单快速 hash（FNV-1a 变体）
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  private isExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() > entry.expiresAt;
  }

  private evictIfNeeded<T>(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size < this.config.maxSize) return;

    // LRU 驱逐：删除最久未访问的条目
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  private cleanupMap<T>(cache: Map<string, CacheEntry<T>>): number {
    let cleaned = 0;
    const now = Date.now();

    for (const [key, entry] of cache) {
      if (now > entry.expiresAt) {
        cache.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建本地缓存
 */
export function createLocalPromptCache(
  config?: Partial<LocalCacheConfig>
): LocalPromptCache {
  return new LocalPromptCache(config);
}
