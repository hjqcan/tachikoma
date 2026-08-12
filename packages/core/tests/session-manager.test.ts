import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent } from '../src';
import { createFauxHarness } from './helpers';

async function drain(events: AsyncIterable<ChatEvent>): Promise<void> {
  for await (const event of events) {
    void event;
  }
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('pi JSONL session ownership', () => {
  it('creates v3 JSONL, restores model/thinking provenance, and isolates session models', async () => {
    const harness = await createFauxHarness();
    try {
      harness.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const first = await engine.createSession({ title: 'first session' });
      const second = await engine.createSession({ title: 'second session' });
      await second.setModel({ provider: harness.faux.provider.id, model: 'alternate' });
      second.setThinkingLevel('high');

      await drain(first.send('one'));
      await drain(second.send('two'));
      const firstId = first.id;
      const secondId = second.id;
      await first.close();
      await second.close();

      const summaries = await engine.listSessions();
      expect(summaries.find((summary) => summary.sessionId === firstId)).toMatchObject({
        model: { provider: harness.faux.provider.id, model: 'chat' },
        status: 'ready',
      });
      expect(summaries.find((summary) => summary.sessionId === secondId)).toMatchObject({
        model: { provider: harness.faux.provider.id, model: 'alternate' },
        thinkingLevel: 'high',
        status: 'ready',
      });

      const resumedFirst = await engine.openSession(firstId);
      const resumedSecond = await engine.openSession(secondId);
      expect(resumedFirst?.model).toEqual({ provider: harness.faux.provider.id, model: 'chat' });
      expect(resumedSecond?.model).toEqual({
        provider: harness.faux.provider.id,
        model: 'alternate',
      });
      expect(resumedSecond?.thinkingLevel).toBe('high');
      await resumedFirst?.close();
      await resumedSecond?.close();

      const files = await readdir(join(harness.dataDir, 'sessions'));
      const secondFile = files.find((filename) => filename.includes(secondId));
      expect(secondFile).toBeDefined();
      const lines = (await readFile(join(harness.dataDir, 'sessions', secondFile!), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ type: 'session', version: 3, id: secondId });
      expect(lines).toContainEqual(
        expect.objectContaining({
          type: 'model_change',
          provider: harness.faux.provider.id,
          modelId: 'alternate',
        })
      );
      expect(lines).toContainEqual(
        expect.objectContaining({ type: 'thinking_level_change', thinkingLevel: 'high' })
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('reports malformed JSONL instead of silently presenting it as a session', async () => {
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
      const created = await engine.createSession();
      await created.close();
      await writeFile(
        join(harness.dataDir, 'sessions', '2026-08-11_corrupt-session.jsonl'),
        '{not-json}\n',
        'utf8'
      );

      const sessions = await engine.listSessions();
      expect(sessions).toContainEqual(
        expect.objectContaining({
          sessionId: 'corrupt-session',
          status: 'corrupt',
          error: expect.stringContaining('SessionManager'),
        })
      );
      expect(engine.openSession('missing')).resolves.toBeNull();
      expect(await engine.deleteSession('corrupt-session')).toBeTrue();
      expect(
        (await engine.listSessions()).some((session) => session.sessionId === 'corrupt-session')
      ).toBeFalse();
      expect(await engine.deleteSession('corrupt-session')).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });

  it('history() 从转录导出文本回合：user_message + 完整助手回合，事件形状与 live 流一致', async () => {
    const harness = await createFauxHarness();
    try {
      harness.faux.setResponses([fauxAssistantMessage('回答一')]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const sessionId = session.id;
      for await (const event of session.send('问题一')) void event;
      await session.close();

      const history = await engine.history(sessionId);
      expect(history.map((event) => event.type)).toEqual([
        'user_message',
        'message_start',
        'message_delta',
        'message_complete',
      ]);
      expect(history[0]).toMatchObject({ type: 'user_message', text: '问题一', sessionId });
      expect(history[2]).toMatchObject({ type: 'message_delta', text: '回答一' });
      expect(history[3]).toMatchObject({ type: 'message_complete', status: 'success' });

      expect(await engine.history('does-not-exist')).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it('history() 重建工具回合：tool_call/tool_result 帧带原 callId，回合恰一个 message_complete', async () => {
    const harness = await createFauxHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-history-tools-'));
    try {
      await writeFile(join(workDir, 'hello.txt'), 'TOOL_MARKER_7734\n');
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
      const sessionId = session.id;
      await drain(session.send('读一下 hello.txt'));
      await session.close();

      const history = await engine.history(sessionId);
      expect(history.map((event) => event.type)).toEqual([
        'user_message',
        'message_start',
        'tool_call',
        'tool_result',
        'message_delta',
        'message_complete',
      ]);
      const toolCall = history[2];
      const toolResult = history[3];
      expect(toolCall).toMatchObject({
        type: 'tool_call',
        tool: 'read',
        input: { path: 'hello.txt' },
      });
      expect(toolResult).toMatchObject({ type: 'tool_result', tool: 'read', isError: false });
      if (toolCall?.type === 'tool_call' && toolResult?.type === 'tool_result') {
        expect(toolCall.callId).toBe(toolResult.callId);
        expect(toolResult.output).toContain('TOOL_MARKER_7734');
      }
      expect(history.at(-1)).toMatchObject({
        type: 'message_complete',
        status: 'success',
        content: '文件内容是 TOOL_MARKER_7734',
      });
      // 全部帧共享同一回合 id：重放光标与 live 流形状一致
      expect(new Set(history.map((event) => event.turnId))).toEqual(new Set(['history-1']));
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('server 的事件账本（*.events.jsonl）绝不被列为幻影会话，也不可经幻影 id 删除', async () => {
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
      const created = await engine.createSession();
      const sessionId = created.id;
      await created.close();
      // 旧布局遗留：server WAL 与转录同目录（事故根源；见 wal.ts 头注释）
      const walPath = join(harness.dataDir, 'sessions', `${sessionId}.events.jsonl`);
      await writeFile(walPath, '{"v":1}\n', 'utf8');

      const sessions = await engine.listSessions();
      expect(sessions.some((session) => session.sessionId.endsWith('.events'))).toBeFalse();
      expect(sessions.some((session) => session.status === 'corrupt')).toBeFalse();

      // 幻影 id 的删除请求不得 unlink 账本文件
      expect(await engine.deleteSession(`${sessionId}.events`)).toBeFalse();
      expect(existsSync(walPath)).toBeTrue();
    } finally {
      await harness.cleanup();
    }
  });

  it('persists overflow compaction provenance and resumes from the compacted branch', async () => {
    const harness = await createFauxHarness({
      tokenSize: { min: 1000, max: 1000 },
      models: [{ id: 'chat', reasoning: true, contextWindow: 200_000 }],
    });
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('first'),
        fauxAssistantMessage('second'),
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'Your input exceeds the context window of this model',
        }),
        fauxAssistantMessage('durable compaction summary'),
        fauxAssistantMessage('recovered after compaction'),
        fauxAssistantMessage('resumed successfully'),
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const largePrompt = 'context '.repeat(12_000);
      await drain(session.send(largePrompt));
      await drain(session.send(largePrompt));

      const events = await collect(session.send('trigger overflow recovery'));
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'compaction', phase: 'start', reason: 'overflow' })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'compaction',
          phase: 'complete',
          reason: 'overflow',
          aborted: false,
          willRetry: true,
        })
      );
      expect(events.at(-1)).toMatchObject({
        type: 'message_complete',
        status: 'success',
        content: 'recovered after compaction',
      });

      const sessionId = session.id;
      await session.close();
      const files = await readdir(join(harness.dataDir, 'sessions'));
      const sessionFile = files.find((filename) => filename.includes(sessionId));
      expect(sessionFile).toBeDefined();
      const entries = (await readFile(join(harness.dataDir, 'sessions', sessionFile!), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'compaction',
          summary: 'durable compaction summary',
          firstKeptEntryId: expect.any(String),
          tokensBefore: expect.any(Number),
          usage: expect.objectContaining({ totalTokens: expect.any(Number) }),
        })
      );

      const resumed = await engine.openSession(sessionId);
      expect(resumed).not.toBeNull();
      const resumedEvents = await collect(resumed!.send('continue from compacted history'));
      expect(resumedEvents.at(-1)).toMatchObject({
        type: 'message_complete',
        status: 'success',
        content: 'resumed successfully',
      });
      await resumed!.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('deletes a closed session without retaining a compatibility record', async () => {
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
      harness.faux.setResponses([fauxAssistantMessage('persist me')]);
      const session = await engine.createSession();
      const sessionId = session.id;
      await drain(session.send('create a durable transcript'));
      await session.close();

      expect(await engine.deleteSession(sessionId)).toBeTrue();
      expect(
        (await engine.listSessions()).some((summary) => summary.sessionId === sessionId)
      ).toBeFalse();
      expect(await engine.openSession(sessionId)).toBeNull();
      expect(await engine.deleteSession(sessionId)).toBeFalse();
    } finally {
      await harness.cleanup();
    }
  });
});
