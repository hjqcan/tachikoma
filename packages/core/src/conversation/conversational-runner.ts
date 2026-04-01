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
import { ConversationPromptBuilder } from './prompt-builder';
import {
  resolveFusionFeatureFlagsFromEnv,
  resolveSessionCompactionConfigFromEnv,
  resolveTodoFsmConfigFromEnv,
} from './session-compaction-env';
import {
  type ConversationalRunnerConfig,
  type SessionState,
  type StreamEvent,
  type ExecutionSummary,
} from './types';
import type { ActionRecord, ThinkingRecord, RecoveryStrategy } from '../orchestrator/session/types';
import { MCPClientManager, loadMCPConfig } from '../mcp';
import {
  executeSkillCommand,
  type SkillCommandContext,
  executeRememberCommand,
  type RememberCommandContext,
} from './commands';
import { thinkingRecordToTrajectory, actionRecordToTrajectory } from '../skills/learning';
import { getAgentIdFromEnv, IdentityUpdater } from '../agent-identity';

type UserLanguage = 'en' | 'zh';

const INIT_PROMPT_TEMPLATE = `Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Code style guidelines including imports, formatting, types, naming conventions, error handling, etc.

The file you create will be given to agentic coding agents (such as yourself) that operate in this repository. Make it about 150 lines long.
If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include them.

If there's already an AGENTS.md, improve it if it's located in \${path}

$ARGUMENTS`;

// =============================================================================
// ConversationalRunner 类
// =============================================================================

/**
 * 多轮对话执行器
 */
export class ConversationalRunner {
  private readonly config: ConversationalRunnerConfig;
  private readonly sessionStore: SessionStore;
  private readonly promptBuilder: ConversationPromptBuilder;
  private readonly contextManagers = new Map<string, ConversationContextManager>();
  private readonly orchestrators = new Map<string, Orchestrator>();
  private mcpClient: MCPClientManager | undefined;
  private mcpInitialized = false;

