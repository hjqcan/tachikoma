/**
 * file_write 工具
 *
 * 写入文件内容
 */

import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { FileWriteInput, FileWriteOutput, ToolResult } from '../types';
import { validatePath, ensureWorkDir } from './utils';

/**
 * file_write 工具定义
 */
export const fileWriteTool: Tool = {
  name: 'file_write',
  description: `写入内容到指定文件。
- 如果文件不存在则创建
- 父目录会自动创建
- 路径相对于工作目录`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录）',
      },
      content: {
        type: 'string',
        description: '要写入的内容',
      },
      append: {
        type: 'boolean',
        description: '是否追加模式（默认 false，覆盖）',
        default: false,
      },
    },
    required: ['path', 'content'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytesWritten: { type: 'number' },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<FileWriteOutput>> {
    const { path: filePath, content, append = false } = input as FileWriteInput;

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      const absolutePath = validatePath(filePath, context.workDir);

      // 确保父目录存在
      const parentDir = dirname(absolutePath);
      await mkdir(parentDir, { recursive: true });

      // 写入文件
      const buffer = Buffer.from(content, 'utf-8');

      if (append) {
        await appendFile(absolutePath, buffer);
      } else {
        await writeFile(absolutePath, buffer);
      }

      return {
        success: true,
        data: {
          path: filePath,
          bytesWritten: buffer.length,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Unknown error writing file',
      };
    }
  },
};
