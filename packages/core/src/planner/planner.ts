/**
 * Planner 实现
 *
 * 负责将高层任务分解为子任务，并生成委托配置
 */

import type { DelegationConfig, DelegationMode, RetryPolicy } from '../types';
import type {
  OrchestratorTask,
  SubTask,
  PlannerInput,
  PlannerOutput,
  PlannerConfig,
  ExecutionPlan,
} from '../orchestrator';
import type { LLMClient, LLMRequest, ParseRetryConfig } from './types';
import {
  createLLMClient,
  LLMClientError,
  PlanningParser,
  PLANNING_SYSTEM_PROMPT,
  generatePlanningUserPrompt,
  convertToSubTasks,
  convertToExecutionPlan,
  type PlanningOutputFormat,
} from './index';
import {
  DEFAULT_PLANNER_CONFIG,
  DEFAULT_DELEGATION_DEFAULTS,
  DEFAULT_RETRY_POLICY,
} from '../orchestrator/config';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Planner 选项
 */
export interface PlannerOptions {
  /** 规划器配置 */
  config?: Partial<PlannerConfig>;
  /** LLM 客户端（可选，用于注入测试） */
  llmClient?: LLMClient;
  /** 解析重试配置 */
  parseRetryConfig?: Partial<ParseRetryConfig>;
}

/**
 * 规划结果
 */
export interface PlanResult {
  /** 是否成功 */
  success: boolean;
  /** 规划输出（成功时存在） */
  output?: PlannerOutput;
  /** 错误信息（失败时存在） */
  error?: string;
  /** 使用的 Token 数 */
  tokensUsed: {
    input: number;
    output: number;
  };
  /** 重试次数 */
  retryCount: number;
  /** 是否使用了降级策略 */
  degraded: boolean;
}

/**
 * 降级策略
 */
export interface DegradationStrategy {
  /** 降级后的 Worker 数量 */
  workerCount?: number;
  /** 降级后的委托模式 */
  mode?: DelegationMode;
  /** 降级后的超时时间 */
  timeout?: number;
  /** 降级后的重试策略 */
  retryPolicy?: RetryPolicy;
}

// ============================================================================
// Planner 实现
// ============================================================================

/**
 * Planner 类
 *
 * 负责将高层任务分解为子任务，并生成委托配置
 *
 * @example
 * ```ts
 * const planner = new Planner({
 *   config: { defaultMaxSubtasks: 10 }
 * });
 *
 * const result = await planner.plan({
 *   task: {
 *     id: 'task-1',
 *     type: 'composite',
 *     objective: '实现用户认证系统',
 *     constraints: ['使用 JWT', '支持 OAuth'],
 *     priority: 'high',
 *     complexity: 'complex',
 *   }
 * });
 * ```
 */
export class Planner {
  private readonly config: PlannerConfig;
  private readonly llmClient: LLMClient;
  private readonly parser: PlanningParser;
  private readonly parseRetryConfig: ParseRetryConfig;

  constructor(options: PlannerOptions = {}) {
    // 合并配置
    this.config = {
      ...DEFAULT_PLANNER_CONFIG,
      ...options.config,
      agent: {
        ...DEFAULT_PLANNER_CONFIG.agent,
        ...options.config?.agent,
      },
    };

    // 创建或使用注入的 LLM 客户端
    this.llmClient = options.llmClient || createLLMClient(this.config.agent);

    // 解析重试配置
    this.parseRetryConfig = {
      maxRetries: this.config.maxParseRetries,
      includeErrorFeedback: true,
      ...options.parseRetryConfig,
    };

    // 创建解析器
    this.parser = new PlanningParser(this.llmClient, this.parseRetryConfig);
  }

