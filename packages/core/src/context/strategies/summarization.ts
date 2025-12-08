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
    offloadFn?: (content: string) => Promise<string>
  ): Promise<SummarizationResult> {
    const beforeTokens = this.calculateTotalTokens(messages, estimateTokens);

    // 如果配置了摘要前卸载，先保存完整上下文
    let offloadedPath: string | undefined;
    if (this.config.offloadBeforeSummarize && offloadFn) {
      const fullContext = this.serializeMessages(messages);
      offloadedPath = await offloadFn(fullContext);
    }

    // 确定需要摘要的消息范围
    const summarizeUpTo = Math.max(0, messages.length - this.config.keepLastN);
    const messagesToSummarize = messages.slice(0, summarizeUpTo);
    const messagesToKeep = messages.slice(summarizeUpTo);

    // 生成结构化摘要
    let summary: StructuredSummary;
    if (this.config.mode === 'structured') {
      summary = await llmClient.generateSummary(messagesToSummarize, this.schema);
    } else {
      // 自由形式摘要（转换为结构化格式）
      summary = await this.generateFreeformSummary(messagesToSummarize, llmClient);
    }

    // 创建摘要消息
    const summaryMessage = this.createSummaryMessage(summary, offloadedPath);

    // 替换原消息列表
    messages.length = 0;
    messages.push(summaryMessage, ...messagesToKeep);

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

    return `请分析以下对话历史，并生成结构化摘要。

## 对话历史

${conversationText}

## 摘要格式

请按以下字段结构输出 JSON：

${fieldsDescription}

## 输出要求

1. 使用 JSON 格式输出
2. 确保所有字段都有值（列表可以为空数组）
3. 保持简洁但完整
4. 重点保留关键信息，避免遗漏重要细节`;
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
    offloadedPath?: string
  ): ContextMessage {
    const content = this.formatSummaryAsContent(summary, offloadedPath);

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
    offloadedPath?: string
  ): string {
    const sections: string[] = [];

    sections.push('## 对话摘要\n');

    if (summary.userGoal) {
      sections.push(`### 用户目标\n${summary.userGoal}\n`);
    }

    if (summary.completedSteps.length > 0) {
      sections.push(`### 已完成步骤\n${summary.completedSteps.map((s) => `- ${s}`).join('\n')}\n`);
    }

    if (summary.keyFindings.length > 0) {
      sections.push(`### 关键发现\n${summary.keyFindings.map((f) => `- ${f}`).join('\n')}\n`);
    }

    if (summary.modifiedFiles.length > 0) {
      sections.push(`### 修改的文件\n${summary.modifiedFiles.map((f) => `- ${f}`).join('\n')}\n`);
    }

    if (summary.currentProgress) {
      sections.push(`### 当前进度\n${summary.currentProgress}\n`);
    }

    if (summary.nextSteps.length > 0) {
      sections.push(`### 下一步计划\n${summary.nextSteps.map((s) => `- ${s}`).join('\n')}\n`);
    }

    if (summary.errors.length > 0) {
      sections.push(`### 错误/警告\n${summary.errors.map((e) => `⚠️ ${e}`).join('\n')}\n`);
    }

    if (summary.lastStopPoint) {
      sections.push(`### 最后停止位置\n${summary.lastStopPoint}\n`);
    }

    if (offloadedPath) {
      sections.push(`\n> 完整对话历史已保存到: ${offloadedPath}\n`);
    }

    return sections.join('\n');
  }

  private validateAndNormalize(parsed: Partial<StructuredSummary>): StructuredSummary {
    return {
      userGoal: parsed.userGoal || '',
      completedSteps: Array.isArray(parsed.completedSteps) ? parsed.completedSteps : [],
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
      modifiedFiles: Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : [],
      currentProgress: parsed.currentProgress || '',
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      lastStopPoint: parsed.lastStopPoint || '',
    };
  }

  private createDefaultSummary(rawResponse: string): StructuredSummary {
    return {
      userGoal: '未能解析用户目标',
      completedSteps: [],
      keyFindings: [rawResponse.slice(0, 500)],
      modifiedFiles: [],
      currentProgress: '摘要解析失败，请查看原始响应',
      nextSteps: [],
      errors: ['摘要解析失败'],
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
