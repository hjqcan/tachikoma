/**
 * MVP Runner
 *
 * 简化的端到端任务执行器，用于 CLI 演示
 * 集成 Planner + WorkerExecutor + Tools
 */

import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { Planner, createLLMClient } from '../planner';
import { createWorkerExecutor, type WorkerExecutor } from '../worker';
import { createAndInitializeSessionFileManager, type ISessionFileManager } from '../orchestrator/session';
import { createObservability } from '../observability';
import { coreTools, getToolDefinitions } from '../tools';
import type { SubTask } from '../orchestrator/types';

// =============================================================================
// 类型定义
// =============================================================================

/**
 * MVP Runner 配置
 */
export interface MVPRunnerConfig {
  /** 任务描述 */
  task: string;
  /** 工作目录 */
  workdir: string;
  /** 最大 Worker 数量 */
  maxWorkers?: number;
  /** 是否详细输出 */
  verbose?: boolean;
  /** LLM 配置 */
  llm?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

/**
 * 进度回调
 */
export interface ProgressCallback {
  onPlanStart?: () => void;
  onPlanComplete?: (subtasks: SubTask[]) => void;
  onWorkerStart?: (workerId: string, subtask: SubTask) => void;
  onWorkerThinking?: (workerId: string, content: string) => void;
  onToolCall?: (workerId: string, tool: string, args: unknown) => void;
  onToolResult?: (workerId: string, tool: string, success: boolean) => void;
  onWorkerComplete?: (workerId: string, success: boolean) => void;
  onComplete?: (success: boolean, metrics: RunMetrics) => void;
  onError?: (error: Error) => void;
}

/**
 * 运行指标
 */
export interface RunMetrics {
  totalDuration: number;
  planningDuration: number;
  executionDuration: number;
  tokensUsed: number;
  subtasksTotal: number;
  subtasksCompleted: number;
  subtasksFailed: number;
  toolCallsTotal: number;
}

// =============================================================================
// MVP Runner
// =============================================================================

/**
 * MVP Runner
 *
 * 简化的端到端执行流程：
 * 1. 规划任务 → 生成子任务
 * 2. 执行子任务 → 调用工具
 * 3. 收集结果 → 返回指标
 */
export class MVPRunner {
  private readonly config: MVPRunnerConfig;
  private readonly callbacks: ProgressCallback;
  private sessionManager: ISessionFileManager | null = null;
  private executor: WorkerExecutor | null = null;

