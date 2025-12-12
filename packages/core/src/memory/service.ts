import type { 
  MemoryConfig, 
  MemoryProvider, 
  MemoryEntry, 
  MemoryScope, 
  MemoryRetrievalResult,
  ContextMessageMinimal,
  SemanticSearchOptions,
  SemanticSearchResult,
  KnowledgeSearchItem
} from './types';
import { InMemoryMemoryProvider } from './providers/in-memory';
import { LevelDBMemoryProvider } from './providers/leveldb';
import { RedisMemoryProvider } from './providers/redis';
import { VectorMemoryProvider } from './providers/vector';
import { OpenRouterEmbeddingService, MockEmbeddingService } from './embedding';

/**
 * Memory Service
 * 
 * Orchestrates memory storage and retrieval.
 * Manages the specific provider implementation and embedding service.
 */
export class MemoryService implements MemoryProvider {
  private provider: MemoryProvider;
  private config: MemoryConfig;
  private levelDBProvider?: LevelDBMemoryProvider;
  private redisProvider?: RedisMemoryProvider;
  private vectorProvider?: VectorMemoryProvider;

  constructor(config: MemoryConfig) {
    this.config = config;
    
    // Initialize Embedding Service
    const embeddingService = config.embeddingService || this.createDefaultEmbeddingService(config);

    // Initialize Provider based on type
    switch (config.providerType) {
      case 'redis': {
        if (!config.redisUrl) {
          throw new Error('Redis provider requires redisUrl in config');
        }
        const redisOptions: { keyPrefix?: string; ttlSeconds?: number } = {};
        if (config.redisKeyPrefix) redisOptions.keyPrefix = config.redisKeyPrefix;
        if (config.redisTtlSeconds) redisOptions.ttlSeconds = config.redisTtlSeconds;
        this.redisProvider = new RedisMemoryProvider(
          config.redisUrl, 
          embeddingService,
          redisOptions
        );
        this.provider = this.redisProvider;
        break;
      }
      case 'leveldb':
        if (!config.persistPath) {
          throw new Error('LevelDB provider requires persistPath in config');
        }
        this.levelDBProvider = new LevelDBMemoryProvider(config.persistPath, embeddingService);
        this.provider = this.levelDBProvider;
        break;
      case 'vector':
        if (!config.vectorDBProvider) {
          throw new Error('Vector provider requires vectorDBProvider in config');
        }
        this.vectorProvider = new VectorMemoryProvider(config.vectorDBProvider, embeddingService);
        this.provider = this.vectorProvider;
        break;
      case 'in-memory':
      default:
        this.provider = new InMemoryMemoryProvider(embeddingService);
        break;
    }
  }

  private createDefaultEmbeddingService(config: MemoryConfig) {
    if (config.openRouterApiKey) {
      return new OpenRouterEmbeddingService(config.openRouterApiKey);
    }
    return new MockEmbeddingService();
  }

  /**
   * Save a memory entry
   */
  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    if (!this.config.enabled) {
      return '';
    }
    return this.provider.save(entry);
  }

  /**
   * Retrieve memories based on a query
   */
  async retrieve(
    query: string, 
    topK: number = 5, 
    scope?: MemoryScope
  ): Promise<MemoryRetrievalResult> {
    if (!this.config.enabled) {
      return { memories: [], latencyMs: 0, fromCache: false };
    }
    return this.provider.retrieve(query, topK, scope);
  }

  /**
   * Search memories based on context
   */
  async search(
    context: ContextMessageMinimal[], 
    topK = 5
  ): Promise<MemoryRetrievalResult> {
    if (!this.config.enabled) {
      return { memories: [], latencyMs: 0, fromCache: false };
    }
    return this.provider.search(context, topK);
  }

  /**
   * Delete a memory
   */
  async delete(id: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    return this.provider.delete(id);
  }

  /**
   * Clear memories
   */
  async clear(scope?: MemoryScope): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    return this.provider.clear(scope);
  }

  /**
   * 语义搜索 - 结合 Memory 和 KnowledgeBase
   * 
   * 两阶段检索：
   * 1. Memory 向量搜索（长期记忆）
   * 2. KnowledgeBase 代码知识搜索（可选）
   * 
   * @param query 搜索查询
   * @param options 搜索选项
   */
  async semanticSearch(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult> {
    if (!this.config.enabled) {
      return { memories: [], knowledge: [], latencyMs: 0 };
    }

    const startTime = Date.now();
    const { 
      topK = 5, 
      scope, 
      includeKnowledge = false, 
      knowledgeBase,
      userId
    } = options;

    // 阶段1: Memory 检索
    // 如果指定了 userId 且 scope 为 user，添加到过滤条件
    let memoryScope = scope;
    if (userId && (!scope || scope === 'user')) {
      memoryScope = 'user';
    }

    let memoryResult: MemoryRetrievalResult;
    try {
      memoryResult = await this.retrieve(query, topK, memoryScope);
    } catch (error) {
      console.warn('[MemoryService] Memory retrieval failed in semanticSearch:', error);
      memoryResult = { memories: [], latencyMs: 0, fromCache: false };
    }
    
    // user scope 下按 userId 过滤（userId 约定存于 metadata.userId）
    let filteredMemories = memoryResult.memories;
    if (userId && memoryScope === 'user') {
      filteredMemories = memoryResult.memories.filter(
        m => m.metadata?.userId === userId
      );
    }

    // 阶段2: KnowledgeBase 检索 (可选)
    let knowledge: KnowledgeSearchItem[] = [];
    if (includeKnowledge && knowledgeBase) {
      try {
        const kbResults = await knowledgeBase.search(query, topK);
        knowledge = kbResults.map(r => ({
          content: r.content,
          score: r.score,
          metadata: r.metadata,
        }));
      } catch (error) {
        console.warn('[MemoryService] KnowledgeBase search failed:', error);
        // 降级：继续返回 memory 结果
      }
    }

    const latencyMs = Date.now() - startTime;

    return {
      memories: filteredMemories,
      knowledge,
      latencyMs,
    };
  }

  /**
   * Close the provider (required for LevelDB, Redis, and Vector)
   */
  async close(): Promise<void> {
    if (this.levelDBProvider) {
      await this.levelDBProvider.close();
    }
    if (this.redisProvider) {
      await this.redisProvider.disconnect();
    }
    if (this.vectorProvider) {
      await this.vectorProvider.close();
    }
  }

  /**
   * Factory method to create MemoryService
   */
  static create(config: Partial<MemoryConfig> = {}): MemoryService {
    const defaultConfig: MemoryConfig = {
      enabled: true,
      providerType: 'in-memory',
      ...config,
    };
    return new MemoryService(defaultConfig);
  }
}
