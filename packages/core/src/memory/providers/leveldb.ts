import { Level } from 'level';
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
 * LevelDB Memory Provider
 *
 * Stores memories in a local LevelDB database for persistence.
 * Features:
 * - Persistent storage across restarts
 * - Scope-based key prefixing for efficient filtering
 * - Vector similarity search via linear scan (suitable for < 10k entries)
 * - Auto-opens on first operation (lazy loading)
 *
 * Data structure:
 * - Key: `memory:{scope}:{id}`
 * - Value: MemoryEntry object (using Level's json encoding)
 */
export class LevelDBMemoryProvider implements MemoryProvider {
  private db: Level<string, MemoryEntry>;
  private embeddingService: EmbeddingService;
  private isOpen = false;

  constructor(dbPath: string, embeddingService: EmbeddingService) {
    this.db = new Level<string, MemoryEntry>(dbPath, { valueEncoding: 'json' });
    this.embeddingService = embeddingService;
  }

  /**
   * Open the database manually (optional - auto-opens on first operation)
   */
  async open(): Promise<void> {
    if (!this.isOpen) {
      await this.db.open();
      this.isOpen = true;
    }
  }

  /**
   * Close the database (recommended on shutdown)
   */
  async close(): Promise<void> {
    if (this.isOpen) {
      await this.db.close();
      this.isOpen = false;
    }
  }

  private getKey(scope: MemoryScope, id: string): string {
    return `memory:${scope}:${id}`;
  }

  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    await this.ensureOpen();

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
    await this.db.put(key, memoryEntry);

    return id;
  }

  async retrieve(query: string, topK = 5, scope?: MemoryScope): Promise<MemoryRetrievalResult> {
    await this.ensureOpen();
    const startTime = Date.now();

    const queryEmbedding = await this.embeddingService.embed(query);
    const candidates: { entry: MemoryEntry; score: number }[] = [];

    // Iterate through all entries (or filtered by scope)
    const prefix = scope ? `memory:${scope}:` : 'memory:';

    for await (const [key, entry] of this.db.iterator()) {
      if (!key.startsWith(prefix)) continue;

      // Filter by scope if provided
      if (scope && entry.scope !== scope) continue;

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

    // Update lastAccessedAt in DB (without relevanceScore)
    for (const result of results) {
      const key = this.getKey(result.scope, result.id);
      // Build entry without relevanceScore for persistence
      const persistEntry: MemoryEntry = {
        id: result.id,
        content: result.content,
        scope: result.scope,
        createdAt: result.createdAt,
        lastAccessedAt: now,
      };
      // Only include optional fields if defined
      if (result.embedding) {
        persistEntry.embedding = result.embedding;
      }
      if (result.metadata) {
        persistEntry.metadata = result.metadata;
      }
      await this.db.put(key, persistEntry);
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
    await this.ensureOpen();

    // Need to find the entry first to get its scope
    for await (const [key, entry] of this.db.iterator()) {
      if (!key.startsWith('memory:')) continue;

      if (entry.id === id) {
        await this.db.del(key);
        return;
      }
    }
  }

  async clear(scope?: MemoryScope): Promise<void> {
    await this.ensureOpen();

    const prefix = scope ? `memory:${scope}:` : 'memory:';
    const keysToDelete: string[] = [];

    for await (const [key] of this.db.iterator()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      await this.db.del(key);
    }
  }

  /**
   * Get count of stored memories
   */
  async count(scope?: MemoryScope): Promise<number> {
    await this.ensureOpen();

    const prefix = scope ? `memory:${scope}:` : 'memory:';
    let count = 0;

    for await (const [key] of this.db.iterator()) {
      if (key.startsWith(prefix)) {
        count++;
      }
    }

    return count;
  }

  // --- Helper Methods ---

  private async ensureOpen(): Promise<void> {
    if (!this.isOpen) {
      await this.open();
    }
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
