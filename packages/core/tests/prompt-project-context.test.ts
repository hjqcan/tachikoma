import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectContextLoader, ProjectContextInjector } from '../src/prompt/project';
import type { ContextMessage } from '../src/prompt/types';

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tachikoma-project-context-'));
}

describe('prompt/project ProjectContextLoader + ProjectContextInjector', () => {
  test('loader detects project vs parent levels using resolved paths', async () => {
    const base = await createTempDir();
    try {
      const projectDir = join(base, 'proj');
      await mkdir(projectDir, { recursive: true });

      await writeFile(join(projectDir, 'TACHIKOMA.md'), '# Project\n', 'utf-8');
      await writeFile(join(base, 'AGENTS.md'), '# Parent\n', 'utf-8');

      const loader = new ProjectContextLoader();
      const ctx = await loader.loadProjectContext(projectDir);

      expect(ctx.metadata.projectLevel).not.toBeNull();
      expect(ctx.metadata.parentLevels).toBe(1);

      const hasProject = ctx.files.some((f) => f.level === 'project');
      const hasParent = ctx.files.some((f) => f.level === 'parent');
      expect(hasProject).toBe(true);
      expect(hasParent).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('injector is idempotent (no duplicate project-context message)', async () => {
    const base = await createTempDir();
    try {
      await writeFile(join(base, 'TACHIKOMA.md'), '# Project\nRules\n', 'utf-8');

      const injector = new ProjectContextInjector();
      const input: ContextMessage[] = [
        { id: 'sys', role: 'system', content: 'system', timestamp: Date.now(), format: 'full' },
        { id: 'u1', role: 'user', content: 'hi', timestamp: Date.now(), format: 'full' },
      ];

      const once = await injector.injectProjectContext(input, base);
      const twice = await injector.injectProjectContext(once, base);

      const projectMessages = twice.filter((m) => m.id === 'project-context');
      expect(projectMessages.length).toBe(1);

      // Should be inserted after existing system messages, before user message
      const sysIndex = twice.findIndex((m) => m.id === 'sys');
      const projIndex = twice.findIndex((m) => m.id === 'project-context');
      const userIndex = twice.findIndex((m) => m.id === 'u1');
      expect(sysIndex).toBeGreaterThanOrEqual(0);
      expect(projIndex).toBeGreaterThan(sysIndex);
      expect(userIndex).toBeGreaterThan(projIndex);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

