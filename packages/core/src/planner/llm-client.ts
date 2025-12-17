/**
 * LLM 客户端实现
 *
 * 使用 AI SDK 提供统一的 LLM 客户端接口
 * 支持 Anthropic、OpenAI 和 Mock 客户端实现
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type {
  LLMClient,
  LLMClientConfig,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from './types';

// ============================================================================
// 错误类型
// ============================================================================

/**
 * LLM 客户端错误
 */
export class LLMClientError extends Error {
  constructor(
    message: string,
    public provider: LLMProvider,
    public code: string,
    public retryable = false
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'LLMClientError';
  }
}

function isDebugEnabled(): boolean {
  const raw = process.env.TACHIKOMA_LOG_LEVEL ?? '';
  const level = String(raw).toLowerCase();
  return level === 'debug' || level === 'trace';
}

function isTransientNetworkError(code: string, message: string): boolean {
  // Bun/Node fetch/network errors are often surfaced as code + message with no HTTP status.
  const upper = code.toUpperCase();
  const lowerMsg = message.toLowerCase();

  if (upper === 'ECONNRESET') return true;
  if (upper === 'ETIMEDOUT') return true;
  if (upper === 'ECONNREFUSED') return true;
  if (upper === 'EPIPE') return true;

  return (
    lowerMsg.includes('socket connection was closed') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('network error')
  );
}

function isRetryableError(statusCode: number, code: string, message: string): boolean {
  return statusCode >= 500 || statusCode === 429 || isTransientNetworkError(code, message);
}

// ============================================================================
// 抽象基类
// ============================================================================

/**
 * LLM 客户端抽象基类
 */
export abstract class BaseLLMClient implements LLMClient {
  abstract readonly provider: LLMProvider;
  protected readonly config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  abstract complete(request: LLMRequest): Promise<LLMResponse>;

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }
}

// ============================================================================
// Anthropic 客户端
// ============================================================================

/**
 * Anthropic Claude 客户端
 *
 * 使用 AI SDK @ai-sdk/anthropic 调用 Anthropic Messages API
 */
export class AnthropicLLMClient extends BaseLLMClient {
  readonly provider: LLMProvider = 'anthropic';
  private readonly anthropicProvider: ReturnType<typeof createAnthropic>;
  private readonly anthropicProviderBase: ReturnType<typeof createAnthropic>;
  private extendedContextEnabled: boolean;

  constructor(config: LLMClientConfig) {
    super(config);
    
    // 检测是否需要 Extended Context Beta Header (P1)
    const needsExtendedContext =
      config.enableExtendedContext === true && this.isExtendedContextModel(config.model);

    const betaHeaderValue = config.extendedContextBetaHeader ?? 'extended-context-2025-04-14';

    const baseProviderConfig = {
      ...(config.apiKey && { apiKey: config.apiKey }),
      ...(config.baseUrl && { baseURL: config.baseUrl }),
    };

    // 始终创建 base provider（无 beta header），用于降级重试
    this.anthropicProviderBase = createAnthropic(baseProviderConfig);

    // 创建可能带 beta header 的 provider
    this.anthropicProvider = needsExtendedContext
      ? createAnthropic({
          ...baseProviderConfig,
          headers: { 'anthropic-beta': betaHeaderValue },
        })
      : this.anthropicProviderBase;

    this.extendedContextEnabled = needsExtendedContext;

    if (needsExtendedContext) {
      console.debug(
        `[AnthropicLLMClient] Extended context beta enabled for ${config.model} (${betaHeaderValue})`
      );
    }
  }
  
  /**
   * 检查是否是支持 Extended Context 的模型
   * Claude 4/4.5 系列支持 1M tokens
   */
  private isExtendedContextModel(model: string): boolean {
    const lowerModel = model.toLowerCase();
    return (
      lowerModel.includes('claude-4') ||
      lowerModel.includes('claude-4.5') ||
      lowerModel.includes('claude-sonnet-4') ||
      lowerModel.includes('claude-opus-4')
    );
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new LLMClientError(
        'API key is required',
        this.provider,
        'AUTH_ERROR',
        false
      );
    }

    const {
      systemPrompt,
      messages,
      maxTokens = this.config.maxTokens || 8192,
      temperature = this.config.temperature ?? 0.3,
      stopSequences,
      abortSignal,
    } = request;

