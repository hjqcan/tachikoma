/**
 * Tool Executor - 统一工具执行器
 * 
 * 提供统一的工具执行入口，自动集成权限校验和错误处理
 */

import type { Tool, ExecutionContext } from '../types';
import type { ToolResult } from './types';
import { PermissionValidator } from './permission-validator';
import { PermissionDeniedError } from './registry';

/**
 * 工具执行配置
 */
export interface ToolExecutionConfig {
  /** 是否跳过权限校验（仅用于测试） */
  skipPermissionCheck?: boolean;
  /** 是否在错误时抛出异常 */
  throwOnError?: boolean;
}

/**
 * 工具执行器类
 * 
 * 统一的工具执行入口，自动处理：
 * 1. 权限校验
 * 2. 错误处理
 * 3. 执行指标收集
 */
export class ToolExecutor {
  private validator: PermissionValidator;

  constructor() {
    this.validator = new PermissionValidator();
  }

  /**
   * 执行工具
   * 
   * @param tool - 要执行的工具
   * @param input - 工具输入
   * @param context - 执行上下文
   * @param config - 执行配置
   * @returns 工具执行结果
   * @throws PermissionDeniedError - 权限不足
   * @throws Error - 工具执行错误（当throwOnError=true时）
   */
  async execute<T = unknown>(
    tool: Tool,
    input: unknown,
    context: ExecutionContext,
    config: ToolExecutionConfig = {}
  ): Promise<ToolResult<T>> {
    const { skipPermissionCheck = false, throwOnError = false } = config;

    // 1. 权限校验
    if (!skipPermissionCheck) {
      const validation = this.validator.validate(tool, context);
      if (!validation.allowed) {
        const error = new PermissionDeniedError(
          tool.name,
          validation.reason || 'Permission denied'
        );
        
        if (throwOnError) {
          throw error;
        }
        
        return {
          success: false,
          error: error.message,
        } as ToolResult<T>;
      }
    }

    // 2. 执行工具
    const startTime = Date.now();
    try {
      const result = await tool.execute(input, context);
      const duration = Date.now() - startTime;

      // 3. 检查返回值shape，确保符合ToolResult契约
      if (!result || typeof result !== 'object') {
        // 工具返回了裸数据，包装为错误
        return {
          success: false,
          error: 'Tool returned invalid result (not an object)',
          meta: { executionTime: duration },
        } as ToolResult<T>;
      }

      const toolResult = result as ToolResult<T>;
      
      // 检查success字段存在性
      if (typeof toolResult.success !== 'boolean') {
        // success字段缺失或类型错误，视为失败
        return {
          success: false,
          error: 'Tool returned invalid result (missing or invalid success field)',
          data: toolResult.data,
          meta: { executionTime: duration },
        } as ToolResult<T>;
      }
      
      // 如果工具返回success=false且配置要求抛异常
      if (throwOnError && !toolResult.success) {
        throw new Error(toolResult.error || 'Tool execution failed');
      }

      // 添加执行指标到meta字段（不污染data）
      return {
        ...toolResult,
        meta: {
          ...(toolResult.meta || {}),
          executionTime: duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const err = error as Error;

      // 如果已经是PermissionDeniedError，直接抛出
      if (error instanceof PermissionDeniedError) {
        throw error;
      }

      // 如果配置要求抛异常，直接抛出
      if (throwOnError) {
        throw error;
      }

      // 否则返回错误结果
      return {
        success: false,
        error: err.message || 'Unknown execution error',
        meta: {
          executionTime: duration,
        },
      };
    }
  }

  /**
   * 批量执行工具
   * 
   * @param executions - 工具执行列表
   * @param context - 执行上下文
   * @param config - 执行配置
   * @returns 所有工具的执行结果
   */
  async executeMany(
    executions: Array<{ tool: Tool; input: unknown }>,
    context: ExecutionContext,
    config: ToolExecutionConfig = {}
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const { tool, input } of executions) {
      try {
        const result = await this.execute(tool, input, context, config);
        results.push(result);
      } catch (error) {
        // 如果某个工具失败，记录错误并继续
        const err = error as Error;
        results.push({
          success: false,
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * 检查工具是否可执行
   * 
   * @param tool - 要检查的工具
   * @param context - 执行上下文
   * @returns 是否可执行及原因
   */
  canExecute(
    tool: Tool,
    context: ExecutionContext
  ): { allowed: boolean; reason?: string } {
    return this.validator.validate(tool, context);
  }
}

/**
 * 全局工具执行器实例
 */
export const globalToolExecutor = new ToolExecutor();