  /**
   * 执行任务规划
   *
   * @param input - 规划器输入
   * @returns 规划结果
   */
  async plan(input: PlannerInput): Promise<PlanResult> {
    const { task, availableTools, contextConstraints, maxSubtasks, preferences } = input;

    let totalTokens = { input: 0, output: 0 };
    let totalRetries = 0;
    let degraded = false;

    try {
      // 生成用户 Prompt
      const userPrompt = generatePlanningUserPrompt({
        objective: task.objective,
        constraints: task.constraints,
        availableTools,
        maxSubtasks: maxSubtasks ?? this.config.defaultMaxSubtasks,
        additionalContext: this.buildAdditionalContext(task, preferences),
      });

      // 构建 LLM 请求
      const request: LLMRequest = {
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: this.config.agent.maxTokens,
        temperature: this.config.agent.temperature,
      };

      // 调用 LLM
      const response = await this.llmClient.complete(request);
      totalTokens.input += response.usage.inputTokens;
      totalTokens.output += response.usage.outputTokens;

      // 解析响应（带重试）
      const { result: parseResult, retryCount, totalTokens: retryTokens } =
        await this.parser.parseWithRetry(response.content, request);

      totalTokens.input += retryTokens.input;
      totalTokens.output += retryTokens.output;
      totalRetries = retryCount;

      if (!parseResult.success || !parseResult.data) {
        return {
          success: false,
          error: parseResult.error || 'Failed to parse planning output',
          tokensUsed: totalTokens,
          retryCount: totalRetries,
          degraded,
        };
      }

      // 转换为内部格式并生成委托配置
      const plannerOutput = this.buildPlannerOutput(
        task,
        parseResult.data,
        contextConstraints,
        preferences
      );

      return {
        success: true,
        output: plannerOutput,
        tokensUsed: totalTokens,
        retryCount: totalRetries,
        degraded,
      };
    } catch (error) {
      // 处理可重试的错误，尝试降级
      if (error instanceof LLMClientError && error.retryable) {
        const degradationResult = await this.tryDegradation(input, totalTokens, totalRetries);
        if (degradationResult) {
          return { ...degradationResult, degraded: true };
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        tokensUsed: totalTokens,
        retryCount: totalRetries,
        degraded,
      };
    }
  }

  /**
   * 构建额外上下文
   */
  private buildAdditionalContext(
    task: OrchestratorTask,
    preferences?: PlannerInput['preferences']
  ): string | undefined {
    const parts: string[] = [];

    // 添加优先级和复杂度信息
    parts.push(`任务优先级：${task.priority}`);
    parts.push(`任务复杂度：${task.complexity}`);

    // 添加偏好信息
    if (preferences?.preferParallel) {
      parts.push('偏好：尽可能并行执行子任务');
    }
    if (preferences?.conservativeMode) {
      parts.push('模式：保守模式，生成较少的子任务');
    }

    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /**
   * 构建 PlannerOutput
   */
  private buildPlannerOutput(
    task: OrchestratorTask,
    planningOutput: PlanningOutputFormat,
    contextConstraints?: PlannerInput['contextConstraints'],
    _preferences?: PlannerInput['preferences'] // 保留用于将来扩展
  ): PlannerOutput {
    // 转换子任务
    const subtasks = convertToSubTasks(planningOutput, task.id);

    // 转换执行计划
    const executionPlan = convertToExecutionPlan(planningOutput);

    // 计算委托配置
    const delegation = this.calculateDelegationConfig(
      subtasks,
      executionPlan,
      task.complexity,
      contextConstraints
    );

    return {
      taskId: task.id,
      subtasks,
      delegation,
      executionPlan,
      reasoning: this.config.enableReasoning ? planningOutput.reasoning : undefined,
      estimatedTotalDuration: planningOutput.estimatedTotalMinutes * 60 * 1000,
      estimatedTokens: this.estimateTokenUsage(subtasks),
    };
  }

  /**
   * 计算委托配置
   */
  private calculateDelegationConfig(
    subtasks: SubTask[],
    executionPlan: ExecutionPlan,
    complexity: OrchestratorTask['complexity'],
    contextConstraints?: PlannerInput['contextConstraints']
  ): DelegationConfig {
    // 基于复杂度和子任务数量计算 Worker 数量
    let workerCount = this.calculateWorkerCount(subtasks.length, complexity, executionPlan.isParallel);

    // 基于复杂度和子任务数量计算超时时间
    let timeout = this.calculateTimeout(subtasks, complexity);

    // 应用上下文约束
    if (contextConstraints?.maxExecutionTime) {
      timeout = Math.min(timeout, contextConstraints.maxExecutionTime);
    }

    // 默认使用 communication 模式
    const mode: DelegationMode = 'communication';

    return {
      mode,
      workerCount,
      timeout,
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
  }

  /**
   * 计算 Worker 数量
   */
  private calculateWorkerCount(
    subtaskCount: number,
    complexity: OrchestratorTask['complexity'],
    isParallel: boolean
  ): number {
    if (!isParallel) {
      return 1;
    }

    // 基于复杂度的并行因子
    const parallelFactor =
      complexity === 'complex' ? 0.5 : complexity === 'moderate' ? 0.7 : 1;

    // 计算并行 Worker 数量（最少 1 个，最多与子任务数相同）
    const calculatedCount = Math.max(1, Math.ceil(subtaskCount * parallelFactor));

    // 限制最大 Worker 数量
    return Math.min(calculatedCount, DEFAULT_DELEGATION_DEFAULTS.workerCount * 3);
  }

  /**
   * 计算超时时间
   */
  private calculateTimeout(
    subtasks: SubTask[],
    complexity: OrchestratorTask['complexity']
  ): number {
    // 基于子任务预估时间计算
    const totalEstimatedDuration = subtasks.reduce(
      (sum, st) => sum + (st.estimatedDuration || 0),
      0
    );

    // 如果有预估时间，使用预估时间的 1.5 倍作为超时
    if (totalEstimatedDuration > 0) {
      return Math.max(totalEstimatedDuration * 1.5, DEFAULT_DELEGATION_DEFAULTS.timeout);
    }

    // 否则基于复杂度设置默认超时
    const complexityMultiplier =
      complexity === 'complex' ? 3 : complexity === 'moderate' ? 2 : 1;

    return DEFAULT_DELEGATION_DEFAULTS.timeout * complexityMultiplier;
  }

  /**
   * 估算 Token 使用量
   */
  private estimateTokenUsage(subtasks: SubTask[]): number {
    // 粗略估算：每个子任务约 500-1500 tokens
    const baseTokensPerSubtask = 800;
    return subtasks.length * baseTokensPerSubtask;
  }

  /**
   * 尝试降级策略
   */
  private async tryDegradation(
    input: PlannerInput,
    currentTokens: { input: number; output: number },
    currentRetries: number
  ): Promise<PlanResult | null> {
    // 简单的降级策略：减少最大子任务数量并重试
    const degradedMaxSubtasks = Math.max(
      3,
      Math.floor((input.maxSubtasks ?? this.config.defaultMaxSubtasks) / 2)
    );

    // 如果已经是最小值，放弃降级
    if (degradedMaxSubtasks <= 3 && (input.maxSubtasks ?? this.config.defaultMaxSubtasks) <= 3) {
      return null;
    }

    try {
      const degradedInput: PlannerInput = {
        ...input,
        maxSubtasks: degradedMaxSubtasks,
        preferences: {
          ...input.preferences,
          conservativeMode: true,
        },
      };

      // 递归调用 plan，但标记为降级
      const result = await this.plan(degradedInput);

      // 累加 token 使用量
      result.tokensUsed.input += currentTokens.input;
      result.tokensUsed.output += currentTokens.output;
      result.retryCount += currentRetries;
      result.degraded = true;

      return result;
    } catch {
      return null;
    }
  }

  /**
   * 获取配置
   */
  getConfig(): PlannerConfig {
    return { ...this.config };
  }

  /**
   * 检查 LLM 客户端是否可用
   */
  isAvailable(): boolean {
    return this.llmClient.isAvailable();
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Planner 实例
 *
 * @param options - Planner 选项
 * @returns Planner 实例
 */
export function createPlanner(options?: PlannerOptions): Planner {
  return new Planner(options);
}
