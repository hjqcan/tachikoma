import { describe, expect, test } from 'bun:test';
import type {
  ChatEngineConfig,
  ChatEvent,
  ChatModelRef,
  ChatSessionSummary,
  ChatThinkingLevel,
} from '@tachikoma/core';
import {
  VERSION,
  runCli,
  type ChatEnginePort,
  type ChatSessionPort,
  type CliDependencies,
  type CliTerminal,
} from '../src/index.js';

const baseEvent = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  timestamp: 1,
};

function successEvents(text = 'hello'): ChatEvent[] {
  return [
    { ...baseEvent, type: 'message_start', messageId: 'message-1' } as ChatEvent,
    { ...baseEvent, type: 'message_delta', messageId: 'message-1', text } as ChatEvent,
    {
      ...baseEvent,
      type: 'message_complete',
      messageId: 'message-1',
      status: 'success',
      content: text,
      model: { provider: 'faux', model: 'test' },
      stopReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as ChatEvent,
  ];
}

class FakeSession implements ChatSessionPort {
  readonly id: string;
  model: ChatModelRef = { provider: 'faux', model: 'test' };
  thinkingLevel: ChatThinkingLevel = 'medium';
  memoryStatus = { enabled: true, status: 'ready' } as const;
  activeTools: readonly string[] = [];
  abortCount = 0;
  closeCount = 0;
  compactCount = 0;
  beforeSend?: () => void;
  events: ChatEvent[] = successEvents();

  constructor(id = 'session-1') {
    this.id = id;
  }

  async abort(): Promise<boolean> {
    this.abortCount += 1;
    return true;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  async compact(): Promise<unknown> {
    this.compactCount += 1;
    return {};
  }

  async *send(): AsyncGenerator<ChatEvent> {
    this.beforeSend?.();
    for (const event of this.events) yield event;
  }

  async setModel(model: ChatModelRef): Promise<ChatModelRef> {
    this.model = model;
    return model;
  }

  setThinkingLevel(level: ChatThinkingLevel): ChatThinkingLevel {
    this.thinkingLevel = level;
    return level;
  }
}

class FakeEngine implements ChatEnginePort {
  readonly created: FakeSession[] = [];
  readonly sessions = new Map<string, FakeSession>();
  createFailure: Error | undefined;
  private nextCreated: FakeSession | undefined;

  constructor(initial?: FakeSession) {
    if (initial) {
      this.nextCreated = initial;
      this.sessions.set(initial.id, initial);
    }
  }

  async createSession(input?: {
    model?: ChatModelRef;
    thinkingLevel?: ChatThinkingLevel;
    title?: string;
  }): Promise<FakeSession> {
    if (this.createFailure) {
      const error = this.createFailure;
      this.createFailure = undefined;
      throw error;
    }
    const session = this.nextCreated ?? new FakeSession(`session-${this.created.length + 1}`);
    this.nextCreated = undefined;
    if (input?.model) session.model = input.model;
    if (input?.thinkingLevel) session.thinkingLevel = input.thinkingLevel;
    this.created.push(session);
    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 2,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      status: 'ready',
    }));
  }

  async openSession(sessionId: string): Promise<FakeSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }
}

