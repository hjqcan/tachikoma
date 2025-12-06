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
    public retryable: boolean = false
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'LLMClientError';
  }
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

  constructor(config: LLMClientConfig) {
    super(config);
    // 创建 Anthropic provider 实例，使用条件展开避免 undefined 问题
    this.anthropicProvider = createAnthropic({
      ...(config.apiKey && { apiKey: config.apiKey }),
      ...(config.baseUrl && { baseURL: config.baseUrl }),
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

    try {
      const result = await generateText({
        model: this.anthropicProvider(this.config.model),
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
      // 处理 AI SDK 错误
      const err = error as Error & { status?: number; code?: string };
      const statusCode = err.status || 0;
      const isRetryable = statusCode >= 500 || statusCode === 429;

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

    // P0 修复：过滤 messages 中的 system 角色，避免与 systemPrompt 双重发送
    const filteredMessages = messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    );

    // 确定 AbortSignal：优先使用外部传入的，否则使用配置的 timeout
    const effectiveAbortSignal =
      abortSignal ??
      (this.config.timeout ? AbortSignal.timeout(this.config.timeout) : undefined);

    try {
      const result = await generateText({
        model: this.openaiProvider(this.config.model),
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
      // 处理 AI SDK 错误
      const err = error as Error & { status?: number; code?: string };
      const statusCode = err.status || 0;
      const isRetryable = statusCode >= 500 || statusCode === 429;

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
