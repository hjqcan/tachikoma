import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider } from '@earendil-works/pi-ai';
import type { FauxProviderHandle, RegisterFauxProviderOptions } from '@earendil-works/pi-ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FauxHarness {
  dataDir: string;
  faux: FauxProviderHandle;
  modelRuntime: ModelRuntime;
  cleanup(): Promise<void>;
}

export async function createFauxHarness(
  options: RegisterFauxProviderOptions = {}
): Promise<FauxHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-core-test-'));
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: `tachikoma-faux-${crypto.randomUUID()}`,
    models: [
      { id: 'chat', reasoning: true },
      { id: 'alternate', reasoning: true },
    ],
    ...options,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  return {
    dataDir,
    faux,
    modelRuntime,
    async cleanup() {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
