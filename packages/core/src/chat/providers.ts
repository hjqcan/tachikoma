/**
 * Chat Provider 工厂
 *
 * 多 Provider 是 chatbot 的第一能力：anthropic / openai / openai-compatible（OpenRouter 等）。
 * 这里是唯一的 pi-mono 运行时构造入口——不允许在会话链路里硬编码 provider
 * （历史教训：conversational-runner.ts 曾在 4 处硬编码 'openai'）。
 */

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import type { Api, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
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
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o';

/** 各 provider 的默认模型；openai-compatible 端点各异，必须显式指定 */
export const DEFAULT_CHAT_MODELS: Readonly<Record<ChatProvider, string | undefined>> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  'openai-compatible': undefined,
};

export interface ChatAgentRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
}

function resolveBuiltinPiProvider(provider: ChatProvider): Provider {
  switch (provider) {
    case 'anthropic':
      return anthropicProvider();
    case 'openai':
      return openaiProvider();
    case 'openai-compatible':
      return openrouterProvider();
    default: {
      const exhaustive: never = provider;
      throw new ChatProviderError(`未知 provider: ${String(exhaustive)}`);
    }
  }
}

function createCustomModel(config: ChatModelConfig & { baseUrl: string }): {
  model: Model<Api>;
  provider: Provider;
} {
  const providerId = `tachikoma-${config.provider}`;
  const api =
    config.provider === 'anthropic'
      ? ('anthropic-messages' as const)
      : config.provider === 'openai'
        ? ('openai-responses' as const)
        : ('openai-completions' as const);
  const streams: ProviderStreams =
    api === 'anthropic-messages'
      ? anthropicMessagesApi()
      : api === 'openai-responses'
        ? openAIResponsesApi()
        : openAICompletionsApi();
  const model: Model<Api> = {
    id: config.model,
    name: config.model,
    api,
    provider: providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const provider = createProvider({
    id: providerId,
    name: `Tachikoma ${config.provider}`,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth('Tachikoma API key', [
        config.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
      ]),
    },
    models: [model],
    api: streams,
  });
  return { model, provider };
}

/**
 * 构造 ChatEngine 使用的 pi-mono model + stream runtime。
 *
 * 自定义模型沿用对应 provider 的协议能力，只覆盖 model id/baseUrl；工具循环、
 * 参数校验、错误 tool_result 和后续模型调用全部由 pi-agent-core 负责。
 */
export function createChatAgentRuntime(config: ChatModelConfig): ChatAgentRuntime {
  if (!config.apiKey) {
    throw new ChatProviderError('缺少 API key', config.provider);
  }
  if (!config.model) {
    throw new ChatProviderError(
      `provider "${config.provider}" 需要显式指定 model`,
      config.provider
    );
  }

  const isOpenRouter =
    config.provider === 'openai-compatible' &&
    config.baseUrl?.replace(/\/+$/, '') === OPENROUTER_BASE_URL;
  const resolved =
    config.baseUrl && !isOpenRouter
      ? createCustomModel({ ...config, baseUrl: config.baseUrl })
      : (() => {
          const provider = resolveBuiltinPiProvider(config.provider);
          const model = provider.getModels().find((candidate) => candidate.id === config.model);
          if (!model) {
            throw new ChatProviderError(
              `pi-mono 的 ${config.provider} catalog 中没有模型 "${config.model}"`,
              config.provider
            );
          }
          return { model, provider };
        })();
  const models = createModels();
  models.setProvider(resolved.provider);

  return {
    model: resolved.model,
    streamFn: models.streamSimple.bind(models),
  };
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
      baseUrl = baseUrl ?? env.OPENAI_BASE_URL;
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

  // 显式 provider=openai/openai-compatible 时也允许 OPENAI_BASE_URL 提供端点
  if (!baseUrl && (provider === 'openai' || provider === 'openai-compatible')) {
    baseUrl = env.OPENAI_BASE_URL;
  }
  if (provider === 'openai-compatible' && !baseUrl) {
    baseUrl = env.OPENROUTER_API_KEY ? OPENROUTER_BASE_URL : undefined;
  }
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new ChatProviderError('openai-compatible 需要 baseUrl（如 OpenRouter）', provider);
  }

  const isOpenRouter =
    provider === 'openai-compatible' && baseUrl?.replace(/\/+$/, '') === OPENROUTER_BASE_URL;
  const model =
    input.model ??
    env.TACHIKOMA_CHAT_MODEL ??
    (isOpenRouter ? DEFAULT_OPENROUTER_MODEL : DEFAULT_CHAT_MODELS[provider]);
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
