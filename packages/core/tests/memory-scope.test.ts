import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ChatEngine } from '../src';
import type { ChatEvent, ChatSession } from '../src';
import { createChatMemoryRuntime, profileMemoryId } from '../src/chat/memory';
import { createFauxHarness } from './helpers';

async function complete(session: ChatSession, text: string): Promise<void> {
  const events: ChatEvent[] = [];
  for await (const event of session.send(text)) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
  const statuses = events.filter((event) => event.type === 'memory_status');
  if (statuses.some((event) => ['degraded', 'write-failed', 'disabled'].includes(event.status)))
    throw new Error(JSON.stringify({ input: text, statuses }));
  expect(
    statuses.some((event) => event.phase === 'writeback' && event.status === 'ready')
  ).toBeTrue();
}

// Public host operations on isolated synthetic SQLite data. No storage internals are inspected.
describe('memory scope controls across sessions', () => {
  for (const action of ['forget-one', 'clear-workspace', 'forget-profile'] as const) {
    it(`${action} preserves another user's records and independent workspace data`, async () => {
      const h = await createFauxHarness();
      const sessions: ChatSession[] = [];
      try {
        h.faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage('Acknowledged.')));
        const databasePath = join(h.dataDir, 'shared.sqlite');
        const make = (userId: string) =>
          new ChatEngine(
            {
              dataDir: join(h.dataDir, userId),
              model: { provider: h.faux.provider.id, model: 'chat' },
              memory: { userId, databasePath },
            },
            { modelRuntime: h.modelRuntime }
          );
        const own = make('owner');
        const other = make('neighbor');
        const ownSession = await own.createSession();
        const otherSession = await other.createSession();
        sessions.push(ownSession, otherSession);
        await complete(ownSession, 'My name is Mira.');
        await complete(ownSession, '请记住项目代号=Amber。');
        await complete(ownSession, '请记住备用项目代号=Quartz。');
        await complete(otherSession, 'My name is Noor.');
        await complete(otherSession, '请记住项目代号=Cobalt。');
        const memory = createChatMemoryRuntime({ databasePath, userId: 'owner' }).memory!;
        const freshRecall = async (userId: string, text: string) => {
          const runtime = createChatMemoryRuntime({ databasePath, userId });
          let context: unknown[] = [];
          h.faux.setResponses([
            (request) => {
              context = request.messages;
              return fauxAssistantMessage('Acknowledged.');
            },
          ]);
          const queryEngine = new ChatEngine(
            {
              dataDir: join(h.dataDir, userId),
              model: { provider: h.faux.provider.id, model: 'chat' },
              memory: { userId, databasePath },
            },
            {
              modelRuntime: h.modelRuntime,
              memoryRuntimeKit: {
                ...runtime.kit,
                afterModelCall: (input) =>
                  runtime.kit.afterModelCall({ ...input, writeback: { mode: 'off' } }),
              },
            }
          );
          const query = await queryEngine.createSession();
          sessions.push(query);
          await complete(query, text);
          await query.close();
          return context
            .filter((message) => JSON.stringify(message).includes('<recalled_user_context>'))
            .map((message) => JSON.stringify(message))
            .join('\n');
        };
        const nameQuery = 'What is my name?';
        const projectQuery = '现在项目代号和备用项目代号是什么？';
        expect(await freshRecall('owner', nameQuery)).toContain('Mira');

        const foreignScope = {
          userId: 'owner',
          workspaceId: 'not-tachikoma',
          agentId: 'tachikoma',
        };
        await memory.remember({
          scope: foreignScope,
          messages: [{ role: 'user', content: '请记住外部项目代号=Silver。' }],
        });
        const neighborBefore = (await memory.exportMemory({ scope: { userId: 'neighbor' } }))
          .durable;
        const foreignBefore = (await memory.exportMemory({ scope: foreignScope })).durable;
        expect(neighborBefore.profile?.identity.name).toBe('Noor');
        expect(neighborBefore.facts.some((record) => record.content.includes('Cobalt'))).toBeTrue();
        expect(foreignBefore.facts.some((record) => record.content.includes('Silver'))).toBeTrue();
        const recalledBefore = await freshRecall('owner', projectQuery);
        expect(recalledBefore).toContain('Amber');
        expect(recalledBefore).toContain('Quartz');
        expect(recalledBefore).not.toContain('Silver');
        const ownBefore = await own.memoryList();
        expect(
          ownBefore.some((record) => record.type === 'profile' && record.content.includes('Mira'))
        ).toBeTrue();
        const amber = ownBefore.find(
          (record) => record.type === 'fact' && record.content.includes('Amber')
        )!;
        expect(amber).toBeDefined();
        if (action === 'forget-one') {
          expect(await own.memoryForget(amber.id)).toBeTrue();
          expect(await own.memoryForget(amber.id)).toBeFalse();
          const recalled = await freshRecall('owner', projectQuery);
          expect(recalled).not.toContain('Amber');
          expect(recalled).toContain('Quartz');
          expect(
            (await own.memoryList()).some((record) => record.content.includes('Quartz'))
          ).toBeTrue();
        } else if (action === 'clear-workspace') {
          expect(await own.memoryClear()).toBeGreaterThan(0);
          expect((await own.memoryList()).map((record) => record.type)).toEqual(['profile']);
          const recalled = await freshRecall('owner', projectQuery);
          expect(await freshRecall('owner', nameQuery)).toContain('Mira');
          expect(recalled).not.toContain('Amber');
          expect(recalled).not.toContain('Quartz');
        } else {
          expect(await own.memoryForget(profileMemoryId('neighbor'))).toBeFalse();
          expect(await own.memoryForget(profileMemoryId('owner'))).toBeTrue();
          expect((await own.memoryList()).some((record) => record.type === 'profile')).toBeFalse();
          expect(await freshRecall('owner', nameQuery)).not.toContain('Mira');
          const recalled = await freshRecall('owner', projectQuery);
          expect(recalled).toContain('Amber');
          expect(recalled).toContain('Quartz');
          expect((await own.memoryList()).filter((record) => record.type === 'fact')).toHaveLength(
            2
          );
        }
        expect(await freshRecall('neighbor', nameQuery)).toContain('Noor');
        const neighborAfter = (await memory.exportMemory({ scope: { userId: 'neighbor' } }))
          .durable;
        expect(neighborAfter).toEqual(neighborBefore);
        const foreignAfter = (await memory.exportMemory({ scope: foreignScope })).durable;
        // User-wide profile can change under explicit profile removal; foreign workspace rows cannot.
        for (const key of ['facts', 'preferences', 'evidence', 'sourceMessages'] as const)
          expect(foreignAfter[key]).toEqual(foreignBefore[key]);
      } finally {
        for (const session of sessions) await session.close();
        await h.cleanup();
      }
    });
  }
});
