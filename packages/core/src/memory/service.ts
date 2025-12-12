import type { 
  MemoryConfig, 
  MemoryProvider, 
  MemoryEntry, 
  MemoryScope, 
  MemoryRetrievalResult,
  ContextMessageMinimal 
} from './types';
import { InMemoryMemoryProvider } from './providers/in-memory';
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

  constructor(config: MemoryConfig) {
    this.config = config;
    
    // Initialize Embedding Service
    const embeddingService = config.embeddingService || this.createDefaultEmbeddingService(config);

    // Initialize Provider based on type
    switch (config.providerType) {
      case 'redis':
        throw new Error('Redis provider not implemented yet');
      case 'leveldb':
        throw new Error('LevelDB provider not implemented yet');
      case 'vector':
        throw new Error('Vector provider not implemented yet');
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
