/**
 * 压缩策略实现
 *
 * 压缩是可逆的：保留恢复标识符，可按需恢复完整内容
 *
 * 核心原则（来自 Manus）：
 * 1. 双格式设计：每条消息有 fullContent 和 content
 * 2. 可逆压缩：移除大内容，保留参数标识符
 * 3. 渐进压缩：先压缩最老的 50%，保留最新的完整
 *
 * @module context/strategies/compaction
 */

import type {
  ContextMessage,
  CompactionConfig,
  CompactionResult,
  ToolResultCompactionRule,
} from '../types';

// ============================================================================
// 压缩策略
// ============================================================================

/**
 * 压缩策略
 *
 * 实现可逆的上下文压缩，通过移除大内容并保留恢复标识符
 */
export class CompactionStrategy {
  private readonly config: CompactionConfig;

  constructor(config: CompactionConfig) {
    this.config = config;
  }

  /**
   * 压缩消息列表
   *
   * 规则：
   * 1. 保留最后 N 条完整消息（作为少样本示例）
   * 2. 对工具调用，移除大内容，保留恢复标识符
   * 3. 对工具结果，根据工具类型应用不同规则
   */
  compact(
    messages: ContextMessage[],
    estimateTokens: (content: string) => number
  ): CompactionResult {
    const beforeTokens = this.calculateTotalTokens(messages, estimateTokens);
    const recoveryRefs: string[] = [];

    // 计算压缩边界
    const keepFromIndex = Math.max(
      0,
      messages.length - this.config.keepLastN
    );
    const compactToIndex = Math.floor(
      keepFromIndex * this.config.compactRatio
    );

    let compactedCount = 0;

    // 压缩消息
    const compactedMessages = messages.map((msg, index) => {
      // 跳过最后 N 条消息（保持完整）
      if (index >= keepFromIndex) {
        return msg;
      }

      // 只压缩指定范围内的消息
      if (index > compactToIndex) {
        return msg;
      }

      // 已经是紧凑格式，跳过
      if (msg.format === 'compact') {
        return msg;
      }

      // 执行压缩
      const compacted = this.compactMessage(msg);
      if (compacted.format === 'compact' && compacted.recoveryRef) {
        recoveryRefs.push(compacted.recoveryRef);
        compactedCount++;
      }

      return compacted;
    });

    const afterTokens = this.calculateTotalTokens(compactedMessages, estimateTokens);
    const gainRatio = beforeTokens > 0 ? (beforeTokens - afterTokens) / beforeTokens : 0;

    // 更新原消息数组（直接返回新数组，不修改原数组）
    // 注意: 调用方需要使用返回的 compactedMessages
    const result: CompactionResult = {
      success: true,
      beforeTokens,
      afterTokens,
      gainRatio,
      compactedCount,
      recoveryRefs,
    };

    // 就地更新消息
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const compacted = compactedMessages[i];
      if (msg && compacted && compacted !== msg) {
        msg.content = compacted.content;
        msg.format = compacted.format;
        if (compacted.fullContent !== undefined) {
          msg.fullContent = compacted.fullContent;
        }
        if (compacted.recoveryRef !== undefined) {
          msg.recoveryRef = compacted.recoveryRef;
        }
      }
    }

