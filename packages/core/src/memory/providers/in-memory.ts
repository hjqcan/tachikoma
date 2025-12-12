import { v4 as uuidv4 } from 'uuid';
import type { 
  MemoryProvider, 
  MemoryEntry, 
  MemoryScope, 
  MemoryRetrievalResult, 
  EmbeddingService, 
  ContextMessage
} from '../types';

/**
 * In-Memory Memory Provider
 * 
 * Stores memories in a simple Javascript Map.
 * Performs linear scan for vector similarity search (cosine similarity).
 * Suitable for small to medium datasets (< 10k entries).
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  private store: Map<string, MemoryEntry> = new Map();
  private embeddingService: EmbeddingService;

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
  }

  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = uuidv4();
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

    this.store.set(id, memoryEntry);
    return id;
  }

  async retrieve(
    query: string, 
    topK: number = 5, 
    scope?: MemoryScope
  ): Promise<MemoryRetrievalResult> {
    const startTime = Date.now();
    const queryEmbedding = await this.embeddingService.embed(query);

    const candidates: { entry: MemoryEntry; score: number }[] = [];

    for (const entry of this.store.values()) {
      // Filter by scope if provided
      if (scope && entry.scope !== scope) {
        continue;
      }

      // Calculate similarity
      if (entry.embedding) {
        const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
        candidates.push({ entry, score });
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Take topK
    const results = candidates.slice(0, topK).map(item => ({
      ...item.entry,
      relevanceScore: item.score,
      lastAccessedAt: Date.now(),
    }));

    // Update lastAccessedAt in store
    for (const result of results) {
      const stored = this.store.get(result.id);
      if (stored) {
        stored.lastAccessedAt = Date.now();
      }
    }

    return {
      memories: results,
      latencyMs: Date.now() - startTime,
      fromCache: false,
    };
  }

  async search(
    context: ContextMessage[], 
    topK: number = 5
  ): Promise<MemoryRetrievalResult> {
    // Simple strategy: use the content of the last message as query
    // In future, this could be enhanced with LLM keyword extraction
    if (context.length === 0) {
      return { memories: [], latencyMs: 0, fromCache: false };
    }

    const lastMessage = context[context.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!lastMessage) {
       return { memories: [], latencyMs: 0, fromCache: false };
    }
    const query = lastMessage.content;

    // TODO: optimization - combine last few messages or extract keywords
    
    return this.retrieve(query, topK);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (!scope) {
      this.store.clear();
      return;
    }

    for (const [id, entry] of this.store.entries()) {
      if (entry.scope === scope) {
        this.store.delete(id);
      }
    }
  }

  // --- Helper Methods ---

  /**
   * Calculate Cosine Similarity between two vectors
   */
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
