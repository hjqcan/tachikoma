import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LevelDBMemoryProvider } from '../src/memory/providers/leveldb';
import { MemoryService } from '../src/memory/service';
import { MockEmbeddingService } from '../src/memory/embedding';

describe('LevelDBMemoryProvider', () => {
  const mockEmbeddingService = new MockEmbeddingService(10);
  let testDbPath: string;
  let provider: LevelDBMemoryProvider;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDbPath = mkdtempSync(join(tmpdir(), 'tachikoma-leveldb-test-'));
    provider = new LevelDBMemoryProvider(testDbPath, mockEmbeddingService);
    await provider.open();
  });

  afterEach(async () => {
    await provider.close();
    // Clean up test DB
    if (existsSync(testDbPath)) {
      rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  test('save and retrieve memory', async () => {
    const id = await provider.save({
      content: 'How to build an AI agent',
      scope: 'declarative',
    });

    expect(id).toBeTruthy();
    expect(await provider.count()).toBe(1);

    const result = await provider.retrieve('building AI agents');
    expect(result.memories.length).toBe(1);
    expect(result.memories[0].content).toBe('How to build an AI agent');
  });

  test('scope isolation', async () => {
    await provider.save({ content: 'Declarative memory', scope: 'declarative' });
    await provider.save({ content: 'Procedural memory', scope: 'procedural' });

    expect(await provider.count()).toBe(2);
    expect(await provider.count('declarative')).toBe(1);
    expect(await provider.count('procedural')).toBe(1);

    const declarativeResult = await provider.retrieve('memory', 10, 'declarative');
    expect(declarativeResult.memories.length).toBe(1);
    expect(declarativeResult.memories[0].content).toBe('Declarative memory');
  });

  test('clear by scope', async () => {
    await provider.save({ content: 'Declarative 1', scope: 'declarative' });
    await provider.save({ content: 'Declarative 2', scope: 'declarative' });
    await provider.save({ content: 'Procedural 1', scope: 'procedural' });

    expect(await provider.count()).toBe(3);

    await provider.clear('declarative');
    expect(await provider.count()).toBe(1);
    expect(await provider.count('procedural')).toBe(1);
  });

  test('delete specific memory', async () => {
    const id1 = await provider.save({ content: 'Memory 1', scope: 'declarative' });
    await provider.save({ content: 'Memory 2', scope: 'declarative' });

    expect(await provider.count()).toBe(2);

    await provider.delete(id1);
    expect(await provider.count()).toBe(1);
  });

  test('persistence across open/close', async () => {
    await provider.save({ content: 'Persistent memory', scope: 'declarative' });
    await provider.close();

    // Reopen
    const provider2 = new LevelDBMemoryProvider(testDbPath, mockEmbeddingService);
    await provider2.open();

    expect(await provider2.count()).toBe(1);
    const result = await provider2.retrieve('persistent');
    expect(result.memories[0].content).toBe('Persistent memory');

    await provider2.close();
  });

  test('search from context', async () => {
    await provider.save({
      content: 'Agent memory architecture best practices',
      scope: 'declarative',
    });

    const context = [
      { id: '1', role: 'user' as const, content: 'Tell me about agent memory', timestamp: Date.now() },
    ];

    const result = await provider.search(context);
    expect(result.memories.length).toBe(1);
  });
});

describe('MemoryService with LevelDB', () => {
  let testDbPath: string;

  afterEach(() => {
    if (testDbPath && existsSync(testDbPath)) {
      rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  test('creates LevelDB provider with persistPath', async () => {
    testDbPath = mkdtempSync(join(tmpdir(), 'tachikoma-leveldb-service-test-'));
    const service = new MemoryService({
      enabled: true,
      providerType: 'leveldb',
      persistPath: testDbPath,
      embeddingService: new MockEmbeddingService(10),
    });

    const id = await service.save({ content: 'Test memory', scope: 'declarative' });
    expect(id).toBeTruthy();

    await service.close();
  });

  test('throws without persistPath', () => {
    expect(() => new MemoryService({
      enabled: true,
      providerType: 'leveldb',
      embeddingService: new MockEmbeddingService(10),
    })).toThrow('persistPath');
  });
});
