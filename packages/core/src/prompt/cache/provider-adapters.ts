/**
 * Provider 缓存能力适配器
 *
 * 定义各 LLM Provider 的缓存能力和适配逻辑
 *
 * @module prompt/cache/provider-adapters
 */

import type { ProviderCacheCapability, CachedMessage } from './types';
import type { ContextMessage } from '../types';

// ============================================================================
// Provider 缓存能力注册表
// ============================================================================

/**
 * Provider 缓存能力映射
 *
 * 支持的 Provider:
 * - anthropic: Claude 系列，原生 cache_control 支持
 * - openai: GPT 系列，自动缓存相同 prefix
 * - google: Gemini 系列，cached_content API
 * - openrouter: 代理层，继承底层模型能力
 * - generic: 通用回退，仅本地缓存
 */
export const PROVIDER_CACHE_CAPABILITIES: Record<string, ProviderCacheCapability> = {
  // Anthropic: 原生 cache_control 支持
  anthropic: {
    provider: 'anthropic',
    supportsNativeCache: true,
    cacheControlField: 'cache_control',
    cacheTTL: 300, // 5 分钟默认
    supportsCacheMetrics: true,
    supportsExtendedTTL: true, // 可付费延长到 1 小时
    maxCacheableTokens: 200_000,
  },

  // OpenAI: 自动缓存相同 prefix（无需显式控制）
  openai: {
    provider: 'openai',
    supportsNativeCache: true,
    cacheControlField: undefined, // 自动处理，无需显式字段
    cacheTTL: 3600, // 估计 1 小时
    supportsCacheMetrics: false, // API 不返回缓存统计
    supportsExtendedTTL: false,
  },

  // Google Gemini: cached_content API
  google: {
    provider: 'google',
    supportsNativeCache: true,
    cacheControlField: 'cached_content',
    cacheTTL: 3600, // 1 小时
    supportsCacheMetrics: true,
    supportsExtendedTTL: true,
    maxCacheableTokens: 1_000_000,
  },

  // OpenRouter: 代理层，能力取决于底层模型
  openrouter: {
    provider: 'openrouter',
    supportsNativeCache: true, // 透传底层能力
    cacheControlField: 'cache_control', // 遵循 Anthropic 格式
    cacheTTL: 300,
    supportsCacheMetrics: false, // 代理层可能不返回
  },

  // Mistral
  mistral: {
    provider: 'mistral',
    supportsNativeCache: false, // 暂不支持
    cacheTTL: 0,
    supportsCacheMetrics: false,
  },

  // XAI (Grok)
  xai: {
    provider: 'xai',
    supportsNativeCache: false, // 暂不支持
    cacheTTL: 0,
    supportsCacheMetrics: false,
  },

  // 通用回退（无原生支持时使用本地缓存）
  generic: {
    provider: 'generic',
    supportsNativeCache: false,
    cacheTTL: 0,
    supportsCacheMetrics: false,
  },
};

/**
 * 获取 Provider 缓存能力
 *
 * @param provider - Provider 名称（不区分大小写）
 * @returns 缓存能力描述
 */
export function getProviderCacheCapability(
  provider: string
): ProviderCacheCapability {
  const normalized = provider.toLowerCase();

  // 精确匹配
  const capability = PROVIDER_CACHE_CAPABILITIES[normalized];
  if (capability) {
    return capability;
  }

  // 模糊匹配（处理变体，如 'anthropic-claude' -> 'anthropic'）
  for (const [key, capability] of Object.entries(PROVIDER_CACHE_CAPABILITIES)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return capability;
    }
  }

  // 回退到通用
  return PROVIDER_CACHE_CAPABILITIES.generic ?? {
    provider: 'generic',
    supportsNativeCache: false,
    cacheTTL: 0,
    supportsCacheMetrics: false,
  };
}

/**
 * 从模型 ID 推断 Provider
 *
 * @param modelId - 模型 ID（如 'claude-3-5-sonnet', 'gpt-4o'）
 * @returns Provider 名称
 */
export function inferProviderFromModel(modelId: string): string {
  const normalized = modelId.toLowerCase();

  if (normalized.includes('claude')) return 'anthropic';
  if (normalized.includes('gpt')) return 'openai';
  if (normalized.includes('gemini')) return 'google';
  if (normalized.includes('mistral')) return 'mistral';
  if (normalized.includes('grok')) return 'xai';

  return 'generic';
}

// ============================================================================
// Provider 适配器
// ============================================================================

/**
 * Anthropic 缓存适配器
 *
 * 为消息添加 cache_control 标记
 */
export function adaptForAnthropic(
  messages: ContextMessage[],
  _capability: ProviderCacheCapability
): CachedMessage[] {
  return messages.map((msg, index) => {
    const cached: CachedMessage = { ...msg };

    // 系统消息始终缓存
    if (msg.role === 'system') {
      cached.shouldCache = true;
      cached.cacheControl = { type: 'ephemeral' };
    }
    // 长消息缓存（超过阈值）
    else if (msg.content.length > 2000) {
      cached.shouldCache = true;
      cached.cacheControl = { type: 'ephemeral' };
    }
    // 前 N 条历史消息缓存（作为稳定前缀）
    else if (index < 5 && msg.role !== 'assistant') {
      cached.shouldCache = true;
      cached.cacheControl = { type: 'ephemeral' };
    }

    return cached;
  });
}

/**
 * OpenAI 缓存适配器
 *
 * OpenAI 自动缓存相同前缀，无需显式标记
 * 只需确保消息顺序稳定
 */
export function adaptForOpenAI(
  messages: ContextMessage[]
): CachedMessage[] {
  // OpenAI 不需要显式缓存控制，只标记建议缓存
  return messages.map((msg, index) => ({
    ...msg,
    shouldCache: msg.role === 'system' || index < 5,
  }));
}

/**
 * Google Gemini 缓存适配器
 */
export function adaptForGoogle(
  messages: ContextMessage[]
): CachedMessage[] {
  // Gemini 使用 cached_content API，需要单独处理
  // 这里只标记建议缓存的消息
  return messages.map((msg, index) => {
    const cached: CachedMessage = {
      ...msg,
      shouldCache: msg.role === 'system' || index < 10,
    };
    if (msg.role === 'system') {
      cached.cacheControl = { type: 'persistent' };
    }
    return cached;
  });
}

/**
 * 通用适配器（无原生缓存支持）
 *
 * 仅标记消息，不添加缓存控制
 */
export function adaptForGeneric(
  messages: ContextMessage[]
): CachedMessage[] {
  return messages.map((msg, index) => ({
    ...msg,
    shouldCache: msg.role === 'system' || index < 5,
  }));
}

/**
 * 根据 Provider 能力选择适配器
 */
export function adaptMessages(
  messages: ContextMessage[],
  capability: ProviderCacheCapability
): CachedMessage[] {
  switch (capability.provider) {
    case 'anthropic':
    case 'openrouter':
      return adaptForAnthropic(messages, capability);
    case 'openai':
      return adaptForOpenAI(messages);
    case 'google':
      return adaptForGoogle(messages);
    default:
      return adaptForGeneric(messages);
  }
}