  constructor(config: ConversationalRunnerConfig) {
    this.config = config;
    this.sessionStore = new SessionStore(config.sessionDir);
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
   * 从检查点恢复执行（供 UI/CLI 调用）
   */
  async *resumeFromCheckpoint(
    sessionId: string,
    options: { checkpointId?: string; strategy?: RecoveryStrategy; restoreWorkspace?: boolean } = {}
  ): AsyncGenerator<StreamEvent> {
    const session = await this.getSession(sessionId);
    if (!session) {
      yield {
        type: 'error',
        error: `Session not found: ${sessionId}`,
        retryable: false,
        timestamp: Date.now(),
      };
      return;
    }

    const checkpointId =
      options.checkpointId ||
      (typeof session.variables.lastSessionCheckpointId === 'string'
        ? session.variables.lastSessionCheckpointId
        : session.checkpoints[session.checkpoints.length - 1]?.id);

    if (!checkpointId) {
      yield {
        type: 'complete',
        success: true,
        summary: this.t(session, {
          en: 'No checkpoint available to retry.',
          zh: '没有可用于重试的检查点。',
        }),
        timestamp: Date.now(),
      };
      return;
    }

    const targetCheckpoint = session.checkpoints.find((cp) => cp.id === checkpointId);
    if (!targetCheckpoint) {
      yield {
        type: 'complete',
        success: false,
        summary: this.t(session, {
          en: `Checkpoint not found: ${checkpointId}. Use /checkpoints to list available checkpoints.`,
          zh: `未找到检查点: ${checkpointId}。可用检查点请运行 /checkpoints。`,
        }),
        timestamp: Date.now(),
      };
      return;
    }

    let orchestratorCheckpointId = targetCheckpoint.orchestratorCheckpointId;
    const fallbackOrchestratorCheckpointId =
      typeof session.variables.lastOrchestratorCheckpointId === 'string'
        ? session.variables.lastOrchestratorCheckpointId
        : undefined;
    if (!orchestratorCheckpointId && fallbackOrchestratorCheckpointId) {
      orchestratorCheckpointId = fallbackOrchestratorCheckpointId;
      targetCheckpoint.orchestratorCheckpointId = fallbackOrchestratorCheckpointId;
      await this.sessionStore.saveSession(session);
      yield {
        type: 'thinking',
        content: this.t(session, {
          en: `Checkpoint ${checkpointId} has no orchestrator snapshot; using latest orchestrator checkpoint.`,
          zh: `检查点 ${checkpointId} 缺少 orchestrator 快照，改用最新的 orchestrator 检查点继续。`,
        }),
        timestamp: Date.now(),
      };
    }
    if (!orchestratorCheckpointId) {
      yield {
        type: 'complete',
        success: false,
        summary: this.t(session, {
          en: `Checkpoint ${checkpointId} has no orchestrator state. Try /continue instead.`,
          zh: `检查点 ${checkpointId} 没有可恢复的执行状态，请尝试 /continue。`,
        }),
        timestamp: Date.now(),
      };
      return;
    }

    const objective =
      typeof session.variables.lastObjective === 'string'
        ? session.variables.lastObjective
        : '';
    const resumePrompt = objective || 'Resume the last task';

    yield {
      type: 'thinking',
      content: this.t(session, {
        en: `Retrying from checkpoint ${checkpointId}...`,
        zh: `从检查点 ${checkpointId} 继续执行...`,
      }),
      timestamp: Date.now(),
    };

    session.variables.activeSessionCheckpointId = checkpointId;
    session.variables.lastSessionCheckpointId = checkpointId;
    delete session.variables.lastOrchestratorCheckpointId;
    await this.sessionStore.saveSession(session);

    const restoreWorkspace = options.restoreWorkspace === true;
    if (restoreWorkspace) {
      const restoreResult = await this.sessionStore.restoreCheckpointAssets(session.sessionId, checkpointId, {
        workspace: true,
        orchestrator: false,
      });
      if (!restoreResult.restoredWorkspace) {
        yield {
          type: 'thinking',
          content: this.t(session, {
            en: 'No workspace snapshot found; resuming without workspace restore.',
            zh: '未找到工作区快照，将在不恢复工作区的情况下继续执行。',
          }),
          timestamp: Date.now(),
        };
      }
    }

    yield* this.runWithOrchestrator(session, resumePrompt, {
      plannerMode: 'patch',
      resumeFromCheckpointId: orchestratorCheckpointId,
      resumeStrategy: options.strategy ?? 'resume',
    });
  }

  /**
   * 处理用户消息（核心入口）
   *
   * 支持 Slash Commands 作为确定性逃生舱:
   * - /undo [steps|checkpointId] - 撤销到检查点
   * - /checkpoints - 列出所有检查点
   * - /continue - 继续上次任务
   * - /retry - 从最近的检查点继续执行
   * - /clear [--checkpoints] - 清空会话
   * - /remember [type] <content> - 记住偏好/模式/原则
   * - /init [args] - 初始化 AGENTS.md
   * - /help - 显示帮助
   */
  async *handleMessage(
    sessionId: string,
    userMessage: string
  ): AsyncGenerator<StreamEvent> {
    // 1. 获取会话
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      const lang = this.detectUserLanguageFromText(userMessage) ?? 'en';
      yield {
        type: 'error',
        error: lang === 'zh' ? `未找到会话: ${sessionId}` : `Session not found: ${sessionId}`,
        retryable: false,
        timestamp: Date.now(),
      };
      return;
    }

    // 2. Slash Commands - 确定性逃生舱，直接在 Runner 层处理
    const trimmed = userMessage.trim();
    if (trimmed.startsWith('/')) {
      const slashResult = yield* this.handleSlashCommand(session, trimmed);
      if (slashResult.handled) {
        return;
      }
      // 未识别的 slash command，作为普通消息处理
    }

    // Persist user language preference (best-effort) for consistent UX across slash commands.
    const inferredLanguage = this.detectUserLanguageFromText(userMessage);
    if (
      inferredLanguage &&
      session.variables.userLanguage !== inferredLanguage
    ) {
      session.variables.userLanguage = inferredLanguage;
      await this.sessionStore.saveSession(session);
    }

    // 3. 记录用户消息
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

    // 4. 如果正在等待用户回答问题，走澄清流程
    if (session.waitingForUser && session.pendingQuestion) {
      yield* this.handleClarify(session, userMessage);
      return;
    }

    // 5. 所有其他消息直接送 Orchestrator，由 LLM 决定操作
    yield* this.handleNewTask(session, userMessage);
  }

  // ---------------------------------------------------------------------------
  // Slash Commands (确定性逃生舱)
  // ---------------------------------------------------------------------------

  private detectUserLanguageFromText(text: string): UserLanguage | undefined {
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
    if (/[A-Za-z]/.test(text)) return 'en';
    return undefined;
  }

