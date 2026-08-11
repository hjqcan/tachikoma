/**
 * ChatEngine 测试 —— 全程 mock 模型，零网络
 *
 * 覆盖：流式事件顺序、会话持久化、历史窗口、mid-stream 中断、
 * 错误路径（不持久化半成品）、provider 解析、模型切换。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Context,
  type Message,
} from '@earendil-works/pi-ai';
import {
  ChatEngine,
  getChatSessionMessages,
  type ChatAgentRuntime,
  type ChatEvent,
  type ChatMemory,
  type ChatModelConfig,
} from '../src/chat';
import {
  ChatProviderError,
  createChatAgentRuntime,
  resolveChatModelConfig,
  OPENROUTER_BASE_URL,
} from '../src/chat/providers';
import { createGoodMemoryChatMemory, hasRecallHits, type GoodMemoryLike } from '../src/chat/memory';

// =============================================================================
// 测试辅助
// =============================================================================

const TEST_MODEL_CONFIG: ChatModelConfig = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'test-key',
};

interface RuntimeHarness extends ChatAgentRuntime {
  contexts: { systemPrompt: Context['systemPrompt']; messages: Message[] }[];
}

/** pi-ai 官方 faux provider：零网络，实际走 pi-agent-core 的流与工具循环。 */
function streamingRuntime(chunks: string[], options: { chunkDelayInMs?: number } = {}) {
  const faux = createFauxCore({
    provider: 'anthropic',
    models: [{ id: TEST_MODEL_CONFIG.model }],
    tokenSize: { min: 1, max: 1 },
    ...(options.chunkDelayInMs !== undefined && {
      tokensPerSecond: 1000 / options.chunkDelayInMs,
    }),
  });
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(chunks.join(''))));
  const contexts: RuntimeHarness['contexts'] = [];
  return {
    model: faux.getModel(),
    streamFn(model, context, streamOptions) {
      contexts.push({
        systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages),
      });
      return faux.streamSimple(model, context, streamOptions);
    },
    contexts,
  } satisfies RuntimeHarness;
}

function failingRuntime(error: Error): RuntimeHarness {
  const faux = createFauxCore({
    provider: 'anthropic',
    models: [{ id: TEST_MODEL_CONFIG.model }],
  });
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: 'error', errorMessage: error.message }),
  ]);
  const contexts: RuntimeHarness['contexts'] = [];
  return {
    model: faux.getModel(),
    streamFn(model, context, streamOptions) {
      contexts.push({
        systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages),
      });
      return faux.streamSimple(model, context, streamOptions);
    },
    contexts,
  };
}

async function collect(iter: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const evt of iter) events.push(evt);
  return events;
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tachikoma-chat-test-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeEngine(
  runtime: RuntimeHarness,
  overrides: Partial<ConstructorParameters<typeof ChatEngine>[0]> = {},
  memory?: ChatMemory
) {
  return new ChatEngine(
    { dataDir, model: TEST_MODEL_CONFIG, ...overrides },
    { runtimeFactory: () => runtime, ...(memory && { memory }) }
  );
}

function fakeMemory(options: { failRecall?: boolean } = {}) {
  const calls = {
    recalls: [] as string[],
    remembers: [] as { user: string; assistant: string }[],
  };
  const memory: ChatMemory = {
    async recallContext({ query }) {
      calls.recalls.push(query);
      if (options.failRecall) throw new Error('memory backend down');
      return { content: '[记忆] 用户偏好简洁回答', estimatedTokens: 12 };
    },
    async rememberTurn({ userMessage, assistantMessage }) {
      calls.remembers.push({ user: userMessage.content, assistant: assistantMessage.content });
    },
  };
  return { memory, calls };
}

// =============================================================================
// 流式与持久化
// =============================================================================

