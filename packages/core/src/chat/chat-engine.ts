/**
 * ChatEngine —— 螺旋第一圈的核心
 *
 * 直连流式对话引擎：user message → streamText → token 流。
 * 不经过 planner/orchestrator/worker，没有任务分解，没有文件轮询。
 *
 * 设计约束：
 * - token 级流式是主输出（message_delta），不是事后补的。
 * - 中断是一等操作：interrupt() 立即停止生成，已产出的部分持久化并打 interrupted 标记。
 * - Provider 可注入（modelFactory），测试用 mock 模型零网络运行。
 * - 会话先落盘再生成：用户消息在请求发出前已持久化，崩溃不丢输入。
 * - 后续圈层（工具调用/协调）在此之上增量扩展，不推翻本层接口。
 */

import { streamText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { createChatModel } from './providers';
import { buildChatSystemPrompt } from './system-prompt';
import { ChatSessionStore } from './session-store';
import type { ChatMemory } from './memory';
import type {
  ChatEngineConfig,
  ChatErrorEvent,
  ChatEvent,
  ChatFinishReason,
  ChatMessage,
  ChatModelConfig,
  ChatSessionState,
  ChatSessionSummary,
  ChatUsage,
} from './types';

const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const TITLE_MAX_LENGTH = 60;

export type ChatModelFactory = (config: ChatModelConfig) => LanguageModel;

export interface SendMessageOptions {
  /** 外部取消信号（如 CLI 的 Ctrl+C、桌面端窗口关闭） */
  signal?: AbortSignal;
}

export interface ChatEngineOptions {
  /** 测试注入点：给定配置返回模型实例，默认 createChatModel */
  modelFactory?: ChatModelFactory;
  /** 持久记忆层（GoodMemory 适配见 ./memory）；缺省无记忆 */
  memory?: ChatMemory;
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH)}…`
    : firstLine;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /abort/i.test(error.message);
}

/** 与 planner/llm-client 的重试语义保持一致的轻量分类（该模块未导出其内部判断） */
function isRetryableChatError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const statusCode = (error as { statusCode?: number }).statusCode ?? 0;
  if (statusCode >= 500 || statusCode === 429) return true;
  const message = error.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('socket connection was closed') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('econnrefused')
  );
}

function normalizeFinishReason(reason: string): ChatFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content-filter';
    default:
      return 'other';
  }
}

function normalizeUsage(raw: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): ChatUsage | undefined {
  const usage: ChatUsage = {
    ...(typeof raw.inputTokens === 'number' && { inputTokens: raw.inputTokens }),
    ...(typeof raw.outputTokens === 'number' && { outputTokens: raw.outputTokens }),
    ...(typeof raw.totalTokens === 'number' && { totalTokens: raw.totalTokens }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export class ChatEngine {
  private readonly store: ChatSessionStore;
  private modelConfig: ChatModelConfig;
  private readonly systemPrompt: string;
  private readonly maxHistoryMessages: number;
  private readonly temperature: number | undefined;
  private readonly maxOutputTokens: number | undefined;
  private readonly modelFactory: ChatModelFactory;
  private readonly memory: ChatMemory | undefined;
  private readonly activeGenerations = new Map<string, AbortController>();

  constructor(config: ChatEngineConfig, options: ChatEngineOptions = {}) {
    this.store = new ChatSessionStore(config.dataDir);
    this.modelConfig = { ...config.model };
    this.systemPrompt = config.systemPrompt ?? buildChatSystemPrompt();
    this.maxHistoryMessages = config.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    this.temperature = config.temperature;
    this.maxOutputTokens = config.maxOutputTokens;
    this.modelFactory = options.modelFactory ?? createChatModel;
    this.memory = options.memory;
  }

  getModelConfig(): ChatModelConfig {
    return { ...this.modelConfig };
  }

  /**
   * 更新当前模型配置（可选同步到某个会话的记录）。
   * 切换 provider 且未显式给 baseUrl 时会清掉旧 baseUrl，避免把
   * OpenRouter 的端点错带到 anthropic 上。
   */
  async setModel(update: Partial<ChatModelConfig>, sessionId?: string): Promise<ChatModelConfig> {
    const next: ChatModelConfig = { ...this.modelConfig };
    if (update.provider !== undefined && update.provider !== next.provider) {
      next.provider = update.provider;
      delete next.baseUrl;
    }
    if (update.model !== undefined) next.model = update.model;
    if (update.apiKey !== undefined) next.apiKey = update.apiKey;
    if (update.baseUrl !== undefined) next.baseUrl = update.baseUrl;
    this.modelConfig = next;

    if (sessionId) {
      const session = await this.store.load(sessionId);
      if (session) {
        session.provider = next.provider;
        session.model = next.model;
        session.updatedAt = Date.now();
        await this.store.save(session);
      }
    }
    return this.getModelConfig();
  }

  async createSession(init: { title?: string } = {}): Promise<ChatSessionState> {
    return this.store.create({
      provider: this.modelConfig.provider,
      model: this.modelConfig.model,
      ...(init.title && { title: init.title }),
    });
  }

  async openSession(sessionId: string): Promise<ChatSessionState | null> {
    return this.store.load(sessionId);
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    return this.store.list();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
  }

  /** 中断某会话正在进行的生成；返回是否确有生成被中断 */
  interrupt(sessionId: string): boolean {
    const controller = this.activeGenerations.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async *sendMessage(
    sessionId: string,
    text: string,
    options: SendMessageOptions = {}
  ): AsyncGenerator<ChatEvent> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    if (this.activeGenerations.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 已有生成在进行中`);
    }

    // 1. 用户消息先落盘（请求发出前已持久，崩溃不丢输入）
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      createdAt: now,
    };
    session.messages.push(userMessage);
    if (!session.title) {
      const title = deriveTitle(text);
      if (title) session.title = title;
    }
    session.provider = this.modelConfig.provider;
    session.model = this.modelConfig.model;
    session.updatedAt = now;
    await this.store.save(session);

    // 2. 取消信号：外部 signal 与本会话 interrupt() 汇聚到一个 controller
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    this.activeGenerations.set(sessionId, controller);

    // 记忆召回（recall-before-reply）：命中则注入本次 system prompt。
    // 记忆层失败绝不影响对话——降级为无记忆继续。
    let effectiveSystemPrompt = this.systemPrompt;
    if (this.memory) {
      let recalled: { content: string; estimatedTokens?: number } | null = null;
      try {
        recalled = await this.memory.recallContext({ sessionId, query: text });
      } catch {
        recalled = null;
      }
      if (recalled) {
        effectiveSystemPrompt = `${this.systemPrompt}\n\n${recalled.content}`;
      }
      yield {
        type: 'memory_recall',
        hasContext: recalled !== null,
        ...(recalled?.estimatedTokens !== undefined && {
          estimatedTokens: recalled.estimatedTokens,
        }),
        timestamp: Date.now(),
      };
    }

    const assistantId = randomUUID();
    const modelLabel = `${this.modelConfig.provider}/${this.modelConfig.model}`;
    let accumulated = '';
    let finishReason: ChatFinishReason = 'stop';
    let usage: ChatUsage | undefined;
    let errorEvent: ChatErrorEvent | undefined;

    yield { type: 'message_start', messageId: assistantId, timestamp: Date.now() };

    try {
      const result = streamText({
        model: this.modelFactory(this.modelConfig),
        system: effectiveSystemPrompt,
        messages: this.buildModelMessages(session),
        abortSignal: controller.signal,
        // 错误经 fullStream 的 error 部件显式处理，屏蔽 SDK 默认的 console 输出
        onError: () => undefined,
        ...(this.temperature !== undefined && { temperature: this.temperature }),
        ...(this.maxOutputTokens !== undefined && { maxOutputTokens: this.maxOutputTokens }),
      });

      // 消费 fullStream 而非 textStream：错误/finish/usage 都是显式部件，
      // 不会被 SDK 的默认 onError 吞掉（textStream 在出错时会静默结束）。
      for await (const part of result.fullStream) {
        // 中断由引擎自己裁决，不依赖 provider 是否尊重 abortSignal
        if (controller.signal.aborted) {
          finishReason = 'interrupted';
          break;
        }
        switch (part.type) {
          case 'text-delta': {
            if (!part.text) break;
            accumulated += part.text;
            yield {
              type: 'message_delta',
              messageId: assistantId,
              text: part.text,
              timestamp: Date.now(),
            };
            break;
          }
          case 'finish': {
            finishReason = normalizeFinishReason(part.finishReason);
            usage = normalizeUsage(part.totalUsage);
            break;
          }
          case 'abort': {
            finishReason = 'interrupted';
            break;
          }
          case 'error': {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
          default:
            break;
        }
      }

      if (controller.signal.aborted && finishReason !== 'interrupted') {
        finishReason = 'interrupted';
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        finishReason = 'interrupted';
      } else {
        finishReason = 'error';
        const message = error instanceof Error ? error.message : String(error);
        errorEvent = {
          type: 'error',
          error: message,
          retryable: isRetryableChatError(error),
          timestamp: Date.now(),
        };
      }
    } finally {
      this.activeGenerations.delete(sessionId);
    }

    // 3. 收尾：错误不持久化半成品；中断的半成品持久化并打标
    if (finishReason === 'error' && errorEvent) {
      yield errorEvent;
      return;
    }

    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: accumulated,
      createdAt: Date.now(),
      model: modelLabel,
      ...(finishReason === 'interrupted' && { interrupted: true }),
    };

    if (accumulated) {
      session.messages.push(assistantMessage);
      session.updatedAt = Date.now();
      await this.store.save(session);
    }

    // 回合写入记忆（仅正常完成的完整回合；中断的半成品不入记忆）。
    // 失败静默降级——记忆层不得破坏对话。
    if (this.memory && accumulated && finishReason === 'stop') {
      try {
        await this.memory.rememberTurn({
          sessionId,
          userMessage,
          assistantMessage,
        });
      } catch {
        // 忽略：记忆写入失败不影响本轮结果
      }
    }

    yield {
      type: 'message_complete',
      message: assistantMessage,
      finishReason,
      ...(usage && { usage }),
      timestamp: Date.now(),
    };
  }

  /** 组装发给模型的消息：窗口内最近 N 条，跳过空消息 */
  private buildModelMessages(session: ChatSessionState): ModelMessage[] {
    const history = session.messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0
    );
    const windowed =
      history.length > this.maxHistoryMessages ? history.slice(-this.maxHistoryMessages) : history;
    return windowed.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  }
}
