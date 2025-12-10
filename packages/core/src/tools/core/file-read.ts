/**
 * file_read 工具
 *
 * 读取文件内容，支持文本和二进制模式
 */

import { readFile, stat } from 'node:fs/promises';
import type { Tool, ExecutionContext } from '../../types';
import type { FileReadInput, FileReadOutput, ToolResult } from '../types';
import {
  validatePath,
  ensureWorkDir,
  truncateOutput,
  isBinaryFile,
  isBinaryContent,
  DEFAULT_MAX_OUTPUT,
} from './utils';

/** 文件读取输入（扩展版） */
interface ExtendedFileReadInput extends FileReadInput {
  /** 编码格式（默认 utf-8，binary 返回 base64） */
  encoding?: string;
  /** 最大输出长度（默认 50000） */
  maxOutput?: number;
}

/** 文件读取输出（扩展版） */
interface ExtendedFileReadOutput extends FileReadOutput {
  /** 是否为二进制 */
  isBinary?: boolean;
  /** 是否被截断 */
  truncated?: boolean;
}

/**
 * file_read 工具定义
 */
export const fileReadTool: Tool = {
  name: 'file_read',
  description: `读取指定文件的内容。路径相对于工作目录。
- 文本文件返回 UTF-8 内容
- 二进制文件返回 base64 编码
- 大文件会自动截断（默认最大 50000 字符）`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录）',
      },
      encoding: {
        type: 'string',
        description: '编码格式（utf-8|binary，默认自动检测）',
      },
      maxOutput: {
        type: 'number',
        description: '最大输出长度（默认 50000 字符）',
      },
    },
    required: ['path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          size: { type: 'number' },
          isBinary: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<ExtendedFileReadOutput>> {
    const {
      path: filePath,
      encoding,
      maxOutput = DEFAULT_MAX_OUTPUT,
    } = input as ExtendedFileReadInput;

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

      // 应用资源限制（使用默认值如果未提供）
      const maxFileSize = context.resourceLimits?.maxFileSize || 50 * 1024 * 1024; // 50MB
      const maxOutputSize = context.resourceLimits?.maxOutputSize || maxOutput;

      // 获取文件信息
      const fileStat = await stat(absolutePath);
      if (fileStat.isDirectory()) {
        return {
          success: false,
          error: `Path is a directory: ${filePath}`,
        };
      }

      // 检查文件大小限制（早期拒绝）
      if (fileStat.size > maxFileSize) {
        return {
          success: false,
          error: `File size (${fileStat.size} bytes) exceeds resource limit (${maxFileSize} bytes)`,
        };
      }

      // 判断是否二进制
      const forceBinary = encoding === 'binary';
      const forceText = encoding === 'utf-8' || encoding === 'utf8';
      let isBinary = forceBinary || (!forceText && isBinaryFile(filePath));

      // 读取文件
      const buffer = await readFile(absolutePath);

      // 如果没有明确指定编码，检测内容是否为二进制
      if (!forceBinary && !forceText && !isBinary) {
        isBinary = isBinaryContent(buffer);
      }

      let content: string;
      if (isBinary) {
        // 二进制：返回 base64
        content = buffer.toString('base64');
      } else {
        // 文本：返回 UTF-8
        content = buffer.toString('utf-8');
      }

      // 使用资源限制的截断处理
      const truncated = content.length > maxOutputSize;
      if (truncated) {
        content = content.substring(0, maxOutputSize);
      }

      return {
        success: true,
        data: {
          content,
          size: fileStat.size,
          isBinary,
          truncated,
        },
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      return {
        success: false,
        error: err.message || 'Unknown error reading file',
      };
    }
  },
};
