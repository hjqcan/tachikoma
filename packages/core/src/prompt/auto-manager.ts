/**
 * 自动上下文管理器
 *
 * 实现自动化的上下文压缩和摘要，无需调用方显式触发
 *
 * @module prompt/auto-manager
 */

import type { PromptContextEngine } from './prompt-engine';
import type { CompactionResult, SummarizationResult } from './types';

// ============================================================================
// 配置类型
// ============================================================================

/**
 * 自动上下文管理配置
 */
export interface AutoContextConfig {
  /** 是否启用自动压缩 */
  autoCompact: boolean;

  /** 是否启用自动摘要 */
  autoSummarize: boolean;

  /** 压缩检查间隔（消息数） */
  compactCheckInterval: number;

  /**
   * 异步执行还是同步阻塞
   *
   * - true: 异步执行，不阻塞消息添加（当前仅保持一个 pending reduction）
   * - false: 同步阻塞，待压缩完成后返回
   */
  asyncMode: boolean;

  /** 压缩前回调 */
  onBeforeCompact?: () => void;

  /** 压缩完成回调 */
  onCompacted?: (result: CompactionResult) => void;

  /** 摘要完成回调 */
  onSummarized?: (result: SummarizationResult) => void;

  /** 错误回调 */
  onError?: (error: Error) => void;
}

/**
 * 默认自动上下文管理配置
 */
export const DEFAULT_AUTO_CONTEXT_CONFIG: AutoContextConfig = {
  autoCompact: true,
  autoSummarize: true,
  compactCheckInterval: 5, // 每 5 条消息检查一次
  asyncMode: true,
};

// ============================================================================
// 自动上下文管理器
// ============================================================================

/**
 * 自动上下文管理器
 *
 * 监控上下文大小并自动触发压缩/摘要
 */
export class AutoContextManager {
  private readonly config: AutoContextConfig;
  private readonly engine: PromptContextEngine;

  // 状态
  private messagesSinceLastCheck = 0;
  private pendingReduction: Promise<void> | null = null;
  private isReducing = false;

  // 指标
  private autoCompactCount = 0;
  private autoSummarizeCount = 0;
  private totalTokensSaved = 0;

  constructor(
    engine: PromptContextEngine,
    config: Partial<AutoContextConfig> = {}
  ) {
    this.engine = engine;
    this.config = { ...DEFAULT_AUTO_CONTEXT_CONFIG, ...config };
  }

  // ========================================
  // 消息钩子
  // ========================================