describe('ChatEngine 流式对话', () => {
  test('事件顺序：message_start → 逐 token delta → message_complete', async () => {
    const engine = makeEngine(streamingRuntime(['你好', '，', '世界']));
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '打个招呼'));

    expect(events[0]?.type).toBe('message_start');
    const deltas = events.filter((e) => e.type === 'message_delta');
    expect(deltas.map((d) => (d.type === 'message_delta' ? d.text : '')).join('')).toBe(
      '你好，世界'
    );
    const complete = events.at(-1);
    expect(complete?.type).toBe('message_complete');
    if (complete?.type === 'message_complete') {
      expect(complete.message.content).toBe('你好，世界');
      expect(complete.finishReason).toBe('stop');
      expect(complete.usage?.outputTokens).toBeGreaterThan(0);
      expect(complete.message.model).toBe('anthropic/claude-test');
    }
  });

  test('用户消息与助手消息都持久化到磁盘，标题取自首条消息', async () => {
    const engine = makeEngine(streamingRuntime(['answer']));
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, '第一条消息作为标题'));

    const raw = await readFile(join(dataDir, `${session.sessionId}.json`), 'utf-8');
    const persisted = JSON.parse(raw) as {
      title?: string;
      transcript: { message: Message }[];
    };
    expect(persisted.title).toBe('第一条消息作为标题');
    expect(persisted.transcript).toHaveLength(2);
    expect(persisted.transcript[0]?.message.role).toBe('user');
    expect(persisted.transcript[1]?.message.role).toBe('assistant');
    const assistant = persisted.transcript[1]?.message;
    expect(assistant?.role === 'assistant' ? assistant.content[0] : undefined).toEqual({
      type: 'text',
      text: 'answer',
    });
  });

  test('多轮对话：第二轮请求携带完整历史', async () => {
    const runtime = streamingRuntime(['ok']);
    const engine = makeEngine(runtime);
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, '第一轮'));
    await collect(engine.sendMessage(session.sessionId, '第二轮'));

    expect(runtime.contexts).toHaveLength(2);
    const secondPrompt = runtime.contexts[1]?.messages ?? [];
    const roles = secondPrompt.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });

  test('历史窗口：超过 maxHistoryMessages 只携带最近 N 条', async () => {
    const runtime = streamingRuntime(['ok']);
    const engine = makeEngine(runtime, { maxHistoryMessages: 3 });
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, 'm1'));
    await collect(engine.sendMessage(session.sessionId, 'm2'));
    await collect(engine.sendMessage(session.sessionId, 'm3'));

    const lastPrompt = runtime.contexts.at(-1)?.messages ?? [];
    expect(lastPrompt).toHaveLength(3);
    expect(lastPrompt.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('会话不存在时抛错', async () => {
    const engine = makeEngine(streamingRuntime(['x']));
    await expect(collect(engine.sendMessage('chat-0-missing', 'hi'))).rejects.toThrow('会话不存在');
  });
});

