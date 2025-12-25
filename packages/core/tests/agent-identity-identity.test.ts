/**
 * Agent Identity 单元测试
 *
 * 测试 IdentityLoader/IdentityUpdater 的核心功能：
 * - Identity 创建/加载/保存
 * - 统计更新
 * - Core Memory 管理
 *
 * @module tests/agent-identity-identity.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  IdentityLoader,
  IdentityUpdater,
  IDENTITY_FILE_EXTENSION,
  CURRENT_IDENTITY_VERSION,
  MAX_PREFERENCES_COUNT,
  MAX_CORE_MEMORY_LENGTH,
  createDefaultIdentity,
  createDefaultCoreMemory,
  type AgentIdentity,
} from '../src/agent-identity';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-identity-test-'));
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
// createDefaultIdentity 测试
// ============================================================================

describe('createDefaultIdentity', () => {
  test('creates identity with correct default values', () => {
    const identity = createDefaultIdentity('test-agent');

    expect(identity.id).toBe('test-agent');
    expect(identity.sessionsCount).toBe(0);
    expect(identity.tasksCompleted).toBe(0);
    expect(identity.skillsLearned).toEqual([]);
    expect(identity.version).toBe(CURRENT_IDENTITY_VERSION);
    expect(identity.createdAt).toBeGreaterThan(0);
  });

  test('creates valid CoreMemory', () => {
    const memory = createDefaultCoreMemory();

    expect(memory.systemPrompt).toBe('');
    expect(memory.preferences).toEqual([]);
    expect(memory.workPatterns).toEqual([]);
  });
});

// ============================================================================
// IdentityLoader 测试
// ============================================================================

describe('IdentityLoader', () => {
  describe('load', () => {
    test('returns null for non-existent identity', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const identity = await loader.load('non-existent');

      expect(identity).toBeNull();
    });

    test('loads existing identity', async () => {
      const agentsDir = tempDir;
      const testIdentity: AgentIdentity = {
        id: 'test-agent',
        createdAt: 1000000,
        lastActiveAt: 2000000,
        sessionsCount: 5,
        tasksCompleted: 10,
        skillsLearned: ['skill1', 'skill2'],
        coreMemory: {
          systemPrompt: 'Test prompt',
          preferences: ['pref1'],
          workPatterns: ['pattern1'],
        },
        version: CURRENT_IDENTITY_VERSION,
      };

      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, `test-agent${IDENTITY_FILE_EXTENSION}`),
        JSON.stringify(testIdentity)
      );

      const loader = new IdentityLoader({ agentsDir });
      const loaded = await loader.load('test-agent');

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('test-agent');
      expect(loaded!.sessionsCount).toBe(5);
      expect(loaded!.tasksCompleted).toBe(10);
      expect(loaded!.skillsLearned).toEqual(['skill1', 'skill2']);
      expect(loaded!.coreMemory.systemPrompt).toBe('Test prompt');
    });

    test('migrates old version identity', async () => {
      const agentsDir = tempDir;
      // 模拟旧版本 Identity（缺少某些字段）
      const oldIdentity = {
        id: 'old-agent',
        createdAt: 1000000,
        sessionsCount: 3,
        tasksCompleted: 5,
        skillsLearned: [],
        coreMemory: {
          systemPrompt: '',
          preferences: [],
          workPatterns: [],
        },
        // 缺少 version 和 lastActiveAt
      };

      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, `old-agent${IDENTITY_FILE_EXTENSION}`),
        JSON.stringify(oldIdentity)
      );

      const loader = new IdentityLoader({ agentsDir });
      const loaded = await loader.load('old-agent');

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(CURRENT_IDENTITY_VERSION);
      expect(loaded!.lastActiveAt).toBeGreaterThan(0);
    });

    test('rejects invalid agentId (path traversal)', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });
      await expect(loader.load('../evil')).rejects.toThrow('Invalid agentId');
    });
  });

  describe('loadOrCreate', () => {
    test('creates new identity when not exists', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const identity = await loader.loadOrCreate('new-agent');

      expect(identity.id).toBe('new-agent');
      expect(identity.sessionsCount).toBe(0);

      // 验证文件已创建
      const filePath = path.join(tempDir, `new-agent${IDENTITY_FILE_EXTENSION}`);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test('loads existing identity', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      // 先保存一个
      const original = createDefaultIdentity('existing');
      original.sessionsCount = 10;
      await loader.save(original);

      // 再加载
      const loaded = await loader.loadOrCreate('existing');

      expect(loaded.sessionsCount).toBe(10);
    });

    test('quarantines and recreates identity when JSON is corrupted', async () => {
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, `corrupt${IDENTITY_FILE_EXTENSION}`),
        '{ not valid json'
      );

      const loader = new IdentityLoader({ agentsDir: tempDir });
      const identity = await loader.loadOrCreate('corrupt');

      expect(identity.id).toBe('corrupt');
      expect(fs.existsSync(path.join(tempDir, `corrupt${IDENTITY_FILE_EXTENSION}`))).toBe(true);

      // 原文件应被隔离（文件名以 corrupt.json.corrupt.* 开头）
      const files = fs.readdirSync(tempDir);
      expect(files.some((f) => f.startsWith(`corrupt${IDENTITY_FILE_EXTENSION}.corrupt.`))).toBe(true);
    });

    test('quarantines and recreates identity when file exceeds max size', async () => {
      fs.mkdirSync(tempDir, { recursive: true });
      // 写入一个超过 maxFileSize 的合法 JSON 文件
      const big = JSON.stringify({ foo: 'x'.repeat(300) });
      fs.writeFileSync(path.join(tempDir, `big${IDENTITY_FILE_EXTENSION}`), big);

      const loader = new IdentityLoader({ agentsDir: tempDir, maxFileSize: 100 });
      const identity = await loader.loadOrCreate('big');

      expect(identity.id).toBe('big');
      expect(fs.existsSync(path.join(tempDir, `big${IDENTITY_FILE_EXTENSION}`))).toBe(true);

      const files = fs.readdirSync(tempDir);
      expect(files.some((f) => f.startsWith(`big${IDENTITY_FILE_EXTENSION}.oversized.`))).toBe(true);
    });
  });

  describe('save', () => {
    test('saves identity to file', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });
      const identity = createDefaultIdentity('save-test');
      identity.sessionsCount = 42;

      const result = await loader.save(identity);

      expect(result.success).toBe(true);

      // 验证文件内容
      const filePath = path.join(tempDir, `save-test${IDENTITY_FILE_EXTENSION}`);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.sessionsCount).toBe(42);
    });

    test('updates lastActiveAt on save', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });
      const identity = createDefaultIdentity('active-test');
      const originalTime = identity.lastActiveAt;

      // 等待一点时间
      await new Promise((resolve) => setTimeout(resolve, 10));

      await loader.save(identity);

      expect(identity.lastActiveAt).toBeGreaterThan(originalTime);
    });

    test('creates directory if not exists', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'agents');
      const loader = new IdentityLoader({ agentsDir: nestedDir });

      expect(fs.existsSync(nestedDir)).toBe(false);

      const identity = createDefaultIdentity('nested-test');
      await loader.save(identity);

      expect(fs.existsSync(nestedDir)).toBe(true);
    });
  });

  describe('delete', () => {
    test('deletes existing identity', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });
      const identity = createDefaultIdentity('delete-test');
      await loader.save(identity);

      const filePath = path.join(tempDir, `delete-test${IDENTITY_FILE_EXTENSION}`);
      expect(fs.existsSync(filePath)).toBe(true);

      const result = await loader.delete('delete-test');

      expect(result).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test('returns true for non-existent identity', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const result = await loader.delete('non-existent');

      expect(result).toBe(true);
    });
  });

  describe('listAgents', () => {
    test('lists all agent IDs', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await loader.save(createDefaultIdentity('agent1'));
      await loader.save(createDefaultIdentity('agent2'));
      await loader.save(createDefaultIdentity('agent3'));

      const agents = await loader.listAgents();

      expect(agents.sort()).toEqual(['agent1', 'agent2', 'agent3']);
    });

    test('returns empty array when no agents', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const agents = await loader.listAgents();

      expect(agents).toEqual([]);
    });
  });

  describe('exists', () => {
    test('returns true for existing identity', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });
      await loader.save(createDefaultIdentity('exists-test'));

      const exists = await loader.exists('exists-test');

      expect(exists).toBe(true);
    });

    test('returns false for non-existent identity', async () => {
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const exists = await loader.exists('not-found');

      expect(exists).toBe(false);
    });
  });
});

// ============================================================================
// IdentityUpdater 测试
// ============================================================================

describe('IdentityUpdater', () => {
  describe('incrementSessionCount', () => {
    test('increments session count', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await updater.incrementSessionCount('test');
      await updater.incrementSessionCount('test');
      await updater.incrementSessionCount('test');

      const identity = await loader.load('test');

      expect(identity!.sessionsCount).toBe(3);
    });
  });

  describe('incrementTasksCompleted', () => {
    test('increments tasks completed count', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await updater.incrementTasksCompleted('test');
      await updater.incrementTasksCompleted('test');

      const identity = await loader.load('test');

      expect(identity!.tasksCompleted).toBe(2);
    });
  });

  describe('addLearnedSkill', () => {
    test('adds skill to learned list', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await updater.addLearnedSkill('skill1', 'test');
      await updater.addLearnedSkill('skill2', 'test');

      const identity = await loader.load('test');

      expect(identity!.skillsLearned).toContain('skill1');
      expect(identity!.skillsLearned).toContain('skill2');
    });

    test('does not add duplicate skills', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await updater.addLearnedSkill('skill1', 'test');
      await updater.addLearnedSkill('skill1', 'test');
      await updater.addLearnedSkill('skill1', 'test');

      const identity = await loader.load('test');

      expect(identity!.skillsLearned).toEqual(['skill1']);
    });
  });

  describe('addPreference', () => {
    test('adds preference to list', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await updater.addPreference('Use dark mode', 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.preferences).toContain('Use dark mode');
    });

    test('removes oldest when exceeding max', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      // 填满偏好列表
      for (let i = 0; i < MAX_PREFERENCES_COUNT; i++) {
        await updater.addPreference(`pref-${i}`, 'test');
      }

      // 再添加一个
      await updater.addPreference('new-pref', 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.preferences.length).toBe(MAX_PREFERENCES_COUNT);
      expect(identity!.coreMemory.preferences).not.toContain('pref-0');
      expect(identity!.coreMemory.preferences).toContain('new-pref');
    });
  });

  describe('appendSystemPrompt', () => {
    test('appends content to system prompt', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      await updater.appendSystemPrompt('First learning', 'test');
      await updater.appendSystemPrompt('Second learning', 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.systemPrompt).toContain('First learning');
      expect(identity!.coreMemory.systemPrompt).toContain('Second learning');
    });

    test('truncates when exceeding max length', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      const longContent = 'x'.repeat(MAX_CORE_MEMORY_LENGTH + 100);
      await updater.appendSystemPrompt(longContent, 'test');

      const identity = await loader.load('test');

      expect(identity!.coreMemory.systemPrompt.length).toBeLessThanOrEqual(
        MAX_CORE_MEMORY_LENGTH
      );
    });
  });

  describe('getCoreMemoryForPrompt', () => {
    test('returns null when no core memory content', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });
      const loader = new IdentityLoader({ agentsDir: tempDir });

      // 创建空 identity
      await loader.save(createDefaultIdentity('empty'));

      const prompt = await updater.getCoreMemoryForPrompt('empty');

      expect(prompt).toBeNull();
    });

    test('formats core memory for prompt injection', async () => {
      const updater = new IdentityUpdater({ agentsDir: tempDir });

      await updater.appendSystemPrompt('Be concise', 'test');
      await updater.addPreference('Dark mode preferred', 'test');
      await updater.addWorkPattern('Test before commit', 'test');

      const prompt = await updater.getCoreMemoryForPrompt('test');

      expect(prompt).toContain('# Agent Core Memory');
      expect(prompt).toContain('## Learned Principles');
      expect(prompt).toContain('Be concise');
      expect(prompt).toContain('## User Preferences');
      expect(prompt).toContain('Dark mode preferred');
      expect(prompt).toContain('## Work Patterns');
      expect(prompt).toContain('Test before commit');
    });
  });
});
