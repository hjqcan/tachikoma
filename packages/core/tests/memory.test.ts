import { describe, test, expect } from 'bun:test';
import { MemoryService } from '../src/memory/service';
import { InMemoryMemoryProvider } from '../src/memory/providers/in-memory';
import { MockEmbeddingService, OpenRouterEmbeddingService } from '../src/memory/embedding';
import type { MemoryConfig, MemoryEntry, ContextMessageMinimal as ContextMessage } from '../src/memory/types';

describe('Memory System', () => {
  const mockEmbeddingService = new MockEmbeddingService(10); // Low dimension for easy testing

  describe('EmbeddingService', () => {
    test('embed returns vector of correct dimension', async () => {
      const vector = await mockEmbeddingService.embed('hello');
      expect(vector.length).toBe(10);
    });

    test('embedBatch returns array of vectors', async () => {
      const vectors = await mockEmbeddingService.embedBatch(['hello', 'world']);
      expect(vectors.length).toBe(2);
      expect(vectors[0].length).toBe(10);
    });

    test('OpenRouterEmbeddingService has cache and retry options', () => {
      // Test constructor options are accepted (no actual API call)
      const service = new OpenRouterEmbeddingService('fake-key', 'openai/text-embedding-3-small', {
        cacheSize: 500,
        maxRetries: 5,
        timeoutMs: 60000,
      });
      expect(service.getCacheSize()).toBe(0);
    });
  });

  describe('InMemoryMemoryProvider', () => {
    const provider = new InMemoryMemoryProvider(mockEmbeddingService);

    test('save and retrieve', async () => {
      const id = await provider.save({
        content: 'Tachikoma is an AI agent framework',
        scope: 'declarative',
      });
      expect(id).toBeDefined();

      const result = await provider.retrieve('agent framework', 1);
      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.memories[0].content).toContain('Tachikoma');
      expect(result.fromCache).toBe(false);
    });

    test('scope isolation', async () => {
      await provider.save({
        content: 'Session memory',
        scope: 'session',
      });

      const sessionResult = await provider.retrieve('memory', 5, 'session');
      expect(sessionResult.memories.some(m => m.content === 'Session memory')).toBe(true);

      const declarativeResult = await provider.retrieve('memory', 5, 'declarative');
      expect(declarativeResult.memories.some(m => m.content === 'Session memory')).toBe(false);
    });

    test('clear scope', async () => {
      await provider.clear('session');
      const result = await provider.retrieve('memory', 5, 'session');
      expect(result.memories.length).toBe(0);
    });
  });

  describe('MemoryService', () => {
    const config: MemoryConfig = {
      enabled: true,
      providerType: 'in-memory',
      embeddingService: mockEmbeddingService,
    };
    const service = new MemoryService(config);

    test('orchestrates save and retrieval', async () => {
      const id = await service.save({
        content: 'Orchestration test',
        scope: 'procedural',
      });

      const result = await service.retrieve('Orchestration');
      expect(result.memories[0].id).toBe(id);
    });

    test('search from context', async () => {
      const context: ContextMessage[] = [
        {
          id: '1',
          role: 'user',
          content: 'How to build an agent?',
          timestamp: Date.now(),
        },
      ];

      await service.save({
        content: 'To build an agent, start with core framework',
        scope: 'declarative',
      });

      const result = await service.search(context);
      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.memories[0].content).toContain('build an agent');
    });

    test('disabled service returns empty', async () => {
      const disabledService = new MemoryService({ ...config, enabled: false });
      const result = await disabledService.retrieve('test');
      expect(result.memories.length).toBe(0);
    });

    test('search filters system/tool messages', async () => {
      // Save a memory about agents
      await service.save({
        content: 'Agent architecture uses memory for long-term storage',
        scope: 'declarative',
      });

      // Context with mixed message types
      const mixedContext: ContextMessage[] = [
        { id: '1', role: 'system', content: 'You are a helpful assistant', timestamp: Date.now() },
        { id: '2', role: 'tool', content: 'Tool result: file read success', timestamp: Date.now() },
        { id: '3', role: 'user', content: 'Tell me about agent memory', timestamp: Date.now() },
        { id: '4', role: 'assistant', content: 'Agent memory enables persistent knowledge', timestamp: Date.now() },
      ];

      const result = await service.search(mixedContext);
      // Should find memory based on user/assistant messages, not system/tool
      expect(result.memories.length).toBeGreaterThan(0);
    });
  });
});
