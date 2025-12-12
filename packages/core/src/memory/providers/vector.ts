import { v4 as uuidv4 } from 'uuid';
import type { 
  MemoryProvider, 
  MemoryEntry, 
  MemoryScope, 
  MemoryRetrievalResult, 
  EmbeddingService,
  ContextMessageMinimal,
  VectorDBProvider
} from '../types';

/**
 * Vector Database Memory Provider
 * 
 * Implements MemoryProvider using any VectorDBProvider backend.
 * This allows using Qdrant, Pinecone, Chroma, etc. for memory storage.
 * 
 * Features:
 * - Uses vector similarity for semantic search
 * - Stores lightweight payload (no embedding duplication)
 * - Supports scope filtering via payload filter
 * - Uses native deleteByFilter for efficient bulk operations
 */
export class VectorMemoryProvider implements MemoryProvider {
  private vectorDB: VectorDBProvider;
  private embeddingService: EmbeddingService;
  private initialized = false;

  constructor(vectorDB: VectorDBProvider, embeddingService: EmbeddingService) {
    this.vectorDB = vectorDB;
    this.embeddingService = embeddingService;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.vectorDB.initialize();
      this.initialized = true;
    }
  }

  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    await this.ensureInitialized();
    
    const id = uuidv4();
    const createdAt = Date.now();
    
    let embedding = entry.embedding;
    if (!embedding) {
      embedding = await this.embeddingService.embed(entry.content);
    }

    // Build lightweight payload (don't store embedding - it's in the vector)
    const payload: Record<string, unknown> = {
      content: entry.content,
      scope: entry.scope,
      createdAt,
    };
    
    // Only add optional fields if present
    if (entry.metadata) {
      payload.metadata = entry.metadata;
    }

    await this.vectorDB.upsert([{
      id,
      vector: embedding,
      payload,
    }]);

    return id;
  }

  async retrieve(
    query: string, 
    topK = 5, 
    scope?: MemoryScope
  ): Promise<MemoryRetrievalResult> {
    await this.ensureInitialized();
    const startTime = Date.now();
    
    const queryEmbedding = await this.embeddingService.embed(query);
    
    const filter = scope ? { scope } : undefined;
    const results = await this.vectorDB.search(queryEmbedding, topK, filter);

    const memories: MemoryEntry[] = results.map(r => {
      const entry: MemoryEntry = {
        id: r.id,
        content: r.payload.content as string,
        scope: r.payload.scope as MemoryScope,
        createdAt: r.payload.createdAt as number,
        lastAccessedAt: Date.now(),
        relevanceScore: r.score,
      };
      // Note: embedding not stored in payload to save space
      // If needed, it would require re-embedding or fetching from vector
      const metadata = r.payload.metadata as Record<string, unknown> | undefined;
      if (metadata) entry.metadata = metadata;
      return entry;
    });

    return {
      memories,
      latencyMs: Date.now() - startTime,
      fromCache: false,
    };
  }

  async search(
    context: ContextMessageMinimal[], 
    topK = 5
  ): Promise<MemoryRetrievalResult> {
    if (context.length === 0) {
      return { memories: [], latencyMs: 0, fromCache: false };
    }

    // Filter to user and assistant messages
    const relevantMessages = context.filter(
      m => m.role === 'user' || m.role === 'assistant'
    );

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
      .map(m => m.content)
      .filter(c => c.length > 0);

    let query = queryParts.join(' | ');
    
    // Limit query length
    const MAX_QUERY_LENGTH = 2000;
    if (query.length > MAX_QUERY_LENGTH) {
      query = query.slice(0, MAX_QUERY_LENGTH);
    }

    return this.retrieve(query, topK);
  }

  async delete(id: string): Promise<void> {
    await this.ensureInitialized();
    await this.vectorDB.delete([id]);
  }

  async clear(scope?: MemoryScope): Promise<void> {
    await this.ensureInitialized();
    
    if (scope) {
      // Use native deleteByFilter for correct semantics
      await this.vectorDB.deleteByFilter({ scope });
    } else {
      // Clear all scopes using filter-based deletion
      const scopes: MemoryScope[] = ['session', 'user', 'declarative', 'procedural', 'collective'];
      for (const s of scopes) {
        await this.vectorDB.deleteByFilter({ scope: s });
      }
    }
  }

  /**
   * Get count of stored memories
   */
  async count(): Promise<number> {
    await this.ensureInitialized();
    const info = await this.vectorDB.getInfo();
    return info.count;
  }

  /**
   * Close the vector database connection
   */
  async close(): Promise<void> {
    await this.vectorDB.close();
    this.initialized = false;
  }
}
