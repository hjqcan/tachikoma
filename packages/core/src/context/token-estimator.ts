/**
 * Token 估算器模块
 *
 * 提供可插拔的 Token 估算实现，支持不同的估算策略
 *
 * @module context/token-estimator
 */

// ============================================================================
// TokenEstimator 接口
// ============================================================================

/**
 * Token 估算器接口
 */
export interface TokenEstimator {
  /**
   * 估算内容的 Token 数量
   *
   * @param content - 要估算的内容
   * @returns 估算的 Token 数量
   */
  estimate(content: string): number;
}

// ============================================================================
// 内置实现
// ============================================================================

/**
 * 简单 Token 估算器
 *
 * 使用固定的字符/Token 比例（约 3 字符/Token）
 * 这是最快的估算方式，适合大多数场景
 */
export class SimpleTokenEstimator implements TokenEstimator {
  /** 字符/Token 比例（默认 3） */
  private readonly ratio: number;

  constructor(ratio = 3) {
    this.ratio = ratio;
  }

  estimate(content: string): number {
    return Math.ceil(content.length / this.ratio);
  }
}

/**
 * 基于字符类型的 Token 估算器
 *
 * 针对中英文混合内容进行优化：
 * - 中文字符：约 1.5 字符/Token
 * - 英文/数字：约 4 字符/Token
 * - 特殊字符：约 1 字符/Token
 *
 * 比 SimpleTokenEstimator 更精确，但略慢
 */
export class CharacterBasedEstimator implements TokenEstimator {
  // 中日韩统一表意文字范围
  private readonly cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
  // ASCII 字母和数字
  private readonly alphanumPattern = /[a-zA-Z0-9]/g;

  estimate(content: string): number {
    // 统计 CJK 字符
    const cjkMatches = content.match(this.cjkPattern);
    const cjkCount = cjkMatches?.length ?? 0;

    // 统计英文字母和数字
    const alphanumMatches = content.match(this.alphanumPattern);
    const alphanumCount = alphanumMatches?.length ?? 0;

    // 其他字符（标点、空格等）
    const otherCount = content.length - cjkCount - alphanumCount;

    // 计算估算 Token 数
    // CJK：约 1.5 字符/Token
    // 英文数字：约 4 字符/Token
    // 其他：约 1 字符/Token（保守估计）
    const cjkTokens = cjkCount / 1.5;
    const alphanumTokens = alphanumCount / 4;
    const otherTokens = otherCount; // 1:1

    return Math.ceil(cjkTokens + alphanumTokens + otherTokens);
  }
}

/**
 * 缓存 Token 估算器
 *
 * 包装另一个估算器，缓存估算结果避免重复计算
 */
export class CachedTokenEstimator implements TokenEstimator {
  private readonly delegate: TokenEstimator;
  private readonly cache = new Map<string, number>();
  private readonly maxCacheSize: number;

  constructor(delegate: TokenEstimator, maxCacheSize = 1000) {
    this.delegate = delegate;
    this.maxCacheSize = maxCacheSize;
  }

  estimate(content: string): number {
    // 对于短内容直接计算，不缓存
    if (content.length < 50) {
      return this.delegate.estimate(content);
    }

    // 检查缓存
    const cached = this.cache.get(content);
    if (cached !== undefined) {
      return cached;
    }

    // 计算并缓存
    const result = this.delegate.estimate(content);

    // 如果缓存已满，清除一半旧条目
    if (this.cache.size >= this.maxCacheSize) {
      const entries = Array.from(this.cache.keys());
      for (let i = 0; i < this.maxCacheSize / 2; i++) {
        const key = entries[i];
        if (key !== undefined) {
          this.cache.delete(key);
        }
      }
    }

    this.cache.set(content, result);
    return result;
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 估算器类型
 */
export type TokenEstimatorType = 'simple' | 'character-based';

/**
 * 创建 Token 估算器
 *
 * @param type - 估算器类型
 * @param options - 可选配置
 * @returns Token 估算器实例
 *
 * @example
 * ```ts
 * // 创建简单估算器
 * const simple = createTokenEstimator('simple');
 *
 * // 创建针对中英文优化的估算器
 * const charBased = createTokenEstimator('character-based');
 * ```
 */
export function createTokenEstimator(
  type: TokenEstimatorType = 'simple',
  options?: { enableCache?: boolean; cacheSize?: number }
): TokenEstimator {
  let estimator: TokenEstimator;

  switch (type) {
    case 'character-based':
      estimator = new CharacterBasedEstimator();
      break;
    case 'simple':
    default:
      estimator = new SimpleTokenEstimator();
      break;
  }

  // 如果启用缓存，包装一层
  if (options?.enableCache) {
    return new CachedTokenEstimator(estimator, options.cacheSize);
  }

  return estimator;
}

// ============================================================================
// 默认实例
// ============================================================================

/**
 * 默认 Token 估算器（简单模式）
 */
export const defaultTokenEstimator: TokenEstimator = new SimpleTokenEstimator();

/**
 * 快速估算函数
 *
 * 使用默认估算器估算 Token 数
 */
export function estimateTokens(content: string): number {
  return defaultTokenEstimator.estimate(content);
}
