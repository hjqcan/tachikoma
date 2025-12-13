/**
 * WorkerAgent
 *
 * 将 WorkerExecutor/IWorkerBackend 包装为标准 Agent（Task -> TaskResult）。
 *
 * 设计目标：
 * - 对外作为可继承/可替换的 Agent 实现（符合 BaseAgent 生命周期契约）
 * - 对内复用现有 WorkerExecutor（流式执行、审批协议、审计日志、MCP 工具注册等）
 */

import type { AgentConfig, Task, TaskResult, TraceData } from '../types';
import type { Tool } from '../types';

import { randomUUID } from 'node:crypto';

import type { WorkerBackendConfig, WorkerExecutionOptions } from '../worker';
import { WorkerExecutor } from '../worker';
import { coreTools } from '../tools';
import type { ISessionFileManager } from '../orchestrator/session/types';
import type { MCPClientManager } from '../mcp';
import type { Logger, Tracer, MetricsCollector } from '../observability';

import { BaseAgent } from '../abstracts/base-agent';

/**
 * WorkerAgent 配置选项
 */
export interface WorkerAgentOptions {
  /** 工作目录（默认 process.cwd()） */
  workDir?: string;
  /** 可用工具列表（默认 coreTools） */
  tools?: Tool[];
  /** WorkerExecutor 额外执行选项（每次 run 时合并） */
  executionOptions?: Partial<WorkerExecutionOptions>;

  /** Worker 后端配置覆盖（默认从 AgentConfig 派生） */
  backendConfig?: Partial<WorkerBackendConfig>;

  /** SessionFileManager（可选：用于审计日志与文件审批协议） */
  sessionManager?: ISessionFileManager;
  /** MCP 客户端（可选：用于自动注册 MCP 工具） */
  mcpClient?: MCPClientManager;
  /** 是否自动注册 MCP 工具到 ToolRegistry（默认 true） */
  autoRegisterMCPTools?: boolean;

  /** 可观测性注入（可选） */
  logger?: Logger;
  tracer?: Tracer;
  metrics?: MetricsCollector;
}

function createEmptyTrace(operation: string): TraceData {
  return {
    traceId: randomUUID(),
    spanId: randomUUID().replaceAll('-', '').slice(0, 16),
    operation,
    attributes: {},
    events: [],
    duration: 0,
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    err.name === 'AbortError' ||
    err.code === 'ABORT_ERR' ||
    (typeof err.message === 'string' && err.message.toLowerCase().includes('abort'))
  );
}

/**
 * WorkerAgent
 */
export class WorkerAgent extends BaseAgent {
  private readonly options: WorkerAgentOptions;
  private readonly executor: WorkerExecutor;
  private initialized = false;

  constructor(id: string, config: AgentConfig, options: WorkerAgentOptions = {}) {
    super(id, 'worker', config);
    this.options = options;

    const backendConfig: WorkerBackendConfig = {
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      ...(options.backendConfig ?? {}),
    };

    this.executor = new WorkerExecutor({
      workerId: id,
      backendConfig,
      workDir: options.workDir,
      sessionManager: options.sessionManager,
      mcpClient: options.mcpClient,
      autoRegisterMCPTools: options.autoRegisterMCPTools,
      logger: options.logger,
      tracer: options.tracer,
      metrics: options.metrics,
    });
  }

  /**
   * 确保 WorkerExecutor 初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.executor.initialize();
    this.initialized = true;
  }

  /**
   * 停止执行（中断 + 释放资源）
   */
  override async stop(): Promise<void> {
    let interruptError: unknown;
    try {
      await this.executor.interrupt();
    } catch (error) {
      if (!isAbortLikeError(error)) {
        interruptError = error;
      }
    } finally {
      await this.executor.dispose();
      this.initialized = false;
      await super.stop();
    }

    if (interruptError) {
      if (interruptError instanceof Error) {
        throw interruptError;
      }
      throw new Error(String(interruptError));
    }
  }

  /**
   * 执行任务
   *
   * 将 Task 映射为 Orchestrator SubTask 语义（最小字段），复用 WorkerExecutor.executeAndCollect。
   */
  protected override async executeTask(task: Task, signal: AbortSignal): Promise<TaskResult> {
    await this.ensureInitialized();

    const subtask = {
      id: task.id,
      parentId: task.context?.parentTaskId ?? 'root',
      objective: task.objective,
      constraints: task.constraints,
      outputSchema: task.outputSchema,
      status: 'pending' as const,
    };

    const tools = this.options.tools ?? coreTools;
    const workDir = this.options.workDir ?? process.cwd();

    const execOptions: Partial<WorkerExecutionOptions> = {
      workDir,
      abortSignal: signal,
      ...(this.options.executionOptions ?? {}),
    };

    const result = await this.executor.executeAndCollect(subtask, tools, execOptions);

    const baseTrace = createEmptyTrace('agent.worker.run');

    return {
      taskId: task.id,
      status: result.success ? 'success' : 'failure',
      output: result.success
        ? { text: result.output, messages: result.messages }
        : { error: result.error ?? 'Worker execution failed', messages: result.messages },
      artifacts: [],
      metrics: {
        startTime: result.metrics.startTime,
        endTime: result.metrics.endTime,
        duration: result.metrics.duration,
        tokensUsed: result.metrics.tokensUsed,
        toolCallCount: result.metrics.toolCallCount,
        retryCount: result.metrics.retryCount,
      },
      trace: {
        ...baseTrace,
        traceId: task.context?.traceId ?? baseTrace.traceId,
      },
    };
  }
}

/**
 * 便捷创建函数（绕过注册表）
 */
export function createWorkerAgent(
  id: string,
  config: AgentConfig,
  options: WorkerAgentOptions = {}
): WorkerAgent {
  return new WorkerAgent(id, config, options);
}
