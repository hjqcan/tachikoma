/**
 * ChatEngine 测试 —— 全程 mock 模型，零网络
 *
 * 覆盖：流式事件顺序、会话持久化、历史窗口、mid-stream 中断、
 * 错误路径（不持久化半成品）、provider 解析、模型切换。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { ChatEngine, type ChatEvent, type ChatMemory, type ChatModelConfig } from '../src/chat';
import {
  ChatProviderError,
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

function makeV3Usage(input: number, output: number) {
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

/** 构造按序吐出 chunks 的 mock 模型 */
function streamingModel(chunks: string[], options: { chunkDelayInMs?: number } = {}) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          ...chunks.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: makeV3Usage(7, chunks.length),
          },
        ],
        ...(options.chunkDelayInMs !== undefined && {
          chunkDelayInMs: options.chunkDelayInMs,
        }),
      }),
    }),
  });
}

function failingModel(error: Error) {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw error;
    },
  });
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
  model: MockLanguageModelV3,
  overrides: Partial<ConstructorParameters<typeof ChatEngine>[0]> = {},
  memory?: ChatMemory
) {
  return new ChatEngine(
    { dataDir, model: TEST_MODEL_CONFIG, ...overrides },
    { modelFactory: () => model, ...(memory && { memory }) }
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
    const engine = makeEngine(streamingModel(['你好', '，', '世界']));
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '打个招呼'));

    expect(events[0]?.type).toBe('message_start');
    const deltas = events.filter((e) => e.type === 'message_delta');
    expect(deltas.map((d) => (d.type === 'message_delta' ? d.text : ''))).toEqual([
      '你好',
      '，',
      '世界',
    ]);
    const complete = events.at(-1);
    expect(complete?.type).toBe('message_complete');
    if (complete?.type === 'message_complete') {
      expect(complete.message.content).toBe('你好，世界');
      expect(complete.finishReason).toBe('stop');
      expect(complete.usage?.outputTokens).toBe(3);
      expect(complete.message.model).toBe('anthropic/claude-test');
    }
  });

  test('用户消息与助手消息都持久化到磁盘，标题取自首条消息', async () => {
    const engine = makeEngine(streamingModel(['answer']));
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, '第一条消息作为标题'));

    const raw = await readFile(join(dataDir, `${session.sessionId}.json`), 'utf-8');
    const persisted = JSON.parse(raw) as {
      title?: string;
      messages: { role: string; content: string }[];
    };
    expect(persisted.title).toBe('第一条消息作为标题');
    expect(persisted.messages).toHaveLength(2);
    expect(persisted.messages[0]?.role).toBe('user');
    expect(persisted.messages[1]?.role).toBe('assistant');
    expect(persisted.messages[1]?.content).toBe('answer');
  });

  test('多轮对话：第二轮请求携带完整历史', async () => {
    const model = streamingModel(['ok']);
    const engine = makeEngine(model);
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, '第一轮'));
    await collect(engine.sendMessage(session.sessionId, '第二轮'));

    expect(model.doStreamCalls).toHaveLength(2);
    const secondPrompt = model.doStreamCalls[1]?.prompt ?? [];
    // system + user1 + assistant1 + user2
    const roles = secondPrompt.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });

  test('历史窗口：超过 maxHistoryMessages 只携带最近 N 条', async () => {
    const model = streamingModel(['ok']);
    const engine = makeEngine(model, { maxHistoryMessages: 3 });
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, 'm1'));
    await collect(engine.sendMessage(session.sessionId, 'm2'));
    await collect(engine.sendMessage(session.sessionId, 'm3'));

    const lastPrompt = model.doStreamCalls.at(-1)?.prompt ?? [];
    // system + 最近 3 条（assistant(m2 回复), user(m3) … 取尾部 3 条非空消息）
    expect(lastPrompt.length).toBe(4);
    expect(lastPrompt[0]?.role).toBe('system');
  });

  test('会话不存在时抛错', async () => {
    const engine = makeEngine(streamingModel(['x']));
    await expect(collect(engine.sendMessage('chat-0-missing', 'hi'))).rejects.toThrow('会话不存在');
  });
});

// =============================================================================
// 中断
// =============================================================================

