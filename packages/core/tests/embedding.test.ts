import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { OpenRouterEmbeddingService } from '../src/memory/embedding';

describe('OpenRouterEmbeddingService', () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  beforeEach(() => {
    fetchCallCount = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockSuccessResponse = (embeddings: number[][]) => {
    return new Response(JSON.stringify({
      data: embeddings.map((embedding, index) => ({ embedding, index, object: 'embedding' })),
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }), { status: 200 });
  };

  test('cacheSize=0 disables caching', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { cacheSize: 0 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return mockSuccessResponse([[0.1, 0.2, 0.3]]);
    }) as unknown as typeof fetch;

    await service.embed('hello');
    await service.embed('hello'); // Same text, should NOT be cached
    
    expect(fetchCallCount).toBe(2); // Both calls should hit API
    expect(service.getCacheSize()).toBe(0);
  });

  test('cache hit prevents second fetch', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { cacheSize: 100 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return mockSuccessResponse([[0.1, 0.2, 0.3]]);
    }) as unknown as typeof fetch;

    const result1 = await service.embed('hello');
    const result2 = await service.embed('hello'); // Same text, should be cached
    
    expect(fetchCallCount).toBe(1); // Only one API call
    expect(result1).toEqual(result2);
    expect(service.getCacheSize()).toBe(1);
  });

  test('maxRetries=0 still makes one attempt', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { maxRetries: 0 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return mockSuccessResponse([[0.1, 0.2, 0.3]]);
    }) as unknown as typeof fetch;

    await service.embed('hello');
    expect(fetchCallCount).toBe(1);
  });

  test('retries on 429 error', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { maxRetries: 3 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount < 3) {
        return new Response('Rate limited', { status: 429 });
      }
      return mockSuccessResponse([[0.1, 0.2, 0.3]]);
    }) as unknown as typeof fetch;

    const result = await service.embed('hello');
    
    expect(fetchCallCount).toBe(3); // 2 failures + 1 success
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  test('retries on 5xx error', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { maxRetries: 2 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response('Server error', { status: 500 });
      }
      return mockSuccessResponse([[0.1, 0.2, 0.3]]);
    }) as unknown as typeof fetch;

    const result = await service.embed('hello');
    
    expect(fetchCallCount).toBe(2);
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  test('throws after max retries exhausted', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { maxRetries: 2 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response('Rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    await expect(service.embed('hello')).rejects.toThrow('429');
    expect(fetchCallCount).toBe(2);
  });

  test('validates response length matches input', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { maxRetries: 1 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      // Return wrong number of embeddings
      return new Response(JSON.stringify({
        data: [{ embedding: [0.1], index: 0, object: 'embedding' }],
        model: 'model',
        usage: { prompt_tokens: 10, total_tokens: 10 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    // Request 2 embeddings but get 1 back
    await expect(service.embedBatch(['hello', 'world'])).rejects.toThrow('length mismatch');
  });

  test('embedBatch with partial cache hit', async () => {
    const service = new OpenRouterEmbeddingService('fake-key', 'model', { cacheSize: 100 });
    
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      // Only return embeddings for uncached texts
      return mockSuccessResponse([[0.4, 0.5, 0.6]]);
    }) as unknown as typeof fetch;

    // First call caches 'hello'
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return mockSuccessResponse([[0.1, 0.2, 0.3]]);
    }) as unknown as typeof fetch;
    await service.embed('hello');
    expect(fetchCallCount).toBe(1);

    // Second call: 'hello' is cached, only 'world' needs fetch
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return mockSuccessResponse([[0.4, 0.5, 0.6]]);
    }) as unknown as typeof fetch;
    
    const results = await service.embedBatch(['hello', 'world']);
    expect(fetchCallCount).toBe(2); // Only one more call for 'world'
    expect(results[0]).toEqual([0.1, 0.2, 0.3]); // Cached
    expect(results[1]).toEqual([0.4, 0.5, 0.6]); // Fetched
  });
});
