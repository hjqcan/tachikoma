/**
 * Chat Provider 工厂
 *
 * 多 Provider 是 chatbot 的第一能力：anthropic / openai / openai-compatible（OpenRouter 等）。
 * 这里是唯一的模型构造入口——不允许在会话链路里硬编码 provider
 * （历史教训：conversational-runner.ts 曾在 4 处硬编码 'openai'）。
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ChatModelConfig, ChatProvider } from './types';

export class ChatProviderError extends Error {
  constructor(
    message: string,
    public readonly provider?: ChatProvider
  ) {
    super(message);
    this.name = 'ChatProviderError';
  }
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** 各 provider 的默认模型；openai-compatible 端点各异，必须显式指定 */
export const DEFAULT_CHAT_MODELS: Readonly<Record<ChatProvider, string | undefined>> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  'openai-compatible': undefined,
};

export function createChatModel(config: ChatModelConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ChatProviderError('缺少 API key', config.provider);
  }
  if (!config.model) {
    throw new ChatProviderError(
      `provider "${config.provider}" 需要显式指定 model`,
      config.provider
    );
  }

  switch (config.provider) {
    case 'anthropic': {
      const provider = createAnthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl && { baseURL: config.baseUrl }),
      });
      return provider(config.model);
    }
    case 'openai':
    case 'openai-compatible': {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        ...(config.baseUrl && { baseURL: config.baseUrl }),
      });
      return provider(config.model);
    }
    default: {
      const exhaustive: never = config.provider;
      throw new ChatProviderError(`未知 provider: ${String(exhaustive)}`);
    }
  }
}

export interface ResolveChatModelInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** 默认 process.env，测试可注入 */
  env?: Record<string, string | undefined>;
}

function isChatProvider(value: string): value is ChatProvider {
  return value === 'anthropic' || value === 'openai' || value === 'openai-compatible';
}

/**
 * 从显式参数 + 环境变量解析出完整模型配置。
 *
 * 解析顺序（与 CLI 行为一致）：
 * 1. 显式 provider 优先；显式 baseUrl（未指明 provider 时）视为 openai-compatible。
 * 2. 否则按环境探测：ANTHROPIC_API_KEY → anthropic；
 *    OPENROUTER_API_KEY → openai-compatible（OpenRouter 端点）；
 *    OPENAI_API_KEY → openai。
 * 3. 都没有则抛 ChatProviderError（带可操作的提示）。
 */
export function resolveChatModelConfig(input: ResolveChatModelInput = {}): ChatModelConfig {
  const env = input.env ?? process.env;

  const requestedProvider = input.provider;
  if (requestedProvider !== undefined && !isChatProvider(requestedProvider)) {
    throw new ChatProviderError(
      `未知 provider "${requestedProvider}"（可选：anthropic | openai | openai-compatible）`
    );
  }

  let provider: ChatProvider | undefined =
    requestedProvider !== undefined && isChatProvider(requestedProvider)
      ? requestedProvider
      : undefined;
  let apiKey = input.apiKey;
  let baseUrl = input.baseUrl;

  if (!provider && baseUrl) {
    provider = 'openai-compatible';
  }

  if (!provider) {
    if (input.apiKey) {
      // 只给了 key 没给 provider，无法判断端点
      throw new ChatProviderError('指定了 API key 时必须同时指定 provider 或 baseUrl');
    }
    if (env.ANTHROPIC_API_KEY) {
      provider = 'anthropic';
      apiKey = env.ANTHROPIC_API_KEY;
    } else if (env.OPENROUTER_API_KEY) {
      provider = 'openai-compatible';
      apiKey = env.OPENROUTER_API_KEY;
      baseUrl = baseUrl ?? env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL;
    } else if (env.OPENAI_API_KEY) {
      provider = 'openai';
      apiKey = env.OPENAI_API_KEY;
    } else {
      throw new ChatProviderError(
        '未找到可用的 LLM 凭证。请设置 ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY 之一，' +
          '或显式传入 --provider 与 --api-key'
      );
    }
  }

  if (!apiKey) {
    const envKey =
      provider === 'anthropic'
        ? env.ANTHROPIC_API_KEY
        : provider === 'openai'
          ? env.OPENAI_API_KEY
          : (env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY);
    apiKey = envKey;
  }
  if (!apiKey) {
    throw new ChatProviderError(`provider "${provider}" 缺少 API key`, provider);
  }

  if (provider === 'openai-compatible' && !baseUrl) {
    baseUrl = env.OPENROUTER_API_KEY ? OPENROUTER_BASE_URL : undefined;
  }
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new ChatProviderError('openai-compatible 需要 baseUrl（如 OpenRouter）', provider);
  }

  const model = input.model ?? DEFAULT_CHAT_MODELS[provider];
  if (!model) {
    throw new ChatProviderError(`provider "${provider}" 需要显式指定 model`, provider);
  }

  return {
    provider,
    model,
    apiKey,
    ...(baseUrl && { baseUrl }),
  };
}
