/**
 * 摘要策略实现
 *
 * 摘要是不可逆的：使用 LLM 生成结构化摘要
 *
 * 核心原则（来自 Manus + Anthropic）：
 * 1. 结构化模式：使用固定 schema，不是自由形式
 * 2. 摘要前卸载：将完整上下文转储到日志文件
 * 3. 保留最后 N 条：摘要后仍保留最新消息完整内容
 *
 * @module context/strategies/summarization
 */

import type {
  ContextMessage,
  SummarizationConfig,
  SummarizationResult,
  StructuredSummary,
} from '../types';
import { detectUserLanguage, type LanguageCode } from '../language';

// ============================================================================
// 摘要策略
// ============================================================================

/**
 * LLM 客户端接口（用于生成摘要）
 */
export interface SummarizationLLMClient {
  /**
   * 生成结构化摘要
   */
  generateSummary(
    messages: ContextMessage[],
    schema: StructuredSummarySchema
  ): Promise<StructuredSummary>;

  /**
   * 生成自由形式文本（用于 freeform 模式）
   */
  generateText?(prompt: string): Promise<string>;
}

/**
 * 日志记录器接口
 */
export interface SummarizationLogger {
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/**
 * 结构化摘要 Schema
 */
export interface StructuredSummarySchema {
  fields: (keyof StructuredSummary)[];
  descriptions: Record<keyof StructuredSummary, string>;
}

/**
 * 默认摘要 Schema
 */
export const DEFAULT_SUMMARY_SCHEMA: StructuredSummarySchema = {
  fields: [
    'userGoal',
    'constraints',
    'completedSteps',
    'keyFindings',
    'modifiedFiles',
    'currentProgress',
    'nextSteps',
    'errors',
    'lastStopPoint',
  ],
  descriptions: {
    userGoal: '用户的目标或请求',
    constraints: '关键约束或偏好（例如必须/禁止/限定范围）',
    completedSteps: '已完成的关键步骤列表',
    keyFindings: '关键发现或结果',
    modifiedFiles: '修改过的文件路径列表',
    currentProgress: '当前进度描述',
    nextSteps: '下一步计划',
    errors: '重要的错误或警告',
    lastStopPoint: '最后停止的位置',
  },
};

/**
 * 摘要策略
 *
 * 实现上下文摘要，通过 LLM 生成结构化摘要
 */
export class SummarizationStrategy {
  private readonly config: SummarizationConfig;
  private readonly schema: StructuredSummarySchema;
  private readonly logger: SummarizationLogger;

  constructor(
    config: SummarizationConfig,
    schema?: StructuredSummarySchema,
    logger?: SummarizationLogger
  ) {
    this.config = config;
    this.logger = logger ?? console;
    
    // Schema 优先级：
    // 1. 如果传入了 schema，优先使用
    // 2. 如果 config.fields 存在，基于传入的 schema 或默认 schema 构建自定义版本
    // 3. 否则使用默认 schema
    if (schema) {
      // 传入的 schema 优先
      if (config.fields && config.fields.length > 0) {
        // 如果同时指定了 fields，过滤传入的 schema
        this.schema = this.filterSchema(schema, config.fields);
      } else {
        this.schema = schema;
      }
    } else if (config.fields && config.fields.length > 0) {
      // 没有传入 schema，但有 fields，构建自定义 schema
      this.schema = this.buildCustomSchema(config.fields);
    } else {
      // 使用默认 schema
      this.schema = DEFAULT_SUMMARY_SCHEMA;
    }
  }

  /**
   * 根据字段过滤 Schema
   * 
   * 保留传入 schema 的所有描述信息，仅过滤字段列表
   */
  private filterSchema(
    baseSchema: StructuredSummarySchema,
    fields: (keyof StructuredSummary)[]
  ): StructuredSummarySchema {
    // 保留原 schema 的描述信息
    return {
      fields,
      descriptions: baseSchema.descriptions,
    };
  }

