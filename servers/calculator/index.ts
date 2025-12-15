/**
 * Calculator MCP Server Tools (示例)
 *
 * 用于端到端测试的简单计算器工具
 * 演示如何使用 createToolCaller 生成工具包装器
 *
 * @module servers/calculator
 */

import { createToolCaller } from '..';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 加法输入
 */
export interface AddInput extends Record<string, unknown> {
  a: number;
  b: number;
}

/**
 * 乘法输入
 */
export interface MultiplyInput extends Record<string, unknown> {
  a: number;
  b: number;
}

/**
 * 除法输入
 */
export interface DivideInput extends Record<string, unknown> {
  dividend: number;
  divisor: number;
}

// ============================================================================
// 工具包装器
// ============================================================================

/**
 * 加法工具
 *
 * @param input - 两个加数
 * @returns 计算结果
 *
 * @example
 * ```ts
 * const result = await add({ a: 5, b: 3 });
 * console.log(result.data); // 8
 * ```
 */
export const add = createToolCaller<AddInput, number>('calculator', 'add');

/**
 * 乘法工具
 *
 * @param input - 两个乘数
 * @returns 计算结果
 *
 * @example
 * ```ts
 * const result = await multiply({ a: 4, b: 7 });
 * console.log(result.data); // 28
 * ```
 */
export const multiply = createToolCaller<MultiplyInput, number>(
  'calculator',
  'multiply'
);

/**
 * 除法工具
 *
 * @param input - 被除数和除数
 * @returns 计算结果
 *
 * @example
 * ```ts
 * const result = await divide({ dividend: 20, divisor: 4 });
 * console.log(result.data); // 5
 * ```
 */
export const divide = createToolCaller<DivideInput, number>(
  'calculator',
  'divide'
);