describe('ChatEngine pi-mono 工具循环', () => {
  test('read 调用由 pi 执行，callId 贯穿事件和可恢复 transcript', async () => {
    await writeFile(join(dataDir, 'note.txt'), 'pi-read-ok', 'utf-8');
    const faux = createFauxCore({
      provider: 'anthropic',
      models: [{ id: TEST_MODEL_CONFIG.model }],
      tokenSize: { min: 1, max: 1 },
    });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText('正在读取'), fauxToolCall('read', { path: 'note.txt' }, { id: 'call-read-1' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('读取完成'),
      fauxAssistantMessage('上下文仍然完整'),
    ]);
    const contexts: RuntimeHarness['contexts'] = [];
    const runtime: RuntimeHarness = {
      model: faux.getModel(),
      streamFn(model, context, options) {
        contexts.push({
          systemPrompt: context.systemPrompt,
          messages: structuredClone(context.messages),
        });
        return faux.streamSimple(model, context, options);
      },
      contexts,
    };
    const engine = makeEngine(runtime, { workDir: dataDir });
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '读取 note.txt'));
    const call = events.find((event) => event.type === 'tool_call');
    const result = events.find((event) => event.type === 'tool_result');
    expect(call?.type === 'tool_call' ? call.callId : undefined).toBe('call-read-1');
    expect(result?.type === 'tool_result' ? result.callId : undefined).toBe('call-read-1');
    expect(result?.type === 'tool_result' ? result.output : '').toContain('pi-read-ok');

    const persisted = await engine.openSession(session.sessionId);
    expect(persisted?.transcript.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    const toolResult = persisted?.transcript[2]?.message;
    expect(toolResult?.role === 'toolResult' ? toolResult.toolCallId : undefined).toBe(
      'call-read-1'
    );
    const projected = persisted ? getChatSessionMessages(persisted) : [];
    expect(projected.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(projected.at(-1)?.content).toBe('正在读取读取完成');

    const reloadedEngine = makeEngine(runtime, { workDir: dataDir });
    await collect(reloadedEngine.sendMessage(session.sessionId, '继续'));
    expect(runtime.contexts[2]?.messages.some((message) => message.role === 'toolResult')).toBe(
      true
    );
  });

  test('未知工具由 pi 生成唯一 error toolResult，并继续下一轮模型调用', async () => {
    const faux = createFauxCore({
      provider: 'anthropic',
      models: [{ id: TEST_MODEL_CONFIG.model }],
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('missing_tool', {}, { id: 'call-missing-1' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('已从工具错误中恢复'),
    ]);
    const contexts: RuntimeHarness['contexts'] = [];
    const runtime: RuntimeHarness = {
      model: faux.getModel(),
      streamFn(model, context, options) {
        contexts.push({
          systemPrompt: context.systemPrompt,
          messages: structuredClone(context.messages),
        });
        return faux.streamSimple(model, context, options);
      },
      contexts,
    };
    const engine = makeEngine(runtime, { workDir: dataDir });
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '调用不存在的工具'));
    const results = events.filter(
      (event) => event.type === 'tool_result' && event.callId === 'call-missing-1'
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.type === 'tool_result' ? results[0].isError : false).toBe(true);

    const persisted = await engine.openSession(session.sessionId);
    const toolResults = persisted?.transcript.filter(
      (entry) =>
        entry.message.role === 'toolResult' && entry.message.toolCallId === 'call-missing-1'
    );
    expect(toolResults).toHaveLength(1);
    expect(
      toolResults?.[0]?.message.role === 'toolResult' ? toolResults[0].message.isError : undefined
    ).toBe(true);
    expect(runtime.contexts[1]?.messages.some((message) => message.role === 'toolResult')).toBe(
      true
    );
  });
});

// =============================================================================
// 中断
// =============================================================================

describe('ChatEngine 中断', () => {
  test('interrupt() 停止生成，半成品持久化并打 interrupted 标记', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `c${i} `);
    const engine = makeEngine(streamingRuntime(chunks, { chunkDelayInMs: 5 }));
    const session = await engine.createSession();

    const events: ChatEvent[] = [];
    let interrupted = false;
    for await (const evt of engine.sendMessage(session.sessionId, 'go')) {
      events.push(evt);
      if (evt.type === 'message_delta' && !interrupted) {
        interrupted = true;
        expect(engine.interrupt(session.sessionId)).toBe(true);
      }
    }

    const complete = events.at(-1);
    expect(complete?.type).toBe('message_complete');
    if (complete?.type === 'message_complete') {
      expect(complete.finishReason).toBe('interrupted');
      expect(complete.message.interrupted).toBe(true);
      expect(complete.message.content.length).toBeGreaterThan(0);
      expect(complete.message.content.length).toBeLessThan(chunks.join('').length);
    }

    const persisted = await engine.openSession(session.sessionId);
    const assistant = persisted?.transcript.at(-1);
    expect(assistant?.message.role).toBe('assistant');
    expect(assistant?.interrupted).toBe(true);
  });

  test('无生成进行时 interrupt() 返回 false', async () => {
    const engine = makeEngine(streamingRuntime(['x']));
    const session = await engine.createSession();
    expect(engine.interrupt(session.sessionId)).toBe(false);
  });
});

// =============================================================================
// 错误路径
// =============================================================================

