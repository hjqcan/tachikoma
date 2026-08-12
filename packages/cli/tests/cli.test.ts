import { describe, expect, test } from 'bun:test';
import type {
  ChatEngineConfig,
  ChatEvent,
  ChatModelListing,
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
  workspace: { root: string; toolset: 'read-only' | 'coding'; tools: string[] } | null = null;
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

  approvals: { callId: string; approved: boolean; scope?: 'call' | 'session' }[] = [];

  respondToApproval(callId: string, approved: boolean, scope?: 'call' | 'session'): boolean {
    this.approvals.push({ callId, approved, ...(scope && scope !== 'call' ? { scope } : {}) });
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

  titleValue = '';

  rename(title: string): string {
    this.titleValue = title.trim();
    return this.titleValue;
  }
}

class FakeEngine implements ChatEnginePort {
  readonly created: FakeSession[] = [];
  readonly sessions = new Map<string, FakeSession>();
  createFailure: Error | undefined;
  private nextCreated: FakeSession | undefined;

  memoryRecords = [{ id: 'm1', type: 'fact', content: '喜欢等宽字体' }];
  forgottenIds: string[] = [];

  async memoryList() {
    return this.memoryRecords;
  }

  async memorySearch(query: string) {
    return this.memoryRecords
      .filter((record) => record.content.includes(query))
      .map((record) => ({ ...record, score: 0.87 }));
  }

  async memoryForget(memoryId: string) {
    this.forgottenIds.push(memoryId);
    return this.memoryRecords.some((record) => record.id === memoryId);
  }

  constructor(initial?: FakeSession) {
    if (initial) {
      this.nextCreated = initial;
      this.sessions.set(initial.id, initial);
    }
  }

  createInputs: unknown[] = [];

  async createSession(input?: {
    model?: ChatModelRef;
    thinkingLevel?: ChatThinkingLevel;
    title?: string;
    workDir?: string;
    toolset?: 'read-only' | 'coding';
  }): Promise<FakeSession> {
    if (this.createFailure) {
      const error = this.createFailure;
      this.createFailure = undefined;
      throw error;
    }
    this.createInputs.push(input);
    const session = this.nextCreated ?? new FakeSession(`session-${this.created.length + 1}`);
    this.nextCreated = undefined;
    if (input?.model) session.model = input.model;
    if (input?.thinkingLevel) session.thinkingLevel = input.thinkingLevel;
    if (input?.workDir) {
      const toolset = input.toolset ?? 'read-only';
      const tools =
        toolset === 'coding'
          ? ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash']
          : ['read', 'grep', 'find', 'ls'];
      session.workspace = { root: input.workDir, toolset, tools };
      session.activeTools = tools;
    }
    this.created.push(session);
    this.sessions.set(session.id, session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }

  models: ChatModelListing[] = [
    { provider: 'faux', model: 'test', reasoning: true },
    { provider: 'faux', model: 'plain', reasoning: false },
  ];

  async listModels(): Promise<ChatModelListing[]> {
    return this.models;
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
    question?: (prompt: string, options: { signal: AbortSignal }) => Promise<string>;
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
    ...(input.question ? { question: input.question } : {}),
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

  test('/models lists the catalog, marks reasoning and the active model', async () => {
    const session = new FakeSession();
    const harness = createHarness({
      engine: new FakeEngine(session),
      lines: ['/models', '/exit'],
    });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    const output = harness.stdout.join('');
    expect(output).toContain('faux/test  [reasoning] *');
    expect(output).toContain('faux/plain\n');
    expect(output).toContain('[models] 2 available');
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

  test('--allow grants listed tools; ungranted requests are denied immediately', async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'tool_approval_request',
        callId: 'call-w',
        tool: 'write',
        input: { path: 'a.txt' },
        timeoutMs: 120_000,
      } as ChatEvent,
      {
        ...baseEvent,
        type: 'tool_approval_request',
        callId: 'call-b',
        tool: 'bash',
        input: { command: 'ls' },
        timeoutMs: 120_000,
      } as ChatEvent,
      ...successEvents('done'),
    ];
    const harness = createHarness({ engine: new FakeEngine(session) });

    const code = await runCli(
      ['run', 'do it', '--workdir', '/tmp/ws', '--allow', 'write'],
      harness.dependencies
    );

    expect(code).toBe(0);
    expect(session.approvals).toEqual([
      { callId: 'call-w', approved: true },
      { callId: 'call-b', approved: false },
    ]);
    const stderr = harness.stderr.join('');
    expect(stderr).toContain('[approval:write] granted (--allow)');
    expect(stderr).toContain('[approval:bash] denied (add --allow bash to grant)');
  });

  test('--allow validates tool names and requires --workdir', async () => {
    const badName = createHarness();
    expect(
      await runCli(['run', 'x', '--workdir', '/w', '--allow', 'read'], badName.dependencies)
    ).toBe(2);
    expect(badName.stderr.join('')).toContain('--allow accepts write,edit,bash');

    const noWorkdir = createHarness();
    expect(await runCli(['run', 'x', '--allow', 'write'], noWorkdir.dependencies)).toBe(2);
    expect(noWorkdir.stderr.join('')).toContain('--allow requires --workdir');
  });

  test('--allow switches the engine to the coding toolset', async () => {
    let config: ChatEngineConfig | undefined;
    const harness = createHarness({
      onConfig: (received) => {
        config = received;
      },
    });

    await runCli(['run', 'x', '--workdir', '/w', '--allow', 'write,edit'], harness.dependencies);
    expect(config?.toolset).toBe('coding');

    let readOnlyConfig: ChatEngineConfig | undefined;
    const readOnly = createHarness({
      onConfig: (received) => {
        readOnlyConfig = received;
      },
    });
    await runCli(['run', 'x', '--workdir', '/w'], readOnly.dependencies);
    expect(readOnlyConfig?.toolset).toBeUndefined();
  });

  test('REPL asks y/N for ungranted approvals; y approves, other answers deny', async () => {
    function approvalEvents(): ChatEvent[] {
      return [
        {
          ...baseEvent,
          type: 'tool_approval_request',
          callId: 'call-1',
          tool: 'write',
          input: { path: 'a.txt', content: 'hi' },
          timeoutMs: 120_000,
        } as ChatEvent,
        {
          ...baseEvent,
          type: 'tool_approval_request',
          callId: 'call-2',
          tool: 'bash',
          input: { command: 'rm -rf /' },
          timeoutMs: 120_000,
        } as ChatEvent,
        ...successEvents('done'),
      ];
    }
    const session = new FakeSession();
    session.events = approvalEvents();
    const answers = ['y', 'no way'];
    const prompts: string[] = [];
    const harness = createHarness({
      engine: new FakeEngine(session),
      lines: ['please write', '/exit'],
      question: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answers[prompts.length - 1] ?? '');
      },
    });

    const code = await runCli(['--workdir', '/w', '--toolset', 'coding'], harness.dependencies);

    expect(code).toBe(0);
    expect(session.approvals).toEqual([
      { callId: 'call-1', approved: true },
      { callId: 'call-2', approved: false },
    ]);
    expect(prompts).toEqual([
      'approve write? [y/N/a=always this session] ',
      'approve bash? [y/N/a=always this session] ',
    ]);
    const stderr = harness.stderr.join('');
    // write 走结构化预览（路径 + 内容），非 write/edit 形状回退 JSON
    expect(stderr).toContain('[approval:write]\na.txt\nhi');
    expect(stderr).toContain('"command": "rm -rf /"');
  });

  test("answering 'a' approves with session scope and reports it", async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'tool_approval_request',
        callId: 'call-a',
        tool: 'bash',
        input: { command: 'bun test' },
        timeoutMs: 120_000,
      } as ChatEvent,
      ...successEvents('ran'),
    ];
    const harness = createHarness({
      engine: new FakeEngine(session),
      lines: ['run tests', '/exit'],
      question: () => Promise.resolve('a'),
    });

    const code = await runCli(['--workdir', '/w', '--toolset', 'coding'], harness.dependencies);

    expect(code).toBe(0);
    expect(session.approvals).toEqual([{ callId: 'call-a', approved: true, scope: 'session' }]);
    expect(harness.stderr.join('')).toContain(
      '[approval:bash] approved for the rest of this session'
    );
  });

  test('core-resolved approvals (timeout) cancel the pending question and free the input', async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'tool_approval_request',
        callId: 'call-t',
        tool: 'bash',
        input: { command: 'sleep 999' },
        timeoutMs: 50,
      } as ChatEvent,
      {
        ...baseEvent,
        type: 'tool_approval_resolved',
        callId: 'call-t',
        approved: false,
        reason: 'timeout',
      } as ChatEvent,
      ...successEvents('gave up'),
    ];
    let questionAborted = false;
    const harness = createHarness({
      engine: new FakeEngine(session),
      lines: ['try it', '/exit'],
      question: (_prompt, options) =>
        new Promise<string>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            questionAborted = true;
            reject(Object.assign(new Error('canceled'), { name: 'AbortError' }));
          });
        }),
    });

    const code = await runCli(['--workdir', '/w', '--toolset', 'coding'], harness.dependencies);

    expect(code).toBe(0);
    expect(questionAborted).toBeTrue();
    expect(session.approvals).toEqual([]);
    expect(harness.stderr.join('')).toContain('[approval] timed out — denied');
  });

  test('tool_update partials stream once as suffix chunks, then the result summary', async () => {
    const session = new FakeSession();
    session.events = [
      {
        ...baseEvent,
        type: 'tool_call',
        callId: 'call-s',
        tool: 'bash',
        input: { command: 'make' },
      } as ChatEvent,
      {
        ...baseEvent,
        type: 'tool_update',
        callId: 'call-s',
        tool: 'bash',
        output: 'compiling…\n',
      } as ChatEvent,
      {
        ...baseEvent,
        type: 'tool_update',
        callId: 'call-s',
        tool: 'bash',
        output: 'compiling…\nlinking…',
      } as ChatEvent,
      {
        ...baseEvent,
        type: 'tool_result',
        callId: 'call-s',
        tool: 'bash',
        output: 'compiling…\nlinking…',
        isError: false,
      } as ChatEvent,
      ...successEvents('built'),
    ];
    const harness = createHarness({ engine: new FakeEngine(session) });

    const code = await runCli(['run', 'build it', '--workdir', '/w'], harness.dependencies);

    expect(code).toBe(0);
    const stderr = harness.stderr.join('');
    expect(stderr).toContain('compiling…\nlinking…\n[tool:bash] ok');
    expect(stderr.split('compiling…').length).toBe(2);
    expect(stderr.split('linking…').length).toBe(2);
  });

  test('--toolset coding enables approvals without pre-granting; requires --workdir', async () => {
    let config: ChatEngineConfig | undefined;
    const harness = createHarness({
      onConfig: (received) => {
        config = received;
      },
    });
    await runCli(['run', 'x', '--workdir', '/w', '--toolset', 'coding'], harness.dependencies);
    expect(config?.toolset).toBe('coding');

    const missing = createHarness();
    expect(await runCli(['run', 'x', '--toolset', 'coding'], missing.dependencies)).toBe(2);
    expect(missing.stderr.join('')).toContain('--toolset requires --workdir');

    const invalid = createHarness();
    expect(
      await runCli(['run', 'x', '--workdir', '/w', '--toolset', 'sudo'], invalid.dependencies)
    ).toBe(2);
    expect(invalid.stderr.join('')).toContain('--toolset accepts read-only|coding');
  });

  test('/delete removes a session; deleting the active one swaps to a fresh session', async () => {
    const old = new FakeSession('old');
    const engine = new FakeEngine(old);
    const harness = createHarness({
      engine,
      lines: ['/delete missing', '/delete old', '/exit'],
    });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    const output = harness.stdout.join('');
    expect(output).toContain('[delete] not found: missing');
    expect(output).toContain('[deleted] old');
    // 删除的是当前会话：自动接续一个新会话
    expect(engine.created.length).toBeGreaterThanOrEqual(2);
    expect(engine.sessions.has('old')).toBeFalse();

    const usage = createHarness({ lines: ['/delete', '/exit'] });
    await runCli([], usage.dependencies);
    expect(usage.stderr.join('')).toContain('Use /delete <session-id>');
  });

  test('/memory list|search|forget manage the durable store', async () => {
    const engine = new FakeEngine();
    const harness = createHarness({
      engine,
      lines: ['/memory list', '/memory search 等宽', '/memory forget m1', '/memory bogus', '/exit'],
    });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    const output = harness.stdout.join('');
    expect(output).toContain('m1  [fact] 喜欢等宽字体');
    expect(output).toContain('(0.87) 喜欢等宽字体');
    expect(output).toContain('[forgotten] m1');
    expect(engine.forgottenIds).toEqual(['m1']);
    expect(harness.stderr.join('')).toContain('/memory [list | search <query> | forget <id>]');
  });

  test('/rename renames the active session and rejects empty titles', async () => {
    const session = new FakeSession('s1');
    const engine = new FakeEngine(session);
    const harness = createHarness({ engine, lines: ['/rename 新标题', '/rename', '/exit'] });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    expect(harness.stdout.join('')).toContain('[renamed] 新标题');
    expect(session.titleValue).toBe('新标题');
    expect(harness.stderr.join('')).toContain('Use /rename <title>');
  });

  test('/workspace grants at runtime via a new session, shows state, and revokes with off', async () => {
    const engine = new FakeEngine();
    const harness = createHarness({
      engine,
      lines: ['/workspace', '/workspace /tmp/ws coding', '/workspace', '/workspace off', '/exit'],
    });

    const code = await runCli([], harness.dependencies);

    expect(code).toBe(0);
    const output = harness.stdout.join('');
    expect(output).toContain('[workspace] none');
    expect(output).toContain(
      '[workspace] /tmp/ws (coding: read, grep, find, ls, write, edit, bash)'
    );
    expect(engine.createInputs.at(1)).toMatchObject({ workDir: '/tmp/ws', toolset: 'coding' });
    // /workspace off 开的新会话不带授予
    const last = engine.createInputs.at(-1) as { workDir?: string };
    expect(last.workDir).toBeUndefined();
    // 旧会话随切换关闭：初始 + 两次切换 = 3 个会话，前两个已 close
    expect(engine.created).toHaveLength(3);
    expect(engine.created[0]?.closeCount).toBe(1);
    expect(engine.created[1]?.closeCount).toBe(1);

    const invalid = createHarness({ lines: ['/workspace /tmp/x sudo', '/exit'] });
    await runCli([], invalid.dependencies);
    expect(invalid.stderr.join('')).toContain('/workspace <dir> [read-only|coding]');
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
