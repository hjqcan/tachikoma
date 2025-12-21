/**
 * Memory Retriever Engine
 *
 * 管理 Generic 后端的 memory 检索和注入逻辑
 * 与 PromptContextEngine 集成
 */

import type { MemoryService, MemoryRetrievalResult, MemoryEntry, MemoryConfig } from '../../memory';
import type { ContextMessage } from '../../prompt';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Memory Retriever 配置
 */
export interface MemoryRetrieverConfig {
  /** 自动检索开关 */
  autoRetrieve?: boolean | undefined;
  /** 检索冷却时间（毫秒） */
  retrievalCooldownMs?: number | undefined;
  /** 检索数量 */
  topK?: number | undefined;
  /** 查询策略 */
  queryStrategy?: 'user-assistant' | 'last-message' | 'retrieval-context' | undefined;
  /** 自动保存开关 */
  autoSave?: boolean | undefined;
}

/**
 * Memory Retriever 回调接口
 */
export interface MemoryRetrieverCallbacks {
  /** 获取上下文消息 */
  getContext: () => ContextMessage[];
  /** 获取检索查询上下文 */
  getRetrievalContext?: () => string;
  /** 检查是否应该检索 memories */
  shouldRetrieveMemories?: () => boolean;
  /** 注入检索到的 memories */
  injectRetrievedMemories: (memories: MemoryEntry[]) => void;
}

/**
 * Memory 检索结果
 */
export interface MemoryRetrievalResultLocal {
  /** 检索到的新 memories（已去重） */
  newMemories: MemoryEntry[];
  /** 跳过的重复 memories 数量 */
  skippedCount: number;
  /** 检索总耗时（毫秒） */
  durationMs: number;
}

// ============================================================================
// Memory Retriever
// ============================================================================

/**
 * Memory Retriever
 * 
 * 封装 memory 检索逻辑，支持：
 * - 检索冷却时间
 * - 重复记忆去重
 * - 多种查询策略
 */
export class MemoryRetriever {
  private lastRetrievalAt: number | undefined;
  private readonly injectedIds = new Set<string>();
  
  constructor(
    private readonly memoryService: MemoryService | undefined,
    private readonly config: MemoryRetrieverConfig = {}
  ) {}
  
  /**
   * 检查是否可以进行检索（冷却时间检查）
   */
  canRetrieve(): boolean {
    if (!this.memoryService) return false;
    if (this.config.autoRetrieve === false) return false;
    
    const cooldownMs = this.config.retrievalCooldownMs ?? 10000;
    const now = Date.now();
    
    return !this.lastRetrievalAt || (now - this.lastRetrievalAt) >= cooldownMs;
  }
  
  /**
   * 执行 memory 检索
   * 
   * @param callbacks - 回调接口
   * @returns 检索结果（null 表示跳过）
   */
  async retrieve(callbacks: MemoryRetrieverCallbacks): Promise<MemoryRetrievalResultLocal | null> {
    if (!this.memoryService) return null;
    if (!this.canRetrieve()) return null;
    
    // 检查上下文是否允许检索
    if (callbacks.shouldRetrieveMemories && !callbacks.shouldRetrieveMemories()) {
      return null;
    }
    
    const startTime = Date.now();
    this.lastRetrievalAt = startTime;
    
    const topK = this.config.topK ?? 5;
    const queryStrategy = this.config.queryStrategy ?? 'user-assistant';
    
    let memoryResult: MemoryRetrievalResult;
    
    try {
      if (queryStrategy === 'retrieval-context' && callbacks.getRetrievalContext) {
        // 使用 PromptContextEngine 的富检索上下文
        const retrievalQuery = callbacks.getRetrievalContext();
        memoryResult = await this.memoryService.retrieve(retrievalQuery, topK);
      } else if (queryStrategy === 'last-message') {
        // 仅使用最后一条消息（简单、快速）
        const messages = callbacks.getContext();
        const lastMessage = messages[messages.length - 1];
        const query = lastMessage?.content ?? '';
        memoryResult = await this.memoryService.retrieve(query, topK);
      } else {
        // 'user-assistant': 使用 provider 的 search
        memoryResult = await this.memoryService.search(callbacks.getContext(), topK);
      }
      
      // 去重：过滤已注入的 memories
      const newMemories = memoryResult.memories.filter(
        (m: MemoryEntry) => !this.injectedIds.has(m.id)
      );
      
      const skippedCount = memoryResult.memories.length - newMemories.length;
      
      // 标记为已注入
      for (const m of newMemories) {
        this.injectedIds.add(m.id);
      }
      
      // 注入到 context
      if (newMemories.length > 0) {
        callbacks.injectRetrievedMemories(newMemories);
      }
      
      return {
        newMemories,
        skippedCount,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      console.warn('[MemoryRetriever] Retrieval failed:', error);
      return null;
    }
  }
  
  /**
   * 保存任务结果到 memory
   * 
   * @param content - 要保存的内容
   * @param metadata - 元数据
   */
  async save(
    content: string,
    metadata: Record<string, unknown> = {}
  ): Promise<boolean> {
    if (!this.memoryService) return false;
    if (this.config.autoSave === false) return false;
    
    try {
      await this.memoryService.save({
        content,
        scope: 'procedural',
        metadata: {
          ...metadata,
          backend: 'generic',
        },
      });
      return true;
    } catch (error) {
      console.warn('[MemoryRetriever] Save failed:', error);
      return false;
    }
  }
  
  /**
   * 重置状态（新任务开始时调用）
   */
  reset(): void {
    this.injectedIds.clear();
    this.lastRetrievalAt = undefined as number | undefined;
  }
  
  /**
   * 关闭 memory service
   */
  async close(): Promise<void> {
    if (this.memoryService) {
      await this.memoryService.close();
    }
  }
}

/**
 * 创建 Memory Retriever
 */
export function createMemoryRetriever(
  memoryService: MemoryService | undefined,
  config?: MemoryConfig
): MemoryRetriever {
  return new MemoryRetriever(memoryService, {
    autoRetrieve: config?.autoRetrieve,
    retrievalCooldownMs: config?.retrievalCooldownMs,
    topK: config?.topK,
    queryStrategy: config?.queryStrategy,
    autoSave: config?.autoSave,
  });
}
