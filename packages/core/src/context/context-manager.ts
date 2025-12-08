/**
 * 核心上下文管理器
 *
 * 整合压缩、摘要、卸载和缓存优化策略
 *
 * @module context/context-manager
 */

import type {
  ContextMessage,
  ContextState,
  ContextManagerConfig,
  IContextManager,
  CompactionResult,
  SummarizationResult,
  OffloadResult,
  StructuredSummary,
  AgentNotes,
} from './types';

import { CompactionStrategy } from './strategies/compaction';
import {
  SummarizationStrategy,
  type SummarizationLLMClient,
} from './strategies/summarization';
import { OffloadStrategy, type OffloadFileManager } from './strategies/offload';
import { PrefixOptimizer } from './cache/prefix-optimizer';
import { NoteManager } from './memory/note-taking';

// ============================================================================
// 上下文管理器
// ============================================================================

/**
 * 上下文管理器依赖
 */
export interface ContextManagerDependencies {
  /** LLM 客户端（用于摘要） */
  llmClient?: SummarizationLLMClient;
  /** 文件管理器（用于卸载） */
  fileManager?: OffloadFileManager;
}

/**
 * 核心上下文管理器
 *
 * 实现完整的上下文工程功能：
 * - 消息管理
 * - 自动压缩（可逆）
 * - 自动摘要（不可逆）
 * - 文件卸载
 * - KV 缓存优化
 */
export class ContextManager implements IContextManager {
  private readonly config: ContextManagerConfig;
  private readonly deps: ContextManagerDependencies;

  // 策略实例
  private readonly compactionStrategy: CompactionStrategy;
  private readonly summarizationStrategy: SummarizationStrategy;
  private readonly offloadStrategy: OffloadStrategy;
  private readonly prefixOptimizer: PrefixOptimizer;
  private readonly noteManager: NoteManager;

  // 状态
  private messages: ContextMessage[] = [];
  private compactionCount = 0;
  private summarizationCount = 0;
  private lastCompactionAt?: number;
  private lastSummarizationAt?: number;
  /** 当前笔记（持久化） */
  private currentNotes: AgentNotes;

  constructor(config: ContextManagerConfig, deps: ContextManagerDependencies = {}) {
    this.config = config;
    this.deps = deps;

    // 初始化策略
    this.compactionStrategy = new CompactionStrategy(config.compaction);
    this.summarizationStrategy = new SummarizationStrategy(config.summarization);
    this.offloadStrategy = new OffloadStrategy(config.offload);
    this.prefixOptimizer = new PrefixOptimizer(config.cacheOptimization);
    this.noteManager = new NoteManager();
    this.currentNotes = this.noteManager.createNotes();
  }

  // ========================================
  // 消息管理
  // ========================================

  /**
   * 添加消息
   */
  addMessage(message: ContextMessage): void {
    // 确保消息有正确的格式
    const normalizedMessage: ContextMessage = {
      ...message,
      format: message.format || 'full',
    };

    this.messages.push(normalizedMessage);
  }

  /**
   * 获取当前上下文（用于 LLM 调用）
   *
   * 返回优化后的消息列表
   */
  getContext(): ContextMessage[] {
    // 应用前缀优化
    return this.prefixOptimizer.optimize(this.messages);
  }

  /**
   * 获取原始消息（不优化）
   */
  getRawMessages(): ContextMessage[] {
    return [...this.messages];
  }

  /**
   * 获取状态
   */
  getState(): ContextState {
    const state: ContextState = {
      messages: this.messages,
      totalTokens: this.calculateTotalTokens(),
      thresholds: this.config.thresholds,
      compactionCount: this.compactionCount,
      summarizationCount: this.summarizationCount,
    };
    if (this.lastCompactionAt !== undefined) {
      state.lastCompactionAt = this.lastCompactionAt;
    }
    if (this.lastSummarizationAt !== undefined) {
      state.lastSummarizationAt = this.lastSummarizationAt;
    }
    return state;
  }

  // ========================================
  // 缩减操作
  // ========================================

  /**
   * 检查是否需要缩减
   */
  needsReduction(): boolean {
    const totalTokens = this.calculateTotalTokens();
    return totalTokens > this.config.thresholds.softLimit;
  }

  /**
   * 检查是否需要摘要（超过硬限制）
   */
  needsSummarization(): boolean {
    const totalTokens = this.calculateTotalTokens();
    return totalTokens > this.config.thresholds.hardLimit;
  }

