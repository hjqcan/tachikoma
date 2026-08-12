import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
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
