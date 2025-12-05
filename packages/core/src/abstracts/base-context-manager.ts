/**
 * ContextManager 抽象基类
 *
 * 提供 ContextManager 接口的基础实现，处理通用字段和上下文管理逻辑
 */

import type {
  ContextManager,
  ContextThresholds,
  ConversationContext,
  ConversationSummary,
  Message,
  ToolCallRecord,
  CompactionStrategy,
  SummarySchema,
} from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * ContextManager 生命周期钩子
 */
export interface ContextManagerHooks {
  /** 添加消息后调用 */
  onMessageAdded?(message: Message): void;
  /** 执行压缩前调用 */
  onBeforeCompact?(strategy: CompactionStrategy): void;
  /** 执行压缩后调用 */
  onAfterCompact?(removedCount: number): void;
  /** 生成摘要后调用 */
  onSummarized?(summary: ConversationSummary): void;
  /** 达到阈值时调用 */
  onThresholdReached?(threshold: 'compaction' | 'summarization' | 'rot' | 'hard'): void;
}

/**
 * ContextManager 日志上下文
 */
export interface ContextManagerLogContext {
  sessionId: string;
  messageCount: number;
  tokenCount: number;
  thresholdStatus: {
    compactionTriggered: boolean;
    summarizationTriggered: boolean;
    rotThresholdReached: boolean;
    hardLimitReached: boolean;
  };
  [key: string]: unknown;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成唯一 ID
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 估算文本的 token 数量
 * 简单实现，实际应使用 tiktoken 等库
 */
function estimateTokens(text: string): number {
  // 粗略估算：平均每 4 个字符一个 token
  return Math.ceil(text.length / 4);
}

// ============================================================================
// 抽象基类
// ============================================================================

/**
 * ContextManager 抽象基类
 *
 * 提供通用的上下文管理、消息存储和阈值监控
 *
 * @example
 * ```ts
 * class RedisContextManager extends BaseContextManager {
 *   constructor(sessionId: string, thresholds: ContextThresholds) {
 *     super(sessionId, thresholds);
 *   }
 *
 *   protected async doCompact(strategy: CompactionStrategy): Promise<number> {
 *     // Redis 特定的压缩逻辑
 *   }
 *
 *   protected async doSummarize(schema: SummarySchema): Promise<ConversationSummary> {
 *     // 使用 LLM 生成摘要
 *   }
 * }
 * ```
 */
export abstract class BaseContextManager implements ContextManager {
  /** 会话 ID */
  protected readonly sessionId: string;

  /** 阈值配置 */
  protected readonly thresholds: ContextThresholds;

  /** 消息列表 */
  protected messages: Message[] = [];

  /** 工具调用记录 */
  protected toolCalls: ToolCallRecord[] = [];

  /** 当前 token 数量 */
  protected tokenCount = 0;

  /** 摘要（如果已生成） */
  protected summary?: ConversationSummary;

  /** 生命周期钩子 */
  protected hooks: ContextManagerHooks = {};

  constructor(sessionId: string, thresholds: ContextThresholds) {
    this.sessionId = sessionId;
    this.thresholds = thresholds;
  }

  // ==========================================================================
  // 公共方法
  // ==========================================================================

  /**
   * 获取当前上下文
   */
  getContext(): ConversationContext {
    const context: ConversationContext = {
      sessionId: this.sessionId,
      messages: [...this.messages],
      toolCalls: [...this.toolCalls],
      tokenCount: this.tokenCount,
    };

    // 只有在有摘要时才添加 summary 属性
    if (this.summary !== undefined) {
      context.summary = this.summary;
    }

    return context;
  }

  /**
   * 添加消息
   */
  addMessage(message: Message): void {
    // 确保消息有 ID
    const msg: Message = {
      ...message,
      id: message.id || generateId('msg'),
      timestamp: message.timestamp || Date.now(),
    };

    // 添加消息
    this.messages.push(msg);

    // 更新 token 计数
    const messageTokens = estimateTokens(msg.content);
    this.tokenCount += messageTokens;

    // 如果是工具消息，记录工具调用
    if (msg.role === 'tool' && msg.toolCall) {
      this.toolCalls.push(msg.toolCall);
    }

    // 调用钩子
    this.hooks.onMessageAdded?.(msg);

    // 检查阈值
    this.checkThresholds();
  }

  /**
   * 执行压缩
   */
  compact(strategy: CompactionStrategy): void {
    this.hooks.onBeforeCompact?.(strategy);

    const removedCount = this.doCompact(strategy);

    // 重新计算 token 数量
    this.tokenCount = this.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0
    );

    this.hooks.onAfterCompact?.(removedCount);
  }

  /**
   * 生成摘要
   */
  summarize(schema: SummarySchema): ConversationSummary {
    const summary = this.doSummarize(schema);
    this.summary = summary;
    this.hooks.onSummarized?.(summary);
    return summary;
  }

