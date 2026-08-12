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
import type { ToolApprovalBridge } from './workspace-guard';
import type {
  ChatCompactionResult,
  ChatEvent,
  ChatMemorySnapshot,
  ChatMemoryStatus,
  ChatMessageCompleteEvent,
  ChatModelRef,
  ChatSendOptions,
  ChatThinkingLevel,
  ChatToolset,
  ChatUsage,
  ChatWorkspaceState,
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
  /** 本会话允许的工具名集合；空集 = 零工具（第一圈默认） */
  allowedTools: readonly string[];
  /** 本会话的工作区授予（canonical 根 + 工具集）；缺省 = 零工具 */
  workspace?: { root: string; toolset: ChatToolset };
  /** 策略扩展的审批桥；ChatSession 在回合内挂 request，回合外审批一律拒绝 */
  approvalBridge: ToolApprovalBridge;
  approvalTimeoutMs: number;
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

function toolOutputText(result: unknown): string {
  if (typeof result === 'string') return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result == null ? '' : JSON.stringify(result);
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text: unknown }).text);
      }
      if (part && typeof part === 'object' && 'mimeType' in part) {
        return `[image:${String((part as { mimeType: unknown }).mimeType)}]`;
      }
      return String(part);
    })
    .join('\n');
}

export class ChatSession {
  private readonly agentSession: AgentSession;
  private readonly modelRuntime: ModelRuntime;
  private readonly memory: ChatMemoryBinding;
  private readonly promptMemoryContext: PromptMemoryContext;
  private readonly workspaceGrant: { root: string; toolset: ChatToolset } | undefined;
  private readonly approvalBridge: ToolApprovalBridge;
  private readonly approvalTimeoutMs: number;
  private readonly pendingApprovals = new Map<
    string,
    {
      tool: string;
      finish: (
        approved: boolean,
        reason: 'reply' | 'timeout' | 'aborted',
        scope?: 'call' | 'session'
      ) => void;
    }
  >();
  /** 本会话内免询问放行的工具（respondToApproval scope 'session' 建立；随会话消亡） */
  private readonly sessionApprovedTools = new Set<string>();
  private readonly onClose: (sessionId: string) => void;
  private memoryStarted = false;
  private memoryState: ChatMemorySnapshot;
  private activeTurnId: string | null = null;
  private activeRun: Promise<void> | null = null;
  private closed = false;

  /** @internal */
  constructor(dependencies: ChatSessionDependencies) {
    const allowed = new Set(dependencies.allowedTools);
    const unexpected = dependencies.agentSession
      .getActiveToolNames()
      .filter((name) => !allowed.has(name));
    if (unexpected.length > 0) {
      throw new Error(`Session has tools outside the allowed set: ${unexpected.join(', ')}`);
    }
    this.agentSession = dependencies.agentSession;
    this.modelRuntime = dependencies.modelRuntime;
    this.memory = dependencies.memory;
    this.promptMemoryContext = dependencies.promptMemoryContext;
    this.workspaceGrant = dependencies.workspace;
    this.approvalBridge = dependencies.approvalBridge;
    this.approvalTimeoutMs = dependencies.approvalTimeoutMs;
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

  /** 本会话的工作区授予状态；null = 零工具会话 */
  get workspace(): ChatWorkspaceState | null {
    return this.workspaceGrant
      ? { ...this.workspaceGrant, tools: [...this.agentSession.getActiveToolNames()] }
      : null;
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
    // 先发中止信号再解审批：钩子解锁时 pi 循环已见 abort，不会再跑下一步模型调用。
    // 不能先 await——abort 可能等待被审批挂起的工具收尾，互相等死。
    const aborting = this.agentSession.abort();
    this.resolveAllApprovals(false, 'aborted');
    await aborting;
    return true;
  }

  /**
   * 应答一个在途的工具审批；返回是否命中待决项。
   * scope 'session'（仅在 approved 时有意义）：该工具本会话内此后自动放行、不再发审批事件。
   */
  respondToApproval(
    callId: string,
    approved: boolean,
    scope: 'call' | 'session' = 'call'
  ): boolean {
    const pending = this.pendingApprovals.get(callId);
    if (!pending) {
      return false;
    }
    const effectiveScope = approved ? scope : 'call';
    if (effectiveScope === 'session') {
      this.sessionApprovedTools.add(pending.tool);
    }
    pending.finish(approved, 'reply', effectiveScope);
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
    this.approvalBridge.request = (request) => this.requestApproval(request, turnId, emit);
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
      // 用户请求过中止时，非成功终结一律归为 interrupted——abort 命中工具执行窗口时
      // pi 会以 stopReason 'error'（AbortError 文本）结束，而不是 'aborted'。
      const rawStatus = terminalStatus(finalMessage);
      const status =
        this.promptMemoryContext.abortRequested && rawStatus !== 'success'
          ? 'interrupted'
          : rawStatus;
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
      delete this.approvalBridge.request;
      this.resolveAllApprovals(false, 'aborted');
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
    } else if (event.type === 'tool_execution_start') {
      emit({
        ...base,
        type: 'tool_call',
        callId: event.toolCallId,
        tool: event.toolName,
        input: event.args,
      });
    } else if (event.type === 'tool_execution_update') {
      emit({
        ...base,
        type: 'tool_update',
        callId: event.toolCallId,
        tool: event.toolName,
        output: toolOutputText(event.partialResult),
      });
    } else if (event.type === 'tool_execution_end') {
      emit({
        ...base,
        type: 'tool_result',
        callId: event.toolCallId,
        tool: event.toolName,
        output: toolOutputText(event.result),
        isError: event.isError,
      });
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

  private requestApproval(
    request: { callId: string; tool: string; input: unknown },
    turnId: string,
    emit: (event: ChatEvent) => void
  ): Promise<boolean> {
    // 会话级放行过的工具直接通过，不再制造审批噪音（tool_call 事件仍然可见）。
    if (this.sessionApprovedTools.has(request.tool)) {
      return Promise.resolve(true);
    }
    emit({
      type: 'tool_approval_request',
      sessionId: this.id,
      turnId,
      timestamp: Date.now(),
      callId: request.callId,
      tool: request.tool,
      input: request.input,
      timeoutMs: this.approvalTimeoutMs,
    });
    return new Promise((resolveApproval) => {
      // finish 只会在 timer 初始化之后被调用（超时回调或 pendingApprovals 应答）
      const finish = (
        approved: boolean,
        reason: 'reply' | 'timeout' | 'aborted',
        scope?: 'call' | 'session'
      ): void => {
        if (!this.pendingApprovals.delete(request.callId)) {
          return;
        }
        clearTimeout(timer);
        emit({
          type: 'tool_approval_resolved',
          sessionId: this.id,
          turnId,
          timestamp: Date.now(),
          callId: request.callId,
          approved,
          reason,
          ...(scope && scope !== 'call' ? { scope } : {}),
        });
        resolveApproval(approved);
      };
      const timer = setTimeout(() => finish(false, 'timeout'), this.approvalTimeoutMs);
      this.pendingApprovals.set(request.callId, { tool: request.tool, finish });
    });
  }

  private resolveAllApprovals(approved: boolean, reason: 'reply' | 'timeout' | 'aborted'): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.finish(approved, reason);
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
