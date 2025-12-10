/**
 * Tool Chain - 工具链串联执行
 * 
 * 支持多工具顺序执行与输出传递
 */

import type { ExecutionContext } from '../types';
import type { ToolResult } from './types';
import type { ToolRegistry } from './registry';

/**
 * 工具链步骤
 */
export interface ToolChainStep {
  /** 工具名称 */
  toolName: string;
  /** 工具输入 */
  input: unknown;
  /** 输入映射：使用前一步的输出 */
  inputMapping?: {
    [key: string]: {
      /** 从第几步获取（0-indexed） */
      fromStep: number;
      /** 字段路径（支持点号分隔） */
      field: string;
    };
  };
}

/**
 * 工具链执行结果
 */
export interface ToolChainResult {
  /** 是否成功 */
  success: boolean;
  /** 完成的步骤数 */
  completedSteps: number;
  /** 所有步骤的结果 */
  results: ToolResult[];
  /** 错误信息（如果失败） */
  error?: unknown;
  /** 执行指标 */
  metrics?: {
    totalDuration: number;
    stepDurations: number[];
  };
}

/**
 * 工具链类
 * 
 * 支持顺序执行多个工具，并自动传递输出
 */
export class ToolChain {
  constructor(private registry: ToolRegistry) {}

  /**
   * 执行工具链
   * 
   * @param steps - 工具链步骤列表
   * @param context - 执行上下文
   * @returns 工具链执行结果
   */
  async execute(
    steps: ToolChainStep[],
    context: ExecutionContext
  ): Promise<ToolChainResult> {
    const results: ToolResult[] = [];
    const stepDurations: number[] = [];
    const startTime = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

      const stepStartTime = Date.now();

      try {
        // 应用输入映射
        const input = this.applyInputMapping(
          step.input,
          step.inputMapping,
          results
        );

        // 执行工具
        const result = await this.registry.execute(
          step.toolName,
          input,
          context
        ) as ToolResult;

        results.push(result);
        stepDurations.push(Date.now() - stepStartTime);
      } catch (error) {
        // 失败时返回部分结果
        return {
          success: false,
          completedSteps: i,
          results,
          error,
          metrics: {
            totalDuration: Date.now() - startTime,
            stepDurations,
          },
        };
      }
    }

    return {
      success: true,
      completedSteps: steps.length,
      results,
      metrics: {
        totalDuration: Date.now() - startTime,
        stepDurations,
      },
    };
  }

  /**
   * 应用输入映射
   * 
   * 从之前步骤的结果中提取数据，注入到当前输入
   */
  private applyInputMapping(
    baseInput: unknown,
    mapping: ToolChainStep['inputMapping'],
    previousResults: ToolResult[]
  ): unknown {
    if (!mapping) {
      return baseInput;
    }

    const input = { ...(baseInput as Record<string, unknown>) };

    for (const [targetKey, source] of Object.entries(mapping)) {
      const { fromStep, field } = source;

      // 检查步骤索引有效性
      if (fromStep < 0 || fromStep >= previousResults.length) {
        throw new Error(`Invalid fromStep: ${fromStep}`);
      }

      const result = previousResults[fromStep];
      if (!result) continue;

      // 提取字段值（支持点号路径）
      const value = this.getNestedField(result, field);
      input[targetKey] = value;
    }

    return input;
  }

  /**
   * 获取嵌套字段值
   * 
   * 支持点号分隔的路径，如 "data.files[0].name"
   */
  private getNestedField(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // 处理数组索引，如 "files[0]"
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const key = arrayMatch[1];
        const index = arrayMatch[2];
        if (!key || !index) continue;
        // @ts-expect-error - 动态属性访问
        current = current[key]?.[parseInt(index, 10)];
      } else {
        // @ts-expect-error - 动态属性访问
        current = current[part];
      }
    }

    return current;
  }
}
