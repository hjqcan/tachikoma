/**
 * file_write 工具
 *
 * 写入文件内容
 */

import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { FileWriteInput, FileWriteOutput, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';

/**
 * file_write 工具定义
 */
export const fileWriteTool: Tool = {
  name: 'file_write',
  title: 'Write File',
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

  annotations: {
    audience: ['assistant'],
    priority: 0.8,
    idempotent: false,
  },

  permissions: ['fs:write'],
  layer: ToolLayer.Atomic,
  category: ToolCategory.FileSystem,

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<FileWriteOutput>> {
    // 检测格式错误的输入（LLM 生成的 JSON 解析失败时可能出现 raw 字段）
    const rawInput = input as Record<string, unknown>;
    if ('raw' in rawInput) {
      return {
        success: false,
        error: `Malformed input detected: the input contains a 'raw' field which indicates JSON parsing failed. ` +
               `Please ensure your tool call uses the correct format: {"path": "file.txt", "content": "..."}. ` +
               `Received raw value: ${String(rawInput.raw).substring(0, 100)}...`,
      };
    }

    const { path: filePath, content, append = false } = input as FileWriteInput;

    // 验证必填字段
    if (!filePath || typeof filePath !== 'string') {
      return {
        success: false,
        error: `Missing or invalid 'path' field. Expected a string path, got: ${typeof filePath}`,
      };
    }
    if (content === undefined || content === null) {
      return {
        success: false,
        error: `Missing 'content' field. The file content must be provided.`,
      };
    }

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }
      // P1-A: 使用 effectiveCwd 作为基础目录
      const baseDir = context.effectiveCwd ?? context.workDir;
      const absolutePath = validatePath(filePath, baseDir);

      // 确保父目录存在
      const parentDir = dirname(absolutePath);
      await mkdir(parentDir, { recursive: true });

      // 应用资源限制检查（使用统一默认值）
      const maxFileSize = context.resourceLimits?.maxFileSize || DEFAULT_RESOURCE_LIMITS.maxFileSize;
      const buffer = Buffer.from(content, 'utf-8');
      
      if (buffer.length > maxFileSize) {
        return {
          success: false,
          error: `Content size (${buffer.length} bytes) exceeds resource limit (${maxFileSize} bytes)`,
        };
      }

      // 写入文件

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
