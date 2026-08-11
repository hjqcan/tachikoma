/**
 * Remember Command 单元测试
 *
 * 测试 /remember 命令的核心功能：
 * - 子命令解析
 * - 类型检测
 * - CoreMemoryEvolver 集成
 *
 * @module tests/remember-command.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  executeRememberCommand,
  isRememberCommand,
  parseRememberArgs,
  type RememberCommandContext,
} from '../src/conversation/commands/remember-command';

import { IdentityLoader } from '../src/agent-identity';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-remember-test-'));
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

// Mock 上下文
function createMockContext(agentId?: string): RememberCommandContext {
  const agentsDir = path.join(tempDir, 'agents');
  return {
    session: {
      sessionId: 'test-session',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      workDir: tempDir,
      messages: [],
      completedSubtasks: [],
      pendingSubtasks: [],
      checkpoints: [],
      variables: {},
      waitingForUser: false,
    },
    workDir: tempDir,
    ...(agentId !== undefined && { agentId }),
    evolverConfig: { agentsDir },
    t: (strings) => strings.en, // 默认英文
  };
}

// 辅助：收集所有事件
async function collectEvents<T>(gen: AsyncGenerator<unknown, T>): Promise<{ events: unknown[]; result: T }> {
  const events: unknown[] = [];
  let result: T;
  
  while (true) {
    const { done, value } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
  }
  
  return { events, result: result! };
}

// ============================================================================
// isRememberCommand 测试
// ============================================================================

describe('isRememberCommand', () => {
  test('returns true for /remember command', () => {
    expect(isRememberCommand('/remember')).toBe(true);
    expect(isRememberCommand('/remember preference use dark mode')).toBe(true);
    expect(isRememberCommand('/REMEMBER')).toBe(true);
  });

  test('returns true for /记住 command', () => {
    expect(isRememberCommand('/记住')).toBe(true);
    expect(isRememberCommand('/记住 使用深色模式')).toBe(true);
  });

  test('returns false for other commands', () => {
    expect(isRememberCommand('/skill')).toBe(false);
    expect(isRememberCommand('/clear')).toBe(false);
    expect(isRememberCommand('remember')).toBe(false);
  });
});

// ============================================================================
// parseRememberArgs 测试
// ============================================================================

describe('parseRememberArgs', () => {
  test('parses empty command', () => {
    expect(parseRememberArgs('/remember')).toEqual([]);
    expect(parseRememberArgs('/remember  ')).toEqual([]);
  });

  test('parses single argument', () => {
    expect(parseRememberArgs('/remember help')).toEqual(['help']);
  });

  test('parses multiple arguments', () => {
    expect(parseRememberArgs('/remember preference use dark mode')).toEqual(['preference', 'use', 'dark', 'mode']);
  });

  test('parses Chinese command', () => {
    expect(parseRememberArgs('/记住 使用深色模式')).toEqual(['使用深色模式']);
  });
});

// ============================================================================
// executeRememberCommand 测试
// ============================================================================

describe('executeRememberCommand', () => {
  describe('help subcommand', () => {
    test('shows help when no args', async () => {
      const ctx = createMockContext();
      const gen = executeRememberCommand([], ctx);
      const { events, result } = await collectEvents(gen);

      expect(result.handled).toBe(true);
      expect(events.length).toBe(1);
      
      const event = events[0] as { type: string; summary: string };
      expect(event.type).toBe('complete');
      expect(event.summary).toContain('/remember');
      expect(event.summary).toContain('Usage');
    });

    test('shows help with help subcommand', async () => {
      const ctx = createMockContext();
      const gen = executeRememberCommand(['help'], ctx);
      const { events, result } = await collectEvents(gen);

      expect(result.handled).toBe(true);
      expect(events.length).toBe(1);
    });
  });

  describe('preference subcommand', () => {
    test('saves preference to CoreMemory', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['preference', 'Use', 'dark', 'mode'], ctx);
      const { events, result } = await collectEvents(gen);

      expect(result.handled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.type).toBe('preference');

      const event = events[0] as { type: string; success: boolean; summary: string };
      expect(event.type).toBe('complete');
      expect(event.success).toBe(true);
      expect(event.summary).toContain('Preference remembered');
    });

    test('returns error for empty preference', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['preference'], ctx);
      const { events, result } = await collectEvents(gen);

      expect(result.handled).toBe(true);
      expect(result.success).toBe(false);

      const event = events[0] as { success: boolean };
      expect(event.success).toBe(false);
    });
  });

  describe('pattern subcommand', () => {
    test('saves work pattern to CoreMemory', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['pattern', 'Always', 'run', 'tests'], ctx);
      const { events, result } = await collectEvents(gen);

      expect(result.handled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.type).toBe('pattern');

      const event = events[0] as { type: string; success: boolean; summary: string };
      expect(event.type).toBe('complete');
      expect(event.success).toBe(true);
      expect(event.summary).toContain('Work pattern remembered');
    });
  });

  describe('rule subcommand', () => {
    test('saves principle to CoreMemory systemPrompt', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['rule', 'Be', 'concise'], ctx);
      const { events, result } = await collectEvents(gen);

      expect(result.handled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.type).toBe('principle');

      const event = events[0] as { type: string; success: boolean; summary: string };
      expect(event.type).toBe('complete');
      expect(event.success).toBe(true);
      expect(event.summary).toContain('Principle remembered');
    });
  });

  describe('auto detection', () => {
    test('detects preference keywords', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['I', 'prefer', 'tabs'], ctx);
      const { result } = await collectEvents(gen);

      expect(result.success).toBe(true);
      expect(result.type).toBe('preference');
    });

    test('detects pattern keywords', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['Always', 'commit', 'frequently'], ctx);
      const { result } = await collectEvents(gen);

      expect(result.success).toBe(true);
      expect(result.type).toBe('pattern');
    });

    test('defaults to principle for unknown content', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(['Code', 'should', 'be', 'readable'], ctx);
      const { result } = await collectEvents(gen);

      expect(result.success).toBe(true);
      expect(result.type).toBe('principle');
    });
  });

  describe('sensitive data redaction', () => {
    test('redacts API keys', async () => {
      const ctx = createMockContext('test-agent');
      const gen = executeRememberCommand(
        ['preference', 'Use', 'key', 'sk-1234567890abcdef1234567890abcdef1234'],
        ctx
      );
      await collectEvents(gen);

      // 检查存储的内容被脱敏
      const loader = new IdentityLoader({ agentsDir: path.join(tempDir, 'agents') });
      const identity = await loader.load('test-agent');
      
      // 偏好中应该包含 [REDACTED]
      const prefs = identity?.coreMemory.preferences ?? [];
      const hasRedacted = prefs.some(p => p.includes('[REDACTED]'));
      expect(hasRedacted).toBe(true);
    });
  });
});
