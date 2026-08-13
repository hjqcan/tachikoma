import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveSidecarDataDir(
  configuredDataDir: string | undefined,
  temporarySmokeDataDir?: string
): string | undefined {
  return temporarySmokeDataDir ?? configuredDataDir;
}

export async function withTemporarySmokeDataDir<T>(
  run: (dataDir: string) => Promise<T>
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-desktop-smoke-'));
  try {
    return await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
