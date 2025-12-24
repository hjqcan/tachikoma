/**
 * Skill Creation tests
 *
 * Tests for SkillCreator
 *
 * @module tests/skill-learning-creation.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  SkillCreator,
  createSkillCreator,
  type ReflectionResult,
  type SkillCreationInput,
} from '../src/skills';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-skill-creation-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 创建测试用 ReflectionResult
 */
function createMockReflectionResult(overrides: Partial<ReflectionResult> = {}): ReflectionResult {
  return {
    success: true,
    reasoningValid: true,
    reasoningSummary: 'Successfully analyzed the task execution trajectory.',
    patterns: [
      {
        name: 'iterative-testing',
        description: 'Always test changes incrementally before proceeding.',
        type: 'solution',
        confidence: 0.9,
        evidence: ['action-1', 'action-2'],
      },
      {
        name: 'file-backup',
        description: 'Create backups before destructive operations.',
        type: 'optimization',
        confidence: 0.85,
        evidence: ['thinking-3'],
      },
    ],
    failureModes: [
      {
        type: 'error',
        description: 'File permission errors when writing to protected directories.',
        rootCause: 'Insufficient permissions',
        mitigation: 'Check directory permissions before write operations.',
      },
    ],
    abstractableKnowledge: [
      'Always verify environment before executing commands.',
      'Prefer incremental changes over large refactors.',
    ],
    suggestedSkillName: 'safe-file-operations',
    suggestedSkillDescription: 'Best practices for safe file system operations.',
    suggestedTags: ['files', 'safety', 'best-practices'],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ============================================================================
// SkillCreator 测试
// ============================================================================

describe('SkillCreator', () => {
  describe('constructor', () => {
    test('creates creator with config', () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });
      expect(creator).toBeInstanceOf(SkillCreator);
    });

    test('creates creator with factory function', () => {
      const creator = createSkillCreator({
        skillsDir: tempDir,
      });
      expect(creator).toBeInstanceOf(SkillCreator);
    });
  });

  describe('create', () => {
    test('creates skill from reflection result', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const input: SkillCreationInput = {
        reflection: createMockReflectionResult(),
      };

      const result = await creator.create(input);

      expect(result.success).toBe(true);
      expect(result.name).toBe('safe-file-operations');
      expect(result.path).toBe(path.join(tempDir, 'safe-file-operations', 'SKILL.md'));
      expect(result.content).toBeDefined();

      // 验证文件存在
      expect(fs.existsSync(result.path!)).toBe(true);
    });

    test('creates skill with custom name', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
        name: 'my-custom-skill',
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('my-custom-skill');
    });

    test('sanitizes skill name to kebab-case', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
        name: 'My Custom Skill!',
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('my-custom-skill');
    });

    test('handles empty string name with fallback', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult({ suggestedSkillName: undefined }),
        name: '',  // 空串应该被跳过
      });

      expect(result.success).toBe(true);
      // 应该 fallback 到 'learned-skill'
      expect(result.name).toBe('learned-skill');
    });

    test('handles Chinese/symbol name with timestamp fallback', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult({ suggestedSkillName: '中文技能名!' }),
        name: '纯中文',  // 清洗后变空
      });

      expect(result.success).toBe(true);
      // 应该生成带时间戳的默认名
      expect(result.name).toMatch(/^learned-skill-[a-z0-9]+$/);
    });

    test('escapes special YAML characters in tags', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
        tags: ['tag:with:colons', 'tag#hash', 'normal-tag'],
      });

      expect(result.success).toBe(true);
      // 应该正确转义
      expect(result.content).toContain('"tag:with:colons"');
      expect(result.content).toContain('"tag#hash"');
    });

    test('handles reflection with missing arrays', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      // 模拟 LLM 返回的不完整 reflection
      const incompleteReflection = {
        success: true,
        reasoningValid: true,
        reasoningSummary: 'Minimal summary',
        // patterns, failureModes, abstractableKnowledge 都缺失
      } as any;

      const result = await creator.create({
        reflection: incompleteReflection,
        name: 'robust-skill',
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('robust-skill');
      // 不应该崩溃
    });

    test('filters empty tags', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
        tags: ['valid', '', '  ', 'another-valid'],
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('- valid');
      expect(result.content).toContain('another-valid');
    });

    test('fails when skill exists and overwrite is false', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
        overwrite: false,
      });

      // 创建目录
      const skillDir = path.join(tempDir, 'existing-skill');
      fs.mkdirSync(skillDir, { recursive: true });

      const result = await creator.create({
        reflection: createMockReflectionResult({
          suggestedSkillName: 'existing-skill',
        }),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    test('overwrites skill when overwrite is true', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
        overwrite: true,
      });

      // 创建目录
      const skillDir = path.join(tempDir, 'existing-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'old content');

      const result = await creator.create({
        reflection: createMockReflectionResult({
          suggestedSkillName: 'existing-skill',
        }),
      });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain('old content');
    });

    test('calls onCreated callback after creation', async () => {
      let callbackCalled = false;
      let callbackPath = '';

      const creator = new SkillCreator({
        skillsDir: tempDir,
        onCreated: async (path) => {
          callbackCalled = true;
          callbackPath = path;
        },
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.success).toBe(true);
      expect(callbackCalled).toBe(true);
      expect(callbackPath).toBe(path.join(tempDir, 'safe-file-operations'));
    });

    test('includes user guidance in generated content', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
        userGuidance: 'Remember to always test in staging first.',
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Additional Notes');
      expect(result.content).toContain('always test in staging first');
    });
  });

  describe('generated SKILL.md content', () => {
    test('contains valid YAML frontmatter', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.content).toMatch(/^---\n/);
      expect(result.content).toContain('name:');
      expect(result.content).toContain('safe-file-operations');
      expect(result.content).toContain('description:');
      expect(result.content).toContain('skillType: knowledge');
      expect(result.content).toContain('tags:');
      expect(result.content).toContain('  - files');
    });

    test('contains overview section', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.content).toContain('## Overview');
      expect(result.content).toContain('Successfully analyzed');
    });

    test('contains recommended approach from solution patterns', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.content).toContain('## Recommended Approach');
      expect(result.content).toContain('### iterative-testing');
      expect(result.content).toContain('Always test changes incrementally');
    });

    test('contains optimization tips', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.content).toContain('## Optimization Tips');
      expect(result.content).toContain('file-backup');
    });

    test('contains common pitfalls from failure modes', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.content).toContain('## Common Pitfalls');
      expect(result.content).toContain('Error Handling');
      expect(result.content).toContain('**Root Cause**:');
      expect(result.content).toContain('**Mitigation**:');
    });

    test('contains key insights from abstractable knowledge', async () => {
      const creator = new SkillCreator({
        skillsDir: tempDir,
      });

      const result = await creator.create({
        reflection: createMockReflectionResult(),
      });

      expect(result.content).toContain('## Key Insights');
      expect(result.content).toContain('verify environment before executing');
    });

    test('can be parsed by existing skill loader', async () => {
      // 创建正确的目录结构：tempDir/.tachikoma/skills/
      const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });

      const creator = new SkillCreator({
        skillsDir: skillsDir,
      });

      await creator.create({
        reflection: createMockReflectionResult(),
      });

      // 验证可以被现有 loader 解析
      const { loadSkills } = await import('../src/skills');
      const outcome = loadSkills({ enabled: true }, tempDir);

      // 查找我们创建的技能
      const createdSkill = outcome.skills.find((s) => s.name === 'safe-file-operations');
      expect(createdSkill).toBeDefined();
      expect(createdSkill?.skillType).toBe('knowledge');
    });
  });
});