  constructor(config: MVPRunnerConfig, callbacks: ProgressCallback = {}) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * 运行任务
   */
  async run(): Promise<RunMetrics> {
    const startTime = Date.now();
    const metrics: RunMetrics = {
      totalDuration: 0,
      planningDuration: 0,
      executionDuration: 0,
      tokensUsed: 0,
      subtasksTotal: 0,
      subtasksCompleted: 0,
      subtasksFailed: 0,
      toolCallsTotal: 0,
    };

    try {
      // 确保工作目录存在
      const workdir = resolve(this.config.workdir);
      await mkdir(workdir, { recursive: true });

      // 创建会话
      const sessionId = `mvp-${randomUUID().substring(0, 8)}`;
      const sessionRoot = join(workdir, '.tachikoma');
      await mkdir(sessionRoot, { recursive: true });

      this.sessionManager = await createAndInitializeSessionFileManager(sessionId, {
        rootDir: sessionRoot,
        enableWatch: false,
      });

      // =========================================================================
      // Phase 1: 规划
      // =========================================================================
      this.callbacks.onPlanStart?.();
      const planStartTime = Date.now();

      const subtasks = await this.planTask();
      metrics.subtasksTotal = subtasks.length;
      metrics.planningDuration = Date.now() - planStartTime;

      this.callbacks.onPlanComplete?.(subtasks);

      // =========================================================================
      // Phase 2: 执行
      // =========================================================================
      const execStartTime = Date.now();

      for (let i = 0; i < subtasks.length; i++) {
        const subtask = subtasks[i];
        if (!subtask) continue;

        const workerId = `worker-${String(i + 1).padStart(3, '0')}`;

        try {
          const result = await this.executeSubtask(workerId, subtask, metrics);

          if (result.success) {
            metrics.subtasksCompleted++;
          } else {
            metrics.subtasksFailed++;
          }
        } catch (error) {
          metrics.subtasksFailed++;
          this.callbacks.onError?.(error as Error);
        }
      }

      metrics.executionDuration = Date.now() - execStartTime;

      // =========================================================================
      // 完成
      // =========================================================================
      metrics.totalDuration = Date.now() - startTime;
      const success = metrics.subtasksFailed === 0;

      this.callbacks.onComplete?.(success, metrics);

      return metrics;
    } catch (error) {
      metrics.totalDuration = Date.now() - startTime;
      this.callbacks.onError?.(error as Error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 规划任务
   */
  private async planTask(): Promise<SubTask[]> {
    const llmConfig = this.config.llm || {};

    // 使用 OpenRouter 或环境变量配置
    const apiKey = llmConfig.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    const baseUrl = llmConfig.baseUrl || process.env.OPENROUTER_BASE_URL;
    const model = llmConfig.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';

    if (!apiKey) {
      throw new Error('缺少 API Key，请设置 OPENROUTER_API_KEY 环境变量');
    }

    const llmClient = createLLMClient({
      provider: 'openai',
      model,
      apiKey,
      ...(baseUrl && { baseUrl }),
      maxTokens: 4096,
    });

    const planner = new Planner({ llmClient });

    // 获取可用工具列表
    const toolDescriptions = getToolDefinitions()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');

    const planResult = await planner.plan({
      task: {
        id: `task-${randomUUID().substring(0, 8)}`,
        type: 'composite',
        objective: this.config.task,
        constraints: [
          `工作目录: ${this.config.workdir}`,
          `可用工具:\n${toolDescriptions}`,
          '请生成清晰的子任务，每个子任务应该可以独立执行',
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
  private async executeSubtask(
    workerId: string,
    subtask: SubTask,
    metrics: RunMetrics
  ): Promise<{ success: boolean; output: string }> {
    this.callbacks.onWorkerStart?.(workerId, subtask);

    // 注册 Worker
    if (this.sessionManager) {
      await this.sessionManager.registerWorker(workerId);
    }

    // 创建可观测性实例
    const obs = createObservability({
      logger: { level: this.config.verbose ? 'debug' : 'info' },
      tracer: { enabled: true },
      metrics: { enabled: true },
    });

    // 获取 LLM 配置
    const llmConfig = this.config.llm || {};
    const apiKey = llmConfig.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    const baseUrl = llmConfig.baseUrl || process.env.OPENROUTER_BASE_URL;
    const model = llmConfig.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';

    if (!apiKey) {
      throw new Error('缺少 API Key');
    }

    // 创建执行器
    this.executor = await createWorkerExecutor({
      backendConfig: {
        provider: 'openai',
        model,
        apiKey,
        ...(baseUrl && { baseUrl }),
      },
      sessionManager: this.sessionManager ?? undefined,
      workerId,
      workDir: resolve(this.config.workdir),
      logger: obs.logger,
      tracer: obs.tracer,
      metrics: obs.metrics,
    });

    let output = '';
    let success = true;

    try {
      // 执行子任务
      for await (const msg of this.executor.execute(subtask, coreTools)) {
        switch (msg.type) {
          case 'thinking':
            this.callbacks.onWorkerThinking?.(workerId, msg.content);
            break;

          case 'tool_call':
            metrics.toolCallsTotal++;
            this.callbacks.onToolCall?.(workerId, msg.tool, msg.input);
            break;

          case 'tool_result':
            this.callbacks.onToolResult?.(workerId, msg.tool, msg.success);
            break;

          case 'output':
            output = msg.content;
            break;

          case 'error':
            success = false;
            output = msg.error;
            break;

          case 'status':
            if (msg.tokensUsed) {
              metrics.tokensUsed += msg.tokensUsed;
            }
            break;
        }
      }

      this.callbacks.onWorkerComplete?.(workerId, success);

      return { success, output };
    } finally {
      await this.executor.dispose();
      this.executor = null;
    }
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    if (this.executor) {
      await this.executor.dispose();
      this.executor = null;
    }

    if (this.sessionManager) {
      await this.sessionManager.close();
      this.sessionManager = null;
    }
  }
}

/**
 * 创建并运行 MVP
 */
export async function runMVP(
  config: MVPRunnerConfig,
  callbacks: ProgressCallback = {}
): Promise<RunMetrics> {
  const runner = new MVPRunner(config, callbacks);
  return runner.run();
}
