import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';

describe('custom models.json resolution', () => {
  it('resolves a custom OpenAI-compatible provider from <dataDir>/models.json offline', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-models-'));
    const previousKey = process.env.CUSTOM_GATEWAY_KEY;
    process.env.CUSTOM_GATEWAY_KEY = 'offline-placeholder-key';
    try {
      await writeFile(
        join(dataDir, 'models.json'),
        JSON.stringify({
          providers: {
            'custom-gateway': {
              name: 'Custom Gateway',
              baseUrl: 'https://gateway.invalid/v1',
              api: 'openai-completions',
              apiKey: '$CUSTOM_GATEWAY_KEY',
              models: [
                {
                  id: 'custom-model',
                  name: 'Custom Model',
                  reasoning: true,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_384,
                },
              ],
            },
          },
        })
      );

      const engine = new ChatEngine({
        dataDir,
        model: { provider: 'custom-gateway', model: 'custom-model' },
        memory: false,
      });
      const session = await engine.createSession();
      expect(session.model).toEqual({ provider: 'custom-gateway', model: 'custom-model' });
      expect(session.activeTools).toHaveLength(0);
      await session.close();

      const models = await engine.listModels();
      expect(models).toContainEqual(
        expect.objectContaining({
          provider: 'custom-gateway',
          model: 'custom-model',
          reasoning: true,
          contextWindow: expect.any(Number),
          maxTokens: expect.any(Number),
        })
      );
      const sorted = [...models].sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)
      );
      expect(models).toEqual(sorted);
    } finally {
      if (previousKey === undefined) {
        delete process.env.CUSTOM_GATEWAY_KEY;
      } else {
        process.env.CUSTOM_GATEWAY_KEY = previousKey;
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('configDir set: models.json resolves from configDir, not from the per-workspace dataDir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-models-data-'));
    const configDir = await mkdtemp(join(tmpdir(), 'tachikoma-models-config-'));
    const previousKey = process.env.CUSTOM_GATEWAY_KEY;
    process.env.CUSTOM_GATEWAY_KEY = 'offline-placeholder-key';
    try {
      await writeFile(
        join(configDir, 'models.json'),
        JSON.stringify({
          providers: {
            'config-gateway': {
              name: 'Config Gateway',
              baseUrl: 'https://gateway.invalid/v1',
              api: 'openai-completions',
              apiKey: '$CUSTOM_GATEWAY_KEY',
              models: [
                {
                  id: 'config-model',
                  name: 'Config Model',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 16_384,
                },
              ],
            },
          },
        })
      );

      const engine = new ChatEngine({
        dataDir,
        configDir,
        model: { provider: 'config-gateway', model: 'config-model' },
        memory: false,
      });
      const session = await engine.createSession();
      expect(session.model).toEqual({ provider: 'config-gateway', model: 'config-model' });
      await session.close();
    } finally {
      if (previousKey === undefined) {
        delete process.env.CUSTOM_GATEWAY_KEY;
      } else {
        process.env.CUSTOM_GATEWAY_KEY = previousKey;
      }
      await rm(dataDir, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('rejects a model that neither the catalog nor models.json defines', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-models-'));
    try {
      const engine = new ChatEngine({
        dataDir,
        model: { provider: 'no-such-provider', model: 'no-such-model' },
        memory: false,
      });
      await expect(engine.createSession()).rejects.toThrow(
        'Unknown model: no-such-provider/no-such-model'
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