  /**
   * 根据配置的字段构造自定义 Schema
   */
  private buildCustomSchema(fields: (keyof StructuredSummary)[]): StructuredSummarySchema {
    const descriptions: Record<keyof StructuredSummary, string> = {
      userGoal: '用户的目标或请求',
      constraints: '关键约束或偏好（例如必须/禁止/限定范围）',
      completedSteps: '已完成的关键步骤列表',
      keyFindings: '关键发现或结果',
      modifiedFiles: '修改过的文件路径列表',
      currentProgress: '当前进度描述',
      nextSteps: '下一步计划',
      errors: '重要的错误或警告',
      lastStopPoint: '最后停止的位置',
    };

    return {
      fields,
      descriptions,
    };
  }

  /**
   * 生成摘要
   *
   * @param messages - 要摘要的消息列表
   * @param llmClient - LLM 客户端（用于生成摘要）
   * @param offloadFn - 卸载函数（可选，用于摘要前保存完整上下文）
   */
  async summarize(
    messages: ContextMessage[],
    llmClient: SummarizationLLMClient,
    estimateTokens: (content: string) => number,
    offloadFn?: (content: string) => Promise<string>,
    language: LanguageCode = detectUserLanguage(messages)
  ): Promise<SummarizationResult> {
    const beforeTokens = this.calculateTotalTokens(messages, estimateTokens);

    // 如果配置了摘要前卸载，先保存完整上下文
    let offloadedPath: string | undefined;
    if (this.config.offloadBeforeSummarize && offloadFn) {
      try {
        const fullContext = this.serializeMessages(messages);
        offloadedPath = await offloadFn(fullContext);
      } catch (error) {
        // Offload is best-effort; do not fail summarization due to logging issues.
        this.logger.warn('[SummarizationStrategy] Pre-summarization offload failed (continuing):', error);
      }
    }

    // 确定需要摘要的消息范围
    const summarizeUpTo = Math.max(0, messages.length - this.config.keepLastN);

    // Nothing to summarize: avoid adding extra messages (would increase token count).
    if (summarizeUpTo <= 0) {
      this.logger.warn('[SummarizationStrategy] summarizeUpTo <= 0; skipping summarization');
      return {
        success: false,
        summary: this.createDefaultSummary(
          'Summarization skipped: no messages eligible for summarization.',
          language
        ),
        beforeTokens,
        afterTokens: beforeTokens,
        ...(offloadedPath !== undefined && { offloadedPath }),
      };
    }
    
    // Pin task context to reduce the chance of losing critical requirements.
    // NOTE: Keep the pinned content compact (avoid pinning tool lists, large logs, etc.).
    const pinnedTask = this.findPinnedTaskContext(messages, summarizeUpTo, language);

    // 构建待摘要列表（排除 pinned task context source + existing pinned message）
    const messagesToSummarize = messages
      .slice(0, summarizeUpTo)
      .filter((m) => !pinnedTask?.excludedMessages.includes(m));
      
    const messagesToKeep = messages.slice(summarizeUpTo);

    // If the only eligible messages are excluded/pinned, do not generate a summary.
    if (messagesToSummarize.length === 0) {
      this.logger.warn('[SummarizationStrategy] No eligible messages to summarize after exclusions; skipping summarization');
      return {
        success: false,
        summary: this.createDefaultSummary(
          'Summarization skipped: no eligible messages to summarize after exclusions.',
          language
        ),
        beforeTokens,
        afterTokens: beforeTokens,
        ...(offloadedPath !== undefined && { offloadedPath }),
      };
    }

    // 生成结构化摘要
    let summary: StructuredSummary;
    try {
      if (this.config.mode === 'structured') {
        summary = await llmClient.generateSummary(messagesToSummarize, this.schema);
      } else {
        // 自由形式摘要（转换为结构化格式）
        summary = await this.generateFreeformSummary(messagesToSummarize, llmClient);
      }
    } catch (error) {
      this.logger.warn('[SummarizationStrategy] Summarization LLM call failed:', error);
      return {
        success: false,
        summary: this.createDefaultSummary(
          `Summarization failed: ${(error as Error)?.message ?? String(error)}`,
          language
        ),
        beforeTokens,
        afterTokens: beforeTokens,
        ...(offloadedPath !== undefined && { offloadedPath }),
      };
    }

    // 创建摘要消息
    const summaryMessage = this.createSummaryMessage(summary, offloadedPath, language);

    // 替换原消息列表
    const rebuilt: ContextMessage[] = [];
    // Rebuild: [Pinned Task Context] -> [Summary] -> [Recent]
    if (pinnedTask?.pinnedMessage) {
      rebuilt.push(pinnedTask.pinnedMessage);
    }
    rebuilt.push(summaryMessage, ...messagesToKeep);

    messages.length = 0;
    messages.push(...rebuilt);

    const afterTokens = this.calculateTotalTokens(messages, estimateTokens);

    return {
      success: true,
      summary,
      beforeTokens,
      afterTokens,
      ...(offloadedPath !== undefined && { offloadedPath }),
    };
  }

