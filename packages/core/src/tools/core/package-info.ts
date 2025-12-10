/**
 * package_info 工具
 *
 * 读取 package.json 信息，帮助 Agent 了解项目依赖
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { PackageInfoInput, PackageInfoOutput, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { detectPackageManager } from './security';
import { validatePath, ensureWorkDir } from './utils';

/**
 * 解析 bun.lock 文件获取实际版本
 *
 * bun.lock 是 JSON 格式，结构为：
 * {
 *   "lockfileVersion": 0,
 *   "packages": {
 *     "packageName@version": [...]
 *   }
 * }
 */
async function parseBunLock(
  lockPath: string
): Promise<Record<string, string>> {
  const resolvedVersions: Record<string, string> = {};

  try {
    const content = await readFile(lockPath, 'utf-8');
    const lockData = JSON.parse(content);

    if (lockData.packages && typeof lockData.packages === 'object') {
      for (const key of Object.keys(lockData.packages)) {
        // key 格式: "packageName@version" 或 "packageName@version_hash"
        const atIndex = key.lastIndexOf('@');
        if (atIndex > 0) {
          const name = key.slice(0, atIndex);
          const versionPart = key.slice(atIndex + 1);
          // 提取版本号（去掉可能的 hash 后缀）
          const version = versionPart.split('_')[0] ?? versionPart;
          resolvedVersions[name] = version;
        }
      }
    }
  } catch {
    // 解析失败时返回空对象
  }

  return resolvedVersions;
}

/**
 * package_info 工具定义
 */
export const packageInfoTool: Tool = {
  name: 'package_info',
  title: 'Get Package Info',
  description: `读取项目 package.json 信息。
- 返回包名、版本、依赖列表
- 自动检测包管理器 (bun/npm/yarn/pnpm)
- 可选解析锁文件获取实际安装版本（仅支持 bun.lock）
- 不返回 scripts 字段（安全考虑）`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'package.json 所在目录路径（相对于工作目录，默认 "."）',
      },
      resolveLockfile: {
        type: 'boolean',
        description: '是否解析锁文件获取实际版本（默认 false）',
        default: false,
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          dependencies: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          devDependencies: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          peerDependencies: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          resolvedVersions: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          packageManager: {
            type: 'string',
            enum: ['bun', 'npm', 'yarn', 'pnpm', 'unknown'],
          },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.7,
    idempotent: true,
    cacheable: true,
  },

  permissions: ['fs:read'],
  layer: ToolLayer.Atomic,
  category: ToolCategory.FileSystem,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<PackageInfoOutput>> {
    const { path = '.', resolveLockfile = false } = (input as PackageInfoInput) || {};

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      // 解析目标路径
      const targetDir = validatePath(path, context.workDir);
      const packageJsonPath = join(targetDir, 'package.json');

      // 检查文件存在
      if (!existsSync(packageJsonPath)) {
        return {
          success: false,
          error: `package.json not found at: ${packageJsonPath}`,
        };
      }

      // 读取并解析 package.json
      const content = await readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);

      // 检测包管理器
      const packageManager = detectPackageManager(targetDir);

      // 构建输出（过滤 scripts 等敏感字段）
      const output: PackageInfoOutput = {
        name: pkg.name || '',
        version: pkg.version || '',
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
        peerDependencies: pkg.peerDependencies || {},
        packageManager,
      };

      // 可选：解析锁文件
      if (resolveLockfile && packageManager === 'bun') {
        const lockPath = resolve(targetDir, 'bun.lock');
        if (existsSync(lockPath)) {
          output.resolvedVersions = await parseBunLock(lockPath);
        }
      }

      return {
        success: true,
        data: output,
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to read package.json',
      };
    }
  },
};
