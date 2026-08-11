/**
 * 第二圈（工具调用者）测试 —— 全程零网络
 *
 * 覆盖：默认零工具不变（第一圈保证）、workDir 启用只读四件套、
 * 工具事件（tool_call/tool_update/tool_result + callId）、路径边界拦截、
 * symlink 逃逸拦截、findWorkspaceViolation 单元语义。
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, findWorkspaceViolation, WORKSPACE_TOOLS } from '../src';
import type { ChatEvent } from '../src';
import { createFauxHarness } from './helpers';

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function makeWorkspace(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-workspace-'));
  await writeFile(join(workDir, 'hello.txt'), 'TOOL_MARKER_7734\n');
  return workDir;
}

describe('第二圈：只读工具', () => {
  it('默认（无 workDir）保持零工具——第一圈保证不被削弱', async () => {
    const harness = await createFauxHarness();
    try {
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      expect(session.activeTools).toHaveLength(0);
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('workDir 启用恰好只读四件套（read/grep/find/ls）', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
          workDir,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      expect([...session.activeTools].sort()).toEqual([...WORKSPACE_TOOLS].sort());
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('工具循环产生 tool_call/tool_result 事件且读到工作区文件内容', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read', { path: 'hello.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('文件内容是 TOOL_MARKER_7734'),
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
          workDir,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const events = await collect(session.send('读一下 hello.txt'));

      const toolCall = events.find((event) => event.type === 'tool_call');
      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolCall).toMatchObject({ type: 'tool_call', tool: 'read' });
      expect(toolResult).toMatchObject({ type: 'tool_result', tool: 'read', isError: false });
      if (toolCall?.type === 'tool_call' && toolResult?.type === 'tool_result') {
        expect(toolCall.callId).toBe(toolResult.callId);
        expect(toolResult.output).toContain('TOOL_MARKER_7734');
      }
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('相对路径越界（../）被拦截为错误 tool_result，对话不中断', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'tachikoma-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SECRET\n');
    try {
      harness.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('read', {
              path: join('..', outside.split('/').at(-1) ?? '', 'secret.txt'),
            }),
          ],
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage('好的，我不再读取该路径。'),
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
          workDir,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const events = await collect(session.send('读一下外面的 secret.txt'));

      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.output).toContain('outside the workspace');
        expect(toolResult.output).not.toContain('OUTSIDE_SECRET');
      }
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
      await session.close();
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('symlink 逃逸（工作区内链接指向外部）被拦截', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'tachikoma-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SECRET\n');
    await symlink(join(outside, 'secret.txt'), join(workDir, 'innocent.txt'));
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read', { path: 'innocent.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('好的。'),
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
          workDir,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const events = await collect(session.send('读一下 innocent.txt'));

      const toolResult = events.find((event) => event.type === 'tool_result');
      expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.output).not.toContain('OUTSIDE_SECRET');
      }
      await session.close();
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});

describe('findWorkspaceViolation 单元语义', () => {
  it('工作区内路径、相对路径、不存在路径均放行；越界与绝对外部路径拦截', async () => {
    // 前置条件：root 必须是 canonical 路径（引擎侧由 resolveWorkspaceRoot 保证）
    const workDir = await realpath(await makeWorkspace());
    try {
      expect(findWorkspaceViolation({ path: 'hello.txt' }, workDir)).toBeNull();
      expect(findWorkspaceViolation({ path: './sub/does-not-exist.txt' }, workDir)).toBeNull();
      expect(findWorkspaceViolation({ pattern: '../not-a-path-field' }, workDir)).toBeNull();
      expect(findWorkspaceViolation({ path: '../escape.txt' }, workDir)).toBe('../escape.txt');
      expect(findWorkspaceViolation({ path: '/etc/passwd' }, workDir)).toBe('/etc/passwd');
      expect(findWorkspaceViolation(null, workDir)).toBeNull();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
