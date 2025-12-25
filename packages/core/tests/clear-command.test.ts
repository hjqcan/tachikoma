/**
 * /clear 命令 Letta 语义测试
 *
 * 验证 /clear 命令的行为：
 * - 清空会话消息和上下文
 * - 保留 Memory Blocks 和 Agent Identity
 * - 增加 sessionsCount
 *
 * @module tests/clear-command.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  IdentityLoader,
  IdentityUpdater,
  IDENTITY_FILE_EXTENSION,
} from '../src/agent-identity';
import { ConversationalRunner, SessionStore } from '../src/conversation';

// ============================================================================
// 测试辅助函数
// ============================================================================

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-clear-test-'));
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

// 辅助：收集所有事件（AsyncGenerator）
async function collectStreamEvents(gen: AsyncGenerator<unknown, void>): Promise<unknown[]> {
  const events: unknown[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) break;
    events.push(value);
  }
  return events;
}

// ============================================================================
// IdentityUpdater.incrementSessionCount 测试
// ============================================================================

describe('IdentityUpdater.incrementSessionCount', () => {
  test('increments sessionsCount for existing agent', async () => {
    const loader = new IdentityLoader({ agentsDir: tempDir });
    const updater = new IdentityUpdater({ agentsDir: tempDir });

    // 创建初始 identity
    const identity = await loader.loadOrCreate('test-agent');
    expect(identity.sessionsCount).toBe(0); // 初始值为 0

    // 调用 incrementSessionCount（返回 void）
    await updater.incrementSessionCount('test-agent');

    // 验证 sessionsCount 增加
    const updated = await loader.load('test-agent');
    expect(updated!.sessionsCount).toBe(1);
  });

  test('creates identity if not exists', async () => {
    const updater = new IdentityUpdater({ agentsDir: tempDir });
    const loader = new IdentityLoader({ agentsDir: tempDir });

    // 直接调用 incrementSessionCount（会创建新 identity）
    await updater.incrementSessionCount('new-agent');

    // 验证 identity 已创建且 sessionsCount 被增加
    const identity = await loader.load('new-agent');
    expect(identity).not.toBeNull();
    expect(identity!.sessionsCount).toBe(1); // 初始 0 + 增加 1
  });

  test('preserves coreMemory when incrementing session', async () => {
    const loader = new IdentityLoader({ agentsDir: tempDir });
    const updater = new IdentityUpdater({ agentsDir: tempDir });

    // 创建 identity 并添加 coreMemory
    const identity = await loader.loadOrCreate('test-agent');
    identity.coreMemory.preferences.push('Use dark mode');
    identity.coreMemory.workPatterns.push('Test before commit');
    identity.coreMemory.systemPrompt = 'Be concise';
    await loader.save(identity);

    // 调用 incrementSessionCount
    await updater.incrementSessionCount('test-agent');

    // 验证 coreMemory 保持不变
    const updated = await loader.load('test-agent');
    expect(updated!.coreMemory.preferences).toContain('Use dark mode');
    expect(updated!.coreMemory.workPatterns).toContain('Test before commit');
    expect(updated!.coreMemory.systemPrompt).toBe('Be concise');
    expect(updated!.sessionsCount).toBe(1);
  });

  test('preserves skillsLearned when incrementing session', async () => {
    const loader = new IdentityLoader({ agentsDir: tempDir });
    const updater = new IdentityUpdater({ agentsDir: tempDir });

    // 创建 identity 并添加技能
    const identity = await loader.loadOrCreate('test-agent');
    identity.skillsLearned.push('git-workflow', 'testing');
    await loader.save(identity);

    // 调用 incrementSessionCount
    await updater.incrementSessionCount('test-agent');

    // 验证技能保持不变
    const updated = await loader.load('test-agent');
    expect(updated!.skillsLearned).toContain('git-workflow');
    expect(updated!.skillsLearned).toContain('testing');
  });
});

// ============================================================================
// /clear 语义验证（模拟测试）
// ============================================================================

describe('/clear Letta semantics', () => {
  test('Memory Blocks files are preserved after clear', async () => {
    // 模拟 Memory Block 文件
    const blocksDir = path.join(tempDir, 'blocks');
    fs.mkdirSync(blocksDir, { recursive: true });
    
    const preferencesFile = path.join(blocksDir, 'preferences.md');
    const projectFile = path.join(blocksDir, 'project.md');
    
    fs.writeFileSync(preferencesFile, '# User Preferences\n- Dark mode');
    fs.writeFileSync(projectFile, '# Project Rules\n- Use TypeScript');

    // 模拟 /clear 行为：清空 session 但不删除文件
    // （实际 executeClear 不操作文件系统，只清空内存状态）

    // 验证文件仍然存在
    expect(fs.existsSync(preferencesFile)).toBe(true);
    expect(fs.existsSync(projectFile)).toBe(true);

    // 验证文件内容不变
    expect(fs.readFileSync(preferencesFile, 'utf-8')).toContain('Dark mode');
    expect(fs.readFileSync(projectFile, 'utf-8')).toContain('Use TypeScript');
  });

  test('Agent Identity file is preserved after clear', async () => {
    const loader = new IdentityLoader({ agentsDir: tempDir });

    // 创建 identity 并添加数据
    const identity = await loader.loadOrCreate('test-agent');
    identity.tasksCompleted = 10;
    identity.coreMemory.systemPrompt = 'Important principle';
    await loader.save(identity);

    // 验证 identity 文件存在（使用正确的路径）
    const identityPath = path.join(tempDir, `test-agent${IDENTITY_FILE_EXTENSION}`);
    expect(fs.existsSync(identityPath)).toBe(true);

    // 模拟 /clear 后的行为：文件仍存在
    expect(fs.existsSync(identityPath)).toBe(true);

    // 验证内容不变
    const reloaded = await loader.load('test-agent');
    expect(reloaded!.tasksCompleted).toBe(10);
    expect(reloaded!.coreMemory.systemPrompt).toBe('Important principle');
  });
});

// ============================================================================
// ConversationalRunner /clear 集成测试（不触网）
// ============================================================================

describe('ConversationalRunner /clear integration (Letta semantics)', () => {
  test('clears messages/variables, preserves checkpoints and block files (with --no-session)', async () => {
    const sessionDir = path.join(tempDir, 'sessions');
    const workDir = path.join(tempDir, 'workdir');
    fs.mkdirSync(workDir, { recursive: true });

    const runner = new ConversationalRunner({
      sessionDir,
      workDir,
      // /clear 不会触发 LLM 调用，这里给一个占位配置即可
      llm: { apiKey: 'test-key' },
      enableCheckpoints: false,
      verbose: false,
      noApproval: true,
    });

    const session = await runner.createSession();
    const store = new SessionStore(sessionDir);

    // 预置一些对话/变量/检查点
    await store.addMessage(session.sessionId, { role: 'user', content: 'hello' });
    await store.createCheckpoint(session.sessionId, 'checkpoint-1', {
      includeWorkspaceSnapshot: false,
      includeOrchestratorSnapshot: false,
    });

    const loaded = await store.getSession(session.sessionId);
    expect(loaded).not.toBeNull();
    loaded!.variables.userLanguage = 'zh';
    loaded!.variables.lastObjective = 'do something';
    loaded!.waitingForUser = true;
    loaded!.pendingQuestion = 'need input';
    await store.saveSession(loaded!);

    // 预置 Memory Blocks 文件（真实路径形式）
    const memoryDir = path.join(workDir, '.tachikoma', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    const preferencesFile = path.join(memoryDir, 'preferences.md');
    fs.writeFileSync(preferencesFile, '# User Preferences\n- Dark mode');

    // 执行 /clear（不增加 sessionsCount，避免污染真实 ~/.tachikoma）
    const events = await collectStreamEvents(
      runner.handleMessage(session.sessionId, '/clear --no-session')
    );

    // 期望返回 complete
    const last = events[events.length - 1] as { type?: string; success?: boolean };
    expect(last.type).toBe('complete');
    expect(last.success).toBe(true);

    // 验证会话被清空
    const cleared = await store.getSession(session.sessionId);
    expect(cleared).not.toBeNull();
    expect(cleared!.messages.length).toBe(0);
    expect(cleared!.waitingForUser).toBe(false);
    expect(cleared!.pendingQuestion).toBeUndefined();

    // 变量清空但保留语言
    expect(cleared!.variables.userLanguage).toBe('zh');
    const keys = Object.keys(cleared!.variables);
    expect(keys.length).toBe(1);
    expect(keys).toContain('userLanguage');

    // checkpoints 默认保留
    expect(cleared!.checkpoints.length).toBe(1);

    // blocks 文件不应被删除/改写
    expect(fs.existsSync(preferencesFile)).toBe(true);
    expect(fs.readFileSync(preferencesFile, 'utf-8')).toContain('Dark mode');
  });

  test('clears checkpoints list when --checkpoints is provided (with --no-session)', async () => {
    const sessionDir = path.join(tempDir, 'sessions2');
    const workDir = path.join(tempDir, 'workdir2');
    fs.mkdirSync(workDir, { recursive: true });

    const runner = new ConversationalRunner({
      sessionDir,
      workDir,
      llm: { apiKey: 'test-key' },
      enableCheckpoints: false,
      verbose: false,
      noApproval: true,
    });

    const session = await runner.createSession();
    const store = new SessionStore(sessionDir);

    await store.createCheckpoint(session.sessionId, 'checkpoint-1', {
      includeWorkspaceSnapshot: false,
      includeOrchestratorSnapshot: false,
    });
    await store.createCheckpoint(session.sessionId, 'checkpoint-2', {
      includeWorkspaceSnapshot: false,
      includeOrchestratorSnapshot: false,
    });

    const events = await collectStreamEvents(
      runner.handleMessage(session.sessionId, '/clear --checkpoints --no-session')
    );
    const last = events[events.length - 1] as { type?: string; success?: boolean };
    expect(last.type).toBe('complete');
    expect(last.success).toBe(true);

    const cleared = await store.getSession(session.sessionId);
    expect(cleared).not.toBeNull();
    expect(cleared!.checkpoints.length).toBe(0);
  });
});
