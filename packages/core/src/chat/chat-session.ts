import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { GoodMemoryRuntimeKit } from 'goodmemory/runtime-kit';
import { randomUUID } from 'node:crypto';

import { EventQueue } from './event-queue';
import { recallHasHits } from './memory';
import { credentialSafeError, safeErrorMessage } from './safe-error';
import type {
  ChatCompactionResult,
  ChatEvent,
  ChatMemorySnapshot,
  ChatMemoryStatus,
  ChatMessageCompleteEvent,
  ChatModelRef,
  ChatSendOptions,
  ChatThinkingLevel,
  ChatUsage,
} from './types';

const TITLE_MAX_LENGTH = 60;

interface PromptMemoryContext {
  value: string;
  abortRequested: boolean;
}

interface EnabledMemoryBinding {
  enabled: true;
  databasePath: string;
  kit?: GoodMemoryRuntimeKit;
  scope: {
    userId: string;
    workspaceId: 'tachikoma';
    agentId: 'tachikoma';
    sessionId: string;
  };
  startupError?: string;
}

interface DisabledMemoryBinding {
  enabled: false;
}

/** @internal */
export type ChatMemoryBinding = EnabledMemoryBinding | DisabledMemoryBinding;

/** @internal */
export interface ChatSessionDependencies {
  agentSession: AgentSession;
  modelRuntime: ModelRuntime;
  memory: ChatMemoryBinding;
  promptMemoryContext: PromptMemoryContext;
  onClose(sessionId: string): void;
}

