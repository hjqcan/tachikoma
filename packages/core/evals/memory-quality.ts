/** Offline quality evidence, not a simulated model-accuracy benchmark. */
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent, ChatSession } from '../src';
import { createChatMemoryRuntime } from '../src/chat/memory';
import { createFauxHarness } from '../tests/helpers';
import cases from './memory-quality.cases.json';

interface QualityExpectation {
  profileName?: string | null;
  recallIncludes?: string[];
  recallExcludes?: string[];
  storedExcludes?: string[];
}
interface QualityCase {
  id: string;
  seed: string[];
  query: string;
  responses?: string[];
  timezone?: string;
  expect: QualityExpectation;
}

async function turn(session: ChatSession, text: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of session.send(text)) events.push(event);
  const complete = events.at(-1);
  if (complete?.type !== 'message_complete' || complete.status !== 'success') {
    throw new Error(`Synthetic turn failed: ${JSON.stringify(complete)}`);
  }
  const memoryEvents = events.filter((event) => event.type === 'memory_status');
  if (
    memoryEvents.some((event) => ['degraded', 'write-failed', 'disabled'].includes(event.status)) ||
    !memoryEvents.some(
      (event) => event.phase === 'recall' && ['empty', 'recalled'].includes(event.status)
    ) ||
    !memoryEvents.some((event) => event.phase === 'writeback' && event.status === 'ready')
  ) {
    throw new Error(`Memory pipeline did not complete: ${JSON.stringify(memoryEvents)}`);
  }
  return memoryEvents;
}

const results = [];
for (const scenario of cases as QualityCase[]) {
  const harness = await createFauxHarness();
  const contexts: Context['messages'][] = [];
  const sessions: ChatSession[] = [];
  try {
    const response = (text: string) => (context: Context) => {
      contexts.push(context.messages);
      return fauxAssistantMessage(text);
    };
    harness.faux.setResponses([
      ...scenario.seed.map((_, index) => response(scenario.responses?.[index] ?? '好的。')),
      response('Synthetic response; only memory input is evaluated.'),
    ]);
    const engine = new ChatEngine(
      {
        dataDir: harness.dataDir,
        model: { provider: harness.faux.provider.id, model: 'chat' },
        memory: {
          userId: 'synthetic-quality-user',
          ...(scenario.timezone ? { timezone: scenario.timezone } : {}),
        },
      },
      { modelRuntime: harness.modelRuntime }
    );
    const seed = await engine.createSession();
    sessions.push(seed);
    const seedEvents = [];
    for (const text of scenario.seed) seedEvents.push(await turn(seed, text));
    await seed.close();
    const memory = createChatMemoryRuntime({
      databasePath: seed.memoryStatus.databasePath!,
      userId: 'synthetic-quality-user',
    }).memory!;
    const exported = await memory.exportMemory({ scope: { userId: 'synthetic-quality-user' } });
    const stored = await engine.memoryList();
    const query = await engine.createSession();
    sessions.push(query);
    const queryEvents = await turn(query, scenario.query);
    const recallContext = (contexts.at(-1) ?? []).filter((message) =>
      JSON.stringify(message).includes('<recalled_user_context>')
    );
    const recall = JSON.stringify(recallContext);
    const storedText = JSON.stringify({ profile: exported.durable.profile, records: stored });
    const failures: string[] = [];
    const expected = scenario.expect;
    if (
      'profileName' in expected &&
      (exported.durable.profile?.identity.name ?? null) !== expected.profileName
    ) {
      failures.push(`profile.name must equal ${JSON.stringify(expected.profileName)}`);
    }
    for (const text of expected.recallIncludes ?? [])
      if (!recall.includes(text)) failures.push(`recall missing ${text}`);
    for (const text of expected.recallExcludes ?? [])
      if (recall.includes(text)) failures.push(`recall contains forbidden ${text}`);
    for (const text of expected.storedExcludes ?? [])
      if (storedText.includes(text)) failures.push(`storage contains forbidden ${text}`);
    results.push({
      ...scenario,
      pass: failures.length === 0,
      failures,
      stored,
      profile: exported.durable.profile,
      facts: exported.durable.facts,
      seedEvents,
      queryEvents,
      recallContext,
    });
    console.log(
      `${failures.length ? 'FAIL' : 'PASS'} ${scenario.id}${failures.length ? `: ${failures.join('; ')}` : ''}`
    );
  } finally {
    for (const session of sessions) await session.close();
    await harness.cleanup();
  }
}
const passed = results.filter((result) => result.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  provider: 'deterministic faux; no live model or judge',
  packageEntry: import.meta.resolve('goodmemory'),
  passed,
  total: results.length,
  results,
};
const output = process.env.TACHIKOMA_MEMORY_EVAL_OUTPUT;
if (output) {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path}`);
}
console.log(
  `${passed}/${results.length} memory expectations passed (chat success is not memory accuracy).`
);
process.exitCode = passed === results.length ? 0 : 1;
