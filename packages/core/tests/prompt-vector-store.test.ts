import { describe, test, expect, beforeEach } from 'bun:test';

import {
  InMemoryVectorStore,
  SimpleEmbeddingProvider,
  createInMemoryVectorStore,
  createSimpleEmbeddingProvider,
} from '../src/prompt/memory/vector-store';

// ============================================================================
// InMemoryVectorStore Tests
// ============================================================================

describe('prompt/memory InMemoryVectorStore', () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = createInMemoryVectorStore();
  });

  test('add and get entry', async () => {
    const entry = {
      id: 'test-1',
      content: 'Hello world',
      embedding: [0.1, 0.2, 0.3, 0.4],
      metadata: { source: 'test' },
    };

    await store.add(entry);
    const retrieved = await store.get('test-1');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.content).toBe('Hello world');
    expect(retrieved?.metadata?.source).toBe('test');
  });

  test('addBatch adds multiple entries', async () => {
    const entries = [
      { id: 'batch-1', content: 'First', embedding: [0.1, 0.2, 0.3] },
      { id: 'batch-2', content: 'Second', embedding: [0.4, 0.5, 0.6] },
      { id: 'batch-3', content: 'Third', embedding: [0.7, 0.8, 0.9] },
    ];

    await store.addBatch(entries);

    expect(store.size()).toBe(3);
    expect(await store.get('batch-2')).not.toBeNull();
  });

  test('search returns results sorted by similarity', async () => {
    // Add entries with known embeddings
    await store.add({
      id: 'similar',
      content: 'Similar content',
      embedding: [1, 0, 0, 0], // Very similar to query
    });
    await store.add({
      id: 'different',
      content: 'Different content',
      embedding: [0, 0, 0, 1], // Very different from query
    });
    await store.add({
      id: 'medium',
      content: 'Medium similarity',
      embedding: [0.7, 0.7, 0, 0], // Somewhat similar
    });

    const query = [1, 0, 0, 0];
    const results = await store.search(query, 3, 0);

    expect(results.length).toBe(3);
    expect(results[0]?.entry.id).toBe('similar');
    expect(results[0]?.score).toBeCloseTo(1, 5);
  });

  test('search respects threshold', async () => {
    await store.add({
      id: 'high',
      content: 'High similarity',
      embedding: [1, 0, 0],
    });
    await store.add({
      id: 'low',
      content: 'Low similarity',
      embedding: [0, 0, 1],
    });

    const query = [1, 0, 0];
    const results = await store.search(query, 10, 0.9);

    // Only the high similarity entry should pass
    expect(results.length).toBe(1);
    expect(results[0]?.entry.id).toBe('high');
  });

  test('search respects topK', async () => {
    for (let i = 0; i < 10; i++) {
      await store.add({
        id: `entry-${i}`,
        content: `Content ${i}`,
        embedding: new Array(4).fill(i / 10),
      });
    }

    const query = [1, 1, 1, 1];
    const results = await store.search(query, 3, 0);

    expect(results.length).toBe(3);
  });

  test('delete removes entry', async () => {
    await store.add({
      id: 'to-delete',
      content: 'Delete me',
      embedding: [0.5, 0.5],
    });

    expect(store.size()).toBe(1);

    const deleted = await store.delete('to-delete');
    expect(deleted).toBe(true);
    expect(store.size()).toBe(0);
    expect(await store.get('to-delete')).toBeNull();
  });

  test('clear removes all entries', async () => {
    await store.addBatch([
      { id: 'a', content: 'A', embedding: [1] },
      { id: 'b', content: 'B', embedding: [2] },
    ]);

    await store.clear();

    expect(store.size()).toBe(0);
  });

  test('euclidean similarity works', async () => {
    const euclideanStore = createInMemoryVectorStore({
      similarityMethod: 'euclidean',
    });

    await euclideanStore.add({
      id: 'close',
      content: 'Close',
      embedding: [1.1, 0.1, 0.1],
    });
    await euclideanStore.add({
      id: 'far',
      content: 'Far',
      embedding: [10, 10, 10],
    });

    const query = [1, 0, 0];
    const results = await euclideanStore.search(query, 2, 0);

    expect(results[0]?.entry.id).toBe('close');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });
});

// ============================================================================
// SimpleEmbeddingProvider Tests
// ============================================================================

describe('prompt/memory SimpleEmbeddingProvider', () => {
  test('embed returns vector of correct dimension', async () => {
    const provider = createSimpleEmbeddingProvider(256);
    const embedding = await provider.embed('Hello world');

    expect(embedding.length).toBe(256);
    expect(provider.getDimension()).toBe(256);
  });

  test('embed returns normalized vector', async () => {
    const provider = createSimpleEmbeddingProvider(128);
    const embedding = await provider.embed('Test content here');

    // Check L2 norm is approximately 1
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test('embedBatch returns multiple embeddings', async () => {
    const provider = createSimpleEmbeddingProvider(64);
    const texts = ['First text', 'Second text', 'Third text'];
    const embeddings = await provider.embedBatch(texts);

    expect(embeddings.length).toBe(3);
    expect(embeddings[0]?.length).toBe(64);
    expect(embeddings[1]?.length).toBe(64);
  });

  test('similar texts produce similar embeddings', async () => {
    const provider = createSimpleEmbeddingProvider(128);

    const e1 = await provider.embed('hello world');
    const e2 = await provider.embed('hello world!');
    const e3 = await provider.embed('completely different content xyz');

    // Calculate cosine similarity
    const similarity12 = dotProduct(e1, e2);
    const similarity13 = dotProduct(e1, e3);

    // Similar texts should have higher similarity
    expect(similarity12).toBeGreaterThan(similarity13);
  });

  test('default dimension is 128', async () => {
    const provider = createSimpleEmbeddingProvider();
    expect(provider.getDimension()).toBe(128);
  });
});

// Helper function for cosine similarity
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}