function lines(values: readonly string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

function createHarness(
  input: {
    engine?: FakeEngine;
    interruptOnPrompt?: boolean;
    lines?: readonly string[];
    onConfig?: (config: ChatEngineConfig) => void;
  } = {}
): {
  dependencies: Partial<CliDependencies>;
  engine: FakeEngine;
  interrupt(): void;
  stderr: string[];
  stdout: string[];
} {
  const engine = input.engine ?? new FakeEngine();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let interruptHandler: (() => void) | undefined;
  const terminal: CliTerminal = {
    lines: lines(input.lines ?? []),
    close: () => undefined,
    onInterrupt: (handler) => {
      interruptHandler = handler;
      return () => {
        interruptHandler = undefined;
      };
    },
    prompt: () => {
      if (input.interruptOnPrompt) {
        input.interruptOnPrompt = false;
        interruptHandler?.();
      }
    },
  };

  return {
    dependencies: {
      createEngine: (config) => {
        input.onConfig?.(config);
        return engine;
      },
      createTerminal: () => terminal,
      env: {},
      onInterrupt: (handler) => {
        interruptHandler = handler;
        return () => {
          interruptHandler = undefined;
        };
      },
      write: (text) => stdout.push(text),
      writeError: (text) => stderr.push(text),
    },
    engine,
    interrupt: () => interruptHandler?.(),
    stderr,
    stdout,
  };
}

describe('runCli', () => {
  test('--workdir flows into the engine config; no env fallback exists', async () => {
    let config: ChatEngineConfig | undefined;
    const harness = createHarness({
      onConfig: (received) => {
        config = received;
      },
    });
    harness.dependencies.env = { TACHIKOMA_WORKDIR: '/should/be/ignored' };

    const code = await runCli(['run', 'hi', '--workdir', '/tmp/workspace'], harness.dependencies);

    expect(code).toBe(0);
    expect(config?.workDir).toBe('/tmp/workspace');

    let secondConfig: ChatEngineConfig | undefined;
    const withoutFlag = createHarness({
      onConfig: (received) => {
        secondConfig = received;
      },
    });
    withoutFlag.dependencies.env = { TACHIKOMA_WORKDIR: '/should/be/ignored' };
    await runCli(['run', 'hi'], withoutFlag.dependencies);
    expect(secondConfig?.workDir).toBeUndefined();
  });

  test('renders tool_call and tool_result on stderr, keeping stdout as the answer', async () => {
    const session = new FakeSession();
    session.activeTools = ['read', 'grep', 'find', 'ls'];
    session.events = [
      {
        ...baseEvent,
        type: 'tool_call',
        callId: 'call-1',
        tool: 'read',
        input: { path: 'hello.txt' },
      } as ChatEvent,
      {
        ...baseEvent,
        type: 'tool_result',
        callId: 'call-1',
        tool: 'read',
        output: 'TOOL_MARKER',
        isError: false,
      } as ChatEvent,
      ...successEvents('answer with TOOL_MARKER'),
    ];
    const harness = createHarness({ engine: new FakeEngine(session) });

    const code = await runCli(['run', 'question'], harness.dependencies);

    expect(code).toBe(0);
    const stderr = harness.stderr.join('');
    expect(stderr).toContain('[tool:read] {"path":"hello.txt"}');
    expect(stderr).toContain('[tool:read] ok (11 chars)');
    expect(harness.stdout.join('')).toContain('answer with TOOL_MARKER');
    expect(harness.stdout.join('')).not.toContain('[tool:');
  });

  test('blocked tool results render as errors with the guard reason', async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'tool_result',
        callId: 'call-1',
        tool: 'read',
        output: 'Path is outside the workspace: ../secret\nmore detail',
        isError: true,
      } as ChatEvent,
      ...successEvents('adjusted'),
    ];
    const harness = createHarness({ engine: new FakeEngine(session) });

    await runCli(['run', 'question'], harness.dependencies);

    expect(harness.stderr.join('')).toContain(
      '[tool:read] error: Path is outside the workspace: ../secret'
    );
  });

  test('/tools reports active tools and the startup banner lists them', async () => {
    const session = new FakeSession();
    session.activeTools = ['read', 'grep', 'find', 'ls'];
    const harness = createHarness({
      engine: new FakeEngine(session),
      lines: ['/tools', '/exit'],
    });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    const output = harness.stdout.join('');
    expect(output).toContain('[tools] read, grep, find, ls');
  });

  test('runs one-shot chat through the same session surface and reports memory degradation', async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'memory_status',
        phase: 'recall',
        status: 'degraded',
        error: 'database unavailable',
      } as ChatEvent,
      ...successEvents('answer'),
    ];
    const harness = createHarness({ engine: new FakeEngine(session) });

    const code = await runCli(['run', 'question'], harness.dependencies);

    expect(code).toBe(0);
    expect(harness.stdout.join('')).toContain('answer');
    expect(harness.stderr.join('')).toContain('[memory:recall] degraded: database unavailable');
    expect(session.closeCount).toBe(1);
  });

  test('uses the default command for the REPL and handles session controls', async () => {
    const old = new FakeSession('old');
    const engine = new FakeEngine(old);
    const harness = createHarness({
      engine,
      lines: [
        '/sessions',
        '/resume old',
        '/model openrouter/anthropic/claude-sonnet-4',
        '/thinking high',
        '/compact keep decisions',
        '/memory',
        '/new',
        '/exit',
      ],
    });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    const output = harness.stdout.join('');
    expect(output).toContain('old  faux/test  2 messages');
    expect(output).toContain('[model] openrouter/anthropic/claude-sonnet-4');
    expect(output).toContain('[thinking] high');
    expect(output).toContain('[compaction] complete');
    expect(output).toContain('[memory] ready');
    expect(old.closeCount).toBe(1);
  });

  test('disables memory only through --no-memory and never accepts API-key flags', async () => {
    let config: ChatEngineConfig | undefined;
    const harness = createHarness({ lines: ['/exit'], onConfig: (value) => (config = value) });
    harness.dependencies.env = { TACHIKOMA_DATA_DIR: '/tmp/tachikoma-test-data' };

    expect(await runCli(['chat', '--no-memory'], harness.dependencies)).toBe(0);
    expect(config?.memory).toBe(false);
    expect(config?.dataDir).toBe('/tmp/tachikoma-test-data');

    const rejected = createHarness();
    expect(await runCli(['run', '--api-key', 'secret', 'hello'], rejected.dependencies)).toBe(2);
    expect(rejected.stderr.join('')).toContain('Unknown option: --api-key');
  });

  test('returns usage and runtime exit codes', async () => {
    const missing = createHarness();
    expect(await runCli(['run'], missing.dependencies)).toBe(2);

    const failedSession = new FakeSession();
    failedSession.events = [
      {
        ...baseEvent,
        type: 'message_complete',
        messageId: 'message-1',
        status: 'failed',
        content: '',
        model: failedSession.model,
        stopReason: 'error',
        error: 'provider failed',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as ChatEvent,
    ];
    const failed = createHarness({ engine: new FakeEngine(failedSession) });
    expect(await runCli(['run', 'hello'], failed.dependencies)).toBe(1);
  });

  test('aborts a one-shot turn and returns 130 on SIGINT', async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'message_complete',
        messageId: 'message-1',
        status: 'interrupted',
        content: '',
        model: session.model,
        stopReason: 'aborted',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as ChatEvent,
    ];
    const harness = createHarness({ engine: new FakeEngine(session) });
    session.beforeSend = harness.interrupt;

    expect(await runCli(['run', 'hello'], harness.dependencies)).toBe(130);
    expect(session.abortCount).toBe(1);
  });

  test('returns 130 and closes an idle REPL session on SIGINT', async () => {
    const session = new FakeSession();
    const harness = createHarness({
      engine: new FakeEngine(session),
      interruptOnPrompt: true,
    });

    expect(await runCli([], harness.dependencies)).toBe(130);
    expect(session.closeCount).toBe(1);
  });

  test('keeps the current session usable when /new creation fails', async () => {
    const session = new FakeSession('current');
    const engine = new FakeEngine(session);
    engine.createFailure = new Error('cannot create session');
    const harness = createHarness({ engine, lines: ['/new', '/model', '/exit'] });

    expect(await runCli(['chat', '--resume', 'current'], harness.dependencies)).toBe(0);
    expect(harness.stderr.join('')).toContain('cannot create session');
    expect(harness.stdout.join('')).toContain('[model] faux/test');
    expect(session.closeCount).toBe(1);
  });

  test('prints help and version without creating a runtime', async () => {
    let created = false;
    const harness = createHarness({ onConfig: () => (created = true) });

    expect(await runCli(['--help'], harness.dependencies)).toBe(0);
    expect(await runCli(['--version'], harness.dependencies)).toBe(0);
    expect(created).toBe(false);
    expect(harness.stdout.join('')).toContain(`Tachikoma ${VERSION}`);
  });
});