function cloneUsage(usage: Usage): ChatUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function emptyUsage(): ChatUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function textContent(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toModelRef(message: AssistantMessage): ChatModelRef {
  return { provider: message.provider, model: message.model };
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH)}…`
    : firstLine;
}

function terminalStatus(message: AssistantMessage): ChatMessageCompleteEvent['status'] {
  if (message.stopReason === 'stop' || message.stopReason === 'length') return 'success';
  if (message.stopReason === 'aborted') return 'interrupted';
  return 'failed';
}

export class ChatSession {
  private readonly agentSession: AgentSession;
  private readonly modelRuntime: ModelRuntime;
  private readonly memory: ChatMemoryBinding;
  private readonly promptMemoryContext: PromptMemoryContext;
  private readonly onClose: (sessionId: string) => void;
  private memoryStarted = false;
  private memoryState: ChatMemorySnapshot;
  private activeTurnId: string | null = null;
  private activeRun: Promise<void> | null = null;
  private closed = false;

  /** @internal */
  constructor(dependencies: ChatSessionDependencies) {
    if (dependencies.agentSession.getActiveToolNames().length !== 0) {
      throw new Error('Chat-only sessions require zero active tools.');
    }
    this.agentSession = dependencies.agentSession;
    this.modelRuntime = dependencies.modelRuntime;
    this.memory = dependencies.memory;
    this.promptMemoryContext = dependencies.promptMemoryContext;
    this.onClose = dependencies.onClose;
    this.memoryState = dependencies.memory.enabled
      ? {
          enabled: true,
          status: dependencies.memory.startupError ? 'degraded' : 'ready',
          databasePath: dependencies.memory.databasePath,
          ...(dependencies.memory.startupError ? { error: dependencies.memory.startupError } : {}),
        }
      : { enabled: false, status: 'disabled' };
  }

  get id(): string {
    return this.agentSession.sessionId;
  }

  get model(): ChatModelRef {
    const model = this.agentSession.model;
    if (!model) {
      throw new Error('Chat session has no model. Configure credentials and a model first.');
    }
    return { provider: model.provider, model: model.id };
  }

  get thinkingLevel(): ChatThinkingLevel {
    return this.agentSession.thinkingLevel;
  }

  get memoryStatus(): ChatMemorySnapshot {
    return { ...this.memoryState };
  }

  get activeTools(): readonly string[] {
    return this.agentSession.getActiveToolNames();
  }

  async *send(text: string, options: ChatSendOptions = {}): AsyncGenerator<ChatEvent> {
    this.assertOpen();
    if (this.activeTurnId) {
      throw new Error(`Session ${this.id} is already generating a response.`);
    }

    const turnId = randomUUID();
    const messageId = randomUUID();
    const events = new EventQueue<ChatEvent>();
    this.activeTurnId = turnId;
    this.promptMemoryContext.abortRequested = false;
    events.push({
      type: 'message_start',
      sessionId: this.id,
      turnId,
      messageId,
      timestamp: Date.now(),
    });

    const onAbort = () => {
      void this.abort().catch((error: unknown) => {
        console.error('Failed to abort Tachikoma chat turn.', safeErrorMessage(error));
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    const run = this.runTurn(text, turnId, messageId, events);
    this.activeRun = run;
    try {
      for await (const event of events) {
        yield event;
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (this.activeTurnId === turnId) {
        await this.abort();
      }
      await run;
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    }
  }

  async abort(): Promise<boolean> {
    if (!this.activeTurnId) {
      return false;
    }
    this.promptMemoryContext.abortRequested = true;
    await this.agentSession.abort();
    return true;
  }

  async setModel(modelRef: ChatModelRef): Promise<ChatModelRef> {
    this.assertOpen();
    const model = this.modelRuntime.getModel(modelRef.provider, modelRef.model);
    if (!model) {
      throw new Error(`Unknown model: ${modelRef.provider}/${modelRef.model}`);
    }
    try {
      await this.agentSession.setModel(model);
      return this.model;
    } catch (error) {
      throw credentialSafeError(error);
    }
  }

  setThinkingLevel(level: ChatThinkingLevel): ChatThinkingLevel {
    this.assertOpen();
    this.agentSession.setThinkingLevel(level);
    return this.agentSession.thinkingLevel;
  }

  async compact(instructions?: string): Promise<ChatCompactionResult> {
    this.assertOpen();
    try {
      const result = await this.agentSession.compact(instructions);
      return {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        ...(result.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: result.estimatedTokensAfter }
          : {}),
        ...(result.usage ? { usage: cloneUsage(result.usage) } : {}),
      };
    } catch (error) {
      throw credentialSafeError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    const activeRun = this.activeRun;
    if (this.activeTurnId) {
      await this.abort();
    }
    if (activeRun) {
      await activeRun;
    }
    if (this.memory.enabled && this.memory.kit && this.memoryStarted) {
      try {
        await this.memory.kit.sessionEnd({ scope: this.memory.scope });
      } catch (error) {
        this.setMemoryState('degraded', safeErrorMessage(error));
      }
    }
    this.agentSession.dispose();
    this.closed = true;
    this.onClose(this.id);
  }

  private async runTurn(
    text: string,
    turnId: string,
    messageId: string,
    events: EventQueue<ChatEvent>
  ): Promise<void> {
    let finalMessage: AssistantMessage | undefined;
    let terminalSent = false;

    const emit = (event: ChatEvent): void => events.push(event);
    const unsubscribe = this.agentSession.subscribe((event) => {
      finalMessage = this.handlePiEvent(event, turnId, messageId, emit, finalMessage);
    });

    try {
      this.throwIfTurnAborted();
      if (!this.agentSession.sessionName) {
        const title = deriveTitle(text);
        if (title) {
          this.agentSession.setSessionName(title);
        }
      }

      await this.prepareMemory(text, turnId, emit);
      this.throwIfTurnAborted();
      await this.agentSession.prompt(text, {
        expandPromptTemplates: false,
        source: 'extension',
      });
      await this.agentSession.waitForIdle();

      if (!finalMessage) {
        throw new Error('pi AgentSession ended without a terminal assistant message.');
      }
      const status = terminalStatus(finalMessage);
      const content = textContent(finalMessage);
      if (status === 'success') {
        await this.finishMemory(text, content, turnId, emit);
      }

      const complete: ChatMessageCompleteEvent = {
        type: 'message_complete',
        sessionId: this.id,
        turnId,
        messageId,
        timestamp: Date.now(),
        status,
        content,
        model: toModelRef(finalMessage),
        stopReason: finalMessage.stopReason,
        usage: cloneUsage(finalMessage.usage),
        ...(finalMessage.errorMessage
          ? { error: safeErrorMessage(finalMessage.errorMessage) }
          : status === 'failed'
            ? { error: `Chat-only session rejected model stop reason: ${finalMessage.stopReason}.` }
            : {}),
      };
      emit(complete);
      terminalSent = true;
    } catch (error) {
      const interrupted =
        this.promptMemoryContext.abortRequested ||
        (error instanceof Error && error.name === 'AbortError');
      const complete: ChatMessageCompleteEvent = {
        type: 'message_complete',
        sessionId: this.id,
        turnId,
        messageId,
        timestamp: Date.now(),
        status: interrupted ? 'interrupted' : 'failed',
        content: finalMessage ? textContent(finalMessage) : '',
        model: finalMessage ? toModelRef(finalMessage) : this.model,
        stopReason: finalMessage?.stopReason ?? (interrupted ? 'aborted' : 'error'),
        usage: finalMessage ? cloneUsage(finalMessage.usage) : emptyUsage(),
        error: safeErrorMessage(error),
      };
      emit(complete);
      terminalSent = true;
    } finally {
      unsubscribe();
      this.promptMemoryContext.value = '';
      this.promptMemoryContext.abortRequested = false;
      this.activeTurnId = null;
      if (!terminalSent) {
        emit({
          type: 'message_complete',
          sessionId: this.id,
          turnId,
          messageId,
          timestamp: Date.now(),
          status: 'failed',
          content: '',
          model: this.model,
          stopReason: 'error',
          usage: emptyUsage(),
          error: 'Chat turn ended without a terminal model event.',
        });
      }
      events.close();
    }
  }

  private handlePiEvent(
    event: AgentSessionEvent,
    turnId: string,
    messageId: string,
    emit: (event: ChatEvent) => void,
    finalMessage: AssistantMessage | undefined
  ): AssistantMessage | undefined {
    const base = { sessionId: this.id, turnId, timestamp: Date.now() };
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') {
        emit({ ...base, type: 'message_delta', messageId, text: update.delta });
      } else if (update.type === 'thinking_delta') {
        emit({ ...base, type: 'reasoning_delta', messageId, text: update.delta });
      }
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      return event.message;
    } else if (event.type === 'auto_retry_start') {
      emit({
        ...base,
        type: 'retry',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: safeErrorMessage(event.errorMessage),
      });
    } else if (event.type === 'compaction_start') {
      emit({ ...base, type: 'compaction', phase: 'start', reason: event.reason });
    } else if (event.type === 'compaction_end') {
      emit({
        ...base,
        type: 'compaction',
        phase: 'complete',
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage ? { error: safeErrorMessage(event.errorMessage) } : {}),
      });
    }
    return finalMessage;
  }

  private async prepareMemory(
    text: string,
    turnId: string,
    emit: (event: ChatEvent) => void
  ): Promise<void> {
    const base = { sessionId: this.id, turnId, timestamp: Date.now() };
    if (!this.memory.enabled) {
      if (!this.memoryStarted) {
        this.memoryStarted = true;
        emit({ ...base, type: 'memory_status', phase: 'session_start', status: 'disabled' });
      }
      return;
    }
    if (!this.memory.kit) {
      emit({
        ...base,
        type: 'memory_status',
        phase: 'session_start',
        status: 'degraded',
        error: this.memory.startupError ?? 'GoodMemory failed to initialize.',
      });
      return;
    }

    if (!this.memoryStarted) {
      try {
        await this.memory.kit.sessionStart({ scope: this.memory.scope });
        this.memoryStarted = true;
        this.setMemoryState('ready');
        emit({ ...base, type: 'memory_status', phase: 'session_start', status: 'ready' });
      } catch (error) {
        const message = safeErrorMessage(error);
        this.setMemoryState('degraded', message);
        emit({
          ...base,
          type: 'memory_status',
          phase: 'session_start',
          status: 'degraded',
          error: message,
        });
        return;
      }
    }

    try {
      const result = await this.memory.kit.beforeModelCall({
        scope: this.memory.scope,
        query: text,
        retrievalProfile: 'general_chat',
        messages: [{ role: 'user', content: text }],
      });
      // 空库时渲染文本仍含框架头，命中与否以召回桶为准（recall 缺失时退回文本判定）
      const hasContext =
        (result.recall === undefined || recallHasHits(result.recall)) &&
        result.context.content.trim().length > 0;
      this.promptMemoryContext.value = hasContext ? result.context.content : '';
      const status: ChatMemoryStatus = hasContext ? 'recalled' : 'empty';
      this.setMemoryState(status);
      emit({
        ...base,
        type: 'memory_status',
        phase: 'recall',
        status,
        hasContext,
        estimatedTokens: result.context.estimatedTokens,
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      this.promptMemoryContext.value = '';
      this.setMemoryState('degraded', message);
      emit({
        ...base,
        type: 'memory_status',
        phase: 'recall',
        status: 'degraded',
        error: message,
      });
    }
  }

  private async finishMemory(
    userText: string,
    assistantText: string,
    turnId: string,
    emit: (event: ChatEvent) => void
  ): Promise<void> {
    if (!this.memory.enabled || !this.memory.kit || !this.memoryStarted) {
      return;
    }
    const base = { sessionId: this.id, turnId, timestamp: Date.now() };
    try {
      await this.memory.kit.afterModelCall({
        scope: this.memory.scope,
        messages: [{ role: 'user', content: userText }],
        assistantText,
        writeback: { mode: 'selective', annotation: 'durable_candidate', policy: 'allow' },
      });
      this.setMemoryState('ready');
      emit({ ...base, type: 'memory_status', phase: 'writeback', status: 'ready' });
    } catch (error) {
      const message = safeErrorMessage(error);
      this.setMemoryState('write-failed', message);
      emit({
        ...base,
        type: 'memory_status',
        phase: 'writeback',
        status: 'write-failed',
        error: message,
      });
    }
  }

  private setMemoryState(status: ChatMemoryStatus, error?: string): void {
    this.memoryState = {
      ...this.memoryState,
      status,
      ...(error ? { error } : {}),
    };
    if (!error) {
      delete this.memoryState.error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Session ${this.id} is closed.`);
    }
  }

  private throwIfTurnAborted(): void {
    if (!this.promptMemoryContext.abortRequested) {
      return;
    }
    const error = new Error('Chat turn was aborted.');
    error.name = 'AbortError';
    throw error;
  }
}
