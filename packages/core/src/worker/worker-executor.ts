/**
 * Worker 执行器
 *
 * 连接 WorkerPool 和 IWorkerBackend，处理任务执行流程
 * 集成 SessionFileManager 实现审计日志
 */

import type { Tool } from '../types';
import type { SubTask } from '../orchestrator/types';
import type { ISessionFileManager } from '../orchestrator/session/types';
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

// ============================================================================
// 类型定义
// ============================================================================

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

    // 转换 SubTask 为 WorkerTask
    const workerTask: WorkerTask = {
      id: subtask.id,
      type: 'atomic', // 子任务默认为原子任务
      objective: subtask.objective,
      constraints: subtask.constraints,
      parentTaskId: subtask.parentId,
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

    try {
      // 更新 Worker 状态
      if (sessionManager) {
        await sessionManager.writeWorkerStatus(workerId, {
          status: 'thinking',
          progress: 0,
          currentSubtask: {
            id: subtask.id,
            objective: subtask.objective,
            startedAt: Date.now(),
          },
          lastHeartbeat: Date.now(),
        });
      }

      // 执行任务
      for await (const msg of this.backend.execute(workerTask, tools, execOptions)) {
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
        await sessionManager.writeWorkerStatus(workerId, {
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
        await sessionManager.writeWorkerStatus(workerId, {
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