  /**
   * 构建摘要提示
   */
  buildSummarizationPrompt(messages: ContextMessage[]): string {
    const conversationText = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n\n');

    const fieldsDescription = this.schema.fields
      .map((f) => `- ${f}: ${this.schema.descriptions[f]}`)
      .join('\n');

    return `Analyze the following conversation history and produce a structured summary as JSON.

## Conversation History

${conversationText}

## Output Schema

Return a JSON object with the following fields (use these exact keys):

${fieldsDescription}

## Requirements

1. Output JSON only (no additional prose).
2. Every field must be present (arrays may be empty).
3. Be concise but complete.
4. Preserve critical requirements/constraints from the user.
5. Use the same language as the source messages for field values whenever possible.

## Guidance
- Include key constraints, decisions, progress, and next steps.
- Exclude verbose tool outputs and raw logs unless they contain critical errors.`;
  }

  /**
   * 解析摘要响应
   */
  parseSummaryResponse(response: string): StructuredSummary {
    // 尝试提取 JSON
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch?.[1] ?? response;

    try {
      const parsed = JSON.parse(jsonStr.trim()) as Partial<StructuredSummary>;
      return this.validateAndNormalize(parsed);
    } catch {
      // 解析失败，返回默认摘要
      return this.createDefaultSummary(response);
    }
  }

  // ========================================
  // 私有方法
  // ========================================

  private calculateTotalTokens(
    messages: ContextMessage[],
    estimateTokens: (content: string) => number
  ): number {
    return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  }

  private serializeMessages(messages: ContextMessage[]): string {
    return messages
      .map((m) => JSON.stringify({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolCall: m.toolCall,
        toolResult: m.toolResult,
      }))
      .join('\n');
  }

  private async generateFreeformSummary(
    messages: ContextMessage[],
    llmClient: SummarizationLLMClient
  ): Promise<StructuredSummary> {
    // 如果 LLM 客户端支持文本生成，使用提示词生成自由形式摘要然后解析
    if (llmClient.generateText) {
      const prompt = this.buildSummarizationPrompt(messages);
      try {
        const response = await llmClient.generateText(prompt);
        const summary = this.parseSummaryResponse(response);
        return summary;
      } catch (error) {
        // 解析失败，记录日志并回退到结构化模式
        this.logger.warn('[SummarizationStrategy] Freeform parsing failed, falling back to structured mode:', error);
        return llmClient.generateSummary(messages, this.schema);
      }
    }

    // 回退：使用结构化模式
    return llmClient.generateSummary(messages, this.schema);
  }

  private createSummaryMessage(
    summary: StructuredSummary,
    offloadedPath?: string,
    language: LanguageCode = 'en'
  ): ContextMessage {
    const content = this.formatSummaryAsContent(summary, offloadedPath, language);

    return {
      id: `summary-${Date.now()}`,
      role: 'system',
      content,
      timestamp: Date.now(),
      format: 'full',
    };
  }

