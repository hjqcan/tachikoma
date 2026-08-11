import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type {
  MemoryProvider,
  MemoryEntry,
  MemoryScope,
  MemoryRetrievalResult,
  EmbeddingService,
  ContextMessageMinimal,
} from '../types';

/**
 * Redis Memory Provider
 *
 * Stores memories in Redis for distributed persistence.
 * Features:
 * - Distributed storage across multiple instances
 * - Scope-based key prefixing with Redis sets for efficient filtering
 * - Vector similarity search via linear scan (suitable for < 10k entries)
 * - Optional TTL support for memory expiration
 * - Auto-connects on first operation (lazy loading)
 *
 * Data structure:
 * - Key: `memory:{scope}:{id}` -> JSON MemoryEntry
 * - Set: `memory:ids:{scope}` -> set of IDs for fast scope listing
 */
export class RedisMemoryProvider implements MemoryProvider {
  private redis: Redis;
  private embeddingService: EmbeddingService;
  private keyPrefix: string;
  private ttlSeconds: number | undefined;

  constructor(
    redisUrl: string,
    embeddingService: EmbeddingService,
    options: { keyPrefix?: string; ttlSeconds?: number } = {}
  ) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    this.embeddingService = embeddingService;
    this.keyPrefix = options.keyPrefix ?? 'tachikoma';
    this.ttlSeconds = options.ttlSeconds;
  }

  /**
   * Connect to Redis (optional - auto-connects on first command)
   */
  async connect(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  /**
   * Disconnect from Redis (recommended on shutdown)
   */
  async disconnect(): Promise<void> {
    if (this.redis.status === 'ready' || this.redis.status === 'connecting') {
      await this.redis.quit();
    }
  }

  private getKey(scope: MemoryScope, id: string): string {
    return `${this.keyPrefix}:memory:${scope}:${id}`;
  }

  private getScopeSetKey(scope: MemoryScope): string {
    return `${this.keyPrefix}:memory:ids:${scope}`;
  }

  private static readonly ALL_SCOPES: MemoryScope[] = [
    'session',
    'user',
    'declarative',
    'procedural',
    'collective',
  ];

  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = randomUUID();
    const createdAt = Date.now();

    let embedding = entry.embedding;
    if (!embedding) {
      embedding = await this.embeddingService.embed(entry.content);
    }

    const memoryEntry: MemoryEntry = {
      ...entry,
      id,
      createdAt,
      embedding,
    };

    const key = this.getKey(entry.scope, id);
    const scopeSetKey = this.getScopeSetKey(entry.scope);

    // Use pipeline for atomic operations
    const pipeline = this.redis.pipeline();
    pipeline.set(key, JSON.stringify(memoryEntry));
    if (this.ttlSeconds) {
      pipeline.expire(key, this.ttlSeconds);
    }
    pipeline.sadd(scopeSetKey, id);
    await pipeline.exec();

    return id;
  }

  async retrieve(query: string, topK = 5, scope?: MemoryScope): Promise<MemoryRetrievalResult> {
    const startTime = Date.now();

    const queryEmbedding = await this.embeddingService.embed(query);
    const candidates: { entry: MemoryEntry; score: number }[] = [];

    // Get all entries (or filtered by scope)
    const entries = await this.getAllEntries(scope);

    for (const entry of entries) {
      if (entry.embedding) {
        const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
        candidates.push({ entry, score });
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    const now = Date.now();

    // Take topK and build results
    const results = candidates.slice(0, topK).map((item) => ({
      ...item.entry,
      relevanceScore: item.score,
      lastAccessedAt: now,
    }));

    // Update lastAccessedAt (batch update)
    if (results.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const result of results) {
        const key = this.getKey(result.scope, result.id);
        const persistEntry: MemoryEntry = {
          id: result.id,
          content: result.content,
          scope: result.scope,
          createdAt: result.createdAt,
          lastAccessedAt: now,
        };
        if (result.embedding) {
          persistEntry.embedding = result.embedding;
        }
        if (result.metadata) {
          persistEntry.metadata = result.metadata;
        }
        pipeline.set(key, JSON.stringify(persistEntry));
        if (this.ttlSeconds) {
          pipeline.expire(key, this.ttlSeconds);
        }
      }
      await pipeline.exec();
    }

    return {
      memories: results,
      latencyMs: Date.now() - startTime,
      fromCache: false,
    };
  }

  async search(context: ContextMessageMinimal[], topK = 5): Promise<MemoryRetrievalResult> {
    if (context.length === 0) {
      return { memories: [], latencyMs: 0, fromCache: false };
    }

    // Filter to user and assistant messages
    const relevantMessages = context.filter((m) => m.role === 'user' || m.role === 'assistant');

    if (relevantMessages.length === 0) {
      const lastMessage = context[context.length - 1];
      if (!lastMessage) {
        return { memories: [], latencyMs: 0, fromCache: false };
      }
      return this.retrieve(lastMessage.content, topK);
    }

    // Combine last 3 relevant messages
    const queryParts = relevantMessages
      .slice(-3)
      .map((m) => m.content)
      .filter((c) => c.length > 0);

    let query = queryParts.join(' | ');

    // Limit query length
    const MAX_QUERY_LENGTH = 2000;
    if (query.length > MAX_QUERY_LENGTH) {
      query = query.slice(0, MAX_QUERY_LENGTH);
    }

    return this.retrieve(query, topK);
  }

  async delete(id: string): Promise<void> {
    // Find scope by checking all scope sets with sismember (O(4) instead of O(N))
    let foundScope: MemoryScope | null = null;
    for (const scope of RedisMemoryProvider.ALL_SCOPES) {
      const isMember = await this.redis.sismember(this.getScopeSetKey(scope), id);
      if (isMember) {
        foundScope = scope;
        break;
      }
    }

    if (foundScope) {
      const key = this.getKey(foundScope, id);
      const scopeSetKey = this.getScopeSetKey(foundScope);

      const pipeline = this.redis.pipeline();
      pipeline.del(key);
      pipeline.srem(scopeSetKey, id);
      await pipeline.exec();
    }
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (scope) {
      // Clear specific scope
      const scopeSetKey = this.getScopeSetKey(scope);
      const ids = await this.redis.smembers(scopeSetKey);

      if (ids.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const id of ids) {
          pipeline.del(this.getKey(scope, id));
        }
        pipeline.del(scopeSetKey);
        await pipeline.exec();
      }
    } else {
      // Clear all scopes by iterating (avoids blocking KEYS command)
      for (const s of RedisMemoryProvider.ALL_SCOPES) {
        await this.clear(s);
      }
    }
  }

  /**
   * Get count of stored memories
   */
  async count(scope?: MemoryScope): Promise<number> {
    if (scope) {
      const scopeSetKey = this.getScopeSetKey(scope);
      return this.redis.scard(scopeSetKey);
    } else {
      // Count all entries by checking all scope sets
      let total = 0;
      for (const s of RedisMemoryProvider.ALL_SCOPES) {
        total += await this.redis.scard(this.getScopeSetKey(s));
      }
      return total;
    }
  }

  // --- Helper Methods ---

  private async getAllEntries(scope?: MemoryScope): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];

    if (scope) {
      // Get entries for specific scope using the set
      const scopeSetKey = this.getScopeSetKey(scope);
      const ids = await this.redis.smembers(scopeSetKey);

      if (ids.length === 0) return entries;

      const keys = ids.map((id) => this.getKey(scope, id));
      const values = await this.redis.mget(keys);

      // Track stale IDs (TTL expired but still in set)
      const staleIds: string[] = [];

      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        const id = ids[i];
        if (value) {
          try {
            entries.push(JSON.parse(value) as MemoryEntry);
          } catch {
            // Malformed entry, treat as stale
            if (id) staleIds.push(id);
          }
        } else if (id) {
          // Entry expired, mark for cleanup
          staleIds.push(id);
        }
      }

      // Cleanup stale IDs from set (lazy cleanup)
      if (staleIds.length > 0) {
        await this.redis.srem(scopeSetKey, ...staleIds);
      }
    } else {
      // Get all entries across all scopes
      for (const s of RedisMemoryProvider.ALL_SCOPES) {
        const scopeEntries = await this.getAllEntries(s);
        entries.push(...scopeEntries);
      }
    }

    return entries;
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      const valA = vecA[i] ?? 0;
      const valB = vecB[i] ?? 0;
      dotProduct += valA * valB;
      normA += valA * valA;
      normB += valB * valB;
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
