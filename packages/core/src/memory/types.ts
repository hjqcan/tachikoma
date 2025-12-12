/**
 * Minimal ContextMessage shape for MemoryProvider.search()
 * 
 * This is a subset of context/types.ContextMessage to avoid circular imports.
 * The full ContextMessage type should be imported from @tachikoma/core/context.
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
 * - declarative: Facts and knowledge, long-term persistence
 * - procedural: How-to knowledge, long-term persistence
 * - collective: Shared across agents, long-term persistence
 */
export type MemoryScope = 'session' | 'declarative' | 'procedural' | 'collective';

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
   * - 'retrieval-context': Use ContextManager.getRetrievalContext() for rich query (recommended)
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
