/**
 * 聚合引擎实现
 *
 * 负责聚合所有子任务结果并生成最终结果
 * 从 Orchestrator 类中提取
 */

import type { TaskResult, Artifact, TaskMetrics, TraceData } from '../../types';
import type { SubTask, AggregatedResult } from '../types';
import type { IAggregationEngine } from '../interfaces';
import { generateTimestampId } from '../session';

/**
 * 聚合配置
 */
export interface AggregationConfig {
  /** 合并策略 */
  strategy: 'merge' | 'select-best' | 'custom';
  /** 是否允许部分成功 */
  allowPartialSuccess: boolean;
  /** 部分成功阈值 (0-1) */
  partialSuccessThreshold: number;
}

/**
 * 默认聚合配置
 */
export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  strategy: 'merge',
  allowPartialSuccess: true,
  partialSuccessThreshold: 0.5,
};

/**
 * 聚合引擎实现
 *
 * @example
 * ```ts
 * const engine = new AggregationEngine({ allowPartialSuccess: true });
 * const result = engine.aggregate(subtaskMap, completedSubtasks, failedSubtasks);
 * const finalResult = engine.createFinalResult('task-1', result, startTime, 0);
 * ```
 */
export class AggregationEngine implements IAggregationEngine {
  private readonly config: AggregationConfig;
  private orchestratorId: string = 'default';

  constructor(config: Partial<AggregationConfig> = {}) {
    this.config = { ...DEFAULT_AGGREGATION_CONFIG, ...config };
  }

  /**
   * 设置 Orchestrator ID（用于追踪数据）
   */
  setOrchestratorId(id: string): void {
    this.orchestratorId = id;
  }

  /**
   * 聚合所有子任务结果
   */
  aggregate(
    subtaskMap: Map<string, SubTask>,
    completedSubtasks: Map<string, TaskResult>,
    failedSubtasks: Map<string, string>
  ): AggregatedResult {
    const successCount = completedSubtasks.size;
    const failureCount = failedSubtasks.size;
    const totalCount = subtaskMap.size;

    // 确定状态
    let status: 'success' | 'failure' | 'partial';
    if (failureCount === 0 && successCount === totalCount) {
      status = 'success';
    } else if (successCount === 0) {
      status = 'failure';
    } else {
      // 检查部分成功阈值
      const successRate = successCount / totalCount;
      status =
        this.config.allowPartialSuccess &&
        successRate >= this.config.partialSuccessThreshold
          ? 'partial'
          : 'failure';
    }

    // 合并输出
    const mergedOutput = this.mergeOutputs(completedSubtasks, this.config.strategy);

    // 计算总 token 数
    let totalTokensUsed = 0;
    let totalDuration = 0;
    for (const result of completedSubtasks.values()) {
      totalTokensUsed += result.metrics?.tokensUsed ?? 0;
      totalDuration += result.metrics?.duration ?? 0;
    }

    return {
      status,
      output: mergedOutput,
      subtaskResults: completedSubtasks,
      successCount,
      failureCount,
      metadata: {
        totalDuration,
        totalTokens: totalTokensUsed,
        totalRetries: 0,
      },
    };
  }

  /**
   * 创建最终结果
   */
  createFinalResult(
    taskId: string,
    aggregatedResult: AggregatedResult,
    startTime: number,
    totalRetries: number
  ): TaskResult {
    const endTime = Date.now();
    const duration = endTime - startTime;

    // 收集所有产出物
    const artifacts: Artifact[] = [];
    for (const result of aggregatedResult.subtaskResults.values()) {
      artifacts.push(...result.artifacts);
    }

    // 计算指标
    const metrics: TaskMetrics = {
      startTime,
      endTime,
      duration,
      tokensUsed: aggregatedResult.metadata?.totalTokens ?? 0,
      toolCallCount: 0,
      retryCount: totalRetries,
    };

    // 创建追踪数据
    const trace: TraceData = {
      traceId: generateTimestampId('trace'),
      spanId: generateTimestampId('span'),
      operation: `orchestrator.${this.orchestratorId}.run`,
      attributes: {
        taskId,
        successCount: aggregatedResult.successCount,
        failureCount: aggregatedResult.failureCount,
      },
      events: [],
      duration,
    };

    return {
      taskId,
      status: aggregatedResult.status === 'success' ? 'success' : 'failure',
      output: aggregatedResult.output,
      artifacts,
      metrics,
      trace,
    };
  }

  /**
   * 创建失败结果
   */
  createFailureResult(
    taskId: string,
    error: string,
    startTime: number,
    tokensUsed: { input: number; output: number }
  ): TaskResult {
    const endTime = Date.now();

    return {
      taskId,
      status: 'failure',
      output: { error },
      artifacts: [],
      metrics: {
        startTime,
        endTime,
        duration: endTime - startTime,
        tokensUsed: tokensUsed.input + tokensUsed.output,
        toolCallCount: 0,
        retryCount: 0,
      },
      trace: {
        traceId: generateTimestampId('trace'),
        spanId: generateTimestampId('span'),
        operation: `orchestrator.${this.orchestratorId}.run`,
        attributes: { taskId, error },
        events: [],
        duration: endTime - startTime,
      },
    };
  }

  /**
   * 创建需要用户输入的结果
   */
  createNeedUserInputResult(
    taskId: string,
    startTime: number,
    tokensUsed: { input: number; output: number },
    question: string,
    missingInfo: string[]
  ): TaskResult {
    const endTime = Date.now();
    return {
      taskId,
      status: 'failure',
      output: {
        error: 'need_user_input',
        question,
        ...(missingInfo.length > 0 && { missingInfo }),
      },
      artifacts: [],
      metrics: {
        startTime,
        endTime,
        duration: endTime - startTime,
        tokensUsed: tokensUsed.input + tokensUsed.output,
        toolCallCount: 0,
        retryCount: 0,
      },
      trace: {
        traceId: generateTimestampId('trace'),
        spanId: generateTimestampId('span'),
        operation: `orchestrator.${this.orchestratorId}.run`,
        attributes: { taskId, needUserInput: true },
        events: [],
        duration: endTime - startTime,
      },
    };
  }

  /**
   * 合并输出
   */
  private mergeOutputs(
    completedSubtasks: Map<string, TaskResult>,
    strategy: string
  ): unknown {
    switch (strategy) {
      case 'merge': {
        // 合并所有输出到数组
        const outputs: unknown[] = [];
        for (const result of completedSubtasks.values()) {
          outputs.push(result.output);
        }
        return outputs;
      }
      case 'select-best': {
        // 选择第一个成功的结果
        for (const result of completedSubtasks.values()) {
          if (result.status === 'success') {
            return result.output;
          }
        }
        return null;
      }
      default:
        return Array.from(completedSubtasks.values()).map((r) => r.output);
    }
  }
}

/**
 * 创建聚合引擎实例
 */
export function createAggregationEngine(
  config?: Partial<AggregationConfig>
): IAggregationEngine {
  return new AggregationEngine(config);
}