describe('ChatEngine 错误处理', () => {
  test('模型报错：产出 error 事件，用户消息保留、不持久化半成品助手消息', async () => {
    const engine = makeEngine(failingRuntime(new Error('boom')));
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '会失败的一条'));

    const errorEvt = events.at(-1);
    expect(errorEvt?.type).toBe('error');
    if (errorEvt?.type === 'error') {
      expect(errorEvt.error).toContain('boom');
      expect(errorEvt.retryable).toBe(false);
    }

    const persisted = await engine.openSession(session.sessionId);
    expect(persisted?.transcript).toHaveLength(1);
    expect(persisted?.transcript[0]?.message.role).toBe('user');
  });

  test('5xx/网络类错误标记为可重试', async () => {
    const engine = makeEngine(failingRuntime(new Error('500 Internal Server Error')));
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, 'hi'));
    const errorEvt = events.at(-1);
    if (errorEvt?.type === 'error') {
      expect(errorEvt.retryable).toBe(true);
    } else {
      throw new Error(`期望 error 事件，得到 ${errorEvt?.type}`);
    }
  });
});

// =============================================================================
// 模型切换
// =============================================================================

describe('ChatEngine 模型切换', () => {
  test('setModel 更新配置并同步到会话记录；切 provider 清掉旧 baseUrl', async () => {
    const engine = makeEngine(streamingRuntime(['x']));
    const session = await engine.createSession();

    await engine.setModel({ baseUrl: 'https://openrouter.ai/api/v1' });
    expect(engine.getModelConfig().baseUrl).toBe('https://openrouter.ai/api/v1');

    const updated = await engine.setModel(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'k2' },
      session.sessionId
    );
    expect(updated.provider).toBe('openai');
    expect(updated.baseUrl).toBeUndefined();

    const persisted = await engine.openSession(session.sessionId);
    expect(persisted?.provider).toBe('openai');
    expect(persisted?.model).toBe('gpt-4o');
  });
});

// =============================================================================
// 记忆层（GoodMemory 适配的 ChatMemory 接口）
// =============================================================================

describe('ChatEngine 记忆层', () => {
  test('回复前召回并注入 system prompt，发出 memory_recall 事件', async () => {
    const runtime = streamingRuntime(['好的']);
    const { memory, calls } = fakeMemory();
    const engine = makeEngine(runtime, {}, memory);
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '记得我喜欢什么吗'));

    expect(calls.recalls).toEqual(['记得我喜欢什么吗']);
    const recallEvt = events.find((e) => e.type === 'memory_recall');
    expect(recallEvt?.type).toBe('memory_recall');
    if (recallEvt?.type === 'memory_recall') {
      expect(recallEvt.hasContext).toBe(true);
      expect(recallEvt.estimatedTokens).toBe(12);
    }
    // memory_recall 必须先于 message_start
    expect(events.findIndex((e) => e.type === 'memory_recall')).toBeLessThan(
      events.findIndex((e) => e.type === 'message_start')
    );

    expect(runtime.contexts[0]?.systemPrompt).toContain('[记忆] 用户偏好简洁回答');
  });

  test('完整回合结束后写入记忆（user + assistant）', async () => {
    const { memory, calls } = fakeMemory();
    const engine = makeEngine(streamingRuntime(['答案']), {}, memory);
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, '一个问题'));

    expect(calls.remembers).toHaveLength(1);
    expect(calls.remembers[0]?.user).toBe('一个问题');
    expect(calls.remembers[0]?.assistant).toBe('答案');
  });

  test('记忆后端故障时对话正常降级（hasContext=false，不中断）', async () => {
    const { memory } = fakeMemory({ failRecall: true });
    const engine = makeEngine(streamingRuntime(['仍然工作']), {}, memory);
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, 'hi'));

    const recallEvt = events.find((e) => e.type === 'memory_recall');
    if (recallEvt?.type === 'memory_recall') {
      expect(recallEvt.hasContext).toBe(false);
    } else {
      throw new Error('缺少 memory_recall 事件');
    }
    const complete = events.at(-1);
    expect(complete?.type).toBe('message_complete');
    if (complete?.type === 'message_complete') {
      expect(complete.message.content).toBe('仍然工作');
    }
  });

  test('被中断的回合不写入记忆', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `x${i} `);
    const { memory, calls } = fakeMemory();
    const engine = makeEngine(streamingRuntime(chunks, { chunkDelayInMs: 5 }), {}, memory);
    const session = await engine.createSession();

    for await (const evt of engine.sendMessage(session.sessionId, 'go')) {
      if (evt.type === 'message_delta') engine.interrupt(session.sessionId);
    }

    expect(calls.remembers).toHaveLength(0);
  });
});

