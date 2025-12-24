/**
 * Skill Tool tests
 *
 * Tests for load/unload/refresh/list commands
 *
 * @module tests/skill-tool.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { skillTool } from '../src/tools/core';
import {
  SKILL_FILENAME,
  resetGlobalSkillBlockManager,
  getGlobalSkillBlockManager,
  SKILL_CONTENT_SEPARATOR,
  EMPTY_LOADED_SKILLS_PLACEHOLDER,
} from '../src/skills';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-skill-tool-test-'));
  return dir;
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createSkillFile(
  baseDir: string,
  skillName: string,
  content: string
): string {
  // 技能应该在 .tachikoma/skills/ 目录下
  const skillsBaseDir = path.join(baseDir, '.tachikoma', 'skills');
  const skillDir = path.join(skillsBaseDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, SKILL_FILENAME);
  fs.writeFileSync(skillPath, content, 'utf-8');
  return skillPath;
}

beforeEach(() => {
  tempDir = createTempDir();
  resetGlobalSkillBlockManager();
});

afterEach(() => {
  cleanupTempDir(tempDir);
  resetGlobalSkillBlockManager();
});

// ============================================================================
// SkillBlockManager 基础功能测试（通过 skillTool 间接测试）
// ============================================================================

describe('SkillBlockManager via skillTool', () => {
  test('getLoadedSkillIds returns empty initially', () => {
    const blockManager = getGlobalSkillBlockManager();
    expect(blockManager.getLoadedSkillIds()).toEqual([]);
  });

  test('loadSkill adds skill to loaded block', () => {
    const blockManager = getGlobalSkillBlockManager();
    
    const loaded = blockManager.loadSkill('test-skill', 'Test content');
    
    expect(loaded).toBe(true);
    expect(blockManager.getLoadedSkillIds()).toContain('test-skill');
    expect(blockManager.getLoadedSkillsBlock().value).toContain('# Skill: test-skill');
  });

  test('unloadSkill removes skill from loaded block', () => {
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('test-skill', 'Test content');
    
    const unloaded = blockManager.unloadSkill('test-skill');
    
    expect(unloaded).toBe(true);
    expect(blockManager.getLoadedSkillIds()).toEqual([]);
    expect(blockManager.getLoadedSkillsBlock().value).toBe(EMPTY_LOADED_SKILLS_PLACEHOLDER);
  });

  test('unloadSkill first of multiple skills removes trailing separator', () => {
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('skill-a', 'Content A');
    blockManager.loadSkill('skill-b', 'Content B');
    
    // 移除第一个技能
    blockManager.unloadSkill('skill-a');
    
    const value = blockManager.getLoadedSkillsBlock().value;
    // 不应该以分隔符开头
    expect(value.startsWith('---')).toBe(false);
    expect(value.startsWith('# Skill: skill-b')).toBe(true);
    expect(blockManager.getLoadedSkillIds()).toEqual(['skill-b']);
  });

  test('unloadSkill last of multiple skills removes leading separator', () => {
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('skill-a', 'Content A');
    blockManager.loadSkill('skill-b', 'Content B');
    
    // 移除最后一个技能
    blockManager.unloadSkill('skill-b');
    
    const value = blockManager.getLoadedSkillsBlock().value;
    // 不应该以分隔符结尾
    expect(value.endsWith('---')).toBe(false);
    expect(value.includes('skill-a')).toBe(true);
    expect(blockManager.getLoadedSkillIds()).toEqual(['skill-a']);
  });
});

// ============================================================================
// skillTool.execute 测试
// ============================================================================

describe('skillTool.execute', () => {
  // 创建 mock context
  const mockContext = {
    taskId: 'test-task-1',
    workDir: '', // 将在测试中设置
    sessionId: 'test-session-1',
    agentId: 'test-agent-1',
    attemptNumber: 1,
  };

  beforeEach(() => {
    mockContext.workDir = tempDir;
  });

  test('refresh command discovers skills', async () => {
    // 创建测试技能
    createSkillFile(
      tempDir,
      'test-skill',
      `---
name: test-skill
description: Test skill description
---

# Test Skill

This is a test skill.`
    );

    const result = await skillTool.execute(
      { command: 'refresh' },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('test-skill');
    expect(result.meta.skillCount).toBeGreaterThanOrEqual(1);
  });

  test('list command shows no skills when empty', async () => {
    const result = await skillTool.execute(
      { command: 'list' },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('No skills currently loaded');
    expect(result.meta.loadedCount).toBe(0);
  });

  test('load command loads a skill and returns content', async () => {
    // 创建测试技能
    createSkillFile(
      tempDir,
      'loadable-skill',
      `---
name: loadable-skill
description: A loadable skill
---

# Loadable Skill

Instructions for loading.`
    );

    const result = await skillTool.execute(
      { command: 'load', skills: ['loadable-skill'] },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('"loadable-skill" loaded');
    // 验证返回内容包含技能正文
    expect(result.data).toContain('# Loadable Skill');
    
    // 验证 BlockManager 状态
    const blockManager = getGlobalSkillBlockManager();
    expect(blockManager.getLoadedSkillIds()).toContain('loadable-skill');
  });

  test('load command handles already loaded skill', async () => {
    // 预先设置已加载状态（通过 BlockManager）
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('existing-skill', 'Content here.');

    const result = await skillTool.execute(
      { command: 'load', skills: ['existing-skill'] },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('"existing-skill" already loaded');
  });

  test('load command handles skill not found', async () => {
    const result = await skillTool.execute(
      { command: 'load', skills: ['non-existent-skill'] },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('"non-existent-skill" not found');
  });

  test('unload command unloads a skill', async () => {
    // 预先加载技能（通过 BlockManager）
    const blockManager = getGlobalSkillBlockManager();
    blockManager.loadSkill('to-unload', 'Content here.');

    const result = await skillTool.execute(
      { command: 'unload', skills: ['to-unload'] },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('"to-unload" unloaded');
    expect(blockManager.getLoadedSkillsBlock().value).toBe(EMPTY_LOADED_SKILLS_PLACEHOLDER);
  });

  test('unload command handles not loaded skill', async () => {
    const result = await skillTool.execute(
      { command: 'unload', skills: ['not-loaded'] },
      mockContext
    ) as any;

    expect(result.success).toBe(true);
    expect(result.data).toContain('"not-loaded" not loaded');
  });

  test('load and unload multiple skills', async () => {
    // 创建多个技能
    createSkillFile(tempDir, 'skill-a', `---
name: skill-a
description: Skill A
---
Content A`);
    createSkillFile(tempDir, 'skill-b', `---
name: skill-b
description: Skill B
---
Content B`);

    // 加载两个技能
    const loadResult = await skillTool.execute(
      { command: 'load', skills: ['skill-a', 'skill-b'] },
      mockContext
    ) as any;

    expect(loadResult.success).toBe(true);
    expect(loadResult.data).toContain('"skill-a" loaded');
    expect(loadResult.data).toContain('"skill-b" loaded');

    // 确认都已加载（通过 BlockManager）
    const blockManager = getGlobalSkillBlockManager();
    expect(blockManager.getLoadedSkillIds()).toContain('skill-a');
    expect(blockManager.getLoadedSkillIds()).toContain('skill-b');

    // 卸载其中一个
    const unloadResult = await skillTool.execute(
      { command: 'unload', skills: ['skill-a'] },
      mockContext
    ) as any;

    expect(unloadResult.success).toBe(true);
    expect(unloadResult.data).toContain('"skill-a" unloaded');
    
    // skill-b 应该还在
    expect(blockManager.getLoadedSkillIds()).toContain('skill-b');
    expect(blockManager.getLoadedSkillIds()).not.toContain('skill-a');
  });

  test('load/unload requires skills array', async () => {
    const loadResult = await skillTool.execute(
      { command: 'load' } as any,
      mockContext
    ) as any;

    expect(loadResult.success).toBe(false);
    expect(loadResult.error).toContain("'skills' array");

    const unloadResult = await skillTool.execute(
      { command: 'unload', skills: [] },
      mockContext
    ) as any;

    expect(unloadResult.success).toBe(false);
    expect(unloadResult.error).toContain("'skills' array");
  });
});
