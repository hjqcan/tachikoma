import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionContext } from '../src/types';
import { coreTools, getToolByName, getToolNames } from '../src/tools';
import { applyPatchTool } from '../src/tools/core/file-patch';
import { fileWriteTool } from '../src/tools/core/file-write';
import { ReadFileStateCache } from '../src/tools/read-file-state';

function createExecutionContext(workDir: string, readFileState?: ReadFileStateCache): ExecutionContext {
  return {
    taskId: 'task-tools-surface',
    agentId: 'agent-tools-surface',
    traceId: 'trace-tools-surface',
    workDir,
    env: {},
    ...(readFileState ? { readFileState } : {}),
  };
}

describe('tool surface', () => {
  it('exposes only the minimal Claude Code-style default toolset', () => {
    expect(coreTools.map((tool) => tool.name)).toEqual([
      'file_read',
      'file_write',
      'file_list',
      'shell_run',
      'code_search',
      'apply_patch',
      'spawn_subagent',
      'todowrite',
      'todoread',
    ]);
  });

  it('exposes Claude Code-style canonical names to the model surface', () => {
    expect(getToolNames()).toEqual([
      'Read',
      'Write',
      'Glob',
      'Bash',
      'Grep',
      'Edit',
      'Agent',
      'TodoWrite',
      'TodoRead',
    ]);
    expect(getToolByName('Bash')?.name).toBe('shell_run');
    expect(getToolByName('bash')?.name).toBe('shell_run');
    expect(getToolByName('Read')?.name).toBe('file_read');
    expect(getToolByName('read')?.name).toBe('file_read');
  });

  it('requires reading an existing file before file_write overwrites it', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-tools-'));
    const filePath = join(workDir, 'existing.ts');
    await writeFile(filePath, 'export const value = 1;\n', 'utf-8');

    const readState = new ReadFileStateCache();
    const unreadResult = await fileWriteTool.validateInput?.(
      { path: 'existing.ts', content: 'export const value = 2;\n' },
      createExecutionContext(workDir, readState),
    );
    expect(unreadResult).toEqual({
      result: false,
      message: 'Read the file with file_read before overwriting it with file_write: existing.ts',
    });

    readState.markRead(filePath, 24);
    const readResult = await fileWriteTool.validateInput?.(
      { path: 'existing.ts', content: 'export const value = 2;\n' },
      createExecutionContext(workDir, readState),
    );
    expect(readResult).toEqual({ result: true });
  });

  it('requires reading an existing file before apply_patch edits it', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-tools-'));
    const filePath = join(workDir, 'existing.ts');
    await writeFile(filePath, 'export const value = 1;\n', 'utf-8');

    const readState = new ReadFileStateCache();
    const unreadResult = await applyPatchTool.validateInput?.(
      {
        path: 'existing.ts',
        patches: [{ search: 'value = 1', replace: 'value = 2' }],
      },
      createExecutionContext(workDir, readState),
    );
    expect(unreadResult).toEqual({
      result: false,
      message: 'Read the file with file_read before editing it with apply_patch: existing.ts',
    });

    readState.markRead(filePath, 24);
    const readResult = await applyPatchTool.validateInput?.(
      {
        path: 'existing.ts',
        patches: [{ search: 'value = 1', replace: 'value = 2' }],
      },
      createExecutionContext(workDir, readState),
    );
    expect(readResult).toEqual({ result: true });
  });
});