// =============================================================================
// GoodMemory 适配器
// =============================================================================

describe('createGoodMemoryChatMemory', () => {
  const emptyRecall = {
    preferences: [],
    facts: [],
    references: [],
    metadata: { hits: [] },
  };
  const hitRecall = {
    preferences: [],
    facts: [{ id: 'f1', content: '用户偏好中文' }],
    references: [],
    metadata: { hits: ['f1'] },
  };

  function fakeGoodMemory(recallResult: Record<string, unknown>) {
    const calls = { buildContext: 0, remember: [] as unknown[] };
    const gm: GoodMemoryLike = {
      async recall() {
        return recallResult;
      },
      async buildContext() {
        calls.buildContext += 1;
        return { content: '用户记忆上下文：\n用户偏好中文', estimatedTokens: 10 };
      },
      async remember(input) {
        calls.remember.push(input);
        return { accepted: 1 };
      },
    };
    return { gm, calls };
  }

  test('空库召回返回 null 且不调用 buildContext（避免注入空框架头）', async () => {
    const { gm, calls } = fakeGoodMemory(emptyRecall);
    const memory = createGoodMemoryChatMemory({ memory: gm, scope: { userId: 'u1' } });
    const ctx = await memory.recallContext({ sessionId: 's1', query: 'q' });
    expect(ctx).toBeNull();
    expect(calls.buildContext).toBe(0);
  });

  test('命中时返回片段内容', async () => {
    const { gm } = fakeGoodMemory(hitRecall);
    const memory = createGoodMemoryChatMemory({ memory: gm, scope: { userId: 'u1' } });
    const ctx = await memory.recallContext({ sessionId: 's1', query: 'q' });
    expect(ctx?.content).toContain('用户偏好中文');
    expect(ctx?.estimatedTokens).toBe(10);
  });

  test('rememberTurn 传递 user+assistant 消息与 scope.sessionId', async () => {
    const { gm, calls } = fakeGoodMemory(hitRecall);
    const memory = createGoodMemoryChatMemory({
      memory: gm,
      scope: { userId: 'u1', agentId: 'tachikoma-chat' },
    });
    const now = Date.now();
    await memory.rememberTurn({
      sessionId: 's9',
      userMessage: { id: 'a', role: 'user', content: '你好', createdAt: now },
      assistantMessage: { id: 'b', role: 'assistant', content: '你好！', createdAt: now },
    });
    expect(calls.remember).toHaveLength(1);
    const input = calls.remember[0] as {
      scope: { sessionId?: string; userId: string };
      messages: { role: string; content: string }[];
    };
    expect(input.scope.sessionId).toBe('s9');
    expect(input.scope.userId).toBe('u1');
    expect(input.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('hasRecallHits', () => {
  test('空桶 + 空 hits → false', () => {
    expect(hasRecallHits({ facts: [], preferences: [], metadata: { hits: [] } })).toBe(false);
  });
  test('任一桶非空 → true', () => {
    expect(hasRecallHits({ facts: [{ id: 'x' }], metadata: { hits: [] } })).toBe(true);
  });
  test('profile 对象非空 → true', () => {
    expect(hasRecallHits({ facts: [], profile: { name: 'hjqcan' } })).toBe(true);
  });
  test('metadata.hits 非空 → true', () => {
    expect(hasRecallHits({ metadata: { hits: ['m1'] } })).toBe(true);
  });
});

// =============================================================================
// Provider 解析
// =============================================================================

describe('resolveChatModelConfig', () => {
  test('OpenRouter 使用 pi catalog；任意兼容端点使用显式自定义模型', () => {
    const openRouter = createChatAgentRuntime({
      provider: 'openai-compatible',
      model: 'openai/gpt-4o',
      apiKey: 'k',
      baseUrl: `${OPENROUTER_BASE_URL}/`,
    });
    expect(openRouter.model.provider).toBe('openrouter');
    expect(openRouter.model.contextWindow).toBeGreaterThan(0);

    const custom = createChatAgentRuntime({
      provider: 'openai-compatible',
      model: 'local-model',
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    expect(custom.model.provider).toBe('tachikoma-openai-compatible');
    expect(custom.model.api).toBe('openai-completions');
  });

  test('内置 provider 的未知模型在发请求前失败', () => {
    expect(() =>
      createChatAgentRuntime({
        provider: 'openai',
        model: '__missing_model__',
        apiKey: 'not-used',
      })
    ).toThrow(/catalog/);
  });

  test('ANTHROPIC_API_KEY 优先解析为 anthropic + 默认模型', () => {
    const cfg = resolveChatModelConfig({ env: { ANTHROPIC_API_KEY: 'ak' } });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.apiKey).toBe('ak');
    expect(cfg.model.length).toBeGreaterThan(0);
  });

  test('OPENROUTER_API_KEY 解析为 openai-compatible + OpenRouter 端点和默认模型', () => {
    const cfg = resolveChatModelConfig({ env: { OPENROUTER_API_KEY: 'ok' } });
    expect(cfg.provider).toBe('openai-compatible');
    expect(cfg.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(cfg.model).toBe('openai/gpt-4o');
    expect(createChatAgentRuntime(cfg).model.provider).toBe('openrouter');
  });

  test('OPENAI_API_KEY 兜底解析为 openai', () => {
    const cfg = resolveChatModelConfig({ env: { OPENAI_API_KEY: 'sk' } });
    expect(cfg.provider).toBe('openai');
  });

  test('OPENAI_API_KEY + OPENAI_BASE_URL：自定义端点 + TACHIKOMA_CHAT_MODEL 默认模型', () => {
    const cfg = resolveChatModelConfig({
      env: {
        OPENAI_API_KEY: 'sk',
        OPENAI_BASE_URL: 'https://ai.example.com/v1',
        TACHIKOMA_CHAT_MODEL: 'my-model',
      },
    });
    expect(cfg.provider).toBe('openai');
    expect(cfg.baseUrl).toBe('https://ai.example.com/v1');
    expect(cfg.model).toBe('my-model');
  });

  test('显式 provider=openai 也能从 OPENAI_BASE_URL 取端点；显式 model 优先于环境默认', () => {
    const cfg = resolveChatModelConfig({
      provider: 'openai',
      model: 'explicit-model',
      env: {
        OPENAI_API_KEY: 'sk',
        OPENAI_BASE_URL: 'https://ai.example.com/v1',
        TACHIKOMA_CHAT_MODEL: 'env-model',
      },
    });
    expect(cfg.baseUrl).toBe('https://ai.example.com/v1');
    expect(cfg.model).toBe('explicit-model');
  });

  test('显式 baseUrl（未指明 provider）视为 openai-compatible', () => {
    const cfg = resolveChatModelConfig({
      env: {},
      apiKey: 'k',
      baseUrl: 'https://my-gateway.local/v1',
      model: 'm',
    });
    expect(cfg.provider).toBe('openai-compatible');
  });

  test('无凭证时抛出带指引的错误', () => {
    expect(() => resolveChatModelConfig({ env: {} })).toThrow(ChatProviderError);
  });

  test('任意 openai-compatible 端点缺 model 时抛错', () => {
    expect(() =>
      resolveChatModelConfig({
        env: {},
        provider: 'openai-compatible',
        apiKey: 'k',
        baseUrl: 'https://llm.example.com/v1',
      })
    ).toThrow(/model/);
  });

  test('未知 provider 抛错', () => {
    expect(() => resolveChatModelConfig({ provider: 'grok', env: {} })).toThrow(/未知 provider/);
  });
});