    // P0 修复：过滤 messages 中的 system 角色，Anthropic 只接受 user/assistant
    const filteredMessages = messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );

    // 验证角色：确保只有 user/assistant
    for (const msg of filteredMessages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        throw new LLMClientError(
          `Invalid message role: ${msg.role}. Anthropic only accepts 'user' and 'assistant'.`,
          this.provider,
          'INVALID_ROLE',
          false
        );
      }
    }

    // 确定 AbortSignal：优先使用外部传入的，否则使用配置的 timeout
    const effectiveAbortSignal =
      abortSignal ??
      (this.config.timeout ? AbortSignal.timeout(this.config.timeout) : undefined);

    // P0: 检查是否启用 Prompt Caching
    const enableCache = this.config.enablePromptCache !== false;

    const buildRequest = (provider: ReturnType<typeof createAnthropic>) => ({
      model: provider(this.config.model),
        system: systemPrompt,
        messages: filteredMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        maxOutputTokens: maxTokens,
        temperature,
        // 使用条件展开避免 undefined 问题
        ...(stopSequences && { stopSequences }),
        ...(effectiveAbortSignal && { abortSignal: effectiveAbortSignal }),
        // P0: Prompt Caching via experimental_providerMetadata
        ...(enableCache && {
          experimental_providerMetadata: {
            anthropic: {
              cacheControl: { type: 'ephemeral' },
            },
          },
        }),
    });

    const toResponse = (result: Awaited<ReturnType<typeof generateText>>): LLMResponse => ({
      content: result.text,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      stopReason: result.finishReason,
      model: this.config.model,
    });

    try {
      const result = await generateText(buildRequest(this.anthropicProvider));
      return toResponse(result);
    } catch (error) {
      const err = error as Error & { status?: number; code?: string };
      const statusCode = err.status || 0;

      // Beta header 不被支持/已过期时：自动降级重试一次（避免硬失败）
      if (
        this.extendedContextEnabled &&
        statusCode >= 400 &&
        statusCode < 500 &&
        this.isLikelyExtendedContextBetaError(err)
      ) {
        this.extendedContextEnabled = false;
        console.warn(
          `[AnthropicLLMClient] Extended context beta rejected (HTTP ${statusCode}); retrying without beta header`
        );
        try {
          const retryResult = await generateText(buildRequest(this.anthropicProviderBase));
          return toResponse(retryResult);
        } catch (fallbackError) {
          const fallbackErr = fallbackError as Error & { status?: number; code?: string };
          const fallbackStatus = fallbackErr.status || 0;
          const fallbackRetryable = isRetryableError(
            fallbackStatus,
            fallbackErr.code || '',
            fallbackErr.message || ''
          );
          throw new LLMClientError(
            fallbackErr.message || 'Unknown error',
            this.provider,
            fallbackErr.code || `HTTP_${fallbackStatus}`,
            fallbackRetryable
          );
        }
      }

      // 处理 AI SDK 错误
      const message = err.message || '';
      const code = err.code || '';
      const isRetryable = isRetryableError(statusCode, code, message);

      throw new LLMClientError(
        err.message || 'Unknown error',
        this.provider,
        err.code || `HTTP_${statusCode}`,
        isRetryable
      );
    }
  }

  private isLikelyExtendedContextBetaError(
    err: Error & { status?: number; code?: string }
  ): boolean {
    const message = (err.message || '').toLowerCase();
    const code = (err.code || '').toLowerCase();
    return (
      message.includes('anthropic-beta') ||
      message.includes('beta') ||
      message.includes('extended-context') ||
      code.includes('beta') ||
      code.includes('anthropic')
    );
  }
}

// ============================================================================
// OpenAI 客户端
// ============================================================================

/**
 * OpenAI GPT 客户端
 *
 * 使用 AI SDK @ai-sdk/openai 调用 OpenAI Chat Completions API
 */
export class OpenAILLMClient extends BaseLLMClient {
  readonly provider: LLMProvider = 'openai';
  private readonly openaiProvider: ReturnType<typeof createOpenAI>;

