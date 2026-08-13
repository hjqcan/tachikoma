import { describe, expect, it } from 'bun:test';
import { access } from 'node:fs/promises';

import { withTemporarySmokeDataDir } from '../src/main/smoke-data-dir';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('desktop smoke dataDir', () => {
  it('creates a dedicated directory and removes it after success', async () => {
    let observed = '';
    await withTemporarySmokeDataDir(async (dataDir) => {
      observed = dataDir;
      expect(await exists(dataDir)).toBeTrue();
      expect(dataDir).toContain('tachikoma-desktop-smoke-');
    });
    expect(await exists(observed)).toBeFalse();
  });

  it('removes the directory when the smoke callback fails', async () => {
    let observed = '';
    await expect(
      withTemporarySmokeDataDir(async (dataDir) => {
        observed = dataDir;
        throw new Error('smoke failed');
      })
    ).rejects.toThrow('smoke failed');
    expect(await exists(observed)).toBeFalse();
  });
});
