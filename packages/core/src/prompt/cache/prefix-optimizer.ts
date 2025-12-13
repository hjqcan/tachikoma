/**
 * KV 缓存优化策略
 *
 * 来自 Manus：KV 缓存命中率是生产阶段最重要的单一指标
 *
 * 核心原则：
 * 1. 保持前缀稳定：系统提示不包含时间戳
 * 2. 只追加上下文：不修改历史消息
 * 3. 确定性序列化：JSON 键顺序稳定
 *
 * @module context/cache/prefix-optimizer
 */

import type {
  ContextMessage,
  CacheOptimizationConfig,
} from '../types';

// ============================================================================
// KV 缓存优化器
// ============================================================================

/**
 * 缓存断点标记
 */
export const CACHE_BREAKPOINT_MARKER = '<!-- CACHE_BREAKPOINT -->';

/**
 * 前缀优化器
 *
 * 优化上下文前缀以提高 KV 缓存命中率
 */
export class PrefixOptimizer {
  private readonly config: CacheOptimizationConfig;

  constructor(config: CacheOptimizationConfig) {
    this.config = config;
  }

  /**
   * 优化上下文
   *
   * - 移除动态内容
   * - 添加缓存断点
   * - 确保确定性序列化
   */
  optimize(messages: ContextMessage[]): ContextMessage[] {
    return messages.map((msg, index) => {
      let optimized = msg;

      // 对系统消息进行特殊处理
      if (msg.role === 'system') {
        optimized = this.optimizeSystemMessage(msg);

        // 在系统消息末尾添加缓存断点
        if (this.config.addCacheBreakpoints && index === this.findLastSystemMessageIndex(messages)) {
          optimized = this.addCacheBreakpoint(optimized);
        }
      }

      return optimized;
    });
  }

  /**
   * 确定性序列化
   *
   * 确保 JSON 键顺序稳定，避免破坏缓存
   */
  deterministicSerialize(obj: unknown): string {
    if (!this.config.deterministicSerialization) {
      return JSON.stringify(obj);
    }

    return JSON.stringify(obj, this.sortedReplacer());
  }

  /**
   * 检查消息是否包含动态内容
   */
  containsDynamicContent(content: string): boolean {
    for (const pattern of this.config.forbiddenDynamicContent) {
      const regex = this.getDynamicContentRegex(pattern);
      if (regex.test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 移除动态内容
   */
  removeDynamicContent(content: string): string {
    let result = content;

    for (const pattern of this.config.forbiddenDynamicContent) {
      const regex = this.getDynamicContentRegex(pattern);
      result = result.replace(regex, this.getPlaceholder(pattern));
    }

    return result;
  }

  /**
   * 添加缓存断点标记
   */
  addCacheBreakpoint(message: ContextMessage): ContextMessage {
    if (message.content.includes(CACHE_BREAKPOINT_MARKER)) {
      return message;
    }

    return {
      ...message,
      content: `${message.content}\n${CACHE_BREAKPOINT_MARKER}`,
    };
  }

  /**
   * 估算缓存命中率
   *
   * 基于前缀稳定性估算
   */
  estimateCacheHitRate(
    previousMessages: ContextMessage[],
    currentMessages: ContextMessage[]
  ): number {
    if (previousMessages.length === 0 || currentMessages.length === 0) {
      return 0;
    }

    // 计算共同前缀长度
    let commonPrefixLength = 0;
    const minLength = Math.min(previousMessages.length, currentMessages.length);

    for (let i = 0; i < minLength; i++) {
      const prev = previousMessages[i];
      const curr = currentMessages[i];

      if (prev && curr && prev.content === curr.content && prev.role === curr.role) {
        commonPrefixLength++;
      } else {
        break;
      }
    }

    // 命中率 = 共同前缀长度 / 当前消息长度
    return commonPrefixLength / currentMessages.length;
  }

  // ========================================
  // 私有方法
  // ========================================

  private optimizeSystemMessage(message: ContextMessage): ContextMessage {
    if (!this.containsDynamicContent(message.content)) {
      return message;
    }

    return {
      ...message,
      content: this.removeDynamicContent(message.content),
    };
  }

  private findLastSystemMessageIndex(messages: ContextMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'system') {
        return i;
      }
    }
    return -1;
  }

  private sortedReplacer(): (_key: string, value: unknown) => unknown {
    return (_key: string, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return value;
    };
  }

  private getDynamicContentRegex(pattern: string): RegExp {
    switch (pattern) {
      case 'timestamp':
        // 匹配各种时间戳格式
        return /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b/g;

      case 'random':
        // 匹配随机数/ID
        return /\b[a-f0-9]{8,32}\b/gi;

      case 'uuid':
        // 匹配 UUID
        return /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

      default:
        // 自定义模式
        return new RegExp(pattern, 'g');
    }
  }

  private getPlaceholder(pattern: string): string {
    switch (pattern) {
      case 'timestamp':
        return '[TIMESTAMP]';
      case 'random':
        return '[RANDOM]';
      case 'uuid':
        return '[UUID]';
      default:
        return `[${pattern.toUpperCase()}]`;
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建前缀优化器
 */
export function createPrefixOptimizer(config: CacheOptimizationConfig): PrefixOptimizer {
  return new PrefixOptimizer(config);
}