  /**
   * 消息添加后的钩子
   *
   * 在每次添加消息后调用此方法以触发自动检查
   */
  async onMessageAdded(): Promise<void> {
    this.messagesSinceLastCheck++;

    // 检查是否达到检查间隔
    if (this.messagesSinceLastCheck < this.config.compactCheckInterval) {
      return;
    }

    this.messagesSinceLastCheck = 0;

    // 检查是否需要压缩
    if (!this.config.autoCompact || !this.engine.needsReduction()) {
      return;
    }

    // 如果已经在压缩中，跳过
    if (this.isReducing) {
      return;
    }

    // 执行压缩/摘要
    if (this.config.asyncMode) {
      // 异步执行，不阻塞
      this.pendingReduction = this.executeReduction().catch((error) => {
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    } else {
      // 同步阻塞
      await this.executeReduction();
    }
  }

  /**
   * 获取上下文前确保压缩完成
   *
   * 在调用 engine.getContext() 之前调用此方法
   */
  async waitForPendingReduction(): Promise<void> {
    if (this.pendingReduction) {
      await this.pendingReduction;
      this.pendingReduction = null;
    }
  }

  /**
   * 强制执行压缩检查
   *
   * 不等待间隔，立即检查并执行压缩
   */
  async forceCheck(): Promise<CompactionResult | SummarizationResult | null> {
    if (!this.engine.needsReduction()) {
      return null;
    }

    return this.executeReductionWithResult();
  }

  // ========================================
  // 指标
  // ========================================

  /**
   * 获取自动管理指标
   */
  getMetrics(): AutoContextMetrics {
    return {
      autoCompactCount: this.autoCompactCount,
      autoSummarizeCount: this.autoSummarizeCount,
      totalTokensSaved: this.totalTokensSaved,
      isReducing: this.isReducing,
      hasPendingReduction: this.pendingReduction !== null,
    };
  }

  /**
   * 重置指标
   */
  resetMetrics(): void {
    this.autoCompactCount = 0;
    this.autoSummarizeCount = 0;
    this.totalTokensSaved = 0;
  }

  // ========================================
  // 私有方法
  // ========================================

  private async executeReduction(): Promise<void> {
    await this.executeReductionWithResult();
  }

  private async executeReductionWithResult(): Promise<CompactionResult | SummarizationResult | null> {
    if (this.isReducing) {
      return null;
    }

    this.isReducing = true;

    try {
      this.config.onBeforeCompact?.();

      const result = await this.engine.autoReduce();

      if (result) {
        // 计算节省的 token
        const tokensSaved = result.beforeTokens - result.afterTokens;
        this.totalTokensSaved += tokensSaved;

        // 判断是压缩还是摘要
        if ('summary' in result) {
          this.autoSummarizeCount++;
          this.config.onSummarized?.(result);
        } else {
          this.autoCompactCount++;
          this.config.onCompacted?.(result);
        }
      }

      return result;
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      return null;
    } finally {
      this.isReducing = false;
    }
  }
}

/**
 * 自动管理指标
 */
export interface AutoContextMetrics {
  /** 自动压缩次数 */
  autoCompactCount: number;

  /** 自动摘要次数 */
  autoSummarizeCount: number;

  /** 总共节省的 token 数 */
  totalTokensSaved: number;

  /** 是否正在执行压缩 */
  isReducing: boolean;

  /** 是否有待处理的压缩 */
  hasPendingReduction: boolean;
}

// ============================================================================
// 智能压缩决策
// ============================================================================

/**
 * 智能压缩决策器
 *
 * 基于消息重要性评分决定压缩顺序
 */
export class SmartCompactionDecider {
  /**
   * 计算消息重要性分数
   *
   * @param message - 消息内容
   * @param role - 消息角色
   * @param index - 消息索引
   * @param total - 总消息数
   * @returns 重要性分数 (0-100)
   */
  calculateImportance(
    content: string,
    role: string,
    index: number,
    total: number
  ): number {
    let score = 0;

    // 1. 位置权重：最新的消息更重要 (0-30 分)
    const recencyWeight = index / Math.max(1, total - 1);
    score += recencyWeight * 30;

    // 2. 角色权重 (0-40 分)
    const roleWeights: Record<string, number> = {
      system: 40,
      user: 30,
      tool: 15,
      assistant: 10,
    };
    score += roleWeights[role] ?? 10;

    // 3. 内容权重：短消息权重高 (0-20 分)
    const lengthScore = Math.max(0, 20 - content.length / 500);
    score += lengthScore;

    // 4. 关键内容检测 (0-10 分)
    const hasKeyContent = this.containsKeyContent(content);
    if (hasKeyContent) {
      score += 10;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * 检测内容是否包含关键信息
   */
  private containsKeyContent(content: string): boolean {
    const keyPatterns = [
      /error|exception|fail/i,
      /success|complete|done/i,
      /file_write|file_create/i,
      /run_tests|test_result/i,
      /important|critical|必须|关键/i,
    ];

    return keyPatterns.some((pattern) => pattern.test(content));
  }

  /**
   * 获取建议压缩的消息索引
   *
   * @param messages - 消息列表（需要包含 role 和 content）
   * @param targetCount - 目标压缩数量
   * @returns 建议压缩的索引列表（按优先级排序）
   */
  getCompactionCandidates(
    messages: { role: string; content: string }[],
    targetCount: number
  ): number[] {
    const scored = messages.map((msg, index) => ({
      index,
      importance: this.calculateImportance(
        msg.content,
        msg.role,
        index,
        messages.length
      ),
    }));

    // 按重要性升序排序（低分优先压缩）
    scored.sort((a, b) => a.importance - b.importance);

    // 返回前 N 个低分索引
    return scored.slice(0, targetCount).map((s) => s.index);
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建自动上下文管理器
 */
export function createAutoContextManager(
  engine: PromptContextEngine,
  config?: Partial<AutoContextConfig>
): AutoContextManager {
  return new AutoContextManager(engine, config);
}

/**
 * 创建智能压缩决策器
 */
export function createSmartCompactionDecider(): SmartCompactionDecider {
  return new SmartCompactionDecider();
}
