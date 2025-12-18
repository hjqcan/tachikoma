/**
 * Conversational Runner
 *
 * 多轮对话执行器，协调各组件完成任务
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Planner, createLLMClient } from '../planner';
import type { ConversationContextManager, Task, TaskResult } from '../types';
import { createRegisteredConversationContextManager } from '../factories';
import { Orchestrator } from '../orchestrator/orchestrator';
import type { PlannerOutput } from '../orchestrator/types';
import type { OrchestratorEvent } from '../orchestrator/types';

import { SessionStore } from './session-store';
import { IntentAnalyzer } from './intent-analyzer';
import { ConversationPromptBuilder } from './prompt-builder';
import {
  UserIntent,
  type ConversationalRunnerConfig,
  type SessionState,
  type StreamEvent,
  type ExecutionSummary,
} from './types';
import type { ActionRecord, ThinkingRecord } from '../orchestrator/session/types';

// =============================================================================
// ConversationalRunner 类
// =============================================================================

/**
 * 多轮对话执行器
 */
export class ConversationalRunner {
  private readonly config: ConversationalRunnerConfig;
  private readonly sessionStore: SessionStore;
  private readonly intentAnalyzer: IntentAnalyzer;
  private readonly promptBuilder: ConversationPromptBuilder;
  private readonly contextManagers = new Map<string, ConversationContextManager>();
  private readonly orchestrators = new Map<string, Orchestrator>();