  /**
   * 执行压缩（可逆）
   */
  async compact(): Promise<CompactionResult> {
    const result = this.compactionStrategy.compact(
      this.messages,
      (content) => this.estimateTokens(content)
    );

    if (result.success) {
      this.compactionCount++;
      this.lastCompactionAt = Date.now();
    }

    return result;
  }

  /**
   * 执行摘要（不可逆）
   */
  async summarize(): Promise<SummarizationResult> {
    if (!this.deps.llmClient) {
      return {
        success: false,
        summary: this.createEmptySummary(),
        beforeTokens: this.calculateTotalTokens(),
        afterTokens: this.calculateTotalTokens(),
      };
    }

    // 创建卸载函数（如果配置了）
    let offloadFn: ((content: string) => Promise<string>) | undefined;
    if (this.config.summarization.offloadBeforeSummarize && this.deps.fileManager) {
      const fileManager = this.deps.fileManager;
      const workDir = this.config.offload.workDir;
      offloadFn = async (content: string) => {
        const path = `${workDir}/context_before_summary_${Date.now()}.txt`;
        await fileManager.writeFile(path, content);
        return path;
      };
    }

    const result = await this.summarizationStrategy.summarize(
      this.messages,
      this.deps.llmClient,
      (content) => this.estimateTokens(content),
      offloadFn
    );

    if (result.success) {
      this.summarizationCount++;
      this.lastSummarizationAt = Date.now();
    }

    return result;
  }

  /**
   * 自动缩减上下文
   *
   * 根据当前 Token 数自动选择压缩或摘要
   * 
   * 逻辑：
   * 1. 先尝试压缩
   * 2. 压缩后重新评估，若仍超 hardLimit 则强制摘要
   * 3. 若压缩收益低且超 softLimit 也触发摘要
   * 4. 若 LLM 不可用且超硬限制，返回失败结果并尝试卸载
   * 
   * @returns 压缩/摘要结果，若无需缩减返回 null
   * @throws 摘要失败时如果仍超硬限制，会在结果中标记 success: false
   */
  async autoReduce(): Promise<CompactionResult | SummarizationResult | null> {
    if (!this.needsReduction()) {
      return null;
    }

    // 先尝试压缩
    const compactionResult = await this.compact();

    // 压缩后重新评估 Token 数
    const currentTokens = this.calculateTotalTokens();

    // 硬限制：若仍超过 hardLimit，强制摘要
    if (currentTokens > this.config.thresholds.hardLimit) {
      // 检查 LLM 是否可用
      if (!this.deps.llmClient) {
        // LLM 不可用，尝试卸载作为降级方案
        const tokensBeforeOffload = currentTokens;
        let tokensAfterOffload = currentTokens;
        
        if (this.deps.fileManager) {
          // 循环卸载直到不超限或无法继续
          const maxOffloadRounds = 3;
          for (let round = 0; round < maxOffloadRounds; round++) {
            const largeMessages = this.messages
              .filter(m => 
                m.format !== 'compact' && 
                this.estimateTokens(m.content) > this.config.offload.tokenThreshold
              )
              .map(m => m.id);
            
            if (largeMessages.length === 0) {
              break; // 没有更多可卸载的消息
            }
            
            await this.offload(largeMessages);
            tokensAfterOffload = this.calculateTotalTokens();
            
            // 检查是否已降到硬限制以下
            if (tokensAfterOffload <= this.config.thresholds.hardLimit) {
              // 卸载成功降到硬限制以下，返回压缩结果
              return {
                ...compactionResult,
                afterTokens: tokensAfterOffload,
              };
            }
          }
        }
        
        // 仍然超限，返回失败结果
        return {
          success: false,
          summary: {
            userGoal: '',
            completedSteps: [],
            keyFindings: [],
            modifiedFiles: [],
            currentProgress: '',
            nextSteps: [],
            errors: [
              `上下文超过硬限制 (${tokensAfterOffload}/${this.config.thresholds.hardLimit} tokens)，LLM 不可用无法摘要`,
              tokensAfterOffload < tokensBeforeOffload 
                ? `已卸载部分内容 (${tokensBeforeOffload} → ${tokensAfterOffload} tokens)`
                : '无法卸载更多内容',
              '请配置 llmClient 或手动清理上下文',
            ],
            lastStopPoint: '',
          },
          beforeTokens: tokensBeforeOffload,
          afterTokens: tokensAfterOffload,
        } satisfies SummarizationResult;
      }
      
      return this.summarize();
    }

    // 软限制：若压缩收益低且仍超 softLimit，触发摘要
    if (
      compactionResult.gainRatio < this.config.compaction.minGainRatio &&
      currentTokens > this.config.thresholds.softLimit
    ) {
      // 检查 LLM 是否可用
      if (!this.deps.llmClient) {
        // LLM 不可用，返回压缩结果并警告
        return compactionResult;
      }
      
      return this.summarize();
    }

    return compactionResult;
  }

