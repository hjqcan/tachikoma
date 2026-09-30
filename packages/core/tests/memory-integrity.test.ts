import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'bun:test';
import { createSQLiteDocumentStore } from 'goodmemory';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent } from '../src';
import { createChatMemoryRuntime, profileMemoryId } from '../src/chat/memory';
import { createFauxHarness } from './helpers';

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const result: ChatEvent[] = [];
  for await (const event of events) result.push(event);
  expect(result.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
  return result;
}

function recallText(messages: unknown[]): string[] {
  return messages
    .map((message) => JSON.stringify(message))
    .filter((text) => text.includes('<recalled_user_context>'));
}

describe('memory integrity through ChatEngine and SQLite', () => {
  it('injects only fresh recall, drops forgotten snapshots, and never persists new snapshots', async () => {
    const harness = await createFauxHarness();
    const contexts: unknown[][] = [];
    try {
      harness.faux.setResponses(
        Array.from({ length: 4 }, () => (context) => {
          contexts.push(context.messages);
          return fauxAssistantMessage('Okay.');
        })
      );
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: { userId: 'fresh-recall-user' },
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      await collect(session.send('请记住项目代号=Tachikoma。'));
      await collect(session.send('项目代号是什么？'));
      await collect(session.send('再说一次项目代号是什么？'));
      const record = (await engine.memoryList()).find((item) => item.type === 'fact');
      expect(record).toBeDefined();
      expect(await engine.memoryForget(record!.id)).toBeTrue();
      await collect(session.send('现在项目代号是什么？'));
      expect(contexts.map(recallText).map((messages) => messages.length)).toEqual([0, 1, 1, 0]);
      await session.close();
      const [info] = await SessionManager.list(harness.dataDir, join(harness.dataDir, 'sessions'));
      expect(await readFile(info!.path, 'utf8')).not.toContain('tachikoma-recalled-memory');
    } finally {
      await harness.cleanup();
    }
  });

  it('filters persisted legacy snapshots when reopening a session with memory disabled', async () => {
    const harness = await createFauxHarness();
    let context: unknown[] = [];
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('Okay.'),
        (value) => {
          context = value.messages;
          return fauxAssistantMessage('Okay.');
        },
      ]);
      const config = {
        dataDir: harness.dataDir,
        model: { provider: harness.faux.provider.id, model: 'chat' },
        memory: false as const,
      };
      const engine = new ChatEngine(config, { modelRuntime: harness.modelRuntime });
      const seed = await engine.createSession();
      await collect(seed.send('Hello.'));
      await seed.close();
      const [info] = await SessionManager.list(harness.dataDir, join(harness.dataDir, 'sessions'));
      SessionManager.open(info!.path).appendCustomMessageEntry(
        'tachikoma-recalled-memory',
        '<recalled_user_context>obsolete synthetic profile</recalled_user_context>',
        false
      );
      const resumed = await engine.openSession(seed.id);
      expect(resumed).not.toBeNull();
      await collect(resumed!.send('What do you know?'));
      expect(recallText(context)).toEqual([]);
      expect(JSON.stringify(context)).toContain('Hello.');
      await resumed!.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('excludes legacy memory snapshots from compaction input', async () => {
    const harness = await createFauxHarness({
      tokenSize: { min: 1000, max: 1000 },
      models: [{ id: 'chat', reasoning: true, contextWindow: 200_000 }],
    });
    let summaryInput = '';
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('Hello.'),
        fauxAssistantMessage('First.'),
        fauxAssistantMessage('Second.'),
        (context) => {
          summaryInput = JSON.stringify(context.messages);
          return fauxAssistantMessage('Clean summary.');
        },
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const seed = await engine.createSession();
      await collect(seed.send('Hello.'));
      await seed.close();
      const [info] = await SessionManager.list(harness.dataDir, join(harness.dataDir, 'sessions'));
      SessionManager.open(info!.path).appendCustomMessageEntry(
        'tachikoma-recalled-memory',
        '<recalled_user_context>obsolete synthetic profile</recalled_user_context>',
        false
      );
      const resumed = (await engine.openSession(seed.id))!;
      await collect(resumed.send('context '.repeat(12_000)));
      await collect(resumed.send('context '.repeat(12_000)));
      await resumed.compact();
      expect(summaryInput.length).toBeGreaterThan(100);
      expect(summaryInput).not.toContain('obsolete synthetic profile');
      expect(summaryInput).not.toContain('recalled_user_context');
      await resumed.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('makes the shared profile visible and explicitly deletable without clearing other scopes', async () => {
    const harness = await createFauxHarness();
    let context: unknown[] = [];
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('Okay.'),
        (value) => {
          context = value.messages;
          return fauxAssistantMessage('Okay.');
        },
      ]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: { userId: 'profile-owner' },
        },
        { modelRuntime: harness.modelRuntime }
      );
      const seed = await engine.createSession();
      await collect(seed.send('我的名字是 Lin，请记住。'));
      const memory = createChatMemoryRuntime({
        databasePath: seed.memoryStatus.databasePath!,
        userId: 'profile-owner',
      }).memory!;
      const ownExport = await memory.exportMemory({ scope: { userId: 'profile-owner' } });
      ownExport.durable.profile!.expertise = {
        primarySkills: ['Rust'],
        domains: ['Robotics'],
        level: 'senior',
      };
      ownExport.durable.profile!.activeContext = {
        goals: ['ship the robot'],
        currentProjects: ['Gadget'],
      };
      await memory.forget({ scope: { userId: 'profile-owner' }, memoryId: 'profile-owner' });
      await memory.importMemory({
        scope: { userId: 'profile-owner' },
        source: { kind: 'durable', durable: ownExport.durable },
      });
      const otherScope = { userId: 'profile-owner', workspaceId: 'other-app' };
      await memory.remember({
        scope: otherScope,
        messages: [{ role: 'user', content: '请记住项目代号=PreserveMe。' }],
      });
      await memory.remember({
        scope: { userId: 'other-person' },
        messages: [{ role: 'user', content: '我的名字是 Alice，请记住。' }],
      });
      const profiles = (await engine.memoryList()).filter((record) => record.type === 'profile');
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        id: profileMemoryId('profile-owner'),
        content: expect.stringContaining('identity.name: Lin'),
      });
      for (const value of ['Lin', 'Rust', 'Robotics', 'senior', 'ship the robot', 'Gadget']) {
        expect(await engine.memorySearch(value)).toHaveLength(1);
      }
      expect(await engine.memoryForget(profileMemoryId('other-person'))).toBeFalse();
      await engine.memoryClear();
      expect((await engine.memoryList()).some((record) => record.type === 'profile')).toBeTrue();
      expect(await engine.memoryForget(profiles[0]!.id)).toBeTrue();
      expect(await engine.memoryForget(profiles[0]!.id)).toBeFalse();
      expect(await engine.memoryList()).toEqual([]);
      expect((await memory.exportMemory({ scope: otherScope })).durable.facts).toHaveLength(1);
      expect(
        (await memory.exportMemory({ scope: { userId: 'other-person' } })).durable.profile?.identity
          .name
      ).toBe('Alice');
      const query = await engine.createSession();
      await collect(query.send('我叫什么名字？'));
      expect(recallText(context)).toEqual([]);
      await seed.close();
      await query.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('refuses same-user cross-kind ID collisions while preserving another user with the same ID', async () => {
    const harness = await createFauxHarness();
    try {
      const userId = 'profile-collision-owner';
      const databasePath = join(harness.dataDir, 'memory.sqlite');
      const memory = createChatMemoryRuntime({ databasePath, userId }).memory!;
      const engine = new ChatEngine(
        { dataDir: harness.dataDir, memory: { databasePath, userId } },
        { modelRuntime: harness.modelRuntime }
      );
      const scope = { userId, workspaceId: 'tachikoma', agentId: 'tachikoma' };
      await memory.remember({
        scope,
        messages: [{ role: 'user', content: '我的名字是 Lin，请记住。' }],
      });
      await memory.remember({
        scope,
        messages: [{ role: 'user', content: '请记住项目代号=Tachikoma。' }],
      });
      const exported = await memory.exportMemory({ scope: { userId } });
      const fact = exported.durable.facts[0]!;
      const store = createSQLiteDocumentStore(databasePath);
      await store.set('facts', userId, { ...fact, id: userId, workspaceId: 'other-app' });
      await expect(engine.memoryForget(profileMemoryId(userId))).rejects.toThrow('collides');
      expect(await store.get('facts', userId)).not.toBeNull();
      expect(await store.get('profiles', userId)).not.toBeNull();
      await store.set('facts', userId, {
        ...fact,
        id: userId,
        userId: 'different-person',
        workspaceId: 'other-app',
      });
      expect(await engine.memoryForget(profileMemoryId(userId))).toBeTrue();
      expect(await store.get('profiles', userId)).toBeNull();
      expect(await store.get('facts', userId)).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('inherits an explicitly remembered timezone and otherwise leaves occurrence unresolved', async () => {
    for (const timezone of [undefined, 'America/New_York']) {
      const harness = await createFauxHarness();
      try {
        const userId = 'profile-timezone-owner';
        const databasePath = join(harness.dataDir, 'memory.sqlite');
        const memory = createChatMemoryRuntime({ databasePath, userId }).memory!;
        if (timezone)
          await memory.remember({
            scope: { userId },
            messages: [{ role: 'user', content: `我的时区是 ${timezone}。` }],
          });
        harness.faux.setResponses([fauxAssistantMessage('Okay.')]);
        const engine = new ChatEngine(
          {
            dataDir: harness.dataDir,
            model: { provider: harness.faux.provider.id, model: 'chat' },
            memory: { databasePath, userId },
          },
          { modelRuntime: harness.modelRuntime }
        );
        const session = await engine.createSession();
        await collect(session.send('Yesterday I moved to Paris. Remember that.'));
        const { durable } = await memory.exportMemory({ scope: { userId } });
        const fact = durable.facts.find((item) => item.content.includes('Paris'))!;
        expect(fact.observedAt).toBeDefined();
        if (timezone) expect(fact.occurrence?.timezone).toBe(timezone);
        else expect(fact.occurrence).toBeUndefined();
        await session.close();
      } finally {
        await harness.cleanup();
      }
    }
  });

  it('anchors relative events to receipt time and explicit user timezone with source provenance', async () => {
    const harness = await createFauxHarness();
    try {
      harness.faux.setResponses([fauxAssistantMessage('Okay.')]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: { userId: 'event-owner', timezone: 'Asia/Shanghai' },
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const events = await collect(session.send('Yesterday I moved to Paris. Remember that.'));
      const turnId = events[0]!.turnId;
      const memory = createChatMemoryRuntime({
        databasePath: session.memoryStatus.databasePath!,
        userId: 'event-owner',
      }).memory!;
      const { durable } = await memory.exportMemory({ scope: { userId: 'event-owner' } });
      expect(durable.facts).toHaveLength(1);
      const fact = durable.facts[0]!;
      expect(fact.content).toBe('I moved to Paris.');
      expect(fact.occurrence).toMatchObject({ precision: 'day', timezone: 'Asia/Shanghai' });
      expect(fact.observedAt).toBeDefined();
      const observed = Date.parse(fact.observedAt!);
      const shanghaiDay = new Date(observed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const midnight = Date.parse(`${shanghaiDay}T00:00:00+08:00`);
      expect(fact.occurrence!.start).toBe(new Date(midnight - 86400000).toISOString());
      expect(fact.occurrence!.endExclusive).toBe(new Date(midnight).toISOString());
      expect(durable.sourceMessages?.find((message) => message.role === 'user')).toMatchObject({
        sourceMessageId: `${turnId}:user`,
        observedAt: fact.observedAt,
        timezone: 'Asia/Shanghai',
      });
      expect(durable.evidence[0]?.sourceMessageIds).toContain(`${turnId}:user`);
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects invalid timezone configuration without guessing the server timezone', () => {
    expect(() => new ChatEngine({ memory: { timezone: 'Mars/Olympus' } })).toThrow('IANA timezone');
  });
});
