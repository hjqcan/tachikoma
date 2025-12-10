/**
 * env_get 工具
 *
 * 读取白名单环境变量，提供安全的环境信息访问
 */

import type { Tool, ExecutionContext } from '../../types';
import type { EnvGetInput, EnvGetOutput, ToolResult } from '../types';
import { filterEnvRequests, DEFAULT_ENV_WHITELIST } from './security';

/**
 * env_get 工具定义
 */
export const envGetTool: Tool = {
  name: 'env_get',
  description: `读取环境变量（仅限白名单变量）。
- 只能读取预定义白名单中的变量（如 NODE_ENV, PATH, HOME 等）
- 敏感变量（如 API_KEY）会被拒绝
- 返回值包含：读取成功的变量、被拒绝的变量、不存在的变量`,
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '要读取的环境变量名称列表',
      },
    },
    required: ['names'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          values: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '成功读取的变量',
          },
          denied: {
            type: 'array',
            items: { type: 'string' },
            description: '被拒绝的变量（不在白名单）',
          },
          missing: {
            type: 'array',
            items: { type: 'string' },
            description: '不存在的变量',
          },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    _context: ExecutionContext
  ): Promise<ToolResult<EnvGetOutput>> {
    const { names } = input as EnvGetInput;

    try {
      // 验证输入
      if (!Array.isArray(names) || names.length === 0) {
        return {
          success: false,
          error: 'names must be a non-empty array of strings',
        };
      }

      // 过滤请求
      const { allowed, denied } = filterEnvRequests(names, DEFAULT_ENV_WHITELIST);

      // 读取允许的变量
      const values: Record<string, string> = {};
      const missing: string[] = [];

      for (const name of allowed) {
        const value = process.env[name];
        if (value !== undefined) {
          values[name] = value;
        } else {
          missing.push(name);
        }
      }

      return {
        success: true,
        data: {
          values,
          denied,
          missing,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to read environment variables',
      };
    }
  },
};
