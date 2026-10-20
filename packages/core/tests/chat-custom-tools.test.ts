import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'bun:test';
import { ChatEngine } from '../src';
import type { ChatEngineConfig, ChatEvent } from '../src';
import { createFauxHarness } from './helpers';

function capability(
  execute = async () => ({ content: [{ type: 'text' as const, text: 'host result' }], details: {} })
): ToolDefinition {
  return {
    name: 'host_lookup',
    label: 'Host lookup',
    description: 'Look up host data.',
    parameters: Type.Object({}),
    execute,
  };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const result: ChatEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('exclusive host custom tools', () => {
  it('executes only registered callbacks and emits the ordinary tool contract', async () => {
    const h = await createFauxHarness();
    let calls = 0;
    try {
      h.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('host_lookup', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ]);
      const tool = capability(async () => {
        calls++;
        return { content: [{ type: 'text', text: 'host result' }], details: {} };
      });
      const tools = [tool];
      const engine = new ChatEngine(
        {
          dataDir: h.dataDir,
          memory: false,
          model: { provider: h.faux.provider.id, model: 'chat' },
          customTools: tools,
        },
        { modelRuntime: h.modelRuntime }
      );
      tools.length = 0;
      tool.name = 'changed_after_construction';
      const session = await engine.createSession();
      try {
        expect(session.activeTools).toEqual(['host_lookup']);
        const events = await collect(session.send('lookup'));
        expect(calls).toBe(1);
        expect(events.some((e) => e.type === 'tool_call' && e.tool === 'host_lookup')).toBe(true);
        expect(
          events.some((e) => e.type === 'tool_result' && e.tool === 'host_lookup' && !e.isError)
        ).toBe(true);
      } finally {
        await session.close();
      }
      const reopened = await new ChatEngine(
        { dataDir: h.dataDir, memory: false },
        { modelRuntime: h.modelRuntime }
      ).openSession(session.id);
      if (!reopened) throw new Error('Session not found');
      try {
        expect(reopened.activeTools).toEqual([]);
      } finally {
        await reopened.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it('empty custom grant stays tool-free and rejects session workspace/skills', async () => {
    const h = await createFauxHarness();
    try {
      const engine = new ChatEngine(
        { dataDir: h.dataDir, memory: false, customTools: [] },
        { modelRuntime: h.modelRuntime }
      );
      const session = await engine.createSession();
      try {
        expect(session.activeTools).toEqual([]);
      } finally {
        await session.close();
      }
      await expect(engine.createSession({ workDir: h.dataDir })).rejects.toThrow(
        'cannot be combined'
      );
      await expect(engine.createSession({ skills: [h.dataDir] })).rejects.toThrow(
        'cannot be combined'
      );
    } finally {
      await h.cleanup();
    }
  });

  it('rejects duplicate, reserved, invalid and oversized allowlists and mixed grants', () => {
    for (const name of [
      'read',
      'write',
      'edit',
      'bash',
      'grep',
      'find',
      'ls',
      'powershell',
      'codemode',
      'tool_search',
      'Invalid',
      '',
      'a'.repeat(65),
    ]) {
      expect(
        () => new ChatEngine({ memory: false, customTools: [{ ...capability(), name }] })
      ).toThrow('Invalid');
    }
    expect(() => new ChatEngine({ customTools: [capability(), capability()] })).toThrow('Invalid');
    expect(
      () =>
        new ChatEngine({
          customTools: Array.from({ length: 17 }, (_, i) => ({
            ...capability(),
            name: `host_${i}`,
          })),
        })
    ).toThrow('Invalid');
    for (const config of [{ workDir: '/tmp' }, { skills: ['/tmp'] }]) {
      expect(() => new ChatEngine({ ...config, customTools: [] })).toThrow('cannot be combined');
    }
    const typedConfig: ChatEngineConfig = { customTools: Object.freeze([capability()]) };
    expect(() => new ChatEngine(typedConfig)).not.toThrow();
  });

  it('does not execute unknown built-ins, and preserves callback errors', async () => {
    const h = await createFauxHarness();
    let calls = 0;
    try {
      h.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo forbidden' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxToolCall('host_lookup', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ]);
      const session = await new ChatEngine(
        {
          dataDir: h.dataDir,
          memory: false,
          model: { provider: h.faux.provider.id, model: 'chat' },
          customTools: [
            capability(async () => {
              calls++;
              throw new Error('host refused');
            }),
          ],
        },
        { modelRuntime: h.modelRuntime }
      ).createSession();
      try {
        const events = await collect(session.send('lookup'));
        expect(calls).toBe(1);
        expect(session.activeTools).toEqual(['host_lookup']);
        expect(events.filter((e) => e.type === 'tool_result' && e.isError)).toHaveLength(2);
      } finally {
        await session.close();
      }
    } finally {
      await h.cleanup();
    }
  });
});