    return result;
  }

  /**
   * 压缩单条消息
   */
  private compactMessage(message: ContextMessage): ContextMessage {
    // 系统消息和用户消息不压缩
    if (message.role === 'system' || message.role === 'user') {
      return message;
    }

    // 工具消息：根据规则压缩
    if (message.role === 'tool' && message.toolResult) {
      return this.compactToolResult(message);
    }

    // 助手消息（工具调用）：压缩输入参数
    if (message.role === 'assistant' && message.toolCall) {
      return this.compactToolCall(message);
    }

    // 普通助手消息：如果内容太长，生成摘要
    if (message.role === 'assistant' && message.content.length > 2000) {
      return this.compactLongContent(message);
    }

    return message;
  }

  /**
   * 压缩工具结果
   */
  private compactToolResult(message: ContextMessage): ContextMessage {
    if (!message.toolResult) {
      return message;
    }

    const toolName = this.extractToolName(message);
    const rule = this.findMatchingRule(toolName);

    if (!rule) {
      return message;
    }

    const output = message.toolResult.output;
    let recoveryRef: string | undefined;
    let compactContent: string;

    switch (rule.handler) {
      case 'keep-path':
        // 文件操作：保留路径
        recoveryRef = this.extractPath(output);
        compactContent = recoveryRef
          ? `[文件内容已压缩，路径: ${recoveryRef}]`
          : message.content;
        break;

      case 'keep-url':
        // 浏览器操作：保留 URL
        recoveryRef = this.extractUrl(output);
        compactContent = recoveryRef
          ? `[网页内容已压缩，URL: ${recoveryRef}]`
          : message.content;
        break;

      case 'keep-query':
        // 搜索操作：保留查询
        recoveryRef = this.extractQuery(output);
        compactContent = recoveryRef
          ? `[搜索结果已压缩，查询: ${recoveryRef}]`
          : message.content;
        break;

      case 'keep-summary':
        // Shell 操作：保留摘要
        compactContent = this.generateSummary(output);
        recoveryRef = `tool:${message.toolResult.callId}`;
        break;

      case 'remove':
        compactContent = '[内容已移除]';
        recoveryRef = `tool:${message.toolResult.callId}`;
        break;

      default:
        return message;
    }

    return {
      ...message,
      fullContent: message.content,
      content: compactContent,
      format: 'compact' as const,
      ...(recoveryRef !== undefined && { recoveryRef }),
    };
  }

  /**
   * 压缩工具调用
   */
  private compactToolCall(message: ContextMessage): ContextMessage {
    if (!message.toolCall) {
      return message;
    }

    const input = message.toolCall.input;
    if (typeof input !== 'object' || input === null) {
      return message;
    }

    // 检查输入是否包含大内容
    const inputStr = JSON.stringify(input);
    if (inputStr.length <= 1000) {
      return message;
    }

    // 提取关键标识符
    const identifiers = this.extractIdentifiers(input as Record<string, unknown>);
    const compactContent = `[调用 ${message.toolCall.name}，参数: ${JSON.stringify(identifiers)}]`;

    return {
      ...message,
      fullContent: message.content,
      content: compactContent,
      format: 'compact',
      recoveryRef: `tool:${message.toolCall.id}`,
    };
  }

  /**
   * 压缩长内容
   */
  private compactLongContent(message: ContextMessage): ContextMessage {
    // 保留前 500 字符 + "..." + 后 200 字符
    const content = message.content;
    const compactContent = `${content.slice(0, 500)}...[已压缩 ${content.length} 字符]...${content.slice(-200)}`;

    return {
      ...message,
      fullContent: content,
      content: compactContent,
      format: 'compact',
      recoveryRef: `msg:${message.id}`,
    };
  }

  /**
   * 从消息恢复完整内容
   */
  recover(message: ContextMessage): ContextMessage {
    if (message.format !== 'compact' || !message.fullContent) {
      return message;
    }

    return {
      ...message,
      content: message.fullContent,
      format: 'full' as const,
    };
  }

  // ========================================
  // 辅助方法
  // ========================================

  private calculateTotalTokens(
    messages: ContextMessage[],
    estimateTokens: (content: string) => number
  ): number {
    return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  }

  private extractToolName(message: ContextMessage): string {
    // 尝试从 toolResult 的 callId 推断工具名
    // 或者从消息内容中提取
    if (message.toolResult?.callId) {
      // 假设 callId 格式为 "toolName_xxx"
      const parts = message.toolResult.callId.split('_');
      if (parts.length > 1 && parts[0]) {
        return parts[0];
      }
    }
    return 'unknown';
  }

  private findMatchingRule(toolName: string): ToolResultCompactionRule | undefined {
    return this.config.toolResultRules.find((rule) => {
      const pattern = rule.toolPattern.replace('*', '.*');
      return new RegExp(`^${pattern}$`).test(toolName);
    });
  }

  private extractPath(output: unknown): string | undefined {
    if (typeof output === 'object' && output !== null) {
      const obj = output as Record<string, unknown>;
      if (typeof obj.path === 'string') return obj.path;
      if (typeof obj.filePath === 'string') return obj.filePath;
    }
    if (typeof output === 'string') {
      const match = output.match(/(?:path|file):\s*["']?([^\s"']+)/i);
      if (match) return match[1];
    }
    return undefined;
  }

  private extractUrl(output: unknown): string | undefined {
    if (typeof output === 'object' && output !== null) {
      const obj = output as Record<string, unknown>;
      if (typeof obj.url === 'string') return obj.url;
    }
    if (typeof output === 'string') {
      const match = output.match(/https?:\/\/[^\s"'<>]+/);
      if (match) return match[0];
    }
    return undefined;
  }

  private extractQuery(output: unknown): string | undefined {
    if (typeof output === 'object' && output !== null) {
      const obj = output as Record<string, unknown>;
      if (typeof obj.query === 'string') return obj.query;
      if (typeof obj.q === 'string') return obj.q;
    }
    return undefined;
  }

  private extractIdentifiers(input: Record<string, unknown>): Record<string, unknown> {
    const identifiers: Record<string, unknown> = {};
    const keyPatterns = ['path', 'url', 'id', 'name', 'query', 'command'];

    for (const [key, value] of Object.entries(input)) {
      if (keyPatterns.some((p) => key.toLowerCase().includes(p))) {
        identifiers[key] = typeof value === 'string' && value.length > 100
          ? value.slice(0, 50) + '...'
          : value;
      }
    }

    return identifiers;
  }

  private generateSummary(output: unknown): string {
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    if (str.length <= 200) {
      return str;
    }

    // 提取关键信息
    const lines = str.split('\n').filter((l) => l.trim());
    const summary = lines.slice(0, 3).join('\n');
    return `${summary}\n... [总计 ${lines.length} 行]`;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建压缩策略
 */
export function createCompactionStrategy(config: CompactionConfig): CompactionStrategy {
  return new CompactionStrategy(config);
}
