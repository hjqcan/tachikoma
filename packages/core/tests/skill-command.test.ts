/**
 * Skill Command Tests
 *
 * 测试 /skill CLI 命令
 *
 * @module tests/skill-command.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  executeSkillCommand,
  type SkillCommandContext,
} from '../src/conversation/commands/skill-command';
import type { SessionState, StreamEvent } from '../src/conversation/types';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-skill-cmd-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createMockSession(): SessionState {
  return {
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
  };
}

function createMockContext(session: SessionState): SkillCommandContext {
  return {
    session,
    workDir: tempDir,
    t: (strings: { en: string; zh: string }) => strings.en,
  };
}

async function collectEvents(
  generator: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function createTestSkill(
  skillsDir: string,
  name: string,
  content?: string,
): void {
  const skillDir = path.join(skillsDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    content ??
      `---
name: ${name}
description: Test skill ${name}
skillType: knowledge
tags:
  - test
---

# ${name}

This is a test skill.
`,
  );
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ============================================================================
// executeSkillCommand 测试
// ============================================================================

describe('executeSkillCommand', () => {
  describe('/skill help', () => {
    test('shows help with no arguments', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(executeSkillCommand([], ctx));

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('complete');
      if (events[0]?.type === 'complete') {
        expect(events[0].summary).toContain('Skill Commands');
        expect(events[0].summary).toContain('/skill list');
      }
    });

    test('shows help with "help" subcommand', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(executeSkillCommand(['help'], ctx));

      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('complete');
      if (events[0]?.type === 'complete') {
        expect(events[0].summary).toContain('/skill load');
        expect(events[0].summary).toContain('/skill unload');
        expect(events[0].summary).toContain('/skill learn');
      }
    });
  });

  describe('/skill list', () => {
    test('lists skills including global directory', async () => {
      // 注意：全局技能目录 ~/.tachikoma/skills 可能有内容
      // 所以我们只验证命令成功执行，不假设没有技能
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(executeSkillCommand(['list'], ctx));

      // 应该有 thinking + complete 两个事件
      expect(events.length).toBe(2);
      expect(events[1]?.type).toBe('complete');
      if (events[1]?.type === 'complete') {
        expect(events[1].success).toBe(true);
        // 列出技能或显示"未找到"
        expect(
          events[1].summary.includes('Available skills') ||
            events[1].summary.includes('No skills found'),
        ).toBe(true);
      }
    });

    test('lists available skills from project directory', async () => {
      const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
      createTestSkill(skillsDir, 'test-skill-1');
      createTestSkill(skillsDir, 'test-skill-2');

      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(executeSkillCommand(['list'], ctx));

      expect(events.length).toBe(2);
      if (events[1]?.type === 'complete') {
        expect(events[1].success).toBe(true);
        expect(events[1].summary).toContain('test-skill-1');
        expect(events[1].summary).toContain('test-skill-2');
        expect(events[1].summary).toContain('[K]'); // Knowledge type
      }
    });
  });

  describe('/skill load', () => {
    test('shows usage when no name provided', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(executeSkillCommand(['load'], ctx));

      expect(events.length).toBe(1);
      if (events[0]?.type === 'complete') {
        expect(events[0].success).toBe(false);
        expect(events[0].summary).toContain('Usage');
      }
    });

    test('fails when skill not found', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(
        executeSkillCommand(['load', 'nonexistent-skill-xyz-12345'], ctx),
      );

      expect(events.length).toBe(2); // thinking + complete
      if (events[1]?.type === 'complete') {
        expect(events[1].success).toBe(false);
        expect(events[1].summary).toContain('not found');
      }
    });

    test('loads skill successfully', async () => {
      const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
      createTestSkill(skillsDir, 'test-skill');

      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(
        executeSkillCommand(['load', 'test-skill'], ctx),
      );

      expect(events.length).toBe(2); // thinking + complete
      if (events[1]?.type === 'complete') {
        expect(events[1].success).toBe(true);
        expect(events[1].summary).toContain('Skill loaded');
        expect(events[1].summary).toContain('test-skill');
      }
    });

    test('reports already loaded when loading twice', async () => {
      const skillsDir = path.join(tempDir, '.tachikoma', 'skills');
      createTestSkill(skillsDir, 'test-skill-double');

      const session = createMockSession();
      const ctx = createMockContext(session);

      // 第一次加载
      await collectEvents(executeSkillCommand(['load', 'test-skill-double'], ctx));

      // 第二次加载 - 应该报告 already loaded
      const events = await collectEvents(
        executeSkillCommand(['load', 'test-skill-double'], ctx),
      );

      expect(events.length).toBe(2); // thinking + complete
      if (events[1]?.type === 'complete') {
        expect(events[1].success).toBe(true);
        expect(events[1].summary).toContain('already loaded');
      }
    });
  });

  describe('/skill unload', () => {
    test('shows usage when no name provided', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(executeSkillCommand(['unload'], ctx));

      expect(events.length).toBe(1);
      if (events[0]?.type === 'complete') {
        expect(events[0].success).toBe(false);
        expect(events[0].summary).toContain('Usage');
      }
    });

    test('handles unload of non-loaded skill gracefully', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(
        executeSkillCommand(['unload', 'nonexistent-skill-xyz-12345'], ctx),
      );

      // 应该返回一个 complete 事件
      expect(events.length).toBe(1);
      if (events[0]?.type === 'complete') {
        // 如果技能未加载，应该返回失败
        expect(events[0].summary).toContain('not loaded');
        expect(events[0].success).toBe(false);
      }
    });
  });

  describe('/skill learn', () => {
    test('fails when LLM not configured', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);
      // llmCall is undefined

      const events = await collectEvents(executeSkillCommand(['learn'], ctx));

      expect(events.length).toBe(1);
      if (events[0]?.type === 'complete') {
        expect(events[0].success).toBe(false);
        expect(events[0].summary).toContain('LLM not configured');
      }
    });

    test('fails when no trajectory available', async () => {
      const session = createMockSession();
      const ctx: SkillCommandContext = {
        ...createMockContext(session),
        llmCall: async () => '{}',
        getTrajectory: async () => [],
      };

      const events = await collectEvents(executeSkillCommand(['learn'], ctx));

      // thinking + complete
      expect(events.length).toBe(2);
      if (events[1]?.type === 'complete') {
        expect(events[1].success).toBe(false);
        expect(events[1].summary).toContain('No execution trajectory');
      }
    });
  });

  describe('unknown subcommand', () => {
    test('shows error for unknown subcommand', async () => {
      const session = createMockSession();
      const ctx = createMockContext(session);

      const events = await collectEvents(
        executeSkillCommand(['unknown'], ctx),
      );

      expect(events.length).toBe(1);
      if (events[0]?.type === 'complete') {
        expect(events[0].success).toBe(false);
        expect(events[0].summary).toContain('Unknown subcommand');
      }
    });
  });
});