  constructor(config: ConversationalRunnerConfig) {
    this.config = config;
    this.sessionStore = new SessionStore(config.sessionDir);
    this.intentAnalyzer = new IntentAnalyzer();
    this.promptBuilder = new ConversationPromptBuilder(
      config.maxHistoryMessages ? { maxMessages: config.maxHistoryMessages } : {}
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * 创建新会话
   */
  async createSession(): Promise<SessionState> {
    return this.sessionStore.createSession(this.config.workDir);
  }

  /**
   * 获取会话
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.sessionStore.getSession(sessionId);
  }

  /**
   * 列出所有会话
   */
  async listSessions(): Promise<SessionState[]> {
    return this.sessionStore.listSessions();
  }

  /**
   * 处理用户消息（核心入口）
   */
  async *handleMessage(
    sessionId: string,
    userMessage: string
  ): AsyncGenerator<StreamEvent> {
    // 1. 获取会话
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      yield {
        type: 'error',
        error: `Session not found: ${sessionId}`,
        retryable: false,
        timestamp: Date.now(),
      };
      return;
    }

    // 2. 记录用户消息
    await this.sessionStore.addMessage(sessionId, {
      role: 'user',
      content: userMessage,
    });
    this.getContextManager(sessionId).addMessage({
      id: `msg-${randomUUID().substring(0, 8)}`,
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    // 3. 分析意图
    const intent = this.intentAnalyzer.analyze(userMessage, session);

    if (this.config.verbose) {
      console.log(`[ConversationalRunner] Intent: ${intent.intent} (${intent.confidence})`);
    }

    // 3.1 鲁棒性：新会话/无检查点时，避免把“包含回退语义的长任务描述”误判成撤销
    // 例如：首次对话里出现“1:1还原样式”这类短语，不应触发 UNDO 分支。
    if (intent.intent === UserIntent.UNDO && session.checkpoints.length === 0) {
      const trimmed = userMessage.trim();
      const startsWithUndo =
        /^(撤销|回退|回滚|还原|恢复)/.test(trimmed) ||
        /^(undo|rollback|revert)\b/i.test(trimmed);
      if (!startsWithUndo) {
        yield* this.handleNewTask(session, userMessage);
        return;
      }
    }

    // 4. 根据意图路由
    switch (intent.intent) {
      case UserIntent.NEW_TASK:
        yield* this.handleNewTask(session, userMessage);
        break;

      case UserIntent.CONTINUE:
        yield* this.handleContinue(session);
        break;

      case UserIntent.MODIFY:
        yield* this.handleModify(session, intent.entities);
        break;

      case UserIntent.CLARIFY:
        yield* this.handleClarify(session, userMessage);
        break;

      case UserIntent.UNDO:
        yield* this.handleUndo(session, intent.entities);
        break;

      case UserIntent.QUERY:
        yield* this.handleQuery(session);
        break;

      default:
        yield* this.handleNewTask(session, userMessage);
    }
  }

  /**
   * 中断执行
   */
  async interrupt(sessionId: string): Promise<void> {
    // TODO: 实现中断逻辑
    const session = await this.sessionStore.getSession(sessionId);
    if (session) {
      session.waitingForUser = true;
      await this.sessionStore.saveSession(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Intent Handlers
  // ---------------------------------------------------------------------------

  /**
   * 处理新任务
   */
  private async *handleNewTask(
    session: SessionState,
    task: string
  ): AsyncGenerator<StreamEvent> {
    try {
      // 1. 创建检查点
      if (this.config.enableCheckpoints) {
        await this.sessionStore.createCheckpoint(
          session.sessionId,
          `开始新任务: ${task.substring(0, 50)}...`
        );
      }

      // 2. 执行（对话驱动 → Orchestrator）
      yield* this.runWithOrchestrator(session, task, { plannerMode: 'full' });
    } catch (error) {
      yield {
        type: 'error',
        error: String(error),
        retryable: false,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 处理继续执行
   */
  private async *handleContinue(
    session: SessionState
  ): AsyncGenerator<StreamEvent> {
    const lastObjective = session.variables.lastObjective;
    const lastStatus = session.variables.lastRunStatus;

    if (typeof lastObjective === 'string' && lastObjective.trim() && lastStatus !== 'success') {
      const maxSubtasks = this.inferPatchMaxSubtasks(session, lastObjective);
      yield* this.runWithOrchestrator(
        session,
        `继续上次任务：${lastObjective}`,
        { plannerMode: 'patch', maxSubtasks }
      );
      return;
    }

    yield {
      type: 'complete',
      success: true,
      summary: session.currentPlan ? '当前会话没有挂起执行' : '没有待执行的任务',
      timestamp: Date.now(),
    };
  }

  /**
   * 处理修改请求
   */
  private async *handleModify(
    session: SessionState,
    entities: Record<string, unknown>
  ): AsyncGenerator<StreamEvent> {
    const target = entities.target as string | undefined;
    const newValue = entities.newValue as string | undefined;

    const modifyPrompt = this.promptBuilder.buildModifyPrompt(
      session,
      target,
      newValue
    );

    yield {
      type: 'thinking',
      content: `处理修改请求: ${modifyPrompt}`,
      timestamp: Date.now(),
    };

    // 增量修改：走 patch-planning（基于已有计划/产出生成最小 delta 计划）
    const maxSubtasks = this.inferPatchMaxSubtasks(session, modifyPrompt);
    yield* this.runWithOrchestrator(session, modifyPrompt, {
      plannerMode: 'patch',
      maxSubtasks,
    });
  }

  private inferPatchMaxSubtasks(session: SessionState, objective: string): number {
    const lastFiles = session.variables.lastFilesAffected;
    if (Array.isArray(lastFiles) && lastFiles.length >= 8) return 10;

    const text = objective.toLowerCase();
    const largeChangeKeywords = [
      'refactor',
      'migration',
      'migrate',
      'restructure',
      'architecture',
      '重构',
      '迁移',
      '架构',
      '多文件',
      '大量',
    ];
    if (largeChangeKeywords.some((k) => text.includes(k))) return 10;
    if (objective.length >= 240) return 8;
    return 5;
  }

  /**
   * 处理用户澄清回答
   */
  private async *handleClarify(
    session: SessionState,
    answer: string
  ): AsyncGenerator<StreamEvent> {
    session.waitingForUser = false;
    session.pendingQuestion = undefined;
    await this.sessionStore.saveSession(session);

    yield {
      type: 'thinking',
      content: `收到回答: ${answer}`,
      timestamp: Date.now(),
    };

    const pendingObjective = session.variables.pendingObjective;
    if (typeof pendingObjective === 'string' && pendingObjective.trim()) {
      delete session.variables.pendingObjective;
      delete session.variables.pendingMissingInfo;
      await this.sessionStore.saveSession(session);
      yield* this.handleNewTask(
        session,
        `${pendingObjective}\n\n[用户补充信息]\n${answer}`
      );
      return;
    }

    yield* this.handleNewTask(session, answer);
  }

  /**
   * 处理撤销
   */
  private async *handleUndo(
    session: SessionState,
    _entities: Record<string, unknown>
  ): AsyncGenerator<StreamEvent> {
    const checkpoints = session.checkpoints;
    if (checkpoints.length === 0) {
      yield {
        type: 'error',
        error: this.config.enableCheckpoints
          ? '没有可撤销的检查点（当前会话尚未创建检查点，可能是首次对话）'
          : '没有可撤销的检查点（当前未启用检查点 enableCheckpoints）',
        retryable: false,
        timestamp: Date.now(),
      };
      return;
    }

    // 获取最近的检查点
    const latestCheckpoint = checkpoints[checkpoints.length - 1];
    if (!latestCheckpoint) {
      yield {
        type: 'error',
        error: '检查点数据异常',
        retryable: false,
        timestamp: Date.now(),
      };
      return;
    }

    yield {
      type: 'thinking',
      content: `正在撤销到: ${latestCheckpoint.description}`,
      timestamp: Date.now(),
    };

    await this.sessionStore.rollbackToCheckpoint(
      session.sessionId,
      latestCheckpoint.id
    );

    yield {
      type: 'complete',
      success: true,
      summary: `已撤销到: ${latestCheckpoint.description}`,
      timestamp: Date.now(),
    };
  }

  /**
   * 处理状态查询
   */
  private async *handleQuery(
    session: SessionState
  ): AsyncGenerator<StreamEvent> {
    const context = this.promptBuilder.buildContext(session);

    yield {
      type: 'complete',
      success: true,
      summary: context,
      timestamp: Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Execution Logic
  // ---------------------------------------------------------------------------

  /**
   * 获取/创建 ConversationContextManager（会话容器）
   */
  private getContextManager(sessionId: string): ConversationContextManager {
    const existing = this.contextManagers.get(sessionId);
    if (existing) return existing;

    const created = createRegisteredConversationContextManager({ sessionId });
    this.contextManagers.set(sessionId, created);
    return created;
  }

  /**
   * 获取/创建 Orchestrator（每个会话复用）
   */
  private getOrchestrator(session: SessionState): Orchestrator {
    const existing = this.orchestrators.get(session.sessionId);
    if (existing) return existing;

    const { apiKey, baseUrl, model } = this.config.llm;

    const llmClient = createLLMClient({
      provider: 'openai',
      model: model ?? 'gpt-4o',
      apiKey,
      ...(baseUrl && { baseUrl }),
      maxTokens: 8192,
      temperature: 0.3,
    });

    const planner = new Planner({
      llmClient,
      config: {
        agent: {
          provider: 'openai',
          model: model ?? 'gpt-4o',
          maxTokens: 8192,
          temperature: 0.3,
          ...(baseUrl && { baseUrl }),
          apiKey,
        },
      },
    });

    const orchestrator = new Orchestrator(`orch-${session.sessionId}`, {
      planner,
      config: {
        session: {
          rootDir: resolve(this.config.sessionDir),
          enableWatch: true,
          watchPollInterval: 300,
        },
      },
    });

    this.orchestrators.set(session.sessionId, orchestrator);
    return orchestrator;
  }

  /**
   * 对话驱动的执行入口（内部调用 Orchestrator）
   */
  private async *runWithOrchestrator(
    session: SessionState,
    objective: string,
    options: { plannerMode: 'full' | 'patch'; maxSubtasks?: number } = { plannerMode: 'full' }
  ): AsyncGenerator<StreamEvent> {
    const orchestrator = this.getOrchestrator(session);
    const taskId = `task-${randomUUID().substring(0, 8)}`;

    const contextText = this.promptBuilder.buildContext(session);

    const task: Task = {
      id: taskId,
      type: 'composite',
      objective,
      constraints: [
        `Current working directory: ${resolve(this.config.workDir)}`,
        'All file operations must use relative paths.',
        ...(contextText
          ? [`Conversation context (for reference only; do not quote verbatim):\n${contextText}`]
          : []),
      ],
      context: {
        parentTaskId: session.sessionId,
        sessionId: session.sessionId,
        metadata: {
          workDir: resolve(this.config.workDir),
          llm: {
            provider: 'openai',
            apiKey: this.config.llm.apiKey,
            ...(this.config.llm.baseUrl && { baseUrl: this.config.llm.baseUrl }),
            model: this.config.llm.model ?? 'gpt-4o',
          },
          planner: {
            mode: options.plannerMode,
            ...(options.maxSubtasks !== undefined && { maxSubtasks: options.maxSubtasks }),
            ...(typeof session.variables.lastRunError === 'string' && session.variables.lastRunError.trim()
              ? { previousError: session.variables.lastRunError.trim() }
              : {}),
            ...(Array.isArray(session.variables.lastFilesAffected) && session.variables.lastFilesAffected.length > 0
              ? { previousFiles: session.variables.lastFilesAffected.slice(0, 50) }
              : {}),
          },
          memorySync: { strategy: 'selective' },
        },
      },
    };

    const queue: StreamEvent[] = [];
    let done = false;
    let notify: (() => void) | null = null;

    const push = (evt: StreamEvent) => {
      queue.push(evt);
      notify?.();
      notify = null;
    };

    const waitForNext = async (): Promise<void> => {
      if (queue.length > 0 || done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    };

    const filesAffected: string[] = [];
    const plannerRoles = new Map<string, string>(); // Cache role names
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    const truncate = (text: string, max: number): string => {
      if (text.length <= max) return text;
      return `${text.slice(0, max)}…[truncated]`;
    };
    const summarizeToolOutput = (
      tool: string,
      output: unknown
    ): { result?: unknown; outputPreview?: string } => {
      const MAX_PREVIEW = 2000;
      const MAX_STDIO = 1500;

      if (tool === 'shell_run' && isRecord(output)) {
        const success = typeof output.success === 'boolean' ? output.success : undefined;
        const error = typeof output.error === 'string' ? output.error : undefined;
        const data = isRecord(output.data) ? (output.data as Record<string, unknown>) : null;

        const stdout = typeof data?.stdout === 'string' ? data.stdout.trim() : '';
        const stderr = typeof data?.stderr === 'string' ? data.stderr.trim() : '';
        const exitCode = typeof data?.exitCode === 'number' ? data.exitCode : undefined;

        const stdoutPreview = stdout ? truncate(stdout, MAX_STDIO) : '';
        const stderrPreview = stderr ? truncate(stderr, MAX_STDIO) : '';

        const safeData: Record<string, unknown> = {};
        if (exitCode !== undefined) safeData.exitCode = exitCode;
        if (stdoutPreview) safeData.stdout = stdoutPreview;
        if (stderrPreview) safeData.stderr = stderrPreview;
        if (typeof data?.stdoutTruncated === 'boolean') safeData.stdoutTruncated = data.stdoutTruncated;
        if (typeof data?.stderrTruncated === 'boolean') safeData.stderrTruncated = data.stderrTruncated;

        const safe: Record<string, unknown> = {};
        if (success !== undefined) safe.success = success;
        if (Object.keys(safeData).length > 0) safe.data = safeData;
        if (error) safe.error = error;

        const previewParts: string[] = [];
        if (exitCode !== undefined) previewParts.push(`exitCode=${exitCode}`);
        if (stdoutPreview) previewParts.push(`stdout:\n${stdoutPreview}`);
        if (stderrPreview) previewParts.push(`stderr:\n${stderrPreview}`);

        const summarized: { result?: unknown; outputPreview?: string } = {};
        if (Object.keys(safe).length > 0) summarized.result = safe;
        if (previewParts.length > 0) summarized.outputPreview = truncate(previewParts.join('\n'), MAX_PREVIEW);
        return summarized;
      }

      if (tool === 'file_read' && isRecord(output)) {
        const success = typeof output.success === 'boolean' ? output.success : undefined;
        const error = typeof output.error === 'string' ? output.error : undefined;
        const data = isRecord(output.data) ? (output.data as Record<string, unknown>) : null;
        const size = typeof data?.size === 'number' ? data.size : undefined;

        const safe: Record<string, unknown> = {};
        if (success !== undefined) safe.success = success;
        if (size !== undefined) safe.data = { size };
        if (error) safe.error = error;

        const summarized: { result?: unknown; outputPreview?: string } = {};
        if (Object.keys(safe).length > 0) summarized.result = safe;
        summarized.outputPreview = size !== undefined ? `size=${size} bytes (content omitted)` : 'content omitted';
        return summarized;
      }

      if (tool === 'file_list' && isRecord(output)) {
        const success = typeof output.success === 'boolean' ? output.success : undefined;
        const error = typeof output.error === 'string' ? output.error : undefined;
        const data = isRecord(output.data) ? (output.data as Record<string, unknown>) : null;
        const count = typeof data?.count === 'number' ? data.count : undefined;

        const safe: Record<string, unknown> = {};
        if (success !== undefined) safe.success = success;
        if (count !== undefined) safe.data = { count };
        if (error) safe.error = error;

        const summarized: { result?: unknown; outputPreview?: string } = {};
        if (Object.keys(safe).length > 0) summarized.result = safe;
        if (count !== undefined) summarized.outputPreview = `count=${count}`;
        return summarized;
      }

      if (typeof output === 'string') {
        const summarized: { result?: unknown; outputPreview?: string } = {
          outputPreview: truncate(output, MAX_PREVIEW),
        };
        if (output.length <= MAX_PREVIEW) summarized.result = output;
        return summarized;
      }

      if (isRecord(output)) {
        try {
          const json = JSON.stringify(output);
          const summarized: { result?: unknown; outputPreview?: string } = {
            outputPreview: truncate(json, MAX_PREVIEW),
          };
          if (json.length <= MAX_PREVIEW) summarized.result = output;
          return summarized;
        } catch {
          return {};
        }
      }

      return {};
    };

    const onPlanStart = () => {
      push({ type: 'thinking', content: '正在规划任务...', timestamp: Date.now() });
    };
    const onPlanComplete = (plan: PlannerOutput) => {
      session.currentPlan = {
        subtasks: plan.subtasks,
        executionOrder: plan.executionPlan.steps.flatMap((s) => s.subtaskIds),
      };
      session.pendingSubtasks = plan.subtasks.map((s) => s.id);
      session.completedSubtasks = [];
      void this.sessionStore.saveSession(session);

      // Cache roles
      if (plan.roles) {
        for (const role of plan.roles) {
          plannerRoles.set(role.id, role.name);
        }
      }

      const roles = plan.roles?.map((r) => ({
        id: r.id,
        name: r.name,
        responsibilities: r.responsibilities,
      }));
      push({
        type: 'plan_generated',
        subtasks: plan.subtasks,
        ...(roles && { roles }),
        timestamp: Date.now(),
      });

      push({
        type: 'thinking',
        content: `已规划 ${plan.subtasks.length} 个子任务${
          plan.roles ? `，分配给 ${plan.roles.length} 个角色` : ''
        }`,
        timestamp: Date.now(),
      });
    };
    const onSubtaskAssigned = (
      subtaskId: string,
      subtaskObjective: string,
      workerId: string,
      roleName?: string
    ) => {
      push({
        type: 'subtask_start',
        subtaskId,
        subtaskObjective,
        workerId,
        ...(roleName && { role: roleName }),
        timestamp: Date.now(),
      });
      if (!session.pendingSubtasks.includes(subtaskId)) {
        session.pendingSubtasks.push(subtaskId);
        void this.sessionStore.saveSession(session);
      }
    };
    const onSubtaskDone = (subtaskId: string, success: boolean, error?: string) => {
      if (!subtaskId) return;
      push({
        type: 'subtask_complete',
        subtaskId,
        success,
        ...(typeof error === 'string' && { error }),
        timestamp: Date.now(),
      });
      session.pendingSubtasks = session.pendingSubtasks.filter((id) => id !== subtaskId);
      if (success && !session.completedSubtasks.includes(subtaskId)) {
        session.completedSubtasks.push(subtaskId);
      }
      void this.sessionStore.saveSession(session);
    };
    const onWorkerThinking = (workerId: string, record: ThinkingRecord) => {
      if (!this.config.verbose) return;
      const line = record.content.trim().split('\n')[0] ?? '';
      if (!line) return;
      push({
        type: 'thinking',
        content: `[${workerId}] ${line}`,
        timestamp: Date.now(),
      });
    };
    const onWorkerAction = (_workerId: string, record: ActionRecord) => {
      const desc = record.description ?? '';

      const callingMatch = desc.match(/^Calling tool:\s*(.+)$/);
      if (callingMatch) {
        const tool = callingMatch[1] ?? 'unknown';
        const input = (record.params?.input as Record<string, unknown> | undefined) ?? {};
        push({ type: 'tool_call', tool, input, timestamp: Date.now() });

        // 追踪文件操作（用于 summary）
        if (['file_write', 'apply_patch'].includes(tool)) {
          const path = (input as Record<string, unknown>).path as string | undefined;
          if (path && !filesAffected.includes(path)) filesAffected.push(path);
        }
        return;
      }

      const resultMatch = desc.match(/^Tool result:\s*(.+)$/);
      if (resultMatch) {
        const tool = resultMatch[1] ?? 'unknown';
        const success = record.result?.success ?? false;
        const durationMs = record.result?.duration;
        const error = record.result?.error;
        const { result, outputPreview } = summarizeToolOutput(tool, record.result?.output);
        push({
          type: 'tool_result',
          tool,
          success,
          ...(durationMs !== undefined && { durationMs }),
          ...(typeof error === 'string' && { error }),
          ...(typeof outputPreview === 'string' && { outputPreview }),
          ...(result !== undefined && { result }),
          timestamp: Date.now(),
        });
      }
    };

    const planStartHandler = () => onPlanStart();
    const planCompleteHandler = (evt: OrchestratorEvent<{ plan: PlannerOutput }>) =>
      onPlanComplete(evt.data.plan);
    const subtaskAssignedHandler = (
      evt: OrchestratorEvent<{
        subtaskId: string;
        subtask: { objective: string; roleId?: string };
        workerId?: string;
      }>
    ) => {
      const roleId = evt.data.subtask.roleId;
      const roleName = roleId ? plannerRoles.get(roleId) ?? roleId : undefined;
      onSubtaskAssigned(
        evt.data.subtaskId,
        evt.data.subtask.objective,
        evt.data.workerId || 'unknown',
        roleName
      );
    };
    const subtaskCompleteHandler = (evt: OrchestratorEvent<{ result: TaskResult }>) => {
      const output = evt.data.result.output;
      const asText = (() => {
        if (typeof output === 'string') return output.trim();
        if (!isRecord(output)) return '';
        const candidates = ['content', 'text', 'message', 'output'];
        for (const key of candidates) {
          const value = output[key];
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
      })();

      if (asText) {
        push({
          type: 'subtask_output',
          subtaskId: evt.subtaskId ?? '',
          content: asText,
          timestamp: Date.now(),
        });
      }
      onSubtaskDone(evt.subtaskId ?? '', true);
    };
    const subtaskFailedHandler = (evt: OrchestratorEvent<{ error: string; retryCount: number }>) =>
      onSubtaskDone(evt.subtaskId ?? '', false, evt.data.error);
    const workerThinkingHandler = (evt: OrchestratorEvent<{ workerId: string; record: ThinkingRecord }>) =>
      onWorkerThinking(evt.data.workerId, evt.data.record);
    const workerActionHandler = (evt: OrchestratorEvent<{ workerId: string; record: ActionRecord }>) =>
      onWorkerAction(evt.data.workerId, evt.data.record);

    orchestrator.on('plan:start', planStartHandler);
    orchestrator.on('plan:complete', planCompleteHandler);
    orchestrator.on('subtask:assigned', subtaskAssignedHandler);
    orchestrator.on('subtask:complete', subtaskCompleteHandler);
    orchestrator.on('subtask:failed', subtaskFailedHandler);
    orchestrator.on('worker:thinking', workerThinkingHandler);
    orchestrator.on('worker:action', workerActionHandler);

    const runPromise = orchestrator
      .run(task)
      .then(async (result) => {
        const out = result.output as unknown;
        if (
          result.status !== 'success' &&
          out &&
          typeof out === 'object' &&
          (out as Record<string, unknown>).error === 'need_user_input' &&
          typeof (out as Record<string, unknown>).question === 'string'
        ) {
          const question = (out as Record<string, unknown>).question as string;
          const missingInfo = Array.isArray((out as Record<string, unknown>).missingInfo)
            ? ((out as Record<string, unknown>).missingInfo as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];

          session.waitingForUser = true;
          session.pendingQuestion = question;
          session.variables.pendingObjective = objective;
          if (missingInfo.length > 0) session.variables.pendingMissingInfo = missingInfo;
          await this.sessionStore.saveSession(session);

          push({
            type: 'need_user_input',
            question,
            timestamp: Date.now(),
          });
          return;
        }

        // 更新变量
        session.variables.lastFilesAffected = filesAffected;
        session.variables.lastObjective = objective;
        session.variables.lastRunStatus = result.status;
        if (result.status !== 'success') {
          if (out && typeof out === 'object' && typeof (out as Record<string, unknown>).error === 'string') {
            session.variables.lastRunError = (out as Record<string, unknown>).error;
          }
        } else {
          delete session.variables.lastRunError;
        }
        await this.sessionStore.saveSession(session);

        const summary: ExecutionSummary = {
          success: result.status === 'success',
          subtasksCompleted: session.completedSubtasks.length,
          subtasksFailed: Math.max(0, session.currentPlan ? session.currentPlan.subtasks.length - session.completedSubtasks.length : 0),
          filesAffected,
        };

        await this.sessionStore.addMessage(session.sessionId, {
          role: 'assistant',
          content: `已完成 ${summary.subtasksCompleted} 个子任务`,
          executionSummary: summary,
        });
        this.getContextManager(session.sessionId).addMessage({
          id: `msg-${randomUUID().substring(0, 8)}`,
          role: 'assistant',
          content: `已完成 ${summary.subtasksCompleted} 个子任务`,
          timestamp: Date.now(),
        });

        push({
          type: 'complete',
          success: result.status === 'success',
          summary: `已完成 ${summary.subtasksCompleted} 个子任务，修改了 ${filesAffected.length} 个文件${
            filesAffected.length > 0
              ? `:\n${filesAffected.map((f) => `  - ${f}`).join('\n')}`
              : ''
          }${
            result.status !== 'success' && session.variables.lastRunError
              ? `\n失败原因: ${session.variables.lastRunError}`
              : ''
          }`,
          timestamp: Date.now(),
        });
      })
      .catch((error) => {
        push({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
          timestamp: Date.now(),
        });
      })
      .finally(() => {
        done = true;
        notify?.();
        notify = null;
      });

    while (!done || queue.length > 0) {
      await waitForNext();
      while (queue.length > 0) {
        const evt = queue.shift();
        if (evt) yield evt;
      }
    }

    orchestrator.off('plan:start', planStartHandler);
    orchestrator.off('plan:complete', planCompleteHandler);
    orchestrator.off('subtask:assigned', subtaskAssignedHandler);
    orchestrator.off('subtask:complete', subtaskCompleteHandler);
    orchestrator.off('subtask:failed', subtaskFailedHandler);
    orchestrator.off('worker:thinking', workerThinkingHandler);
    orchestrator.off('worker:action', workerActionHandler);

    await runPromise;
  }
}
