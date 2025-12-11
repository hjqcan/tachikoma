/**
 * Conversational Runner
 *
 * 多轮对话执行器，协调各组件完成任务
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Planner, createLLMClient } from '../planner';
import { createWorkerExecutor, type WorkerExecutor } from '../worker';
import { coreTools, getToolDefinitions } from '../tools';
import { createObservability } from '../observability';

import { SessionStore } from './session-store';
import { IntentAnalyzer } from './intent-analyzer';
import { FeedbackLoop } from './feedback-loop';
import { ConversationContextManager } from './context-manager';
import {
  UserIntent,
  FeedbackAction,
  type ConversationalRunnerConfig,
  type SessionState,
  type StreamEvent,
  type ExecutionSummary,
} from './types';
import type { SubTask } from '../orchestrator/types';

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
  private readonly feedbackLoop: FeedbackLoop;
  private readonly contextManager: ConversationContextManager;
  private executor: WorkerExecutor | null = null;

  constructor(config: ConversationalRunnerConfig) {
    this.config = config;
    this.sessionStore = new SessionStore(config.sessionDir);
    this.intentAnalyzer = new IntentAnalyzer();
    this.feedbackLoop = new FeedbackLoop();
    this.contextManager = new ConversationContextManager(
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

    // 3. 分析意图
    const intent = this.intentAnalyzer.analyze(userMessage, session);

    if (this.config.verbose) {
      console.log(`[ConversationalRunner] Intent: ${intent.intent} (${intent.confidence})`);
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
    yield {
      type: 'thinking',
      content: '正在规划任务...',
      timestamp: Date.now(),
    };

    try {
      // 1. 创建检查点
      if (this.config.enableCheckpoints) {
        await this.sessionStore.createCheckpoint(
          session.sessionId,
          `开始新任务: ${task.substring(0, 50)}...`
        );
      }

      // 2. 规划任务
      const subtasks = await this.planTask(task);

      session.currentPlan = {
        subtasks,
        executionOrder: subtasks.map((s) => s.id),
      };
      session.pendingSubtasks = subtasks.map((s) => s.id);
      session.completedSubtasks = [];
      await this.sessionStore.saveSession(session);

      yield {
        type: 'thinking',
        content: `已规划 ${subtasks.length} 个子任务`,
        timestamp: Date.now(),
      };

      // 3. 执行子任务
      yield* this.executeSubtasks(session);
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
    if (session.pendingSubtasks.length === 0) {
      yield {
        type: 'complete',
        success: true,
        summary: '没有待执行的任务',
        timestamp: Date.now(),
      };
      return;
    }

    yield {
      type: 'thinking',
      content: `继续执行，剩余 ${session.pendingSubtasks.length} 个子任务`,
      timestamp: Date.now(),
    };

    yield* this.executeSubtasks(session);
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

    const modifyPrompt = this.contextManager.buildModifyPrompt(
      session,
      target,
      newValue
    );

    yield {
      type: 'thinking',
      content: `处理修改请求: ${modifyPrompt}`,
      timestamp: Date.now(),
    };

    // 将修改请求作为新任务处理
    yield* this.handleNewTask(session, modifyPrompt);
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

    // 继续执行
    yield* this.executeSubtasks(session);
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
        error: '没有可撤销的检查点',
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
    const context = this.contextManager.buildContext(session);

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
   * 规划任务
   */
  private async planTask(task: string): Promise<SubTask[]> {
    const { apiKey, baseUrl, model } = this.config.llm;

    const llmClient = createLLMClient({
      provider: 'openai',
      model: model ?? 'gpt-4o',
      apiKey,
      ...(baseUrl && { baseUrl }),
      maxTokens: 8192,
    });

    const planner = new Planner({ llmClient });

    const toolDescriptions = getToolDefinitions()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');

    const planResult = await planner.plan({
      task: {
        id: `task-${randomUUID().substring(0, 8)}`,
        type: 'composite',
        objective: task,
        constraints: [
          `当前工作目录: ${resolve(this.config.workDir)}`,
          '所有文件操作使用相对路径',
          `可用工具:\n${toolDescriptions}`,
        ],
        priority: 'medium',
        complexity: 'moderate',
      },
      maxSubtasks: 5,
      availableTools: coreTools.map((t) => t.name),
    });

    if (!planResult.output) {
      throw new Error('规划失败：未返回输出');
    }

    return planResult.output.subtasks;
  }

  /**
   * 执行子任务
   */
  private async *executeSubtasks(
    session: SessionState
  ): AsyncGenerator<StreamEvent> {
    const { apiKey, baseUrl, model } = this.config.llm;

    // 初始化执行器
    if (!this.executor) {
      const obs = createObservability();

      this.executor = await createWorkerExecutor({
        backendConfig: {
          provider: 'openai',
          model: model ?? 'gpt-4o',
          apiKey,
          ...(baseUrl && { baseUrl }),
        },
        workerId: `conv-worker-${randomUUID().substring(0, 4)}`,
        workDir: resolve(this.config.workDir),
        logger: obs.logger,
        tracer: obs.tracer,
        metrics: obs.metrics,
      });
    }

    const filesAffected: string[] = [];

    while (session.pendingSubtasks.length > 0) {
      const subtaskId = session.pendingSubtasks[0];
      
      // noUncheckedIndexedAccess: 数组访问可能返回 undefined
      if (!subtaskId) {
        session.pendingSubtasks.shift();
        continue;
      }
      
      const subtask = session.currentPlan?.subtasks.find((s) => s.id === subtaskId);

      if (!subtask) {
        session.pendingSubtasks.shift();
        continue;
      }

      yield {
        type: 'thinking',
        content: `执行: ${subtask.objective}`,
        timestamp: Date.now(),
      };

      let success = true;
      let error: string | undefined;

      try {
        for await (const msg of this.executor.execute(subtask, coreTools, {
          keyDecisionPolicy: { enabled: false },
        })) {
          switch (msg.type) {
            case 'thinking':
              yield { type: 'thinking', content: msg.content, timestamp: Date.now() };
              break;
            case 'tool_call':
              yield { type: 'tool_call', tool: msg.tool, input: msg.input, timestamp: Date.now() };
              // 追踪文件操作
              if (['file_write', 'apply_patch'].includes(msg.tool)) {
                const path = (msg.input as Record<string, unknown>).path as string;
                if (path && !filesAffected.includes(path)) {
                  filesAffected.push(path);
                }
              }
              break;
            case 'tool_result':
              yield { type: 'tool_result', tool: msg.tool, success: msg.success, timestamp: Date.now() };
              break;
            case 'error':
              error = msg.error;
              success = false;
              break;
          }
        }
      } catch (e) {
        error = String(e);
        success = false;
      }

      yield {
        type: 'subtask_complete',
        subtaskId,
        success,
        timestamp: Date.now(),
      };

      // 更新会话状态
      session.pendingSubtasks.shift();
      if (success) {
        session.completedSubtasks.push(subtaskId);
      }
      await this.sessionStore.saveSession(session);

      // 反馈循环分析
      if (!success && error) {
        const feedback = this.feedbackLoop.analyze(
          {
            success: false,
            subtasksCompleted: session.completedSubtasks.length,
            subtasksFailed: 1,
            filesAffected,
            error,
          },
          session
        );

        if (feedback.action === FeedbackAction.ASK_USER && feedback.question) {
          session.waitingForUser = true;
          session.pendingQuestion = feedback.question;
          await this.sessionStore.saveSession(session);

          yield {
            type: 'need_user_input',
            question: feedback.question ?? '遇到问题，需要您的帮助',
            timestamp: Date.now(),
          };
          return;
        }

        if (feedback.action === FeedbackAction.REPLAN) {
          yield {
            type: 'thinking',
            content: `需要重新规划: ${feedback.replanSuggestion}`,
            timestamp: Date.now(),
          };
          // TODO: 触发重新规划
          break;
        }
      }
    }

    // 更新变量
    session.variables.lastFilesAffected = filesAffected;
    await this.sessionStore.saveSession(session);

    // 记录助手消息
    const summary: ExecutionSummary = {
      success: session.pendingSubtasks.length === 0,
      subtasksCompleted: session.completedSubtasks.length,
      subtasksFailed: 0,
      filesAffected,
    };

    await this.sessionStore.addMessage(session.sessionId, {
      role: 'assistant',
      content: `已完成 ${summary.subtasksCompleted} 个子任务`,
      executionSummary: summary,
    });

    yield {
      type: 'complete',
      success: true,
      summary: `已完成 ${summary.subtasksCompleted} 个子任务，修改了 ${filesAffected.length} 个文件`,
      timestamp: Date.now(),
    };
  }
}
