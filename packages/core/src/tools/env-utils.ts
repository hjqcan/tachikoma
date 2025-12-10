/**
 * 合并环境变量的通用工具函数
 * 
 * 使用context.env覆盖process.env，实现多租户隔离
 */

import type { ExecutionContext } from '../types';
import { ENV_WHITELIST, SHELL_SAFETY } from './constants';

/**
 * 合并环境变量
 * 
 * @param context - 执行上下文
 * @returns 合并后的环境变量
 */
export function mergeEnv(context: ExecutionContext): Record<string, string> {
  // 基础环境变量白名单
  const baseEnv: Record<string, string> = {};
  
  for (const key of ENV_WHITELIST) {
    const value = process.env[key];
    if (value) {
      baseEnv[key] = value;
    }
  }
  
  // context.env优先级更高，并添加安全限制
  return {
    ...baseEnv,
    ...context.env,
    // 安全限制
    FORCE_COLOR: SHELL_SAFETY.forceColor,
    TERM: SHELL_SAFETY.termType,
  };
}
