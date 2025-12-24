/**
 * Skill Memory Blocks tests
 *
 * Tests for SkillBlockManager
 *
 * @module tests/skill-blocks.test
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  SkillBlockManager,
  SKILL_MEMORY_BLOCK_LABELS,
  SKILL_READ_ONLY_BLOCKS,
  EMPTY_LOADED_SKILLS_PLACEHOLDER,
  SKILL_CONTENT_SEPARATOR,
  getGlobalSkillBlockManager,
  resetGlobalSkillBlockManager,
} from '../src/skills';

// ============================================================================
// SkillBlockManager 测试
// ============================================================================

describe('SkillBlockManager', () => {
  let manager: SkillBlockManager;

  beforeEach(() => {
    manager = new SkillBlockManager();
  });

  describe('initial state', () => {
    test('initializes with empty skills block', () => {
      const skillsBlock = manager.getSkillsBlock();
      expect(skillsBlock.label).toBe('skills');
      expect(skillsBlock.value).toBe('');
      expect(skillsBlock.readOnly).toBe(true);
    });

    test('initializes loaded_skills with placeholder', () => {
      const loadedSkillsBlock = manager.getLoadedSkillsBlock();
      expect(loadedSkillsBlock.label).toBe('loaded_skills');
      expect(loadedSkillsBlock.value).toBe(EMPTY_LOADED_SKILLS_PLACEHOLDER);
      expect(loadedSkillsBlock.readOnly).toBe(true);
    });

    test('getAllBlocks returns both blocks', () => {
      const blocks = manager.getAllBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks.map((b) => b.label)).toEqual(['skills', 'loaded_skills']);
    });
  });

  describe('refreshSkillsBlock', () => {
    test('updates skills block with rendered content', () => {
      const skills = [
        { name: 'skill-a', description: 'Skill A', path: '/path/a/SKILL.md' },
        { name: 'skill-b', description: 'Skill B', path: '/path/b/SKILL.md' },
      ];

      manager.refreshSkillsBlock(skills);

      const block = manager.getSkillsBlock();
      expect(block.value).toContain('skill-a');
      expect(block.value).toContain('skill-b');
    });

    test('shows no skills available for empty list', () => {
      manager.refreshSkillsBlock([]);

      const block = manager.getSkillsBlock();
      expect(block.value).toBe('[NO SKILLS AVAILABLE]');
    });
  });

  describe('loadSkill', () => {
    test('loads a skill successfully', () => {
      const result = manager.loadSkill('test-skill', '# Test Content\n\nSome instructions.');

      expect(result).toBe(true);
      expect(manager.getLoadedSkillIds()).toContain('test-skill');

      const block = manager.getLoadedSkillsBlock();
      expect(block.value).toContain('# Skill: test-skill');
      expect(block.value).toContain('# Test Content');
    });

    test('returns false for already loaded skill', () => {
      manager.loadSkill('test-skill', 'Content 1');
      const result = manager.loadSkill('test-skill', 'Content 2');

      expect(result).toBe(false);
      expect(manager.getLoadedSkillIds()).toEqual(['test-skill']);
    });

    test('loads multiple skills with separator', () => {
      manager.loadSkill('skill-a', 'Content A');
      manager.loadSkill('skill-b', 'Content B');

      const block = manager.getLoadedSkillsBlock();
      expect(block.value).toContain('# Skill: skill-a');
      expect(block.value).toContain('# Skill: skill-b');
      expect(block.value).toContain(SKILL_CONTENT_SEPARATOR);
      expect(manager.getLoadedSkillIds()).toEqual(['skill-a', 'skill-b']);
    });
  });

  describe('unloadSkill', () => {
    test('unloads a skill successfully', () => {
      manager.loadSkill('test-skill', 'Content');
      const result = manager.unloadSkill('test-skill');

      expect(result).toBe(true);
      expect(manager.getLoadedSkillIds()).toEqual([]);
      expect(manager.getLoadedSkillsBlock().value).toBe(EMPTY_LOADED_SKILLS_PLACEHOLDER);
    });

    test('returns false for not loaded skill', () => {
      const result = manager.unloadSkill('not-loaded');
      expect(result).toBe(false);
    });

    test('unloads one of multiple skills', () => {
      manager.loadSkill('skill-a', 'Content A');
      manager.loadSkill('skill-b', 'Content B');

      const result = manager.unloadSkill('skill-a');

      expect(result).toBe(true);
      expect(manager.getLoadedSkillIds()).toEqual(['skill-b']);

      const block = manager.getLoadedSkillsBlock();
      expect(block.value).not.toContain('# Skill: skill-a');
      expect(block.value).toContain('# Skill: skill-b');
    });
  });

  describe('renderLoadedSkillsForPrompt', () => {
    test('returns null for empty loaded skills', () => {
      const result = manager.renderLoadedSkillsForPrompt();
      expect(result).toBeNull();
    });

    test('renders loaded skills for prompt', () => {
      manager.loadSkill('test-skill', 'Instructions here.');

      const result = manager.renderLoadedSkillsForPrompt();

      expect(result).not.toBeNull();
      expect(result).toContain('## Loaded Skills');
      expect(result).toContain('# Skill: test-skill');
    });
  });

  describe('reset', () => {
    test('resets all blocks to initial state', () => {
      manager.refreshSkillsBlock([{ name: 'skill', description: 'Desc', path: '/p' }]);
      manager.loadSkill('skill', 'Content');

      manager.reset();

      expect(manager.getSkillsBlock().value).toBe('');
      expect(manager.getLoadedSkillsBlock().value).toBe(EMPTY_LOADED_SKILLS_PLACEHOLDER);
      expect(manager.getLoadedSkillIds()).toEqual([]);
    });
  });

  describe('static methods', () => {
    test('isSkillBlock identifies skill blocks', () => {
      expect(SkillBlockManager.isSkillBlock('skills')).toBe(true);
      expect(SkillBlockManager.isSkillBlock('loaded_skills')).toBe(true);
      expect(SkillBlockManager.isSkillBlock('persona')).toBe(false);
    });

    test('isReadOnlyBlock identifies read-only blocks', () => {
      expect(SkillBlockManager.isReadOnlyBlock('skills')).toBe(true);
      expect(SkillBlockManager.isReadOnlyBlock('loaded_skills')).toBe(true);
      expect(SkillBlockManager.isReadOnlyBlock('project')).toBe(false);
    });
  });
});

// ============================================================================
// 常量测试
// ============================================================================

describe('Skill Memory Block Constants', () => {
  test('SKILL_MEMORY_BLOCK_LABELS contains expected labels', () => {
    expect(SKILL_MEMORY_BLOCK_LABELS).toContain('skills');
    expect(SKILL_MEMORY_BLOCK_LABELS).toContain('loaded_skills');
    expect(SKILL_MEMORY_BLOCK_LABELS).toHaveLength(2);
  });

  test('SKILL_READ_ONLY_BLOCKS matches SKILL_MEMORY_BLOCK_LABELS', () => {
    expect(SKILL_READ_ONLY_BLOCKS).toEqual(SKILL_MEMORY_BLOCK_LABELS);
  });

  test('EMPTY_LOADED_SKILLS_PLACEHOLDER is correct', () => {
    expect(EMPTY_LOADED_SKILLS_PLACEHOLDER).toBe('[CURRENTLY EMPTY]');
  });

  test('SKILL_CONTENT_SEPARATOR is correct', () => {
    expect(SKILL_CONTENT_SEPARATOR).toBe('\n\n---\n\n');
  });
});

// ============================================================================
// 全局单例测试
// ============================================================================

describe('Global SkillBlockManager', () => {
  beforeEach(() => {
    resetGlobalSkillBlockManager();
  });

  test('getGlobalSkillBlockManager returns singleton', () => {
    const manager1 = getGlobalSkillBlockManager();
    const manager2 = getGlobalSkillBlockManager();

    expect(manager1).toBe(manager2);
  });

  test('resetGlobalSkillBlockManager creates new instance', () => {
    const manager1 = getGlobalSkillBlockManager();
    manager1.loadSkill('skill', 'Content');

    resetGlobalSkillBlockManager();

    const manager2 = getGlobalSkillBlockManager();
    expect(manager2.getLoadedSkillIds()).toEqual([]);
  });
});
