import {
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { expect, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import { createFauxHarness } from './helpers';

it('reopens real pi 0.84.2 history under pi 0.86 without restoring grants or legacy recall', async () => {
  const harness = await createFauxHarness({ provider: 'tachikoma-legacy-upgrade-faux' });
  let context: TranscriptContext | undefined;
  try {
    harness.faux.setResponses([
      (value) => {
        context = value;
        return fauxAssistantMessage('Upgraded safely.');
      },
    ]);
    // Recorded with old pi 0.84.2, a seven-tool coding grant, and a legacy
    // hidden memory snapshot. Only the ephemeral workspace path is tokenized.
    const text = (
      await readFile(join(import.meta.dir, 'fixtures/pi-0.84.2-session.jsonl'), 'utf8')
    ).replaceAll('{{legacy-workspace}}', harness.dataDir);
    const header = JSON.parse(text.split('\n')[0]!) as { id: string; version: number };
    expect(header.version).toBe(3);
    const directory = join(harness.dataDir, 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `2026-09-30T08-23-24-534Z_${header.id}.jsonl`), text);
    const engine = new ChatEngine(
      { dataDir: harness.dataDir, memory: false },
      { modelRuntime: harness.modelRuntime }
    );
    const session = await engine.openSession(header.id);
    expect(session).not.toBeNull();
    expect(session!.activeTools).toEqual([]);
    let status: string | undefined;
    for await (const event of session!.send('Continue the old conversation.')) {
      if (event.type === 'message_complete') status = event.status;
    }
    expect(status).toBe('success');
    expect(context).toBeDefined();
    expect(getCurrentTools(context!.messages)).toEqual([]);
    expect(getCurrentSystemPrompt(context!.messages)).toContain(
      'You have no tools in this session.'
    );
    expect(getCurrentSystemPrompt(context!.messages)).not.toContain('You have coding tools');
    const messages = JSON.stringify(context!.messages);
    expect(messages).toContain('Legacy user prompt.');
    expect(messages).toContain('Legacy assistant reply.');
    expect(messages).not.toContain('obsolete synthetic legacy profile');
    expect(messages).not.toContain('<recalled_user_context>');
    await session!.close();
  } finally {
    await harness.cleanup();
  }
});
