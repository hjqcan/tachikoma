import { describe, expect, test } from 'bun:test';
import type { Tool } from '../src/types';
import { runToolPreflight, resolveToolProfile } from '../src/worker/tool-runtime';

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    execute: async () => ({ success: true }),
  };
}

describe('runToolPreflight', () => {
  test('should enforce pi-core aliases and sanitize unavailable tool hints', () => {
    const tools: Tool[] = [
      createMockTool('file_read'),
      createMockTool('file_write'),
      createMockTool('apply_patch'),
      createMockTool('shell_run'),
      createMockTool('file_list'),
    ];

    const result = runToolPreflight({
      tools,
      profile: 'pi-core',
      constraints: ['Recommended tools: read, write, deep_research'],
    });

    expect(result.profile).toBe('pi-core');
    expect([...result.availableToolNames].sort()).toEqual([
      'apply_patch',
      'file_read',
      'file_write',
      'shell_run',
    ]);
    expect(result.availableSkillToolNames).toContain('read');
    expect(result.availableSkillToolNames).toContain('write');
    expect(result.availableSkillToolNames).toContain('edit');
    expect(result.availableSkillToolNames).toContain('bash');
    expect(result.removedToolHints).toContain('deep_research');
    expect(result.mismatchCount).toBe(1);

    const mergedConstraints = result.sanitizedConstraints.join('\n');
    expect(mergedConstraints).toContain('Recommended tools: file_read, file_write');
    expect(mergedConstraints).toContain('(unavailable: deep_research)');
  });

  test('should fallback to full profile when canonical pi-core tools are missing', () => {
    const tools: Tool[] = [createMockTool('file_list'), createMockTool('code_search')];

    const result = runToolPreflight({
      tools,
      profile: 'pi-core',
      constraints: [],
    });

    expect(result.profile).toBe('full');
    expect(result.availableToolNames).toEqual(['file_list', 'code_search']);
    expect(result.nativeTools.map((tool) => tool.name)).toEqual(['file_list', 'code_search']);
    expect(result.notes.some((note) => note.includes('fell back to full profile'))).toBe(true);
  });
});

describe('resolveToolProfile', () => {
  test('应支持 TACHIKOMA_TOOL_PROFILE_DEFAULT 作为默认剖面来源', () => {
    const profile = resolveToolProfile(undefined, {
      TACHIKOMA_TOOL_PROFILE_DEFAULT: 'pi-core',
    });
    expect(profile).toBe('pi-core');
  });
});
