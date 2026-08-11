import { expect, it } from 'bun:test';

import { OFFLINE_NETWORK_ERROR } from './offline-guard';

it('poisons provider credentials and blocks fetch in the offline suite', async () => {
  expect(process.env.OPENAI_API_KEY).toBe('poison-offline-credential');
  expect(process.env.ANTHROPIC_API_KEY).toBe('poison-offline-credential');
  expect(process.env.OPENROUTER_API_KEY).toBe('poison-offline-credential');
  expect(process.env.GOOGLE_API_KEY).toBe('poison-offline-credential');
  expect(process.env.TACHIKOMA_RUN_LIVE_TESTS).toBe('0');
  await expect(globalThis.fetch('https://network-access-is-forbidden.invalid')).rejects.toThrow(
    OFFLINE_NETWORK_ERROR
  );
});
