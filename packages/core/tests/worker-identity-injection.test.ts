/**
 * Worker Identity 注入（18.6）测试
 *
 * 目标：确保默认的 SDK 后端（OpenAI/Claude）在构建 system prompt 时也会注入 Agent Identity CoreMemory。
 * 说明：不触发真实 LLM/SDK 执行，仅调用后端内部的 prompt 构建路径（best-effort）。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { OpenAIAgentsBackend, ClaudeAgentSDKBackend } from '../src/worker';
import { IdentityLoader } from '../src/agent-identity';

let tempDir: string;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tachikoma-worker-identity-test-'));
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

describe('18.6 identityContext injection in SDK backends', () => {
  test('OpenAIAgentsBackend buildSystemPrompt includes identityContext when identity exists', async () => {
    const agentsDir = path.join(tempDir, 'agents');
    const loader = new IdentityLoader({ agentsDir });
    const identity = await loader.loadOrCreate('test-agent');
    identity.coreMemory.preferences.push('Use dark mode');
    await loader.save(identity);

    const backend = new OpenAIAgentsBackend({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      identityConfig: { agentId: 'test-agent', agentsDir },
    });

    // 调用私有方法（仅用于测试注入逻辑）
    const systemPrompt = (await (backend as any).buildSystemPrompt('memory', null)) as string;
    expect(systemPrompt).toContain('# Agent Identity');
    expect(systemPrompt).toContain('Use dark mode');
  });

  test('ClaudeAgentSDKBackend buildSDKOptions includes identityContext when identity exists', async () => {
    const agentsDir = path.join(tempDir, 'agents2');
    const workDir = path.join(tempDir, 'workdir');
    fs.mkdirSync(workDir, { recursive: true });

    const loader = new IdentityLoader({ agentsDir });
    const identity = await loader.loadOrCreate('test-agent');
    identity.coreMemory.preferences.push('Use dark mode');
    await loader.save(identity);

    const backend = new ClaudeAgentSDKBackend({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key',
      identityConfig: { agentId: 'test-agent', agentsDir },
      // 避免 SDK 行为差异：这里不传 sdkOptions.systemPrompt
    });

    // 调用私有方法（仅用于测试注入逻辑；tools 为空不会触发真实 MCP 执行）
    // buildSDKOptions signature: (tools, options, task, memoryContext, skillsManager, taskObjective, taskParentObjective, constraintPolicy)
    const sdkOptions = (await (backend as any).buildSDKOptions(
      [],                        // tools
      { workDir },               // options
      { id: 'test-task', type: 'atomic', objective: 'test-objective' }, // task
      undefined,                 // memoryContext
      undefined,                 // skillsManager (skip to avoid renderSystemPromptSection call)
      'test-objective',          // taskObjective
      undefined                  // taskParentObjective
    )) as Record<string, unknown>;

    const systemPrompt = sdkOptions.systemPrompt as string | undefined;
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt!).toContain('# Agent Identity');
    expect(systemPrompt!).toContain('Use dark mode');
  });

  test('ClaudeAgentSDKBackend transformSDKMessage should treat isError payload as tool failure', async () => {
    const backend = new ClaudeAgentSDKBackend({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key',
    });

    // Prime call map so tool_result can recover name/input.
    (backend as any).transformSDKMessage({
      type: 'tool_use',
      id: 'call-1',
      name: 'todowrite',
      input: { todos: [] },
    });

    const transformed = (backend as any).transformSDKMessage({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: JSON.stringify({
        isError: true,
        code: 'TOOL_FUNCTIONAL_ERROR',
        error: 'Invalid todo transition',
      }),
    }) as Record<string, unknown>;

    expect(transformed.type).toBe('tool_result');
    expect(transformed.success).toBe(false);
  });
});
