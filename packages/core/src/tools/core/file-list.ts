/**
 * file_list 工具
 *
 * 列出目录内容
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { FileListInput, FileListOutput, FileInfo, ToolResult } from '../types';
import { validatePath, ensureWorkDir } from './utils';

/**
 * 匹配 glob 模式（简单实现）
 */
function matchPattern(filename: string, pattern?: string): boolean {
  if (!pattern) return true;

  // 简单的通配符匹配
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return regex.test(filename);
}

/**
 * 递归读取目录
 */
async function readDirRecursive(
  dirPath: string,
  basePath: string,
  pattern?: string,
  results: FileInfo[] = []
): Promise<FileInfo[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    // 计算相对于 basePath 的路径
    const relativePath = fullPath.substring(basePath.length + 1);

    if (entry.isDirectory()) {
      results.push({
        name: entry.name,
        path: relativePath,
        isDirectory: true,
        size: 0,
      });
      await readDirRecursive(fullPath, basePath, pattern, results);
    } else if (matchPattern(entry.name, pattern)) {
      const fileStat = await stat(fullPath);
      results.push({
        name: entry.name,
        path: relativePath,
        isDirectory: false,
        size: fileStat.size,
      });
    }
  }

  return results;
}

/**
 * file_list 工具定义
 */
export const fileListTool: Tool = {
  name: 'file_list',
  description: `列出指定目录的内容。
- 支持递归列出子目录
- 支持文件名模式过滤（* 和 ? 通配符）
- 路径相对于工作目录`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目录路径（相对于工作目录，默认为当前目录）',
        default: '.',
      },
      recursive: {
        type: 'boolean',
        description: '是否递归列出子目录',
        default: false,
      },
      pattern: {
        type: 'string',
        description: '文件名模式过滤（支持 * 和 ? 通配符）',
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
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                isDirectory: { type: 'boolean' },
                size: { type: 'number' },
              },
            },
          },
          count: { type: 'number' },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<FileListOutput>> {
    const { path: dirPath = '.', recursive = false, pattern } = (input || {}) as FileListInput;

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      const absolutePath = validatePath(dirPath, context.workDir);

      // 检查是否为目录
      const dirStat = await stat(absolutePath);
      if (!dirStat.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${dirPath}`,
        };
      }

      let files: FileInfo[];

      if (recursive) {
        files = await readDirRecursive(absolutePath, absolutePath, pattern);
      } else {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        files = [];

        for (const entry of entries) {
          if (!matchPattern(entry.name, pattern)) continue;

          const fullPath = join(absolutePath, entry.name);

          if (entry.isDirectory()) {
            files.push({
              name: entry.name,
              path: entry.name,
              isDirectory: true,
              size: 0,
            });
          } else {
            const fileStat = await stat(fullPath);
            files.push({
              name: entry.name,
              path: entry.name,
              isDirectory: false,
              size: fileStat.size,
            });
          }
        }
      }

      return {
        success: true,
        data: {
          files,
          count: files.length,
        },
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === 'ENOENT') {
        return {
          success: false,
          error: `Directory not found: ${dirPath}`,
        };
      }

      return {
        success: false,
        error: err.message || 'Unknown error listing directory',
      };
    }
  },
};
