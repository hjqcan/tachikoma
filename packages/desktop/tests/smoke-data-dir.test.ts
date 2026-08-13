import { describe, expect, it } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSidecarDataDir, withTemporarySmokeDataDir } from '../src/main/smoke-data-dir';

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

  it('overrides an existing environment dataDir without touching its sentinel', async () => {
    const configuredDataDir = await mkdtemp(join(tmpdir(), 'tachikoma-configured-data-'));
    const sentinel = join(configuredDataDir, 'sentinel.txt');
    await writeFile(sentinel, 'must-survive');
    const previous = process.env.TACHIKOMA_DATA_DIR;
    process.env.TACHIKOMA_DATA_DIR = configuredDataDir;
    try {
      let smokeDataDir = '';
      await withTemporarySmokeDataDir(async (temporaryDataDir) => {
        const resolved = resolveSidecarDataDir(process.env.TACHIKOMA_DATA_DIR, temporaryDataDir);
        smokeDataDir = resolved ?? '';
        expect(smokeDataDir).toBe(temporaryDataDir);
        expect(smokeDataDir).not.toBe(configuredDataDir);
      });
      expect(await exists(smokeDataDir)).toBeFalse();
      expect(await readFile(sentinel, 'utf8')).toBe('must-survive');
    } finally {
      if (previous === undefined) delete process.env.TACHIKOMA_DATA_DIR;
      else process.env.TACHIKOMA_DATA_DIR = previous;
      await rm(configuredDataDir, { recursive: true, force: true });
    }
  });
});