  constructor(config: LLMClientConfig) {
    super(config);
    // 创建 OpenAI provider 实例，使用条件展开避免 undefined 问题
    this.openaiProvider = createOpenAI({
      ...(config.apiKey && { apiKey: config.apiKey }),
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      headers: {
        'HTTP-Referer': 'https://github.com/hjqcan/tachikoma',
        'X-Title': 'Tachikoma',
      },
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new LLMClientError(
        'API key is required',
        this.provider,
        'AUTH_ERROR',
        false
      );
    }

    const {
      systemPrompt,
      messages,
      maxTokens = this.config.maxTokens || 4096,
      temperature = this.config.temperature ?? 0.3,
      stopSequences,
      abortSignal,
    } = request;

    // 过滤 system 消息（因为已经通过 system 参数传递）
    // 注意：PromptContextEngine 会将 tool 消息转换为 user 消息，因此这里不需要处理 tool 角色
    const filteredMessages = messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );

    // 确定 AbortSignal：优先使用外部传入的，否则使用配置的 timeout
    const effectiveAbortSignal =
      abortSignal ??
      (this.config.timeout ? AbortSignal.timeout(this.config.timeout) : undefined);

    try {
      const result = await generateText({
        // Fix: Use .chat() to force using OpenAIChatLanguageModel (/chat/completions endpoint)
        // instead of the default which might use /responses endpoint for OpenRouter
        model: this.openaiProvider.chat(this.config.model),
        system: systemPrompt,
        messages: filteredMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        maxOutputTokens: maxTokens,
        temperature,
        // 使用条件展开避免 undefined 问题
        ...(stopSequences && { stopSequences }),
        ...(effectiveAbortSignal && { abortSignal: effectiveAbortSignal }),
      });

      return {
        content: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        stopReason: result.finishReason,
        model: this.config.model,
      };
    } catch (error) {
      if (isDebugEnabled()) {
        console.debug('[OpenAILLMClient] Raw error:', error);
      }
      // 处理 AI SDK 错误
      const err = error as Error & { status?: number; code?: string };
      const statusCode = err.status || 0;
      const message = err.message || '';
      const code = err.code || '';
      const isRetryable = isRetryableError(statusCode, code, message);

      throw new LLMClientError(
        err.message || 'Unknown error',
        this.provider,
        err.code || `HTTP_${statusCode}`,
        isRetryable
      );
    }
  }
}

// ============================================================================
// Mock 客户端（用于测试）
// ============================================================================

/**
 * Mock 响应配置
 */
export interface MockLLMConfig extends LLMClientConfig {
  /** 预设响应列表（按顺序返回） */
  responses?: LLMResponse[] | undefined;
  /** 是否模拟延迟 */
  simulateDelay?: number | undefined;
  /** 是否模拟错误 */
  simulateError?: LLMClientError | undefined;
}

/**
 * Mock LLM 客户端
 *
 * 用于测试的模拟客户端
 */
export class MockLLMClient extends BaseLLMClient {
  readonly provider: LLMProvider = 'mock';
  private responseIndex = 0;
  private readonly responses: LLMResponse[];
  private readonly simulateDelay: number | undefined;
  private readonly simulateError: LLMClientError | undefined;
  private callHistory: LLMRequest[] = [];

  constructor(config: MockLLMConfig) {
    super(config);
    this.responses = config.responses || [];
    this.simulateDelay = config.simulateDelay;
    this.simulateError = config.simulateError;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // 记录调用历史
    this.callHistory.push(request);

    // 模拟延迟
    if (this.simulateDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.simulateDelay));
    }

    // 模拟错误
    if (this.simulateError) {
      throw this.simulateError;
    }

    // 返回预设响应
    if (this.responses.length === 0) {
      return {
        content:
          '{"reasoning": "Mock response", "subtasks": [], "executionPlan": {"isParallel": false, "steps": []}, "estimatedTotalMinutes": 0, "complexityScore": 1}',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: this.config.model,
      };
    }

    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;
    // response 不会是 undefined，因为我们在上面检查了 responses.length === 0
    return response!;
  }

  isAvailable(): boolean {
    return true; // Mock 客户端始终可用
  }

  /**
   * 获取调用历史
   */
  getCallHistory(): LLMRequest[] {
    return [...this.callHistory];
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.responseIndex = 0;
    this.callHistory = [];
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 LLM 客户端
 *
 * @param config - 客户端配置
 * @returns LLM 客户端实例
 */
export function createLLMClient(config: LLMClientConfig): LLMClient {
  const provider = config.provider.toLowerCase();

  switch (provider) {
    case 'anthropic':
      return new AnthropicLLMClient(config);
    case 'openai':
      return new OpenAILLMClient(config);
    case 'mock':
      return new MockLLMClient(config as MockLLMConfig);
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
