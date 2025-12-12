import type { EmbeddingService } from './types';

/**
 * Fast hash function for cache keys (DJB2 + length prefix)
 * Uses DJB2 for speed while adding length to reduce collisions
 */
function hashKey(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and combine with length for fewer collisions
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Simple LRU Cache for embeddings
 * Uses hashed keys to reduce memory for long texts
 */
class EmbeddingCache {
  private cache = new Map<string, number[]>();
  private maxSize: number;
  private enabled: boolean;

  constructor(maxSize = 1000) {
    // maxSize <= 0 disables caching
    this.maxSize = Math.max(0, maxSize);
    this.enabled = this.maxSize > 0;
  }

  get(text: string): number[] | undefined {
    if (!this.enabled) return undefined;
    const key = hashKey(text);
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(text: string, value: number[]): void {
    if (!this.enabled) return;
    const key = hashKey(text);
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove oldest (first) entry
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  size(): number {
    return this.cache.size;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * OpenRouter Embedding Service
 * 
 * Uses OpenRouter API to generate embeddings via OpenAI models.
 * Features:
 * - Retry with exponential backoff (3 attempts)
 * - LRU cache (default 1000 entries)
 * - Configurable timeout (default 30s)
 * - Handles 429/5xx errors gracefully
 * 
 * Default model: openai/text-embedding-3-small (1536 dimensions)
 */
export class OpenRouterEmbeddingService implements EmbeddingService {
  private apiKey: string;
  private model: string;
  private readonly baseUrl = 'https://openrouter.ai/api/v1/embeddings';
  private cache: EmbeddingCache;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(
    apiKey: string, 
    model = 'openai/text-embedding-3-small',
    options: { cacheSize?: number; maxRetries?: number; timeoutMs?: number } = {}
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.cache = new EmbeddingCache(options.cacheSize ?? 1000);
    // Clamp maxRetries to >= 1 (at least one attempt)
    this.maxRetries = Math.max(1, options.maxRetries ?? 3);
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  async embed(text: string): Promise<number[]> {
    // Check cache first
    const cached = this.cache.get(text);
    if (cached) {
      return cached;
    }

    const embeddings = await this.embedBatch([text]);
    if (embeddings.length === 0) {
      throw new Error('No embedding returned from service');
    }
    return embeddings[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Partition into cached and uncached
    const results: (number[] | null)[] = texts.map(() => null);
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cached = this.cache.get(text);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedTexts.push(text);
        uncachedIndices.push(i);
      }
    }

    // If all cached, return early
    if (uncachedTexts.length === 0) {
      return results as number[][];
    }

    // Fetch uncached embeddings with retry
    const newEmbeddings = await this.fetchWithRetry(uncachedTexts);

    // Populate results and cache
    for (let i = 0; i < uncachedTexts.length; i++) {
      const text = uncachedTexts[i]!;
      const embedding = newEmbeddings[i]!;
      const originalIndex = uncachedIndices[i]!;
      results[originalIndex] = embedding;
      this.cache.set(text, embedding);
    }

    return results as number[][];
  }

  private async fetchWithRetry(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.fetchEmbeddings(texts);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if retryable
        const isRetryable = this.isRetryableError(lastError);
        if (!isRetryable || attempt === this.maxRetries - 1) {
          break;
        }

        // Exponential backoff: 1s, 2s, 4s...
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[EmbeddingService] Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, lastError.message);
        await this.sleep(delay);
      }
    }

    throw lastError ?? new Error('Unknown embedding error');
  }

  private async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://tachikoma.agent',
          'X-Title': 'Tachikoma Agent',
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        const error = new Error(`Embedding request failed: ${response.status} ${response.statusText} - ${errorBody}`);
        (error as RetryableError).statusCode = response.status;
        throw error;
      }

      const data = await response.json() as OpenAIEmbeddingResponse;

      // Validate response length matches input
      if (data.data.length !== texts.length) {
        const error = new Error(
          `Embedding response length mismatch: expected ${texts.length}, got ${data.data.length}`
        );
        (error as RetryableError).statusCode = 500; // Treat as server error for retry
        throw error;
      }

      // Sort by index to ensure order matches input
      data.data.sort((a, b) => a.index - b.index);

      return data.data.map(item => item.embedding);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private isRetryableError(error: Error): boolean {
    const retryableError = error as RetryableError;
    if (retryableError.statusCode) {
      // Retry on 429 (rate limit) and 5xx (server errors)
      return retryableError.statusCode === 429 || retryableError.statusCode >= 500;
    }
    // Retry on network errors (case-insensitive, common error patterns)
    const msg = error.message.toLowerCase();
    const name = error.name.toLowerCase();
    return (
      msg.includes('fetch') ||
      msg.includes('network') ||
      msg.includes('abort') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('socket') ||
      name === 'aborterror' ||
      name === 'typeerror' // fetch throws TypeError on network failure
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Get current cache size (for debugging/metrics) */
  getCacheSize(): number {
    return this.cache.size();
  }
}

interface RetryableError extends Error {
  statusCode?: number;
}

/**
 * Mock Embedding Service
 * 
 * Generates random embeddings for testing.
 */
export class MockEmbeddingService implements EmbeddingService {
  private dimension: number;

  constructor(dimension = 1536) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    return this.generateVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.generateVector(text));
  }

  private generateVector(text: string): number[] {
    const vector = new Array(this.dimension).fill(0);
    const lower = text.toLowerCase();
    
    // Simple keyword-based embedding for testing semantic similarity
    if (lower.includes('agent') || lower.includes('memory') || lower.includes('build')) {
      vector[0] = 1;
    } else if (lower.includes('weather') || lower.includes('food')) {
      vector[1] = 1;
    } else {
      vector[2] = 1;
    }
    
    // Add deterministic noise based on text length to avoid identical vectors
    vector[3] = (text.length % 100) / 100;

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return magnitude === 0 
      ? vector // Should not happen with logic above
      : vector.map(val => val / magnitude);
  }
}

// Minimal type definition for OpenAI embedding response
interface OpenAIEmbeddingResponse {
  data: {
    embedding: number[];
    index: number;
    object: string;
  }[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
