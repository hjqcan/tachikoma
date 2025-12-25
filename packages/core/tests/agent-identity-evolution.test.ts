/**
 * Core Memory Evolution 单元测试
 *
 * 测试 CoreMemoryEvolver 的核心功能：
 * - 系统提示词进化
 * - 偏好/工作模式学习
 * - 压缩逻辑
 * - 去重检查
 *
 * @module tests/agent-identity-evolution.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  CoreMemoryEvolver,
  IdentityLoader,
  MAX_CORE_MEMORY_LENGTH,
  COMPRESSION_THRESHOLD_RATIO,
  MAX_PREFERENCES_COUNT,
  type LearningRecord,
} from '../src/agent-identity';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-evolution-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ============================================================================
// evolveSystemPrompt 测试
// ============================================================================

describe('CoreMemoryEvolver', () => {
  describe('evolveSystemPrompt', () => {
    test('appends learnings to system prompt', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.evolveSystemPrompt(
        ['Always write tests', 'Use TypeScript'],
        'task_success',
        'test'
      );

      const identity = await loader.load('test');

      expect(identity).not.toBeNull();
      expect(identity!.coreMemory.systemPrompt).toContain('Always write tests');
      expect(identity!.coreMemory.systemPrompt).toContain('Use TypeScript');
      expect(identity!.coreMemory.systemPrompt).toContain('task_success');
    });

    test('returns success for empty learnings', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });

      const result = await evolver.evolveSystemPrompt([], 'manual', 'test');

      expect(result.success).toBe(true);
      expect(result.compressed).toBe(false);
    });

    test('compresses when exceeding threshold', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      // 创建一个接近阈值的初始内容
      const threshold = Math.floor(MAX_CORE_MEMORY_LENGTH * COMPRESSION_THRESHOLD_RATIO);
      const initialContent = 'x'.repeat(threshold - 50);
      
      const identity = await loader.loadOrCreate('test');
      identity.coreMemory.systemPrompt = initialContent;
      await loader.save(identity);

      // 添加足够长的内容触发压缩
      const result = await evolver.evolveSystemPrompt(
        ['A'.repeat(200)],
        'manual',
        'test'
      );

      expect(result.compressed).toBe(true);
      
      const updated = await loader.load('test');
      expect(updated!.coreMemory.systemPrompt.length).toBeLessThan(threshold);
    });

    test('truncates long learnings', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const longContent = 'x'.repeat(1000);
      await evolver.evolveSystemPrompt([longContent], 'manual', 'test');

      const identity = await loader.load('test');

      // 应该被截断并以 ... 结尾
      expect(identity!.coreMemory.systemPrompt).toContain('...');
      expect(identity!.coreMemory.systemPrompt.length).toBeLessThan(1000);
    });
  });

  describe('learnPreference', () => {
    test('adds preference to list', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnPreference('Use dark mode', 'remember_command', 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.preferences).toContain('Use dark mode');
    });

    test('does not add duplicate preferences', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnPreference('Use dark mode', 'manual', 'test');
      await evolver.learnPreference('Use dark mode', 'manual', 'test');
      await evolver.learnPreference('use DARK MODE', 'manual', 'test'); // 大小写不同

      const identity = await loader.load('test');

      expect(identity!.coreMemory.preferences.length).toBe(1);
    });

    test('does not add similar preferences (containment)', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnPreference('Use TypeScript', 'manual', 'test');
      await evolver.learnPreference('Always use TypeScript strictly', 'manual', 'test');

      const identity = await loader.load('test');

      // 第二个包含第一个，应该被去重
      expect(identity!.coreMemory.preferences.length).toBe(1);
    });

    test('removes oldest when exceeding max', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      // 直接构造50个偏好（避免去重逻辑影响）
      const identity = await loader.loadOrCreate('test');
      for (let i = 0; i < MAX_PREFERENCES_COUNT; i++) {
        identity.coreMemory.preferences.push(`pref-${i.toString(16).padStart(4, '0')}`);
      }
      await loader.save(identity);

      const firstPref = identity.coreMemory.preferences[0];

      // 再添加一个完全不同的
      const result = await evolver.learnPreference('ZZZNEWPREF99', 'manual', 'test');

      expect(result.compressed).toBe(true);

      const updated = await loader.load('test');
      expect(updated!.coreMemory.preferences.length).toBe(MAX_PREFERENCES_COUNT);
      expect(updated!.coreMemory.preferences).not.toContain(firstPref);
      expect(updated!.coreMemory.preferences).toContain('ZZZNEWPREF99');
    });

    test('returns error for empty preference', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });

      const result = await evolver.learnPreference('', 'manual', 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty');
    });
  });

  describe('learnWorkPattern', () => {
    test('adds work pattern to list', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnWorkPattern('Test before commit', 'task_success', 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.workPatterns).toContain('Test before commit');
    });

    test('does not add duplicate patterns', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnWorkPattern('Run tests', 'manual', 'test');
      await evolver.learnWorkPattern('Run tests', 'manual', 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.workPatterns.length).toBe(1);
    });
  });

  describe('learn (batch)', () => {
    test('routes learning records to correct methods', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const records: LearningRecord[] = [
        { content: 'Be concise', type: 'principle', trigger: 'task_success', timestamp: Date.now() },
        { content: 'Dark mode', type: 'preference', trigger: 'remember_command', timestamp: Date.now() },
        { content: 'TDD workflow', type: 'work_pattern', trigger: 'manual', timestamp: Date.now() },
      ];

      const result = await evolver.learn(records, 'test');

      expect(result.success).toBe(true);

      const identity = await loader.load('test');

      expect(identity!.coreMemory.systemPrompt).toContain('Be concise');
      expect(identity!.coreMemory.preferences).toContain('Dark mode');
      expect(identity!.coreMemory.workPatterns).toContain('TDD workflow');
    });
  });

  describe('onTaskSuccess', () => {
    test('increments task count and adds learnings', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.onTaskSuccess('Build feature X', ['Use atomic commits'], 'test');
      await evolver.onTaskSuccess('Build feature Y', [], 'test');

      const identity = await loader.load('test');

      expect(identity!.tasksCompleted).toBe(2);
      expect(identity!.coreMemory.systemPrompt).toContain('Use atomic commits');
    });
  });

  describe('onSkillLearned', () => {
    test('records skill and adds summary to system prompt', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.onSkillLearned('git-workflow', 'Use feature branches', 'test');

      const identity = await loader.load('test');

      expect(identity!.skillsLearned).toContain('git-workflow');
      expect(identity!.coreMemory.systemPrompt).toContain('git-workflow');
      expect(identity!.coreMemory.systemPrompt).toContain('Use feature branches');
    });

    test('records skill without summary', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.onSkillLearned('testing', undefined, 'test');

      const identity = await loader.load('test');

      expect(identity!.skillsLearned).toContain('testing');
    });
  });

  describe('getStats', () => {
    test('returns statistics for agent', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });

      await evolver.onTaskSuccess('Task 1', ['Learning 1'], 'test');
      await evolver.learnPreference('Pref 1', 'manual', 'test');
      await evolver.learnWorkPattern('Pattern 1', 'manual', 'test');

      const stats = await evolver.getStats('test');

      expect(stats).not.toBeNull();
      expect(stats!.tasksCompleted).toBe(1);
      expect(stats!.preferencesCount).toBe(1);
      expect(stats!.workPatternsCount).toBe(1);
      expect(stats!.systemPromptLength).toBeGreaterThan(0);
    });

    test('returns null for non-existent agent', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });

      const stats = await evolver.getStats('non-existent');

      expect(stats).toBeNull();
    });
  });

  describe('autoSave config', () => {
    test('does not save when autoSave is false', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir, autoSave: false });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnPreference('Test pref', 'manual', 'test');

      // 因为 autoSave 是 false，所以不会自动保存
      // 但 loadOrCreate 会创建一个默认的 identity
      const identity = await loader.load('test');

      // loadOrCreate 创建了 identity，但 preference 没有被保存
      expect(identity!.coreMemory.preferences).not.toContain('Test pref');
    });

    // P1-2: autoSave 同样控制 onTaskSuccess/onSkillLearned
    test('autoSave=false does not persist onTaskSuccess changes', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir, autoSave: false });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.onTaskSuccess('some task', [], 'test');

      const identity = await loader.load('test');
      // tasksCompleted 不应该被保存
      expect(identity!.tasksCompleted).toBe(0);
    });
  });

  // P1-1: project_rule 返回错误
  describe('project_rule type handling', () => {
    test('returns error for project_rule type', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });

      const result = await evolver.learn([
        { content: 'Some rule', type: 'project_rule', trigger: 'manual', timestamp: Date.now() },
      ], 'test');

      expect(result.success).toBe(false);
      expect(result.results[0]?.error).toContain('not yet implemented');
    });
  });

  // P1-4: 敏感信息脱敏测试
  describe('sensitive data redaction', () => {
    test('redacts OpenAI API keys from learnings', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.evolveSystemPrompt(
        ['Use API key sk-1234567890abcdef1234567890abcdef1234'],
        'manual',
        'test'
      );

      const identity = await loader.load('test');
      expect(identity!.coreMemory.systemPrompt).toContain('[REDACTED]');
      expect(identity!.coreMemory.systemPrompt).not.toContain('sk-');
    });

    test('redacts Bearer tokens', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnPreference(
        'Set header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'manual',
        'test'
      );

      const identity = await loader.load('test');
      expect(identity!.coreMemory.preferences[0]).toContain('[REDACTED]');
      expect(identity!.coreMemory.preferences[0]).not.toContain('Bearer ');
    });

    test('redacts GitHub PAT tokens', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnWorkPattern(
        'Use ghp_abcdef1234567890abcdef1234567890abcd for auth',
        'manual',
        'test'
      );

      const identity = await loader.load('test');
      expect(identity!.coreMemory.workPatterns[0]).toContain('[REDACTED]');
      expect(identity!.coreMemory.workPatterns[0]).not.toContain('ghp_');
    });

    test('redacts password patterns', async () => {
      const evolver = new CoreMemoryEvolver({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await evolver.learnPreference('Use password=mysecretpassword123', 'manual', 'test');

      const identity = await loader.load('test');
      expect(identity!.coreMemory.preferences[0]).toContain('[REDACTED]');
    });
  });
});
