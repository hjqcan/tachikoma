/**
 * 默认缓存策略
 *
 * 实现 ICacheStrategy 接口，提供 Provider 无关的缓存优化
 *
 * @module prompt/cache/default-strategy
 */

import type { ContextMessage } from '../types';
import type {
  ICacheStrategy,
  ProviderCacheCapability,
  CachedMessage,
} from './types';
import { adaptMessages } from './provider-adapters';

// ============================================================================
// 默认缓存策略
// ============================================================================

/**
 * 默认缓存策略
 *
 * 策略规则：
 * 1. 系统消息始终缓存（高价值前缀）
 * 2. 长消息（>2000 字符）缓存
 * 3. 前 N 条历史消息缓存（稳定前缀）
 * 4. 工具调用结果选择性缓存
 */
export class DefaultCacheStrategy implements ICacheStrategy {
  readonly name = 'default';

  /** 稳定前缀消息数量 */
  readonly stablePrefixCount: number;
  /** 长消息阈值（字符） */
  readonly longMessageThreshold: number;

  constructor(options: DefaultCacheStrategyOptions = {}) {
    this.stablePrefixCount = options.stablePrefixCount ?? 5;
    this.longMessageThreshold = options.longMessageThreshold ?? 2000;
  }

  /**
   * 准备缓存控制
   */
  prepareCacheControl(
    messages: ContextMessage[],
    capability: ProviderCacheCapability
  ): CachedMessage[] {
    // 使用 Provider 适配器
    return adaptMessages(messages, capability);
  }

  /**
   * 计算缓存键
   *
   * 基于消息序列生成稳定的 hash
   */
  computeCacheKey(messages: ContextMessage[]): string {
    // 使用消息 ID 和角色生成键（不含内容，避免长键）
    const keyParts = messages.map((m) => `${m.role}:${m.id}`);
    return this.hash(keyParts.join('|'));
  }

  /**
   * 估算缓存命中率
   *
   * 基于前缀稳定性估算
   */
  estimateHitRate(previousKey: string | null, currentKey: string): number {
    if (!previousKey) {
      return 0;
    }

    // 简单估算：键相同 -> 高命中率
    if (previousKey === currentKey) {
      return 0.95;
    }

    // 键不同 -> 检查前缀相似度
    const commonPrefixLength = this.getCommonPrefixLength(
      previousKey,
      currentKey
    );
    const maxLength = Math.max(previousKey.length, currentKey.length);

    return commonPrefixLength / maxLength;
  }

  // ========================================
  // 私有方法
  // ========================================

  private hash(content: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  private getCommonPrefixLength(a: string, b: string): number {
    const minLength = Math.min(a.length, b.length);
    let i = 0;
    while (i < minLength && a[i] === b[i]) {
      i++;
    }
    return i;
  }
}

/**
 * 默认缓存策略选项
 */
export interface DefaultCacheStrategyOptions {
  /** 稳定前缀消息数量 */
  stablePrefixCount?: number;

  /** 长消息阈值（字符） */
  longMessageThreshold?: number;
}

// ============================================================================
// 智能缓存策略
// ============================================================================

/**
 * 智能缓存策略
 *
 * 基于消息重要性和访问模式优化缓存决策
 */
export class SmartCacheStrategy implements ICacheStrategy {
  readonly name = 'smart';

  private readonly accessHistory = new Map<string, number>();
  private readonly importanceWeights: ImportanceWeights;

  constructor(options: SmartCacheStrategyOptions = {}) {
    this.importanceWeights = {
      system: options.systemWeight ?? 1.0,
      user: options.userWeight ?? 0.8,
      assistant: options.assistantWeight ?? 0.5,
      tool: options.toolWeight ?? 0.6,
    };
  }

  prepareCacheControl(
    messages: ContextMessage[],
    capability: ProviderCacheCapability
  ): CachedMessage[] {
    // 计算每条消息的缓存优先级
    const priorities = messages.map((msg, index) => ({
      message: msg,
      priority: this.calculateCachePriority(msg, index, messages.length),
    }));

    // 应用 Provider 适配
    const adapted = adaptMessages(messages, capability);

    // 根据优先级调整 shouldCache
    return adapted.map((msg, index) => {
      const priority = priorities[index]?.priority ?? 0;
      return {
        ...msg,
        shouldCache: priority > 0.5,
      };
    });
  }

  computeCacheKey(messages: ContextMessage[]): string {
    // 使用消息 ID 序列 + 内容 hash 前缀
    const keyParts = messages.map((m) => {
      const contentPrefix = m.content.slice(0, 100);
      return `${m.role}:${m.id}:${this.hash(contentPrefix)}`;
    });
    return this.hash(keyParts.join('|'));
  }

  estimateHitRate(previousKey: string | null, currentKey: string): number {
    if (!previousKey) return 0;

    // 记录访问
    const count = (this.accessHistory.get(currentKey) ?? 0) + 1;
    this.accessHistory.set(currentKey, count);

    // 频繁访问的键有更高的命中率
    if (previousKey === currentKey) {
      return Math.min(0.99, 0.9 + count * 0.01);
    }

    return 0;
  }

  // ========================================
  // 私有方法
  // ========================================

  private calculateCachePriority(
    message: ContextMessage,
    index: number,
    total: number
  ): number {
    let priority = 0;

    // 1. 角色权重
    const roleWeight = this.importanceWeights[message.role] ?? 0.5;
    priority += roleWeight * 0.4;

    // 2. 位置权重（前面的消息更稳定，更适合缓存）
    const positionWeight = 1 - index / total;
    priority += positionWeight * 0.3;

    // 3. 内容长度权重（长内容更值得缓存）
    const lengthWeight = Math.min(1, message.content.length / 5000);
    priority += lengthWeight * 0.3;

    return priority;
  }

  private hash(content: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }
}

/**
 * 智能缓存策略选项
 */
export interface SmartCacheStrategyOptions {
  systemWeight?: number;
  userWeight?: number;
  assistantWeight?: number;
  toolWeight?: number;
}

/**
 * 重要性权重映射
 */
interface ImportanceWeights {
  system: number;
  user: number;
  assistant: number;
  tool: number;
  [key: string]: number;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建默认缓存策略
 */
export function createDefaultCacheStrategy(
  options?: DefaultCacheStrategyOptions
): DefaultCacheStrategy {
  return new DefaultCacheStrategy(options);
}

/**
 * 创建智能缓存策略
 */
export function createSmartCacheStrategy(
  options?: SmartCacheStrategyOptions
): SmartCacheStrategy {
  return new SmartCacheStrategy(options);
}
