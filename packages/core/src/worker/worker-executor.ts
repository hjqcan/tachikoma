/**
 * Worker 执行器
 *
 * 连接 WorkerPool 和 IWorkerBackend，处理任务执行流程
 * 集成 SessionFileManager 实现审计日志
 */

import { createHash } from 'node:crypto';
import type { Tool } from '../types';
import type { SubTask } from '../orchestrator/types';
import type {
  ISessionFileManager,
  SharedContextFile,
  SharedExecutionStateContract,
  SharedKnowledgeData,
  SharedTodoItem,
  SharedTodoSnapshot,
  SyncLogEntry,
  WorkerStatusFile,
} from '../orchestrator/session/types';
import type {
  IWorkerBackend,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
  WorkerBackendConfig,
  WorkerExecutionMetrics,
} from './types';
import { createWorkerBackend } from './backend-factory';
import type { Logger, Tracer, MetricsCollector, Span } from '../observability';
import { noopLogger, createTracer, noopMetrics, WORKER_METRICS } from '../observability';
import type { MCPClientManager } from '../mcp';
import { MCPToolRegistrar } from '../mcp';
import { globalToolRegistry } from '../tools/registry';
import { cleanupAllForTask } from '../tools/core/shell-run';
import { deriveConstraintPolicy, detectConstraintConflicts } from './engines';
import { resolveToolProfile, runToolPreflight } from './tool-runtime';

// ============================================================================
// 类型定义
// ============================================================================

/** Worker 心跳间隔（避免长时间工具调用导致 stale） */
const HEARTBEAT_INTERVAL_MS = 30_000;
const TODO_TOOLS = new Set(['todowrite', 'todoread']);

/**
 * Worker 执行器配置
 */
export interface WorkerExecutorConfig {
  /** 后端配置 */
  backendConfig: WorkerBackendConfig;
  /** 会话管理器（可选，用于审计日志） */
  sessionManager?: ISessionFileManager | undefined;
  /** 工作目录 */
  workDir?: string | undefined;
  /** Worker ID */
  workerId: string;
  /** Logger 实例（可选） */
  logger?: Logger | undefined;
  /** Tracer 实例（可选） */
  tracer?: Tracer | undefined;
  /** Metrics 收集器（可选） */
  metrics?: MetricsCollector | undefined;
  /** MCP 客户端管理器（可选，用于 MCP 工具集成） */
  mcpClient?: MCPClientManager | undefined;
  /** 是否自动注册 MCP 工具到 ToolRegistry（默认 true） */
  autoRegisterMCPTools?: boolean | undefined;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 执行指标 */
  metrics: WorkerExecutionMetrics;
  /** 所有消息 */
  messages: WorkerMessage[];
  /** 错误信息 */
  error?: string | undefined;
  /** 
   * 任务执行期间修改的文件列表 (用于 VerificationGate 范围限定)
   * File paths modified during task execution (for VerificationGate scoping)
   */
  modifiedFiles?: string[] | undefined;
}

// ============================================================================
// WorkerExecutor 实现
// ============================================================================

/**
 * Worker 执行器
 *
 * 职责：
 * 1. 管理 IWorkerBackend 生命周期
 * 2. 将 SubTask 转换为 WorkerTask
 * 3. 流式处理消息并写入审计日志
 * 4. 收集执行指标
 *
 * @example
 * ```ts
 * const executor = new WorkerExecutor({
 *   backendConfig: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
 *   sessionManager: sessionFileManager,
 *   workerId: 'worker-001',
 * });
 *
 * await executor.initialize();
 *
 * for await (const msg of executor.execute(subtask, tools)) {
 *   console.log(msg);
 * }
 *
 * await executor.dispose();
 * ```
 */
export class WorkerExecutor {
  private readonly config: WorkerExecutorConfig;
  private backend: IWorkerBackend | null = null;
  private isInitialized = false;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly metrics: MetricsCollector;
  private mcpRegistrar: MCPToolRegistrar | null = null;

  constructor(config: WorkerExecutorConfig) {
    this.config = config;
    this.logger = config.logger ?? noopLogger;
    this.tracer = config.tracer ?? createTracer({ enabled: false });
    this.metrics = config.metrics ?? noopMetrics;
  }

  /**
   * 初始化执行器
   *
   * 创建后端实例
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.backend = await createWorkerBackend(this.config.backendConfig);

    // MCP 工具自动注册
    if (this.config.mcpClient && this.config.autoRegisterMCPTools !== false) {
      this.mcpRegistrar = new MCPToolRegistrar(
        this.config.mcpClient,
        globalToolRegistry
      );
      const result = await this.mcpRegistrar.registerAll();
      this.logger.info('MCP tools registered', {
        registered: result.registered,
        skipped: result.skipped,
        failed: result.failed.size,
      });
    }

    this.isInitialized = true;
  }

  /**
   * 获取后端实例
   */
  getBackend(): IWorkerBackend | null {
    return this.backend;
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.isInitialized && this.backend !== null && this.backend.isAvailable();
  }