describe('ChatEngine 中断', () => {
  test('interrupt() 停止生成，半成品持久化并打 interrupted 标记', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `c${i} `);
    const engine = makeEngine(streamingModel(chunks, { chunkDelayInMs: 5 }));
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
    const assistant = persisted?.messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.interrupted).toBe(true);
  });

  test('无生成进行时 interrupt() 返回 false', async () => {
    const engine = makeEngine(streamingModel(['x']));
    const session = await engine.createSession();
    expect(engine.interrupt(session.sessionId)).toBe(false);
  });
});

// =============================================================================
// 错误路径
// =============================================================================

describe('ChatEngine 错误处理', () => {
  test('模型报错：产出 error 事件，用户消息保留、不持久化半成品助手消息', async () => {
    const engine = makeEngine(failingModel(new Error('boom')));
    const session = await engine.createSession();

    const events = await collect(engine.sendMessage(session.sessionId, '会失败的一条'));

    const errorEvt = events.at(-1);
    expect(errorEvt?.type).toBe('error');
    if (errorEvt?.type === 'error') {
      expect(errorEvt.error).toContain('boom');
      expect(errorEvt.retryable).toBe(false);
    }

    const persisted = await engine.openSession(session.sessionId);
    expect(persisted?.messages).toHaveLength(1);
    expect(persisted?.messages[0]?.role).toBe('user');
  });

  test('5xx/网络类错误标记为可重试', async () => {
    const err = new Error('Internal Server Error') as Error & { statusCode?: number };
    err.statusCode = 500;
    const engine = makeEngine(failingModel(err));
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
    const engine = makeEngine(streamingModel(['x']));
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
    const model = streamingModel(['好的']);
    const { memory, calls } = fakeMemory();
    const engine = makeEngine(model, {}, memory);
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

    const systemMessage = model.doStreamCalls[0]?.prompt[0];
    expect(systemMessage?.role).toBe('system');
    expect(String(systemMessage?.content)).toContain('[记忆] 用户偏好简洁回答');
  });

  test('完整回合结束后写入记忆（user + assistant）', async () => {
    const { memory, calls } = fakeMemory();
    const engine = makeEngine(streamingModel(['答案']), {}, memory);
    const session = await engine.createSession();

    await collect(engine.sendMessage(session.sessionId, '一个问题'));

    expect(calls.remembers).toHaveLength(1);
    expect(calls.remembers[0]?.user).toBe('一个问题');
    expect(calls.remembers[0]?.assistant).toBe('答案');
  });

  test('记忆后端故障时对话正常降级（hasContext=false，不中断）', async () => {
    const { memory } = fakeMemory({ failRecall: true });
    const engine = makeEngine(streamingModel(['仍然工作']), {}, memory);
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
    const engine = makeEngine(streamingModel(chunks, { chunkDelayInMs: 5 }), {}, memory);
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
  test('ANTHROPIC_API_KEY 优先解析为 anthropic + 默认模型', () => {
    const cfg = resolveChatModelConfig({ env: { ANTHROPIC_API_KEY: 'ak' } });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.apiKey).toBe('ak');
    expect(cfg.model.length).toBeGreaterThan(0);
  });

  test('OPENROUTER_API_KEY 解析为 openai-compatible + OpenRouter 端点', () => {
    const cfg = resolveChatModelConfig({
      env: { OPENROUTER_API_KEY: 'ok' },
      model: 'anthropic/claude-sonnet-4.5',
    });
    expect(cfg.provider).toBe('openai-compatible');
    expect(cfg.baseUrl).toBe(OPENROUTER_BASE_URL);
  });

  test('OPENAI_API_KEY 兜底解析为 openai', () => {
    const cfg = resolveChatModelConfig({ env: { OPENAI_API_KEY: 'sk' } });
    expect(cfg.provider).toBe('openai');
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

  test('openai-compatible 缺 model 时抛错', () => {
    expect(() =>
      resolveChatModelConfig({
        env: {},
        provider: 'openai-compatible',
        apiKey: 'k',
        baseUrl: 'https://openrouter.ai/api/v1',
      })
    ).toThrow(/model/);
  });

  test('未知 provider 抛错', () => {
    expect(() => resolveChatModelConfig({ provider: 'grok', env: {} })).toThrow(/未知 provider/);
  });
});