  /**
   * 获取 token 数量
   */
  getTokenCount(): number {
    return this.tokenCount;
  }

  // ==========================================================================
  // 状态和上下文方法
  // ==========================================================================

  /**
   * 获取日志上下文
   */
  getLogContext(): ContextManagerLogContext {
    return {
      sessionId: this.sessionId,
      messageCount: this.messages.length,
      tokenCount: this.tokenCount,
      thresholdStatus: {
        compactionTriggered: this.tokenCount >= this.thresholds.compactionTrigger,
        summarizationTriggered: this.tokenCount >= this.thresholds.summarizationTrigger,
        rotThresholdReached: this.tokenCount >= this.thresholds.rotThreshold,
        hardLimitReached: this.tokenCount >= this.thresholds.hardLimit,
      },
    };
  }

  /**
   * 设置生命周期钩子
   */
  setHooks(hooks: ContextManagerHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /**
   * 获取最近的消息
   */
  getRecentMessages(count: number): Message[] {
    return this.messages.slice(-count);
  }

  /**
   * 获取最近的工具调用
   */
  getRecentToolCalls(count?: number): ToolCallRecord[] {
    const limit = count ?? this.thresholds.preserveRecentToolCalls;
    return this.toolCalls.slice(-limit);
  }

  /**
   * 清空上下文
   */
  clear(): void {
    this.messages = [];
    this.toolCalls = [];
    this.tokenCount = 0;
    delete this.summary;
  }

  // ==========================================================================
  // 保护方法
  // ==========================================================================

  /**
   * 检查并触发阈值通知
   */
  protected checkThresholds(): void {
    if (this.tokenCount >= this.thresholds.hardLimit) {
      this.hooks.onThresholdReached?.('hard');
    } else if (this.tokenCount >= this.thresholds.rotThreshold) {
      this.hooks.onThresholdReached?.('rot');
    } else if (this.tokenCount >= this.thresholds.summarizationTrigger) {
      this.hooks.onThresholdReached?.('summarization');
    } else if (this.tokenCount >= this.thresholds.compactionTrigger) {
      this.hooks.onThresholdReached?.('compaction');
    }
  }

  // ==========================================================================
  // 抽象方法（子类必须实现）
  // ==========================================================================

  /**
   * 执行压缩的具体逻辑
   * @param strategy - 压缩策略
   * @returns 移除的消息数量
   */
  protected abstract doCompact(strategy: CompactionStrategy): number;

  /**
   * 生成摘要的具体逻辑
   * @param schema - 摘要 Schema
   * @returns 生成的摘要
   */
  protected abstract doSummarize(schema: SummarySchema): ConversationSummary;
}

// ============================================================================
// 简单实现
// ============================================================================

/**
 * 简单的 ContextManager 实现
 *
 * 提供基础的压缩和摘要功能
 */
export class SimpleContextManager extends BaseContextManager {
  constructor(sessionId: string, thresholds: ContextThresholds) {
    super(sessionId, thresholds);
  }

  /**
   * 简单的压缩实现：移除旧消息
   */
  protected doCompact(strategy: CompactionStrategy): number {
    const keepCount = strategy === 'aggressive' ? 5 : strategy === 'balanced' ? 10 : 20;
    const originalCount = this.messages.length;

    if (this.messages.length > keepCount) {
      // 保留系统消息和最近的消息
      const systemMessages = this.messages.filter(m => m.role === 'system');
      const recentMessages = this.messages.slice(-keepCount);

      // 合并，避免重复
      const systemIds = new Set(systemMessages.map(m => m.id));
      this.messages = [
        ...systemMessages,
        ...recentMessages.filter(m => !systemIds.has(m.id)),
      ];
    }

    return originalCount - this.messages.length;
  }

  /**
   * 简单的摘要实现：提取基本信息
   */
  protected doSummarize(schema: SummarySchema): ConversationSummary {
    // 提取用户消息作为目标
    const userMessages = this.messages.filter(m => m.role === 'user');
    const firstUserMessage = userMessages[0];
    const userGoal = schema.includeUserGoal && firstUserMessage
      ? firstUserMessage.content.slice(0, 200)
      : '';

    // 获取最后一条消息作为停止点
    const lastMessage = this.messages[this.messages.length - 1];
    const lastStopPoint = lastMessage
      ? `Last message from ${lastMessage.role}: ${lastMessage.content.slice(0, 100)}...`
      : 'No messages';

    return {
      modifiedFiles: schema.includeModifiedFiles ? [] : [],
      userGoal,
      lastStopPoint,
      keyDecisions: schema.includeKeyDecisions ? [] : [],
      unresolvedIssues: schema.includeUnresolvedIssues ? [] : [],
      nextSteps: schema.includeNextSteps ? [] : [],
    };
  }
}