  /**
   * 执行子任务
   *
   * @param subtask - 子任务
   * @param tools - 可用工具列表
   * @param options - 执行选项
   * @returns 消息流
   */
  async *execute(
    subtask: SubTask,
    tools: Tool[],
    options: Partial<WorkerExecutionOptions> = {}
  ): AsyncIterable<WorkerMessage> {
    if (!this.backend) {
      throw new Error('WorkerExecutor not initialized. Call initialize() first.');
    }

    const workerId = this.config.workerId;
    const sessionManager = this.config.sessionManager;

    // selective memory sync：从 shared context 注入“关键决策/产物”摘要到约束（best-effort）
    const injectedSharedConstraint = await this.buildSharedContextConstraint(sessionManager);

    const rawConstraints = Array.isArray(subtask.constraints)
      ? [...subtask.constraints]
      : [];
    if (injectedSharedConstraint) {
      rawConstraints.push(injectedSharedConstraint);
    }
    const requestedToolProfile = resolveToolProfile(options.toolProfile, options.env);
    const preflight = runToolPreflight({
      tools,
      constraints: rawConstraints,
      profile: requestedToolProfile,
    });
    const runtimeTools = preflight.nativeTools;
    const sanitizedConstraints = preflight.sanitizedConstraints;
    const removedToolHints = preflight.removedToolHints;

    if (removedToolHints.length > 0) {
      const preview = removedToolHints.slice(0, 5).join(', ');
      const remaining = removedToolHints.length - Math.min(removedToolHints.length, 5);
      const suffix = remaining > 0 ? `, +${remaining} more` : '';
      console.info(
        `[WorkerExecutor] Removed unavailable tool hints from constraints: ${preview}${suffix}`
      );
    }
    if (preflight.notes.length > 0) {
      for (const note of preflight.notes) {
        this.logger.info('Tool preflight note', { workerId, note, profile: preflight.profile });
      }
    }
    if (preflight.mismatchCount > 0) {
      this.metrics.increment(
        WORKER_METRICS.TOOL_PREFLIGHT_MISMATCH_COUNT,
        preflight.mismatchCount,
        { workerId, profile: preflight.profile }
      );
    }
    if (preflight.profile !== requestedToolProfile) {
      this.logger.warn('Tool profile adjusted by preflight', {
        workerId,
        requestedProfile: requestedToolProfile,
        resolvedProfile: preflight.profile,
      });
    }

    // 转换 SubTask 为 WorkerTask（注意：必须传递 parentObjective 以支持技能匹配上下文）
    const workerTask: WorkerTask = {
      id: subtask.id,
      type: 'atomic', // 子任务默认为原子任务
      objective: subtask.objective,
      constraints: sanitizedConstraints,
      parentTaskId: subtask.parentId,
      ...(subtask.parentObjective !== undefined && { parentObjective: subtask.parentObjective }),
      ...(subtask.priority !== undefined && { priority: subtask.priority }),
    };

    // 构建执行选项
    // 自动注入 SESSION_ID 和 WORKER_ID 到 env，供工具使用
    const sessionId = sessionManager?.sessionId ?? options.env?.SESSION_ID;
    const injectedEnv: Record<string, string> = {
      ...options.env,
    };
    if (sessionId) {
      injectedEnv.SESSION_ID = String(sessionId);
    }
    if (workerId) {
      injectedEnv.WORKER_ID = String(workerId);
    }

    const execOptions: WorkerExecutionOptions = {
      workDir: this.config.workDir || process.cwd(),
      ...options,
      env: injectedEnv,
      toolProfile: preflight.profile,
      toolPreflight: {
        profile: preflight.profile,
        availableToolNames: preflight.availableToolNames,
        availableSkillToolNames: preflight.availableSkillToolNames,
        aliasMap: preflight.aliasMap,
        mismatchCount: preflight.mismatchCount,
        resolvedToolsetHash: preflight.resolvedToolset.hash,
        resolvedToolset: preflight.resolvedToolset,
      },
    };

    // 注入 intervention 检查回调
    if (sessionManager && !execOptions.onCheckIntervention) {
      execOptions.onCheckIntervention = async () => {
        return sessionManager.readIntervention(workerId);
      };
    }

    // 注入 intervention 确认回调
    if (sessionManager && !execOptions.onAcknowledgeIntervention) {
      execOptions.onAcknowledgeIntervention = async () => {
        await sessionManager.acknowledgeIntervention(workerId);
      };
    }

    // 注入审批文件协议回调（如果没有提供 onApprovalRequest）
    if (sessionManager && !execOptions.onApprovalRequest) {
      // 写入待审批请求
      if (!execOptions.onWritePendingApproval) {
        execOptions.onWritePendingApproval = async (approval) => {
          await sessionManager.writePendingApproval(workerId, {
            requestId: approval.requestId,
            workerId,
            subtaskId: approval.subtaskId,
            requestedAt: Date.now(),
            type: approval.type,
            description: approval.description,
            details: approval.details,
            timeout: approval.timeout,
            defaultDecision: approval.defaultDecision,
          });
        };
      }

      // 读取审批响应
      if (!execOptions.onReadApprovalResponse) {
        execOptions.onReadApprovalResponse = async () => {
          const response = await sessionManager.readApprovalResponse(workerId);
          if (response) {
            const result: { requestId: string; approved: boolean; reason?: string; instructions?: string } = {
              requestId: response.requestId,
              approved: response.approved,
            };
            if (response.reason) result.reason = response.reason;
            if (response.instructions) result.instructions = response.instructions;
            return result;
          }
          return null;
        };
      }

      // 清除待审批请求（通过读取后删除文件实现）
      if (!execOptions.onClearPendingApproval) {
        execOptions.onClearPendingApproval = async () => {
          // SessionFileManager 目前没有 clearPendingApproval 方法
          // 审批完成后 Orchestrator 应该负责清理
          // 这里暂时不做操作
        };
      }
    }

    // 如果有审批回调，包装以持久化
    if (options.onApprovalRequest) {
      const originalCallback = options.onApprovalRequest;
      execOptions.onApprovalRequest = async (request) => {
        // 记录审批请求到决策日志
        if (sessionManager) {
          await sessionManager.appendDecision({
            type: 'approval',
            workerId,
            subtaskId: subtask.id,
            decision: {
              reason: `Approval request: ${request.action} - ${request.description}`,
            },
            trigger: {
              source: 'worker_request',
              requestId: request.requestId,
            },
          });
        }

        // 调用原始回调
        const approved = await originalCallback(request);

        // 记录审批结果到决策日志
        if (sessionManager) {
          await sessionManager.appendDecision({
            type: 'approval',
            workerId,
            subtaskId: subtask.id,
            decision: {
              approved,
              reason: approved ? 'User approved' : 'User rejected',
            },
            trigger: {
              source: 'manual',
              requestId: request.requestId,
            },
          });
        }

        return approved;
      };
    }

    // 创建执行 Span
    const taskSpan: Span = this.tracer.startSpan('worker.execute', {
      attributes: {
        workerId,
        subtaskId: subtask.id,
        objective: subtask.objective,
      },
    });

    // 日志上下文
    const logContext = {
      traceId: taskSpan.traceId,
      spanId: taskSpan.spanId,
      workerId,
      subtaskId: subtask.id,
    };

    this.logger.info('Starting subtask execution', logContext);

    // 指标收集
    const startTime = Date.now();
    let toolCallCount = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let thinkingRounds = 0;
    let tokensUsed = 0;
    const allMessages: WorkerMessage[] = [];
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let currentStatus: Omit<WorkerStatusFile, 'workerId'> | null = null;
    let heartbeatWrite: Promise<void> | null = null;
    let heartbeatEnabled = false;

    const writeWorkerStatus = async (status: Omit<WorkerStatusFile, 'workerId'>) => {
      currentStatus = status;
      if (sessionManager) {
        await sessionManager.writeWorkerStatus(workerId, status);
      }
    };

    const enqueueHeartbeatWrite = () => {
      if (!sessionManager || !currentStatus || !heartbeatEnabled) return;
      const payload = {
        ...currentStatus,
        lastHeartbeat: Date.now(),
      };
      heartbeatWrite = (heartbeatWrite ?? Promise.resolve())
        .then(() => sessionManager.writeWorkerStatus(workerId, payload))
        .catch(() => undefined);
    };

    const startHeartbeat = () => {
      if (!sessionManager || heartbeatTimer) return;
      heartbeatEnabled = true;
      heartbeatTimer = setInterval(() => {
        enqueueHeartbeatWrite();
      }, HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeat = async () => {
      heartbeatEnabled = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (heartbeatWrite) {
        await heartbeatWrite.catch(() => undefined);
        heartbeatWrite = null;
      }
    };

    try {
      const constraintPolicy = deriveConstraintPolicy(workerTask.constraints);
      const constraintConflicts = detectConstraintConflicts(constraintPolicy);
      if (constraintConflicts.length > 0) {
        const conflictLines = constraintConflicts.map((conflict) => `- ${conflict.message}`).join('\n');
        const errorMessage =
          `Constraint conflict detected.\n${conflictLines}\n` +
          'Please clarify the required stack/language before continuing.';
        if (sessionManager) {
          await writeWorkerStatus({
            status: 'error',
            progress: 0,
            error: {
              code: 'CONSTRAINT_CONFLICT',
              message: errorMessage,
              timestamp: Date.now(),
            },
            lastHeartbeat: Date.now(),
          });
        }
        const errorMsg: WorkerMessage = {
          type: 'error',
          error: errorMessage,
          code: 'CONSTRAINT_CONFLICT',
          retryable: false,
          timestamp: Date.now(),
        };
        const statusMsg: WorkerMessage = {
          type: 'status',
          status: 'failed',
          timestamp: Date.now(),
        };
        yield errorMsg;
        yield statusMsg;

        const duration = Date.now() - startTime;
        taskSpan.addTag('success', false);
        taskSpan.setStatus('error', errorMessage);
        taskSpan.end();
        this.metrics.timing(WORKER_METRICS.EXECUTION_DURATION, duration, { workerId, status: 'error' });
        this.metrics.increment(WORKER_METRICS.ERRORS_COUNT, 1, { workerId });
        this.logger.warn('Subtask blocked by constraint conflict', { ...logContext, error: errorMessage });
        return;
      }

      // 更新 Worker 状态
      if (sessionManager) {
        await writeWorkerStatus({
          status: 'thinking',
          progress: 0,
          currentSubtask: {
            id: subtask.id,
            objective: subtask.objective,
            startedAt: Date.now(),
          },
          lastHeartbeat: Date.now(),
        });
        startHeartbeat();
      }

      // 执行任务
      for await (const msg of this.backend.execute(workerTask, runtimeTools, execOptions)) {
        allMessages.push(msg);

        // 持久化消息到审计日志
        if (sessionManager) {
          await this.persistMessage(sessionManager, workerId, subtask.id, msg);
        }

        // 更新指标和日志
        switch (msg.type) {
          case 'thinking':
            thinkingRounds++;
            this.logger.debug('Thinking round', { ...logContext, round: thinkingRounds });
            this.metrics.increment(WORKER_METRICS.THINKING_ROUNDS, 1, { workerId });
            break;
          case 'tool_call':
            toolCallCount++;
            this.logger.info(`Tool call: ${msg.tool}`, { ...logContext, tool: msg.tool, callId: msg.callId });
            taskSpan.addEvent('tool_call', { tool: msg.tool, callId: msg.callId });
            break;
          case 'tool_result': {
            const toolTags = { workerId, tool: msg.tool, success: String(msg.success) };
            this.metrics.timing(WORKER_METRICS.EXECUTION_DURATION, msg.duration, toolTags);
            this.metrics.increment(WORKER_METRICS.TOOL_CALLS_COUNT, 1, toolTags);
            const toolOutcome = this.inspectToolResultPayload(msg.result, msg.success);
            if (toolOutcome.synthetic) {
              this.metrics.increment(WORKER_METRICS.TOOL_SYNTHETIC_RESULT_COUNT, 1, {
                workerId,
                tool: msg.tool,
              });
            }
            if (toolOutcome.isRecoverableError) {
              this.metrics.increment(WORKER_METRICS.TOOL_RECOVERABLE_ERROR_COUNT, 1, {
                workerId,
                tool: msg.tool,
              });
            }
            if (toolOutcome.invalidTodoFsmTransition) {
              this.metrics.increment(
                WORKER_METRICS.TODO_FSM_INVALID_TRANSITION_COUNT,
                1,
                {
                  workerId,
                  tool: msg.tool,
                  ...(toolOutcome.todoFsmMode ? { mode: toolOutcome.todoFsmMode } : {}),
                }
              );
            }
            if (msg.success) {
              successfulToolCalls++;
              this.logger.debug(`Tool result: ${msg.tool} succeeded`, { ...logContext, duration: msg.duration });
            } else {
              failedToolCalls++;
              this.logger.warn(`Tool result: ${msg.tool} failed`, { ...logContext, duration: msg.duration });
              this.metrics.increment(WORKER_METRICS.ERRORS_COUNT, 1, { workerId });
            }
            break;
          }
          case 'error': {
            const code = msg.code ?? '';
            const looksLikeToolFatal =
              code.startsWith('TOOL') ||
              code.includes('SDK') ||
              /tool/i.test(msg.error);
            if (looksLikeToolFatal) {
              this.metrics.increment(WORKER_METRICS.TOOL_FATAL_ERROR_COUNT, 1, { workerId });
            }
            break;
          }
          case 'status':
            if (typeof msg.tokensUsed === 'number') {
              tokensUsed = msg.tokensUsed;
              this.metrics.gauge(WORKER_METRICS.TOKENS_USED, tokensUsed, { workerId });
            }
            break;
        }

        // 发出消息
        yield msg;
      }

      // 更新 Worker 状态为完成
      if (sessionManager) {
        await stopHeartbeat();
        await writeWorkerStatus({
          status: 'idle',
          progress: 100,
          lastHeartbeat: Date.now(),
        });
      }

      // 完成 Span
      const duration = Date.now() - startTime;
      taskSpan.addTag('success', true);
      taskSpan.addTag('toolCallCount', toolCallCount);
      taskSpan.addTag('thinkingRounds', thinkingRounds);
      taskSpan.setStatus('ok');
      taskSpan.end();

      // 记录最终 metrics
      this.metrics.timing(WORKER_METRICS.EXECUTION_DURATION, duration, { workerId, status: 'success' });
      this.logger.info('Subtask execution completed', { ...logContext, duration, toolCallCount, thinkingRounds, tokensUsed });
    } catch (error) {
      // 更新 Worker 状态为失败
      if (sessionManager) {
        await stopHeartbeat();
        await writeWorkerStatus({
          status: 'error',
          progress: 0,
          error: {
            code: 'EXECUTION_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
            timestamp: Date.now(),
          },
          lastHeartbeat: Date.now(),
        });
      }

      // 错误 Span
      const duration = Date.now() - startTime;
      taskSpan.addTag('success', false);
      taskSpan.setStatus('error', error instanceof Error ? error.message : 'Unknown error');
      taskSpan.end();

      // 记录错误 metrics
      this.metrics.timing(WORKER_METRICS.EXECUTION_DURATION, duration, { workerId, status: 'error' });
      this.metrics.increment(WORKER_METRICS.ERRORS_COUNT, 1, { workerId });
      this.logger.error('Subtask execution failed', { ...logContext, error: error instanceof Error ? error.message : 'Unknown error' });

      throw error;
    } finally {
      try {
        await stopHeartbeat();
        // Cleanup all shell resources (background processes + persistent shell sessions)
        await cleanupAllForTask(subtask.id);
      } catch (cleanupError) {
        this.logger.warn('Failed to cleanup task processes', {
          ...logContext,
          error: cleanupError instanceof Error ? cleanupError.message : 'Unknown error',
        });
      }
    }

    // 构建最终指标（用于调试日志）
    const endTime = Date.now();
    const duration = endTime - startTime;
    if (process.env.NODE_ENV === 'development') {
      console.debug('[WorkerExecutor] Execution completed', {
        duration,
        toolCallCount,
        successfulToolCalls,
        failedToolCalls,
        thinkingRounds,
        tokensUsed,
      });
    }
  }

  /**
   * 执行子任务并收集完整结果
   *
   * 便捷方法，等待执行完成并返回结果
   */
  async executeAndCollect(
    subtask: SubTask,
    tools: Tool[],
    options: Partial<WorkerExecutionOptions> = {}
  ): Promise<ExecutionResult> {
    const messages: WorkerMessage[] = [];
    let output = '';
    let errorMsg: string | undefined;

    const startTime = Date.now();
    let toolCallCount = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let thinkingRounds = 0;
    let tokensUsed = 0;

    try {
      for await (const msg of this.execute(subtask, tools, options)) {
        messages.push(msg);

        switch (msg.type) {
          case 'thinking':
            thinkingRounds++;
            break;
          case 'tool_call':
            toolCallCount++;
            break;
          case 'tool_result':
            if (msg.success) {
              successfulToolCalls++;
            } else {
              failedToolCalls++;
            }
            break;
          case 'status':
            if (typeof msg.tokensUsed === 'number') {
              tokensUsed = msg.tokensUsed;
            }
            break;
          case 'output':
            output = msg.content;
            break;
          case 'error':
            errorMsg = msg.error;
            break;
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Unknown error';
    }

    const endTime = Date.now();

    // Get modified files from backend (if supported)
    const modifiedFiles = this.backend?.getModifiedFiles?.() ?? [];

    const result: ExecutionResult = {
      success: !errorMsg,
      output,
      messages,
      metrics: {
        startTime,
        endTime,
        duration: endTime - startTime,
        toolCallCount,
        successfulToolCalls,
        failedToolCalls,
        retryCount: 0,
        tokensUsed,
        thinkingRounds,
      },
      modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined,
    };

    if (errorMsg) {
      result.error = errorMsg;
    }

    return result;
  }

  /**
   * 中断执行
   */
  async interrupt(): Promise<void> {
    if (this.backend) {
      await this.backend.interrupt();
    }
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    // 注销 MCP 工具
    if (this.mcpRegistrar) {
      this.mcpRegistrar.unregisterAll();
      this.mcpRegistrar = null;
    }

    if (this.backend) {
      await this.backend.dispose();
      this.backend = null;
    }
    this.isInitialized = false;
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 持久化消息到审计日志
   */
  private async persistMessage(
    sessionManager: ISessionFileManager,
    workerId: string,
    subtaskId: string,
    msg: WorkerMessage
  ): Promise<void> {
    switch (msg.type) {
      case 'thinking':
        await sessionManager.appendThinking(workerId, {
          timestamp: msg.timestamp,
          subtaskId,
          content: msg.content,
          stage: 'analysis', // 默认阶段
        });
        break;

      case 'tool_call':
        await sessionManager.appendAction(workerId, {
          timestamp: msg.timestamp,
          subtaskId,
          type: 'tool_call',
          description: `Calling tool: ${msg.tool}`,
          params: { tool: msg.tool, input: msg.input },
        });
        break;

      case 'tool_result':
        await sessionManager.appendAction(workerId, {
          timestamp: msg.timestamp,
          subtaskId,
          type: 'tool_call',
          description: `Tool result: ${msg.tool}`,
          result: {
            success: msg.success,
            output: msg.result,
            duration: msg.duration,
          },
        });

        await this.syncTodoSnapshotFromToolResult(
          sessionManager,
          workerId,
          subtaskId,
          msg
        );

        // 失败时记录决策日志
        if (!msg.success) {
          await sessionManager.appendDecision({
            type: 'retry',
            workerId,
            subtaskId,
            decision: {
              reason: `Tool ${msg.tool} failed`,
            },
            trigger: {
              source: 'system',
            },
          });
        }
        break;

      case 'approval_request':
        await sessionManager.writePendingApproval(workerId, {
          requestId: msg.requestId,
          workerId,
          subtaskId,
          requestedAt: msg.timestamp,
          type: 'dangerous_operation', // 默认类型
          description: msg.description,
          details: {
            metadata: msg.details,
            impactScope: 'high',
            reversible: false,
          },
          timeout: 300000, // 5 分钟超时
          defaultDecision: 'reject',
        });
        break;
    }
  }

  private async syncTodoSnapshotFromToolResult(
    sessionManager: ISessionFileManager,
    workerId: string,
    subtaskId: string,
    msg: Extract<WorkerMessage, { type: 'tool_result' }>
  ): Promise<void> {
    if (!msg.success) return;
    if (!TODO_TOOLS.has(msg.tool)) return;

    const sourceTool = msg.tool === 'todowrite' ? 'todowrite' : 'todoread';
    const parsed = this.parseTodoSnapshotPayload(msg.result);
    if (!parsed) return;

    const shared = await sessionManager.readSharedContext().catch(() => null);
    if (!shared) return;

    const data = (shared.sharedKnowledge?.data ?? {}) as SharedKnowledgeData;
    const existing =
      this.normalizeExecutionStateContract(data.executionStateContract)?.todoState ??
      this.normalizeSharedTodoSnapshot(data.todoState);
    if (existing && existing.revision > parsed.revision) {
      return;
    }
    if (
      existing &&
      existing.revision === parsed.revision &&
      existing.hash === parsed.hash
    ) {
      return;
    }

    const todoState: SharedTodoSnapshot = {
      revision: parsed.revision,
      pendingCount: parsed.pendingCount,
      counts: parsed.counts,
      hash: parsed.hash,
      todos: parsed.todos,
      updatedAt: Date.now(),
      updatedByWorkerId: workerId,
      subtaskId,
      sourceTool,
    };

    const existingContract = this.normalizeExecutionStateContract(data.executionStateContract);
    const executionStateContract: SharedExecutionStateContract = {
      todoState,
      ...(existingContract?.summaryState
        ? { summaryState: existingContract.summaryState }
        : {}),
      conflictPolicy: 'todo_wins',
      updatedAt: Date.now(),
    };

    await sessionManager.writeSharedContext({
      objective: shared.objective,
      constraints: shared.constraints,
      sharedKnowledge: {
        data: {
          ...data,
          todoState,
          executionStateContract,
        },
        updatedAt: Date.now(),
      },
      ...(shared.workspace ? { workspace: shared.workspace } : {}),
    });
  }

  private normalizeSharedTodoSnapshot(value: unknown): SharedTodoSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.revision !== 'number' || !Number.isInteger(record.revision)) {
      return null;
    }
    if (typeof record.pendingCount !== 'number' || !Number.isFinite(record.pendingCount)) {
      return null;
    }
    if (typeof record.hash !== 'string' || record.hash.length === 0) {
      return null;
    }
    return record as unknown as SharedTodoSnapshot;
  }

  private normalizeExecutionStateContract(value: unknown): SharedExecutionStateContract | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const conflictPolicy = record.conflictPolicy === 'todo_wins' ? 'todo_wins' : null;
    if (!conflictPolicy) return null;

    const todoState = this.normalizeSharedTodoSnapshot(record.todoState);
    const summaryState =
      record.summaryState && typeof record.summaryState === 'object'
        ? (record.summaryState as SharedExecutionStateContract['summaryState'])
        : undefined;
    const updatedAt =
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : Date.now();

    return {
      ...(todoState ? { todoState } : {}),
      ...(summaryState ? { summaryState } : {}),
      conflictPolicy,
      updatedAt,
    };
  }

  private parseTodoSnapshotPayload(
    payload: unknown
  ): {
    revision: number;
    pendingCount: number;
    counts: Record<string, number>;
    hash: string;
    todos: SharedTodoItem[];
  } | null {
    const root = this.tryParseObject(payload);
    if (!root) return null;

    const nestedData = this.tryParseObject(root.data);
    const candidate = nestedData ?? root;

    const todos = this.normalizeTodoItems(candidate.todos);
    const revisionRaw = candidate.revision;
    const pendingRaw = candidate.pendingCount;

    const revision =
      typeof revisionRaw === 'number' && Number.isInteger(revisionRaw) && revisionRaw >= 0
        ? revisionRaw
        : 0;

    const counts = this.normalizeTodoCounts(candidate.counts, todos);
    const pendingCount =
      typeof pendingRaw === 'number' && Number.isFinite(pendingRaw) && pendingRaw >= 0
        ? pendingRaw
        : (counts.pending ?? 0) + (counts.in_progress ?? 0);

    if (pendingCount < 0) return null;
    if (todos.length === 0 && revision === 0 && pendingCount === 0) return null;

    const hashInput = JSON.stringify({
      revision,
      pendingCount,
      counts,
      todos,
    });
    const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 16);

    return {
      revision,
      pendingCount,
      counts,
      hash,
      todos,
    };
  }

  private tryParseObject(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object') {
      return value as Record<string, unknown>;
    }
    if (typeof value !== 'string') return null;

    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore non-JSON payloads.
    }
    return null;
  }

  private normalizeTodoItems(value: unknown): SharedTodoItem[] {
    if (!Array.isArray(value)) return [];
    const normalized: SharedTodoItem[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      const status = typeof record.status === 'string' ? record.status.trim() : '';
      if (!id || !content || !status) continue;
      const priority = typeof record.priority === 'string' ? record.priority : undefined;
      normalized.push({
        id,
        content,
        status,
        ...(priority ? { priority } : {}),
      });
    }
    return normalized;
  }

  private normalizeTodoCounts(
    value: unknown,
    todos: SharedTodoItem[]
  ): Record<string, number> {
    const counts: Record<string, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      blocked: 0,
      cancelled: 0,
    };

    if (value && typeof value === 'object') {
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue;
        counts[key] = raw;
      }
    }

    if (todos.length > 0) {
      const derived: Record<string, number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        blocked: 0,
        cancelled: 0,
      };
      for (const todo of todos) {
        derived[todo.status] = (derived[todo.status] ?? 0) + 1;
      }
      for (const [key, valueCount] of Object.entries(derived)) {
        const existingCount = counts[key];
        if (typeof existingCount !== 'number' || existingCount <= 0) {
          counts[key] = valueCount;
        }
      }
    }

    return counts;
  }

  private async buildSharedContextConstraint(
    sessionManager?: ISessionFileManager
  ): Promise<string | null> {
    if (!sessionManager) return null;
    const shared = await sessionManager.readSharedContext().catch(() => null);
    if (!shared) return null;
    return this.formatSharedContextConstraint(shared);
  }

  private formatSharedContextConstraint(shared: SharedContextFile): string | null {
    const data = shared.sharedKnowledge?.data;
    const syncLog = Array.isArray(data?.syncLog) ? data.syncLog.slice(-5) : [];
    const contractTodo = (
      (data as Record<string, unknown> | undefined)?.executionStateContract as
        | Record<string, unknown>
        | undefined
    )?.todoState;
    const todoState =
      this.normalizeSharedTodoSnapshot(contractTodo) ??
      this.normalizeSharedTodoSnapshot(data?.todoState);
    const summaryState = (
      (data as Record<string, unknown> | undefined)?.executionStateContract as
        | Record<string, unknown>
        | undefined
    )?.summaryState as Record<string, unknown> | undefined;
    const summaryText =
      summaryState && typeof summaryState.summary === 'string'
        ? summaryState.summary.trim()
        : '';

    if (syncLog.length === 0 && !todoState && !summaryText) return null;

    // 将共享内容压缩为可读摘要，避免爆 token（约 2k 字符上限）
    const lines: string[] = [];
    lines.push('Shared context (selective sync):');

    for (const item of syncLog) {
      const entry = item as SyncLogEntry;
      const subtaskId = entry.subtaskId || 'unknown';
      const objective = entry.objective || '';
      const modifiedFiles = Array.isArray(entry.modifiedFiles) ? entry.modifiedFiles : [];
      const decisions = Array.isArray(entry.decisions) ? entry.decisions : [];

      lines.push(`- ${subtaskId}${objective ? `: ${objective}` : ''}`);
      if (modifiedFiles.length > 0) lines.push(`  files: ${modifiedFiles.slice(0, 10).join(', ')}`);
      if (decisions.length > 0) {
        const reasons = decisions
          .map((d) => d.reason)
          .filter((r) => typeof r === 'string' && r.trim())
          .slice(0, 5);
        if (reasons.length > 0) lines.push(`  decisions: ${reasons.join(' | ')}`);
      }
    }

    if (todoState) {
      const counts = Object.entries(todoState.counts)
        .filter(([, value]) => typeof value === 'number' && value > 0)
        .map(([status, value]) => `${status}=${value}`)
        .join(', ');

      lines.push('');
      lines.push('Shared todo snapshot:');
      lines.push(
        `- revision=${todoState.revision}, pending=${todoState.pendingCount}, hash=${todoState.hash}`
      );
      if (counts) {
        lines.push(`- counts: ${counts}`);
      }
      if (todoState.todos.length > 0) {
        const preview = todoState.todos
          .slice(0, 5)
          .map((todo) => `[${todo.status}] ${todo.content}`)
          .join(' | ');
        if (preview) {
          lines.push(`- top todos: ${preview}`);
        }
      }
    }

    if (summaryText) {
      lines.push('');
      lines.push('Session compaction summary:');
      lines.push(
        `- hash=${typeof summaryState?.summaryHash === 'string' ? summaryState.summaryHash : 'unknown'}, policy=todo_wins`
      );
      lines.push(`- ${summaryText.split('\n').slice(0, 6).join(' | ')}`);
    }

    const text = lines.join('\n').slice(0, 2000);
    return text.trim() ? text : null;
  }

  private inspectToolResultPayload(
    result: unknown,
    success: boolean
  ): {
    synthetic: boolean;
    isRecoverableError: boolean;
    invalidTodoFsmTransition: boolean;
    todoFsmMode?: 'strict' | 'warn';
  } {
    let parsed: Record<string, unknown> | null = null;
    if (result && typeof result === 'object') {
      parsed = result as Record<string, unknown>;
    } else if (typeof result === 'string') {
      try {
        const maybe = JSON.parse(result) as unknown;
        if (maybe && typeof maybe === 'object') {
          parsed = maybe as Record<string, unknown>;
        }
      } catch {
        // Ignore non-JSON result payload.
      }
    }

    const synthetic =
      parsed?.synthetic === true ||
      parsed?.isSynthetic === true;
    const parsedIsError =
      parsed?.isError === true ||
      parsed?.is_error === true ||
      parsed?.success === false;
    const isRecoverableError = !success || parsedIsError;
    const code = typeof parsed?.code === 'string' ? parsed.code : '';
    const errorMessage = typeof parsed?.error === 'string' ? parsed.error : '';
    const invalidByCode =
      code === 'TODO_FSM_INVALID_TRANSITION' ||
      code === 'TODO_FSM_MULTIPLE_IN_PROGRESS';
    const invalidByMessage =
      /Invalid todo status transition|Only one todo item may be in_progress/.test(errorMessage);

    const nestedData =
      parsed?.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : null;
    const warnings = Array.isArray(nestedData?.warnings) ? nestedData.warnings : [];
    const invalidByWarnings = warnings.some((warning) => {
      if (!warning || typeof warning !== 'object') return false;
      const warningCode = (warning as Record<string, unknown>).code;
      return (
        warningCode === 'TODO_FSM_INVALID_TRANSITION' ||
        warningCode === 'TODO_FSM_MULTIPLE_IN_PROGRESS'
      );
    });
    const invalidTodoFsmTransition = invalidByCode || invalidByMessage || invalidByWarnings;

    let todoFsmMode: 'strict' | 'warn' | undefined;
    if (nestedData?.fsm && typeof nestedData.fsm === 'object') {
      const strictMode = (nestedData.fsm as Record<string, unknown>).strictMode;
      if (strictMode === true) {
        todoFsmMode = 'strict';
      } else if (strictMode === false) {
        todoFsmMode = 'warn';
      }
    } else if (invalidByCode || invalidByMessage) {
      todoFsmMode = 'strict';
    }

    return { synthetic, isRecoverableError, invalidTodoFsmTransition, ...(todoFsmMode ? { todoFsmMode } : {}) };
  }

}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Worker 执行器
 *
 * 便捷函数，创建并初始化执行器
 */
export async function createWorkerExecutor(config: WorkerExecutorConfig): Promise<WorkerExecutor> {
  const executor = new WorkerExecutor(config);
  await executor.initialize();
  return executor;
}
