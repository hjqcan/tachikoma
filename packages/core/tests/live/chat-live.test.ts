import { describe, expect, it } from 'bun:test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../../src';
import type { ChatEvent, ChatModelRef } from '../../src';

const liveEnabled = process.env.TACHIKOMA_RUN_LIVE_TESTS === '1';

function liveModel(): ChatModelRef {
  const provider = process.env.TACHIKOMA_LIVE_PROVIDER;
  const model = process.env.TACHIKOMA_LIVE_MODEL;
  if (!provider || !model) {
    throw new Error('Live tests require TACHIKOMA_LIVE_PROVIDER and TACHIKOMA_LIVE_MODEL.');
  }
  return { provider, model };
}

/** 临时 dataDir 保持密封；TACHIKOMA_LIVE_MODELS_JSON 指定的自定义模型文件会被拷入其中 */
async function liveDataDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const models = process.env.TACHIKOMA_LIVE_MODELS_JSON;
  if (models) {
    await copyFile(models, join(dataDir, 'models.json'));
  }
  return dataDir;
}

describe.skipIf(!liveEnabled)('live chat', () => {
  it('streams a real answer with provider usage', async () => {
    const dataDir = await liveDataDir('tachikoma-live-');
    try {
      const engine = new ChatEngine({ dataDir, model: liveModel(), memory: false });
      const session = await engine.createSession();
      const events: ChatEvent[] = [];
      for await (const event of session.send('Reply with exactly: tachikoma-live-ok')) {
        events.push(event);
      }
      const complete = events.at(-1);
      expect(complete?.type).toBe('message_complete');
      if (complete?.type === 'message_complete') {
        expect(complete.status).toBe('success');
        expect(complete.content).toContain('tachikoma-live-ok');
        expect(complete.usage.totalTokens).toBeGreaterThan(0);
      }
      await session.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('streams reasoning deltas when a thinking level is set', async () => {
    const dataDir = await liveDataDir('tachikoma-live-thinking-');
    try {
      const engine = new ChatEngine({
        dataDir,
        model: liveModel(),
        memory: false,
        thinkingLevel: 'low',
      });
      const session = await engine.createSession();
      let reasoningDeltas = 0;
      let complete: ChatEvent | undefined;
      for await (const event of session.send('127 是质数吗？请仔细思考后回答。')) {
        if (event.type === 'reasoning_delta') reasoningDeltas += 1;
        if (event.type === 'message_complete') complete = event;
      }
      expect(complete).toMatchObject({ type: 'message_complete', status: 'success' });
      expect(reasoningDeltas).toBeGreaterThan(0);
      await session.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('interrupts a real stream with one interrupted terminal event', async () => {
    const dataDir = await liveDataDir('tachikoma-live-abort-');
    try {
      const engine = new ChatEngine({ dataDir, model: liveModel(), memory: false });
      const session = await engine.createSession();
      const events: ChatEvent[] = [];
      for await (const event of session.send('Write a detailed 2000-word essay about the ocean.')) {
        events.push(event);
        if (event.type === 'message_delta') {
          await session.abort();
        }
      }
      expect(events.filter((event) => event.type === 'message_complete')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'interrupted' });
      await session.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
