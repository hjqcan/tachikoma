/**
 * Minimal ContextMessage shape for MemoryProvider.search()
 * 
 * This is a subset of context/types.ContextMessage to avoid circular imports.
 * The full ContextMessage type lives in the internal prompt module:
 * @tachikoma/core/internal/prompt
 */
export interface ContextMessageMinimal {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
}

/**
 * Memory Scope
 * 
 * Defines the scope and lifecycle of a memory entry:
 * - session: Ephemeral, cleared after session ends
 * - user: User-specific, persists across sessions but isolated per user
 * - declarative: Facts and knowledge, long-term persistence
 * - procedural: How-to knowledge, long-term persistence
 * - collective: Shared across agents, long-term persistence
 */
export type MemoryScope = 'session' | 'user' | 'declarative' | 'procedural' | 'collective';

/**
 * Memory Entry
 * 
 * A single unit of memory stored in the system.
 */
export interface MemoryEntry {
  /** Unique ID */
  id: string;
  /** Text content */
  content: string;
  /** Vector embedding for semantic search */
  embedding?: number[];
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Scope of the memory */
  scope: MemoryScope;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp (for LRU) */
  lastAccessedAt?: number;
  /** Relevance score (populated during retrieval) */
  relevanceScore?: number;
}

/**
 * Memory Retrieval Result
 */
export interface MemoryRetrievalResult {
  /** List of retrieved memories */
  memories: MemoryEntry[];
  /** Retrieval latency in ms */
  latencyMs: number;
  /** Whether the result came from cache */
  fromCache: boolean;
}

/**
 * Memory Metrics for tracking memory system effectiveness
 */
export interface MemoryMetrics {
  /** Number of memory retrieval attempts */
  retrievalCount: number;
  /** Number of retrievals that returned at least one memory */
  hitCount: number;
  /** Hit rate (hitCount / retrievalCount) */
  hitRate: number;
  /** Estimated tokens saved by reusing memories (rough estimate) */
  tokensSaved: number;
  /** Total retrieval latency in ms */
  totalLatencyMs: number;
}

/**
 * Memory Provider Interface
 * 
 * Abstract interface for storage backends.
 */
export interface MemoryProvider {
  /**
   * Retrieve memories based on a query string
   */
  retrieve(
    query: string,
    topK?: number,
    scope?: MemoryScope
  ): Promise<MemoryRetrievalResult>;

  /**
   * Save a memory entry
   * ID and createdAt will be generated if not provided
   */
  save(
    entry: Omit<MemoryEntry, 'id' | 'createdAt'>
  ): Promise<string>;

  /**
   * Search memories based on conversation context
   */
  search(
    context: ContextMessageMinimal[],
    topK?: number
  ): Promise<MemoryRetrievalResult>;

  /**
   * Delete a memory by ID
   */
  delete(id: string): Promise<void>;

  /**
   * Clear all memories in a scope
   */
  clear(scope?: MemoryScope): Promise<void>;
}

/**
 * Embedding Service Interface
 */
export interface EmbeddingService {
  /** Generate embedding for a single text */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for a batch of texts */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Vector Database Point
 * A single vector with associated payload
 */
export interface VectorPoint {
  /** Unique identifier */
  id: string;
  /** Vector embedding */
  vector: number[];
  /** Associated payload/metadata */
  payload: Record<string, unknown>;
}

/**
 * Vector Search Result
 */
export interface VectorSearchResult {
  /** Point ID */
  id: string;
  /** Similarity score (higher = more similar) */
  score: number;
  /** Associated payload */
  payload: Record<string, unknown>;
}

/**
 * Vector Database Provider Interface
 * 
 * Generic interface for vector database operations.
 * Implementations: Qdrant, Pinecone, Chroma, Weaviate, etc.
 */
export interface VectorDBProvider {
  /** Initialize connection and create collection if needed */
  initialize(): Promise<void>;
  
  /** Upsert points into the collection */
  upsert(points: VectorPoint[]): Promise<void>;
  