  // ========================================
  // 卸载与恢复
  // ========================================

  /**
   * 卸载消息到文件系统
   */
  async offload(messageIds: string[]): Promise<OffloadResult> {
    if (!this.deps.fileManager) {
      return {
        success: false,
        messageIds: [],
        filePaths: [],
        savedTokens: 0,
      };
    }

    const messagesToOffload = this.messages.filter((m) =>
      messageIds.includes(m.id)
    );

    return this.offloadStrategy.offload(
      messagesToOffload,
      this.deps.fileManager,
      (content) => this.estimateTokens(content)
    );
  }

  /**
   * 从引用恢复消息
   */
  async recover(refs: string[]): Promise<ContextMessage[]> {
    if (!this.deps.fileManager) {
      return [];
    }

    const recovered: ContextMessage[] = [];

    for (const ref of refs) {
      const message = this.messages.find((m) => m.recoveryRef === ref);
      if (message) {
        const recoveredMessage = await this.offloadStrategy.recover(
          message,
          this.deps.fileManager
        );
        recovered.push(recoveredMessage);

        // 更新原消息
        const index = this.messages.indexOf(message);
        if (index !== -1) {
          this.messages[index] = recoveredMessage;
        }
      }
    }

    return recovered;
  }

  // ========================================
  // 笔记功能
  // ========================================

  /**
   * 获取笔记管理器
   */
  getNoteManager(): NoteManager {
    return this.noteManager;
  }

  /**
   * 获取当前笔记
   */
  getNotes(): AgentNotes {
    return this.currentNotes;
  }

  /**
   * 更新笔记
   */
  setNotes(notes: AgentNotes): void {
    this.currentNotes = notes;
  }

  /**
   * 添加待办事项
   */
  addTodo(description: string): void {
    this.currentNotes = this.noteManager.addTodo(this.currentNotes, description);
  }

  /**
   * 完成待办事项
   */
  completeTodo(todoId: string): void {
    this.currentNotes = this.noteManager.completeTodo(this.currentNotes, todoId);
  }

  /**
   * 添加发现
   */
  addFinding(finding: string): void {
    this.currentNotes = this.noteManager.addFinding(this.currentNotes, finding);
  }

  /**
   * 注入当前状态提醒到上下文
   * 
   * 使用实际的笔记数据，将待办事项和发现复述到上下文末尾
   */
  injectStatusReminder(): void {
    this.messages = this.noteManager.injectIntoContext(this.currentNotes, this.messages);
  }

  // ========================================
  // 工具方法
  // ========================================

  /**
   * 估算 Token 数
   *
   * 简单估算：每 4 个字符约 1 个 token
   */
  estimateTokens(content: string): number {
    // 简单估算：英文约 4 字符/token，中文约 2 字符/token
    // 使用平均值 3 字符/token
    return Math.ceil(content.length / 3);
  }

  /**
   * 清空上下文
   * 
   * 重置所有状态，包括消息、计数器和笔记
   */
  clear(): void {
    this.messages = [];
    this.compactionCount = 0;
    this.summarizationCount = 0;
    // 重置笔记
    this.currentNotes = this.noteManager.createNotes();
    // 使用 delete 来移除可选属性
    delete (this as unknown as { lastCompactionAt?: number }).lastCompactionAt;
    delete (this as unknown as { lastSummarizationAt?: number }).lastSummarizationAt;
  }

  /**
   * 获取缓存命中率估算
   */
  estimateCacheHitRate(previousMessages: ContextMessage[]): number {
    return this.prefixOptimizer.estimateCacheHitRate(previousMessages, this.messages);
  }

  // ========================================
  // 私有方法
  // ========================================

  private calculateTotalTokens(): number {
    return this.messages.reduce(
      (sum, msg) => sum + this.estimateTokens(msg.content),
      0
    );
  }

  private createEmptySummary(): StructuredSummary {
    return {
      userGoal: '',
      completedSteps: [],
      keyFindings: [],
      modifiedFiles: [],
      currentProgress: '',
      nextSteps: [],
      errors: ['摘要失败：LLM 客户端不可用'],
      lastStopPoint: '',
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建上下文管理器
 */
export function createContextManager(
  config: ContextManagerConfig,
  deps?: ContextManagerDependencies
): ContextManager {
  return new ContextManager(config, deps);
}
