import { fauxAssistantMessage, fauxText, fauxThinking } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';

import { ChatEngine } from '../src';
import type { ChatEvent, ChatMessageCompleteEvent } from '../src';
import { createFauxHarness } from './helpers';

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function terminal(events: ChatEvent[]): ChatMessageCompleteEvent {
  const terminals = events.filter(
    (event): event is ChatMessageCompleteEvent => event.type === 'message_complete'
  );
  expect(terminals).toHaveLength(1);
  expect(events.at(-1)).toBe(terminals[0]);
  return terminals[0]!;
}

describe('ChatSession', () => {
  it('streams text and reasoning, exposes full pi usage, and emits one terminal event', async () => {
    const harness = await createFauxHarness({ tokenSize: { min: 1, max: 1 } });
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxThinking('reasoning'), fauxText('final answer')]),
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
      const events = await collect(session.send('hello'));
      const complete = terminal(events);

      // 回合首事件是用户输入原文：WAL 重放靠它重建对话的"人"这一侧
      expect(events[0]).toMatchObject({ type: 'user_message', text: 'hello' });
      expect(events[0]?.turnId).toBe(complete.turnId);
      expect(events.some((event) => event.type === 'reasoning_delta')).toBeTrue();
      expect(
        events
          .filter((event) => event.type === 'message_delta')
          .map((event) => event.text)
          .join('')
      ).toBe('final answer');
      expect(complete.status).toBe('success');
      expect(complete.content).toBe('final answer');
      expect(complete.usage.input).toBeGreaterThan(0);
      expect(complete.usage.output).toBeGreaterThan(0);
      expect(complete.usage.cacheRead).toBeGreaterThanOrEqual(0);
      expect(complete.usage.cacheWrite).toBeGreaterThanOrEqual(0);
      expect(complete.usage.totalTokens).toBeGreaterThan(0);
      expect(complete.usage.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      });
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('send 携带图片：pi 上下文收到 image part，user_message 只带元数据', async () => {
    const harness = await createFauxHarness();
    try {
      let userContent = '';
      harness.faux.setResponses([
        (context) => {
          userContent = JSON.stringify(context.messages.at(-1)?.content ?? '');
          return fauxAssistantMessage('看到了');
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
      const session = await engine.createSession();
      const base64 = Buffer.from('fake-png-bytes').toString('base64');
      const events = await collect(
        session.send('这张图里是什么？', {
          images: [{ name: 'lens.png', mimeType: 'image/png', data: base64 }],
        })
      );
      expect(events[0]).toMatchObject({
        type: 'user_message',
        text: '这张图里是什么？',
        attachments: [
          {
            kind: 'image',
            mimeType: 'image/png',
            name: 'lens.png',
            bytes: 'fake-png-bytes'.length,
          },
        ],
      });
      // 像素进了 pi 的用户消息内容（转录是事实源），事件账本不搬运 base64
      expect(userContent).toContain('"type":"image"');
      expect(userContent).toContain(base64);
      expect(JSON.stringify(events)).not.toContain(base64);
      expect(terminal(events).status).toBe('success');
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('lets pi retry transient failures without a second public terminal event', async () => {
    const harness = await createFauxHarness();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate limit' }),
        fauxAssistantMessage('recovered'),
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
      const events = await collect(session.send('retry this'));

      expect(events.some((event) => event.type === 'retry')).toBeTrue();
      expect(terminal(events)).toMatchObject({ status: 'success', content: 'recovered' });
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('redacts credentials from provider errors before emitting events', async () => {
    const harness = await createFauxHarness();
    const previousKey = process.env.OPENAI_API_KEY;
    const secret = 'tachikoma-test-secret-credential';
    process.env.OPENAI_API_KEY = secret;
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: `429 rate limit; Authorization: Bearer ${secret}; api_key=${secret}`,
        }),
        fauxAssistantMessage('recovered'),
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
      const events = await collect(session.send('retry safely'));
      const serialized = JSON.stringify(events);

      expect(terminal(events).status).toBe('success');
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('[REDACTED]');
      await session.close();
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      await harness.cleanup();
    }
  });

  it('fails closed when a tool-free model returns a tool-use stop reason', async () => {
    const harness = await createFauxHarness();
    try {
      harness.faux.setResponses([
        fauxAssistantMessage('unexpected tool request', { stopReason: 'toolUse' }),
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
      const events = await collect(session.send('do not use tools'));

      expect(terminal(events)).toMatchObject({
        status: 'failed',
        stopReason: 'toolUse',
        error: 'Chat-only session rejected model stop reason: toolUse.',
      });
      expect(events.every((event) => !event.type.startsWith('tool'))).toBeTrue();
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('interrupts an active stream and preserves the unique terminal contract', async () => {
    const harness = await createFauxHarness({
      tokensPerSecond: 20,
      tokenSize: { min: 1, max: 1 },
    });
    try {
      harness.faux.setResponses([fauxAssistantMessage('a'.repeat(120))]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const events: ChatEvent[] = [];
      for await (const event of session.send('start')) {
        events.push(event);
        if (event.type === 'message_delta') {
          expect(await session.abort()).toBeTrue();
        }
      }

      expect(terminal(events).status).toBe('interrupted');
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('honors an already-aborted signal before pi starts and never calls the provider', async () => {
    const harness = await createFauxHarness();
    try {
      harness.faux.setResponses([fauxAssistantMessage('must not be used')]);
      const engine = new ChatEngine(
        {
          dataDir: harness.dataDir,
          model: { provider: harness.faux.provider.id, model: 'chat' },
          memory: false,
        },
        { modelRuntime: harness.modelRuntime }
      );
      const session = await engine.createSession();
      const controller = new AbortController();
      controller.abort();
      const events = await collect(session.send('do not send', { signal: controller.signal }));

      expect(terminal(events).status).toBe('interrupted');
      expect(harness.faux.state.callCount).toBe(0);
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });

  it('has no active tools even when asked to read files or execute commands', async () => {
    const harness = await createFauxHarness();
    try {
      let advertisedTools: unknown[] | undefined;
      harness.faux.setResponses([
        (context) => {
          advertisedTools = context.tools;
          return fauxAssistantMessage('I cannot access files or run commands.');
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
      const session = await engine.createSession();

      expect(session.activeTools).toEqual([]);
      terminal(await collect(session.send('Read package.json and run pwd.')));
      expect(advertisedTools ?? []).toEqual([]);
      expect(session.activeTools).toEqual([]);
      await session.close();
    } finally {
      await harness.cleanup();
    }
  });
});