  private formatSummaryAsContent(
    summary: StructuredSummary,
    offloadedPath?: string,
    language: LanguageCode = 'en'
  ): string {
    const parts: string[] = [];
    parts.push(language === 'zh' ? '对话摘要（非指令性，仅供上下文参考）：' : 'Conversation summary (non-instructional):');
    parts.push('```json');
    parts.push(JSON.stringify(summary, null, 2));
    parts.push('```');
    if (offloadedPath) {
      parts.push(
        language === 'zh'
          ? `完整对话历史已卸载至：${offloadedPath}`
          : `Offloaded full context: ${offloadedPath}`
      );
    }
    return parts.join('\n');
  }

  private validateAndNormalize(parsed: Partial<StructuredSummary>): StructuredSummary {
    return {
      userGoal: parsed.userGoal || '',
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      completedSteps: Array.isArray(parsed.completedSteps) ? parsed.completedSteps : [],
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
      modifiedFiles: Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : [],
      currentProgress: parsed.currentProgress || '',
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      lastStopPoint: parsed.lastStopPoint || '',
    };
  }

  private isPinnedTaskMessage(message: ContextMessage): boolean {
    return message.role === 'system' && message.id.startsWith('pinned-task-');
  }

  private extractTaskContext(raw: string): string | null {
    const taskIndex = raw.indexOf('Task:');
    if (taskIndex === -1) return null;

    let text = raw.slice(taskIndex);

    const toolsIndex = text.indexOf('Available tools:');
    if (toolsIndex !== -1) {
      text = text.slice(0, toolsIndex);
    }

    text = text.trim();
    if (text.length === 0) return null;

    const maxChars = 2000;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars).trimEnd() + '\n\n[Truncated]';
    }

    return text;
  }

  private findPinnedTaskContext(
    messages: ContextMessage[],
    summarizeUpTo: number,
    language: LanguageCode
  ): { pinnedMessage?: ContextMessage; excludedMessages: ContextMessage[] } | null {
    const excludedMessages: ContextMessage[] = [];

    // Preserve existing pinned task context message (if any).
    const existingPinned = messages.find((m, i) => i < summarizeUpTo && this.isPinnedTaskMessage(m));
    if (existingPinned) {
      excludedMessages.push(existingPinned);
      return { pinnedMessage: existingPinned, excludedMessages };
    }

    // Heuristic: detect the initial task specification message produced by some backends.
    const taskMessageIndex = messages.findIndex(
      (m, i) => i < summarizeUpTo && m.role === 'user' && m.content.includes('Task:')
    );
    if (taskMessageIndex === -1) {
      return null;
    }

    const taskMessage = messages[taskMessageIndex];
    if (!taskMessage) {
      return null;
    }

    const extracted = this.extractTaskContext(taskMessage.content);
    if (!extracted) {
      return null;
    }

    excludedMessages.push(taskMessage);

    const pinnedMessage: ContextMessage = {
      id: `pinned-task-${Date.now()}`,
      role: 'system',
      content:
        language === 'zh'
          ? `任务上下文（固定保留）：\n\n${extracted}`
          : `Task context (pinned):\n\n${extracted}`,
      timestamp: Date.now(),
      format: 'full',
    };

    return { pinnedMessage, excludedMessages };
  }

  private createDefaultSummary(rawResponse: string, language: LanguageCode = 'zh'): StructuredSummary {
    const userGoal = language === 'zh' ? '未能解析用户目标' : 'Unable to parse user goal';
    const currentProgress =
      language === 'zh'
        ? '摘要失败，请查看原始响应'
        : 'Summarization failed; see raw response for details.';
    const errorLabel = language === 'zh' ? '摘要解析失败' : 'Summarization parsing failed';

    return {
      userGoal,
      constraints: [],
      completedSteps: [],
      keyFindings: [rawResponse.slice(0, 500)],
      modifiedFiles: [],
      currentProgress,
      nextSteps: [],
      errors: [errorLabel],
      lastStopPoint: '',
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建摘要策略
 */
export function createSummarizationStrategy(
  config: SummarizationConfig,
  schema?: StructuredSummarySchema,
  logger?: SummarizationLogger
): SummarizationStrategy {
  return new SummarizationStrategy(config, schema, logger);
}
