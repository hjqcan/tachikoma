import { QdrantClient } from '@qdrant/js-client-rest';
import type { VectorDBProvider, VectorPoint, VectorSearchResult } from '../types';

/**
 * Qdrant Vector Database Provider
 * 
 * Implements VectorDBProvider using Qdrant vector database.
 * Features:
 * - Cosine similarity search
 * - Payload filtering
 * - Automatic collection creation with configurable vector size
 * - Collection validation (size/distance check)
 * - Native filter-based deletion and scroll
 */
export class QdrantProvider implements VectorDBProvider {
  private client: QdrantClient;
  private collectionName: string;
  private vectorSize: number;

  constructor(
    url: string,
    collectionName: string,
    vectorSize: number,
    apiKey?: string
  ) {
    const clientParams: { url: string; apiKey?: string } = { url };
    if (apiKey) {
      clientParams.apiKey = apiKey;
    }
    this.client = new QdrantClient(clientParams);
    this.collectionName = collectionName;
    this.vectorSize = vectorSize;
  }

  async initialize(): Promise<void> {
    // Check if collection exists
    const collections = await this.client.getCollections();
    const existing = collections.collections.find(c => c.name === this.collectionName);

    if (!existing) {
      // Create collection with cosine distance
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: this.vectorSize,
          distance: 'Cosine',
        },
      });
    } else {
      // Validate existing collection configuration
      const info = await this.client.getCollection(this.collectionName);
      const vectorConfig = info.config?.params?.vectors;
      
      // Detect named vectors / multi-vectors (not supported)
      if (vectorConfig && typeof vectorConfig === 'object') {
        if (!('size' in vectorConfig)) {
          // This is a named vectors config (object with named vector definitions)
          throw new Error(
            `Collection "${this.collectionName}" uses named or multi-vectors configuration. ` +
            `This provider only supports single unnamed vector configuration. ` +
            `Please use a different collection name.`
          );
        }
        
        // Unnamed single vector config - validate size and distance
        const existingSize = vectorConfig.size as number;
        const existingDistance = vectorConfig.distance as string;
        
        if (existingSize !== this.vectorSize) {
          throw new Error(
            `Collection "${this.collectionName}" exists with vector size ${existingSize}, ` +
            `but requested size is ${this.vectorSize}. Please use a different collection name ` +
            `or delete the existing collection.`
          );
        }
        
        if (existingDistance !== 'Cosine') {
          throw new Error(
            `Collection "${this.collectionName}" uses distance "${existingDistance}", ` +
            `but this provider requires "Cosine". Please use a different collection name.`
          );
        }
      }
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    await this.client.upsert(this.collectionName, {
      wait: true,
      points: points.map(p => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult[]> {
    const searchParams: {
      vector: number[];
      limit: number;
      with_payload: boolean;
      filter?: Record<string, unknown>;
    } = {
      vector,
      limit,
      with_payload: true,
    };
    
    const qdrantFilter = filter ? this.buildFilter(filter) : undefined;
    if (qdrantFilter) {
      searchParams.filter = qdrantFilter;
    }

    const results = await this.client.search(this.collectionName, searchParams);

    return results.map(r => ({
      id: typeof r.id === 'string' ? r.id : String(r.id),
      score: r.score,
      payload: (r.payload as Record<string, unknown>) ?? {},
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.client.delete(this.collectionName, {
      wait: true,
      points: ids,
    });
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    const qdrantFilter = this.buildFilter(filter);
    if (!qdrantFilter) return 0;

    // First get count of matching points
    const beforeCount = (await this.getInfo()).count;
    
    // Delete by filter (Qdrant supports this natively)
    await this.client.delete(this.collectionName, {
      wait: true,
      filter: qdrantFilter,
    });
    
    const afterCount = (await this.getInfo()).count;
    return beforeCount - afterCount;
  }

  async scrollIds(filter?: Record<string, unknown>, limit = 10000): Promise<string[]> {
    const qdrantFilter = filter ? this.buildFilter(filter) : undefined;
    const ids: string[] = [];
    const pageSize = Math.min(limit, 1000); // Scroll in batches of 1000
    
    let offset: string | number | undefined = undefined;
    
    while (true) {
      const scrollParams: {
        limit: number;
        with_payload: boolean;
        with_vector: boolean;
        filter?: Record<string, unknown>;
        offset?: string | number;
      } = {
        limit: pageSize,
        with_payload: false,
        with_vector: false,
      };
      
      if (qdrantFilter) {
        scrollParams.filter = qdrantFilter;
      }
      
      if (offset !== undefined) {
        scrollParams.offset = offset;
      }
      
      const result = await this.client.scroll(this.collectionName, scrollParams);
      
      for (const point of result.points) {
        ids.push(typeof point.id === 'string' ? point.id : String(point.id));
        // Stop if we've reached the limit
        if (ids.length >= limit) {
          return ids;
        }
      }
      
      // Check if there are more pages
      const nextOffset = result.next_page_offset;
      if (!nextOffset) {
        break;
      }
      // next_page_offset can be string, number, or Record - only use string/number
      if (typeof nextOffset === 'string' || typeof nextOffset === 'number') {
        offset = nextOffset;
      } else {
        // Handle extended point id format: use first key as offset
        break;
      }
    }
    
    return ids;
  }

  async getInfo(): Promise<{ count: number; vectorSize: number }> {
    const info = await this.client.getCollection(this.collectionName);
    return { 
      count: info.points_count ?? 0,
      vectorSize: this.vectorSize,
    };
  }

  async close(): Promise<void> {
    // Qdrant JS client doesn't have explicit close, connection is per-request
  }

  /**
   * Build Qdrant filter from simple key-value pairs
   * Supports: scope, content contains, exact match
   */
  private buildFilter(filter: Record<string, unknown>): Record<string, unknown> | undefined {
    const must: Record<string, unknown>[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (typeof value === 'string') {
        must.push({
          key,
          match: { value },
        });
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        must.push({
          key,
          match: { value },
        });
      }
    }

    if (must.length === 0) return undefined;
    return { must };
  }
}
