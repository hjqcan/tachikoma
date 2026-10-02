import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it, spyOn } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent } from '../src';
import { WORKSPACE_TOOLS } from '../src/chat/workspace-guard';
import { createFauxHarness } from './helpers';

it.each(['0.84.2', '0.86.1'])(
  'reopens real pi %s history under pi 1.0 without restoring grants or legacy recall',
  async (version) => {
    const harness = await createFauxHarness({ provider: 'tachikoma-legacy-upgrade-faux' });
    let context: TranscriptContext | undefined;
    try {
      harness.faux.setResponses([
        (value) => {
          context = value;
          return fauxAssistantMessage('Upgraded safely.');
        },
      ]);
      // Recorded with each old pi release, a seven-tool coding grant, and a legacy
      // hidden memory snapshot. Only ephemeral workspace paths are tokenized.
      const text = (
        await readFile(join(import.meta.dir, `fixtures/pi-${version}-session.jsonl`), 'utf8')
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
  }
);

it('keeps system tools and fresh memory after pi 1.0 compaction and a real tool roundtrip', async () => {
  const harness = await createFauxHarness({
    tokenSize: { min: 1000, max: 1000 },
    models: [{ id: 'chat', reasoning: true, contextWindow: 200_000 }],
  });
  // Keep this real-memory compaction check bounded; only lower the retention window.
  const createSettings = SettingsManager.inMemory.bind(SettingsManager);
  const settings = spyOn(SettingsManager, 'inMemory').mockImplementation((initial) =>
    createSettings({ ...initial, compaction: { ...initial?.compaction, keepRecentTokens: 256 } })
  );
  const requests: TranscriptContext[] = [];
  let summaryInput = '';
  try {
    const record =
      (message: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
        requests.push(context);
        return message;
      };
    harness.faux.setResponses([
      record(fauxAssistantMessage('Acknowledged.')),
      record(fauxAssistantMessage('First.')),
      record(fauxAssistantMessage('Second.')),
      (context) => {
        summaryInput = JSON.stringify(context.messages);
        return fauxAssistantMessage('The user sent a long conversation.');
      },
      record(
        fauxAssistantMessage([fauxToolCall('read', { path: 'fixture.txt' })], {
          stopReason: 'toolUse',
        })
      ),
      record(fauxAssistantMessage('Read successfully.')),
    ]);
    const workDir = join(harness.dataDir, 'workspace');
    await mkdir(workDir);
    await writeFile(join(workDir, 'fixture.txt'), 'UPGRADE_TOOL_SENTINEL\n');
    const engine = new ChatEngine(
      {
        dataDir: harness.dataDir,
        model: { provider: harness.faux.provider.id, model: 'chat' },
        memory: { userId: 'pi-upgrade-memory-user' },
        workDir,
      },
      { modelRuntime: harness.modelRuntime }
    );
    const session = await engine.createSession();
    const turn = async (text: string) => {
      const events: ChatEvent[] = [];
      for await (const event of session.send(text)) events.push(event);
      expect(events.filter((event) => event.type === 'message_complete')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'message_complete', status: 'success' });
      expect(events.filter((event) => event.type === 'memory_status')).not.toContainEqual(
        expect.objectContaining({ status: 'degraded' })
      );
      return events;
    };
    await turn('我的名字是 Lin，请记住。');
    await turn('context '.repeat(300));
    await turn('context '.repeat(300));
    await session.compact();
    expect(summaryInput).not.toContain('recalled_user_context');
    expect(summaryInput.length).toBeGreaterThan(100);
    const events = await turn('我叫什么名字？并读取 fixture.txt。');
    expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
      tool: 'read',
      isError: false,
      output: expect.stringContaining('UPGRADE_TOOL_SENTINEL'),
    });
    expect(events.some((event) => event.type === 'tool_approval_request')).toBeFalse();
    for (const request of requests.slice(-2)) {
      expect(getCurrentSystemPrompt(request.messages)).toContain('You have read-only tools');
      expect(getCurrentSystemPrompt(request.messages)).not.toContain('<recalled_user_context>');
      expect(
        getCurrentTools(request.messages)
          .map((tool) => tool.name)
          .sort()
      ).toEqual([...WORKSPACE_TOOLS].sort());
      const recall = request.messages.filter((message) =>
        JSON.stringify(message).includes('<recalled_user_context>')
      );
      expect(recall).toHaveLength(1);
      expect(JSON.stringify(recall)).toContain('Lin');
    }
    await session.close();
    const [info] = await SessionManager.list(harness.dataDir, join(harness.dataDir, 'sessions'));
    expect(await readFile(info!.path, 'utf8')).not.toContain('tachikoma-recalled-memory');
  } finally {
    settings.mockRestore();
    await harness.cleanup();
  }
});
