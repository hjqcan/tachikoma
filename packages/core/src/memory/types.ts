export type { ContextMessage } from '../context/types';

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
    context: ContextMessage[],
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
  /** Optional persistence path (for in-memory dump or leveldb) */
  persistPath?: string;
  /** OpenRouter API Key (if using OpenRouterEmbeddingService) */
  openRouterApiKey?: string;
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
}
