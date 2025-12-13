import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileSystemMemoryStore } from '../src/prompt/memory/file-store';
import { createMemoryEntry } from '../src/prompt/memory/types';
import { WorkingMemoryManager } from '../src/prompt/memory/working-memory';
import type { AgentNotes } from '../src/prompt/types';

async function createTempWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tachikoma-prompt-memory-'));
  return dir;
}

describe('prompt/memory FileSystemMemoryStore + WorkingMemoryManager', () => {
  test('retrieve uses AND semantics for tags', async () => {
    const workDir = await createTempWorkDir();
    try {
      const store = new FileSystemMemoryStore(workDir);
      await store.initialize();

      const e1 = createMemoryEntry('working', 'finding s1', {
        metadata: { tags: ['finding', 's1'] },
      });
      const e2 = createMemoryEntry('working', 'todos s1', {
        metadata: { tags: ['todos', 's1'] },
      });
      const e3 = createMemoryEntry('working', 'finding s2', {
        metadata: { tags: ['finding', 's2'] },
      });

      await store.save(e1);
      await store.save(e2);
      await store.save(e3);

      const result = await store.retrieve('', {
        type: 'working',
        tags: ['finding', 's1'],
        updateAccessStats: false,
        limit: 50,
      });

      expect(result.map((e) => e.id)).toEqual([e1.id]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('updateAccessStats does not touch updatedAt', async () => {
    const workDir = await createTempWorkDir();
    try {
      const store = new FileSystemMemoryStore(workDir);
      await store.initialize();

      const entry = createMemoryEntry('working', 'hello world', {
        metadata: { tags: ['x'] },
      });
      await store.save(entry);

      const saved = await store.get(entry.id);
      expect(saved).not.toBeNull();
      if (!saved) return;

      const savedUpdatedAt = saved.metadata.updatedAt;
      const savedLastAccessedAt = saved.metadata.lastAccessedAt;

      // Ensure time moves forward
      await new Promise((r) => setTimeout(r, 10));

      const retrieved = await store.retrieve('hello world', {
        type: 'working',
        updateAccessStats: true,
        limit: 1,
      });

      expect(retrieved.length).toBe(1);

      const after = await store.get(entry.id);
      expect(after).not.toBeNull();
      if (!after) return;

      expect(after.metadata.updatedAt).toBe(savedUpdatedAt);
      expect(after.metadata.accessCount).toBeGreaterThan(0);
      expect(after.metadata.lastAccessedAt).toBeGreaterThan(savedLastAccessedAt);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('todos persist and can be restored by sessionId', async () => {
    const workDir = await createTempWorkDir();
    try {
      const store1 = new FileSystemMemoryStore(workDir);
      const wm1 = new WorkingMemoryManager(store1, {
        sessionId: 's1',
        autoSave: false,
      });
      await wm1.initialize();

      const now = Date.now();
      const notes: AgentNotes = {
        todos: [
          {
            id: 't1',
            description: 'do something',
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          },
        ],
        findings: [],
        decisions: [],
        lastUpdatedAt: now,
      };

      await wm1.saveTodos(notes);
      await wm1.close();

      const store2 = new FileSystemMemoryStore(workDir);
      const wm2 = new WorkingMemoryManager(store2, {
        sessionId: 's1',
        autoSave: false,
      });
      await wm2.initialize();

      const restored = await wm2.loadTodos();
      expect(restored.length).toBe(1);
      expect(restored[0]?.id).toBe('t1');

      await wm2.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('loadRecentSnapshots is session-scoped', async () => {
    const workDir = await createTempWorkDir();
    try {
      const store = new FileSystemMemoryStore(workDir);
      const wm = new WorkingMemoryManager(store, {
        sessionId: 's1',
        autoSave: false,
      });
      await wm.initialize();

      await wm.saveContextSnapshot(
        [
          { id: '1', role: 'user', content: 'u', timestamp: Date.now(), format: 'full' },
          { id: '2', role: 'assistant', content: 'a', timestamp: Date.now(), format: 'full' },
        ],
        's1 snapshot'
      );

      // Create a foreign session snapshot directly
      const foreign = createMemoryEntry('episodic', JSON.stringify({
        reason: 's2 snapshot',
        messageCount: 0,
        summary: '',
        timestamp: Date.now(),
        sessionId: 's2',
      }), {
        metadata: { tags: ['snapshot', 's2'] },
      });
      await store.save(foreign);

      const recent = await wm.loadRecentSnapshots(10);
      expect(recent.some((s) => s.sessionId === 's1')).toBe(true);
      expect(recent.some((s) => s.sessionId === 's2')).toBe(false);

      await wm.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