  private getUserLanguage(session: SessionState, hint?: string): UserLanguage {
    const stored = session.variables.userLanguage;
    if (stored === 'zh' || stored === 'en') return stored;

    const hintLang = hint ? this.detectUserLanguageFromText(hint) : undefined;
    if (hintLang) return hintLang;

    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg?.role !== 'user') continue;
      const inferred = this.detectUserLanguageFromText(msg.content);
      if (inferred) return inferred;
    }

    return 'en';
  }

  private t(
    session: SessionState,
    strings: { en: string; zh: string },
    hint?: string
  ): string {
    const lang = this.getUserLanguage(session, hint);
    return lang === 'zh' ? strings.zh : strings.en;
  }

  /**
   * 处理 Slash Commands
   */
  private async *handleSlashCommand(
    session: SessionState,
    command: string
  ): AsyncGenerator<StreamEvent, { handled: boolean }> {
    const parts = command.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'undo':
        yield* this.executeUndo(session, args);
        return { handled: true };

      case 'checkpoints':
        yield* this.executeListCheckpoints(session);
        return { handled: true };

      case 'continue':
        yield* this.executeContinue(session, args);
        return { handled: true };

      case 'retry':
        yield* this.executeRetry(session, args);
        return { handled: true };

      case 'clear':
        yield* this.executeClear(session, args);
        return { handled: true };

      case 'help':
        yield* this.executeHelp(session);
        return { handled: true };

      case 'skill':
        yield* this.executeSkill(session, args);
        return { handled: true };

      case 'remember':
      case '记住':
        yield* this.executeRemember(session, args);
        return { handled: true };

      case 'init':
        yield* this.executeInit(session, args);
        return { handled: true };

      default:
        // 未识别的命令，返回未处理
        return { handled: false };
    }
  }

  /**
   * /undo [steps|checkpointId] - 撤销到检查点
   */
  private async *executeUndo(
    session: SessionState,
    args: string[]
  ): AsyncGenerator<StreamEvent> {
    const checkpoints = session.checkpoints;
    
    if (checkpoints.length === 0) {
      yield {
        type: 'complete',
        success: false,
        summary: this.config.enableCheckpoints
          ? this.t(session, {
              en: 'No checkpoints available. This may be the first interaction in this session.',
              zh: '没有可用的检查点，可能这是该会话的第一次交互。',
            })
          : this.t(session, {
              en: 'Checkpoints are disabled. Enable with enableCheckpoints: true in config.',
              zh: '检查点功能已禁用。请在配置中设置 enableCheckpoints: true。',
            }),
        timestamp: Date.now(),
      };
      return;
    }

    let targetCheckpoint;
    const arg = args[0];

    if (arg) {
      // Try to parse as step count or checkpoint ID
      const steps = parseInt(arg, 10);
      if (!isNaN(steps) && steps > 0) {
        // /undo N = go back N checkpoints from the end
        // /undo 1 = latest checkpoint, /undo 2 = second-to-last, etc.
        const targetIndex = checkpoints.length - steps;
        if (targetIndex < 0) {
          yield {
            type: 'complete',
            success: false,
            summary: this.t(session, {
              en: `Only ${checkpoints.length} checkpoint(s) available. Cannot go back ${steps} step(s).`,
              zh: `当前只有 ${checkpoints.length} 个检查点，无法回退 ${steps} 步。`,
            }),
            timestamp: Date.now(),
          };
          return;
        }
        targetCheckpoint = checkpoints[targetIndex];
      } else {
        // Treat as checkpoint ID
        targetCheckpoint = checkpoints.find(cp => cp.id === arg);
        if (!targetCheckpoint) {
          yield {
            type: 'complete',
            success: false,
            summary: this.t(session, {
              en: `Checkpoint not found: ${arg}. Use /checkpoints to list available checkpoints.`,
              zh: `未找到检查点: ${arg}。可用检查点请运行 /checkpoints。`,
            }),
            timestamp: Date.now(),
          };
          return;
        }
      }
    } else {
      // Default: roll back to the latest checkpoint
      // Since slash commands are processed BEFORE checkpoint creation,
      // we should use the most recent checkpoint (not skip it)
      targetCheckpoint = checkpoints[checkpoints.length - 1];
    }

    if (!targetCheckpoint) {
      yield {
        type: 'complete',
        success: false,
        summary: this.t(session, {
          en: 'Failed to determine target checkpoint.',
          zh: '无法确定要回滚到哪个检查点。',
        }),
        timestamp: Date.now(),
      };
      return;
    }

    yield {
      type: 'thinking',
      content: this.t(session, {
        en: `Rolling back to checkpoint: ${targetCheckpoint.description}`,
        zh: `正在回滚到检查点: ${targetCheckpoint.description}`,
      }),
      timestamp: Date.now(),
    };

    await this.sessionStore.rollbackToCheckpoint(session.sessionId, targetCheckpoint.id);

    yield {
      type: 'complete',
      success: true,
      summary: this.t(session, {
        en: `Rolled back to: ${targetCheckpoint.description}`,
        zh: `已回滚到: ${targetCheckpoint.description}`,
      }),
      timestamp: Date.now(),
    };
  }

  /**
   * /checkpoints - 列出所有检查点
   */
  private async *executeListCheckpoints(
    session: SessionState
  ): AsyncGenerator<StreamEvent> {
    const checkpoints = session.checkpoints;

    if (checkpoints.length === 0) {
      yield {
        type: 'complete',
        success: true,
        summary: this.t(session, {
          en: 'No checkpoints in this session.',
          zh: '本会话没有检查点。',
        }),
        timestamp: Date.now(),
      };
      return;
    }

    const now = Date.now();
    const lang = this.getUserLanguage(session);
    const lines = checkpoints.map((cp, i) => {
      const age = this.formatAge(now - cp.timestamp, lang);
      return `${i + 1}. [${cp.id}] ${cp.description} (${age})`;
    });

    yield {
      type: 'complete',
      success: true,
      summary: this.t(session, {
        en: `Available checkpoints:\n${lines.join('\n')}`,
        zh: `可用检查点:\n${lines.join('\n')}`,
      }),
      timestamp: Date.now(),
    };
  }

  /**
   * /continue - Continue the last unfinished task
   */
  private async *executeContinue(
    session: SessionState,
    args: string[]
  ): AsyncGenerator<StreamEvent> {
    const lastObjective = session.variables.lastObjective;
    const pendingSubtasks = session.pendingSubtasks || [];

    if (!lastObjective && pendingSubtasks.length === 0) {
      yield {
        type: 'complete',
        success: true,
        summary: this.t(session, {
          en: 'No pending task to continue.',
          zh: '没有可继续的未完成任务。',
        }),
        timestamp: Date.now(),
      };
      return;
    }

    const additionalContext = args.join(' ');
    const objective = typeof lastObjective === 'string' ? lastObjective : '';
    
    const continuePrompt = additionalContext 
      ? `Continue the previous task: ${objective}\n\nAdditional context: ${additionalContext}`
      : `Continue the previous task: ${objective}`;

    if (this.config.enableCheckpoints) {
      const normalized = continuePrompt.replace(/\s+/g, ' ').trim();
      const preview = normalized.length > 50 ? `${normalized.substring(0, 50)}...` : normalized;
      const checkpoint = await this.sessionStore.createCheckpoint(
        session.sessionId,
        this.t(session, {
          en: `Continue task: ${preview}`,
          zh: `继续任务: ${preview}`,
        }),
        {
          includeWorkspaceSnapshot: true,
          includeOrchestratorSnapshot: true,
        }
      );
      if (!session.checkpoints.some((cp) => cp.id === checkpoint.id)) {
        session.checkpoints.push(checkpoint);
      }
      session.variables.activeSessionCheckpointId = checkpoint.id;
      session.variables.lastSessionCheckpointId = checkpoint.id;
      delete session.variables.lastOrchestratorCheckpointId;
      await this.sessionStore.saveSession(session);
    }

    yield {
      type: 'thinking',
      content: this.t(session, {
        en: `Continuing task: ${objective || '(previous task)'}`,
        zh: `继续任务: ${objective || '（上一次任务）'}`,
      }),
      timestamp: Date.now(),
    };

    // Prefer patch mode when there are pending subtasks (incremental progress)
    // Use full mode only when starting completely fresh
    const hasPendingWork = pendingSubtasks.length > 0 || session.currentPlan;
    yield* this.runWithOrchestrator(session, continuePrompt, { 
      plannerMode: hasPendingWork ? 'patch' : 'full' 
    });
  }

  /**
   * /retry - Resume from the latest checkpoint (best-effort)
   */
  private async *executeRetry(
    session: SessionState,
    args: string[]
  ): AsyncGenerator<StreamEvent> {
    const candidate = args[0];
    const checkpointId =
      (candidate && candidate.startsWith('ckpt-') && candidate) ||
      (typeof session.variables.lastSessionCheckpointId === 'string'
        ? session.variables.lastSessionCheckpointId
        : session.checkpoints[session.checkpoints.length - 1]?.id);

    yield* this.resumeFromCheckpoint(session.sessionId, {
      ...(checkpointId && { checkpointId }),
      restoreWorkspace: false,
    });
  }

  /**
   * /clear [--checkpoints] [--no-session] - Clear conversation history
   * 
   * Letta semantics:
   * - Clears session messages, context cache, and variables
   * - Preserves Memory Blocks and AgentIdentity
   * - Increments sessionsCount (unless --no-session)
   *
   * Note: Only clears messages and context. Plan state (currentPlan, subtasks) 
   * is managed by Orchestrator and will be rehydrated from session files.
   */
  private async *executeClear(
    session: SessionState,
    args: string[]
  ): AsyncGenerator<StreamEvent> {
    const clearCheckpoints = args.includes('--checkpoints');
    const skipSessionCount = args.includes('--no-session');

    // Clear conversation history only (plan state is canonical in orchestrator files)
    session.messages = [];
    delete session.compressedHistory;
    session.waitingForUser = false;
    delete session.pendingQuestion;
    const preservedLanguage = session.variables.userLanguage;
    session.variables = {};
    if (preservedLanguage === 'zh' || preservedLanguage === 'en') {
      session.variables.userLanguage = preservedLanguage;
    }

    if (clearCheckpoints) {
      session.checkpoints = [];
    }

    await this.sessionStore.saveSession(session);

    // Clear context manager cache
    this.contextManagers.delete(session.sessionId);

    // Letta semantics: increment session count (new "conversation session")
    if (!skipSessionCount) {
      try {
        const agentId = getAgentIdFromEnv();
        const updater = new IdentityUpdater();
        await updater.incrementSessionCount(agentId);
      } catch {
        // Identity not initialized yet, skip session count increment
      }
    }

    yield {
      type: 'complete',
      success: true,
      summary: clearCheckpoints
        ? this.t(session, {
            en: 'Conversation cleared (including checkpoints). Memory and identity preserved. Note: Active task state is preserved.',
            zh: '对话已清空（包含检查点）。记忆和身份已保留。注意：当前任务状态会保留。',
          })
        : this.t(session, {
            en: 'Conversation cleared. Memory, identity, and checkpoints preserved. Note: Active task state is preserved.',
            zh: '对话已清空。记忆、身份和检查点已保留。注意：当前任务状态会保留。',
          }),
      timestamp: Date.now(),
    };
  }

  /**
   * /help - 显示帮助
   */
  private async *executeHelp(session: SessionState): AsyncGenerator<StreamEvent> {
    yield {
      type: 'complete',
      success: true,
      summary: this.t(session, {
        en: `Available commands:
/undo [steps|id]         - Roll back to a checkpoint (default: latest)
/checkpoints             - List all available checkpoints
/continue [context]      - Continue the last unfinished task
/retry [checkpointId]    - Resume from latest checkpoint
/clear [--checkpoints]   - Clear conversation (preserves memory/identity)
/remember [type] <text>  - Remember preference/pattern/principle
/skill [subcommand]      - Manage skills (list/load/unload/learn)
/init [args]             - Create or update AGENTS.md
/help                    - Show this help message

All other messages are sent to the AI for processing.`,
        zh: `可用命令:
/undo [steps|id]         - 回滚到检查点（默认：最近）
/checkpoints             - 列出所有检查点
/continue [context]      - 继续上一次未完成任务
/retry [checkpointId]    - 从最近检查点继续执行
/clear [--checkpoints]   - 清空对话（保留记忆/身份）
/remember [类型] <内容>   - 记住偏好/模式/原则
/skill [子命令]          - 管理技能（list/load/unload/learn）
/init [参数]             - 创建或更新 AGENTS.md
/help                    - 显示帮助

其他消息会发送给 AI 处理。`,
      }),
      timestamp: Date.now(),
    };
  }

  /**
   * /init [args] - Initialize AGENTS.md
   */
  private async *executeInit(
    session: SessionState,
    args: string[],
  ): AsyncGenerator<StreamEvent> {
    const initPrompt = this.buildInitPrompt(args);

    yield {
      type: 'thinking',
      content: this.t(session, {
        en: 'Initializing project rules (AGENTS.md)...',
        zh: '正在初始化项目规则（AGENTS.md）...',
      }),
      timestamp: Date.now(),
    };

    yield* this.handleNewTask(session, initPrompt);
  }

  private buildInitPrompt(args: string[]): string {
    const argumentText = args.join(' ').trim();
    const withPath = INIT_PROMPT_TEMPLATE.replace(
      '${path}',
      this.config.workDir
    );
    if (!argumentText) {
      return withPath.replace('$ARGUMENTS', '').trim();
    }
    return withPath.replace('$ARGUMENTS', argumentText).trim();
  }

  /**
   * /remember [type] <content> - 记住偏好/模式/原则
   */
  private async *executeRemember(
    session: SessionState,
    args: string[],
  ): AsyncGenerator<StreamEvent> {
    const ctx: RememberCommandContext = {
      session,
      workDir: this.config.workDir,
      // 使用环境变量或默认值作为稳定 identity key
      agentId: getAgentIdFromEnv(),
      t: (strings: { en: string; zh: string }) => this.t(session, strings),
    };

    yield* executeRememberCommand(args, ctx);
  }

  /**
   * /skill [subcommand] - 管理技能
   */
  private async *executeSkill(
    session: SessionState,
    args: string[],
  ): AsyncGenerator<StreamEvent> {
    const ctx: SkillCommandContext = {
      session,
      workDir: this.config.workDir,
      // 使用配置的 LLM 为 /skill learn 提供能力
      llmCall: async (prompt: string) => {
        const client = createLLMClient({
          provider: 'openai',
          model: this.config.llm.model ?? 'gpt-4o',
          apiKey: this.config.llm.apiKey,
          ...(this.config.llm.baseUrl && { baseUrl: this.config.llm.baseUrl }),
          maxTokens: 8192,
        });
        const response = await client.complete({
          systemPrompt: 'You are a helpful assistant specialized in analyzing code execution patterns.',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 4096,
        });
        return response.content ?? '';
      },
      t: (strings: { en: string; zh: string }) => this.t(session, strings),
      getTrajectory: async () => {
        // 从 session variables 获取最近的轨迹
        const thinking = session.variables.recentThinking as ThinkingRecord[] | undefined;
        const actions = session.variables.recentActions as ActionRecord[] | undefined;
        const trajectories: ReturnType<typeof thinkingRecordToTrajectory>[] = [];
        
        if (Array.isArray(thinking)) {
          for (const r of thinking) {
            trajectories.push(thinkingRecordToTrajectory(r));
          }
        }
        if (Array.isArray(actions)) {
          for (const r of actions) {
            trajectories.push(actionRecordToTrajectory(r));
          }
        }
        trajectories.sort((a, b) => a.timestamp - b.timestamp);
        return trajectories;
      },
    };

    yield* executeSkillCommand(args, ctx);
  }

  /**
   * 格式化时间差
   */
  private formatAge(ms: number, lang: UserLanguage): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (lang === 'zh') {
      if (seconds < 60) return `${seconds}秒前`;
      if (minutes < 60) return `${minutes}分钟前`;
      if (hours < 24) return `${hours}小时前`;
      return `${days}天前`;
    }
    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
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
        const normalized = task.replace(/\s+/g, ' ').trim();
        const preview = normalized.length > 50 ? `${normalized.substring(0, 50)}...` : normalized;
        const checkpoint = await this.sessionStore.createCheckpoint(
          session.sessionId,
          this.t(session, {
            en: `Start new task: ${preview}`,
            zh: `开始新任务: ${preview}`,
          }, task),
          {
            includeWorkspaceSnapshot: true,
            includeOrchestratorSnapshot: true,
          }
        );
        if (!session.checkpoints.some((cp) => cp.id === checkpoint.id)) {
          session.checkpoints.push(checkpoint);
        }
        session.variables.activeSessionCheckpointId = checkpoint.id;
        session.variables.lastSessionCheckpointId = checkpoint.id;
        delete session.variables.lastOrchestratorCheckpointId;
        await this.sessionStore.saveSession(session);
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
      content: this.t(session, {
        en: `Received: ${answer}`,
        zh: `收到回答: ${answer}`,
      }, answer),
      timestamp: Date.now(),
    };

    const pendingObjective = session.variables.pendingObjective;
    if (typeof pendingObjective === 'string' && pendingObjective.trim()) {
      delete session.variables.pendingObjective;
      delete session.variables.pendingMissingInfo;
      await this.sessionStore.saveSession(session);
      yield* this.handleNewTask(
        session,
        `${pendingObjective}\n\n[User additional info]\n${answer}`
      );
      return;
    }

    yield* this.handleNewTask(session, answer);
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
  private async getOrchestrator(session: SessionState): Promise<Orchestrator> {
    // 初始化 MCP 客户端（懒加载）
    await this.initializeMCPClient();

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
      cwd: resolve(this.config.workDir),
    });

    const sessionCompactionOverrides = resolveSessionCompactionConfigFromEnv(process.env);
    const todoFsmOverrides = resolveTodoFsmConfigFromEnv(process.env);
    const featureFlagsOverrides = resolveFusionFeatureFlagsFromEnv(process.env);

    const orchestrator = new Orchestrator(`orch-${session.sessionId}`, {
      planner,
      config: {
        session: {
          rootDir: resolve(this.config.sessionDir),
          enableWatch: true,
          watchPollInterval: 300,
        },
        checkpoint: {
          enabled: this.config.enableCheckpoints ?? false,
          storageDir: '.tachikoma/checkpoints',
          interval: 15000,
          maxCheckpoints: 20,
          gitIntegration: false,
        },
        // 禁用审批：自动批准所有请求
        ...(this.config.noApproval && {
          approval: {
            defaultDecision: 'approve' as const,
            autoApproveTypes: [
              'file_deletion',
              'multi_file_refactor',
              'external_api_call',
              'dangerous_operation',
              'resource_intensive',
            ],
            autoRejectTypes: [],
            lowImpactAutoApprove: true,
            reversibleAutoApprove: true,
            timeout: 1000, // 1秒超时
          },
        }),
        ...(sessionCompactionOverrides && { sessionCompaction: sessionCompactionOverrides }),
        ...(todoFsmOverrides && { todoFsm: todoFsmOverrides }),
        ...(featureFlagsOverrides && { featureFlags: featureFlagsOverrides }),
      },
      // 传递 MCP 客户端（仅在已初始化时）
      ...(this.mcpClient && { mcpClient: this.mcpClient }),
    });

    this.orchestrators.set(session.sessionId, orchestrator);
    return orchestrator;
  }

  /**
   * 初始化 MCP 客户端管理器（懒加载，只初始化一次）
   */
  private async initializeMCPClient(): Promise<void> {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;

    try {
      // 从工作目录加载 mcp.json 配置
      const mcpConfig = await loadMCPConfig(this.config.workDir);
      
      if (!mcpConfig || !mcpConfig.servers || mcpConfig.servers.length === 0) {
        console.debug('[ConversationalRunner] No MCP servers configured');
        return;
      }

      // 创建 MCP 客户端管理器
      this.mcpClient = new MCPClientManager(mcpConfig);

      // 连接所有配置的服务器（并行）
      const servers = mcpConfig.servers;
      const client = this.mcpClient;
      
      const connectionPromises = servers
        .filter(server => server.enabled !== false)
        .map(async (serverConfig) => {
          try {
            await client.connect(serverConfig);
            console.debug(`[ConversationalRunner] Connected to MCP server: ${serverConfig.name}`);
            return { name: serverConfig.name, status: 'fulfilled' };
          } catch (err) {
            console.warn(`[ConversationalRunner] Failed to connect to MCP server ${serverConfig.name}:`, err);
            return { name: serverConfig.name, status: 'rejected', reason: err };
          }
        });

      await Promise.allSettled(connectionPromises);

      console.info(`[ConversationalRunner] MCP client initialized with ${client.getConnectedServers().length} servers`);
    } catch (err) {
      console.warn('[ConversationalRunner] Failed to initialize MCP client:', err);
    }
  }

  /**
   * 对话驱动的执行入口（内部调用 Orchestrator）
   */
  private async *runWithOrchestrator(
    session: SessionState,
    objective: string,
    options: {
      plannerMode: 'full' | 'patch';
      maxSubtasks?: number;
      resumeFromCheckpointId?: string;
      resumeStrategy?: RecoveryStrategy;
    } = { plannerMode: 'full' }
  ): AsyncGenerator<StreamEvent> {
    const orchestrator = await this.getOrchestrator(session);
    const taskId = `task-${randomUUID().substring(0, 8)}`;

    const contextText = this.promptBuilder.buildContext(session);

    const task: Task = {
      id: taskId,
      type: 'composite',
      objective,
      constraints: [
        `Current working directory: ${resolve(this.config.workDir)}`,
        'All file operations must use relative paths.',
        'Definition of Done (default): build + smoke for runnable apps/services.',
        'For frontend apps with data backends, smoke includes browser verification: page renders and data fetch succeeds.',
        'Verification: run the smallest relevant build/test/smoke commands when available; do not claim success without verification.',
        ...(contextText
          ? [`Conversation context (for reference only; do not quote verbatim):\n${contextText}`]
          : []),
      ],
      context: {
        parentTaskId: session.sessionId,
        sessionId: session.sessionId,
        metadata: {
          workDir: resolve(this.config.workDir),
          // 默认使用 `.taskmaster/tasks/tasks.json` 作为唯一任务真相（按 sessionId 做 tag 隔离）
          planSource: 'taskmaster',
          taskmaster: {
            enabled: true,
            tag: session.sessionId,
          },
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
          // 禁用关键决策审批（测试模式）
          ...(this.config.noApproval && { noApproval: true }),
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
    const extractApplyPatchFiles = (input: unknown): string[] => {
      const files = new Set<string>();
      if (isRecord(input)) {
        const directPath = input.path;
        if (typeof directPath === 'string' && directPath.trim()) {
          files.add(directPath.trim());
        }
      }

      const patchText = (() => {
        if (typeof input === 'string') return input;
        if (!isRecord(input)) return null;
        const candidates = ['freeform', 'patch', 'diff', 'content', 'input'];
        for (const key of candidates) {
          const value = input[key];
          if (typeof value === 'string') return value;
        }
        return null;
      })();

      if (!patchText) {
        return Array.from(files);
      }

      for (const line of patchText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*** Update File:')) {
          files.add(trimmed.replace('*** Update File:', '').trim());
          continue;
        }
        if (trimmed.startsWith('*** Add File:')) {
          files.add(trimmed.replace('*** Add File:', '').trim());
          continue;
        }
        if (trimmed.startsWith('*** Delete File:')) {
          files.add(trimmed.replace('*** Delete File:', '').trim());
          continue;
        }
        if (trimmed.startsWith('*** Move to:')) {
          files.add(trimmed.replace('*** Move to:', '').trim());
          continue;
        }
      }

      return Array.from(files);
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
      push({
        type: 'thinking',
        content: this.t(session, { en: 'Planning task...', zh: '正在规划任务...' }),
        timestamp: Date.now(),
      });
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
        content: this.t(session, {
          en: `Planned ${plan.subtasks.length} subtask(s)${
            plan.roles ? ` across ${plan.roles.length} role(s)` : ''
          }`,
          zh: `已规划 ${plan.subtasks.length} 个子任务${
            plan.roles ? `，分配给 ${plan.roles.length} 个角色` : ''
          }`,
        }),
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
      // 记录轨迹到 session.variables（供 /skill learn 使用）
      if (!Array.isArray(session.variables.recentThinking)) {
        session.variables.recentThinking = [];
      }
      const thinkingBuffer = session.variables.recentThinking as ThinkingRecord[];
      thinkingBuffer.push(record);
      // 保持最近 50 条思考记录
      if (thinkingBuffer.length > 50) {
        session.variables.recentThinking = thinkingBuffer.slice(-50);
      }

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
      // 记录轨迹到 session.variables（供 /skill learn 使用）
      if (!Array.isArray(session.variables.recentActions)) {
        session.variables.recentActions = [];
      }
      const actionBuffer = session.variables.recentActions as ActionRecord[];
      actionBuffer.push(record);
      // 保持最近 50 条动作记录
      if (actionBuffer.length > 50) {
        session.variables.recentActions = actionBuffer.slice(-50);
      }

      const desc = record.description ?? '';

      const callingMatch = desc.match(/^Calling tool:\s*(.+)$/);
      if (callingMatch) {
        const tool = callingMatch[1] ?? 'unknown';
        const input = (record.params?.input as Record<string, unknown> | undefined) ?? {};
        push({ type: 'tool_call', tool, input, timestamp: Date.now() });

        // 追踪文件操作（用于 summary）
        if (tool === 'file_write') {
          const path = (input as Record<string, unknown>).path as string | undefined;
          if (path && !filesAffected.includes(path)) filesAffected.push(path);
        }
        if (tool === 'apply_patch') {
          const paths = extractApplyPatchFiles(input);
          for (const path of paths) {
            if (path && !filesAffected.includes(path)) filesAffected.push(path);
          }
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
    const checkpointCreatedHandler = (evt: OrchestratorEvent<{ checkpointId: string }>) => {
      const orchestratorCheckpointId = evt.data?.checkpointId;
      if (!orchestratorCheckpointId) return;
      const activeSessionCheckpointId =
        typeof session.variables.activeSessionCheckpointId === 'string'
          ? session.variables.activeSessionCheckpointId
          : undefined;
      if (activeSessionCheckpointId) {
        const target = session.checkpoints.find((cp) => cp.id === activeSessionCheckpointId);
        if (target) {
          target.orchestratorCheckpointId = orchestratorCheckpointId;
        }
        session.variables.lastSessionCheckpointId = activeSessionCheckpointId;
      }
      session.variables.lastOrchestratorCheckpointId = orchestratorCheckpointId;
      void this.sessionStore.saveSession(session);
    };

    orchestrator.on('plan:start', planStartHandler);
    orchestrator.on('plan:complete', planCompleteHandler);
    orchestrator.on('subtask:assigned', subtaskAssignedHandler);
    orchestrator.on('subtask:complete', subtaskCompleteHandler);
    orchestrator.on('subtask:failed', subtaskFailedHandler);
    orchestrator.on('worker:thinking', workerThinkingHandler);
    orchestrator.on('worker:action', workerActionHandler);
    orchestrator.on('checkpoint:created', checkpointCreatedHandler);

    const runPromise = (options.resumeFromCheckpointId
      ? orchestrator.resumeFrom(options.resumeFromCheckpointId, {
          strategy: options.resumeStrategy ?? 'resume',
        })
      : orchestrator.run(task))
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
          subtasksFailed: session.currentPlan
            ? session.currentPlan.subtasks.filter((st) => st.status === 'failure').length
            : 0,
          filesAffected,
        };

        const lang = this.getUserLanguage(session);
        const assistantLine =
          lang === 'zh'
            ? `已完成 ${summary.subtasksCompleted} 个子任务`
            : `Completed ${summary.subtasksCompleted} subtask(s)`;

        await this.sessionStore.addMessage(session.sessionId, {
          role: 'assistant',
          content: assistantLine,
          executionSummary: summary,
        });
        this.getContextManager(session.sessionId).addMessage({
          id: `msg-${randomUUID().substring(0, 8)}`,
          role: 'assistant',
          content: assistantLine,
          timestamp: Date.now(),
        });

        const baseSummary =
          lang === 'zh'
            ? `已完成 ${summary.subtasksCompleted} 个子任务，修改了 ${filesAffected.length} 个文件`
            : `Completed ${summary.subtasksCompleted} subtask(s), modified ${filesAffected.length} file(s)`;
        const fileList =
          filesAffected.length > 0
            ? `:\n${filesAffected.map((f) => `  - ${f}`).join('\n')}`
            : '';
        const errorPart =
          result.status !== 'success' && session.variables.lastRunError
            ? lang === 'zh'
              ? `\n失败原因: ${session.variables.lastRunError}`
              : `\nFailure reason: ${session.variables.lastRunError}`
            : '';

        push({
          type: 'complete',
          success: result.status === 'success',
          summary: `${baseSummary}${fileList}${errorPart}`,
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
        if (session.variables.activeSessionCheckpointId) {
          delete session.variables.activeSessionCheckpointId;
          void this.sessionStore.saveSession(session);
        }
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
    orchestrator.off('checkpoint:created', checkpointCreatedHandler);

    await runPromise;
  }
}
