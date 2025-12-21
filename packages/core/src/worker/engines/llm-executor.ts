/**
 * LLM Executor Engine
 *
 * 封装 LLM 调用逻辑，包括：
 * - 错误重试
 * - 请求参数预处理
 * - Token 使用统计
 */

import type { LLMClient, LLMRequest, LLMResponse } from '../../planner/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * LLM Executor 配置
 */
export interface LLMExecutorConfig {
  maxRetries?: number;
  retryDelays?: number[];
}

/**
 * 默认配置
 */
export const DEFAULT_LLM_EXECUTOR_CONFIG: LLMExecutorConfig = {
  maxRetries: 3,
  retryDelays: [1000, 2000, 4000],
};

// ============================================================================
// LLM Executor
// ============================================================================

/**
 * LLM Executor
 * 
 * 负责可靠地执行 LLM 请求
 */
export class LLMExecutor {
  private config: LLMExecutorConfig;

  constructor(
    private readonly llmClient: LLMClient,
    config: LLMExecutorConfig = {}
  ) {
    this.config = { ...DEFAULT_LLM_EXECUTOR_CONFIG, ...config };
  }

  /**
   * 执行 LLM 请求（带重试逻辑）
   */
  async executeWithRetry(request: LLMRequest): Promise<LLMResponse> {
    const maxRetries = this.config.maxRetries ?? 3;
    const retryDelays = this.config.retryDelays ?? [1000, 2000, 4000];
    
    let lastError: Error | null = null;
    let response: LLMResponse | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await this.llmClient.complete(request);

        // 检测空响应（允许纯工具调用）
        const hasContent = !!response.content && response.content.trim().length > 0;
        const hasToolCalls = !!response.toolCalls && response.toolCalls.length > 0;
        if (!hasContent && !hasToolCalls) {
          throw new Error('LLM returned empty response');
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (!this.isRetryableError(lastError) || attempt >= maxRetries - 1) {
          console.error(
            `[LLMExecutor] LLM call failed after ${attempt + 1} attempt(s): ${lastError.message}`
          );
          throw lastError;
        }

        const delay = retryDelays[attempt] ?? 4000;
        console.warn(
          `[LLMExecutor] LLM call failed (attempt ${attempt + 1}/${maxRetries}): ` +
          `${lastError.message}. Retrying in ${delay}ms...`
        );
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new Error('LLM retry failed unknown reason');
  }

  /**
   * 判断错误是否可重试
   */
  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: Error): boolean {
    return isRetryableError(error);
  }
}

/**
 * 判断错误是否可重试 (Helper)
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  
  // Prefer explicit retryable hints when provided by upstream clients.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const retryableFlag = (error as any).retryable === true;
  
  return (
    retryableFlag ||
    message.includes('empty response') ||
    message.includes('json parse') ||
    message.includes('api_error') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('socket connection was closed')
  );
}

/**
 * 创建 LLM Executor
 */
export function createLLMExecutor(
  llmClient: LLMClient,
  config?: LLMExecutorConfig
): LLMExecutor {
  return new LLMExecutor(llmClient, config);
}