  /** Search for similar vectors */
  search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult[]>;
  
  /** Delete points by IDs */
  delete(ids: string[]): Promise<void>;
  
  /** Delete points by filter (for bulk clear operations) */
  deleteByFilter(filter: Record<string, unknown>): Promise<number>;
  
  /** Scroll through all IDs matching filter (for iteration without search) */
  scrollIds(filter?: Record<string, unknown>, limit?: number): Promise<string[]>;
  
  /** Get collection info (count, etc.) */
  getInfo(): Promise<{ count: number; vectorSize: number }>;
  
  /** Close connection */
  close(): Promise<void>;
}

/**
 * Memory Configuration
 */
export interface MemoryConfig {
  /** Enable memory system */
  enabled: boolean;
  /** Storage provider type */
  providerType: 'in-memory' | 'redis' | 'leveldb' | 'vector';
  /** Embedding service implementation */
  embeddingService?: EmbeddingService;
  /** Persistence path for LevelDB provider */
  persistPath?: string;
  /** OpenRouter API Key (if using OpenRouterEmbeddingService) */
  openRouterApiKey?: string;
  /** Redis connection URL (for redis provider) */
  redisUrl?: string;
  /** Redis key prefix (for redis provider) @default 'tachikoma' */
  redisKeyPrefix?: string;
  /** Redis TTL in seconds (for redis provider, optional) */
  redisTtlSeconds?: number;
  /** Vector DB provider (for vector provider) */
  vectorDBProvider?: VectorDBProvider;
  /**
   * Auto-retrieve memories before LLM calls.
   * ⚠️ WARNING: This sends conversation context to the embedding API (external).
   * Set to false to disable automatic memory retrieval.
   * @default true
   */
  autoRetrieve?: boolean;
  /**
   * Auto-save task results to memory.
   * ⚠️ WARNING: This sends task results to the embedding API (external).
   * Set to false to disable automatic memory saving.
   * @default true
   */
  autoSave?: boolean;
  /**
   * Query strategy for memory search.
   * - 'last-message': Use only the last message content (simple, fast)
   * - 'user-assistant': Filter to user/assistant messages only, combine last N
   * - 'retrieval-context': Use PromptContextEngine.getRetrievalContext() for rich query (recommended)
   * @default 'user-assistant'
   */
  queryStrategy?: 'last-message' | 'user-assistant' | 'retrieval-context';
  /**
   * Number of memories to retrieve (topK).
   * @default 5
   */
  topK?: number;
  /**
   * Minimum interval between memory retrievals (ms).
   * Prevents excessive embedding API calls in rapid loops.
   * @default 10000 (10 seconds)
   */
  retrievalCooldownMs?: number;
}

// ============================================================================
// 语义搜索类型 (LangGraph 最佳实践)
// ============================================================================

/**
 * KnowledgeBase 接口 (避免循环依赖)
 */
export interface KnowledgeBaseInterface {
  search(
    query: string,
    limit?: number,
    minScore?: number
  ): Promise<{ content: string; score: number; metadata: Record<string, unknown> }[]>;
}

/**
 * 语义搜索选项
 */
export interface SemanticSearchOptions {
  /** 返回数量 */
  topK?: number;
  /** 记忆范围 */
  scope?: MemoryScope;
  /** 是否包含代码知识库结果 */
  includeKnowledge?: boolean;
  /** KnowledgeBase 实例 (如果 includeKnowledge=true) */
  knowledgeBase?: KnowledgeBaseInterface;
  /** 用户 ID (用于 user scope 过滤) */
  userId?: string;
}

/**
 * 知识库搜索结果条目
 */
export interface KnowledgeSearchItem {
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * 语义搜索结果
 */
export interface SemanticSearchResult {
  /** 长期记忆 */
  memories: MemoryEntry[];
  /** 代码知识 (来自 KnowledgeBase) */
  knowledge: KnowledgeSearchItem[];
  /** 总检索延迟 */
  latencyMs: number;
}
