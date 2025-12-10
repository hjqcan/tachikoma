/**
 * apply_patch 工具
 *
 * 应用增量补丁到文件，支持搜索/替换模式
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';

/**
 * 单个补丁操作
 */
interface PatchOperation {
  /** 要匹配的精确文本 */
  search: string;
  /** 替换内容（空字符串表示删除） */
  replace: string;
  /** 匹配第几个出现（默认 1，0 表示全部） */
  occurrence?: number;
}

/**
 * apply_patch 输入
 */
export interface ApplyPatchInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 补丁操作列表 */
  patches: PatchOperation[];
  /** 是否创建备份（默认 false） */
  backup?: boolean;
}

/**
 * apply_patch 输出
 */
export interface ApplyPatchOutput {
  /** 修改的文件路径 */
  path: string;
  /** 应用的补丁数量 */
  patchesApplied: number;
  /** 修改前后的差异行数 */
  linesChanged: number;
  /** 修改前后的字节差 */
  bytesDelta: number;
}

/**
 * 应用单个补丁
 */
function applyPatch(
  content: string,
  patch: PatchOperation
): { success: boolean; result: string; error?: string } {
  const { search, replace, occurrence = 1 } = patch;

  if (!search) {
    return { success: false, result: content, error: 'Search string cannot be empty' };
  }

  // 检查内容中是否包含搜索字符串
  if (!content.includes(search)) {
    // 提供上下文帮助 LLM 理解问题
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
    return {
      success: false,
      result: content,
      error: `Search string not found in file. File preview:\n${preview}`,
    };
  }

  if (occurrence === 0) {
    // 替换所有出现
    const result = content.split(search).join(replace);
    return { success: true, result };
  }

  // 替换第 N 个出现
  let count = 0;
  let lastIndex = 0;
  let found = false;
  let result = '';

  while (true) {
    const index = content.indexOf(search, lastIndex);
    if (index === -1) break;

    count++;
    if (count === occurrence) {
      result = content.slice(0, index) + replace + content.slice(index + search.length);
      found = true;
      break;
    }
    lastIndex = index + 1;
  }

  if (!found) {
    return {
      success: false,
      result: content,
      error: `Only found ${count} occurrence(s), but trying to replace occurrence #${occurrence}`,
    };
  }

  return { success: true, result };
}

/**
 * apply_patch 工具定义
 */
export const applyPatchTool: Tool = {
  name: 'apply_patch',
  title: 'Apply Patch',
  description: `对文件应用增量补丁。使用搜索/替换模式，无需输出完整文件内容。

使用方法：
- 指定要查找的精确文本（search）和替换内容（replace）
- 可以在一次调用中应用多个补丁
- 适合修改现有文件的特定部分

示例：
{
  "path": "app.js",
  "patches": [
    { "search": "const old = 1;", "replace": "const new = 2;" },
    { "search": "function foo() {}", "replace": "function bar() {}" }
  ]
}

注意：
- search 必须是文件中的精确文本（包括空格和换行）
- occurrence=0 替换所有出现，默认只替换第一个
- 如果 search 找不到，会返回错误和文件预览`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录）',
      },
      patches: {
        type: 'array',
        description: '补丁操作列表',
        items: {
          type: 'object',
          properties: {
            search: {
              type: 'string',
              description: '要匹配的精确文本',
            },
            replace: {
              type: 'string',
              description: '替换内容（空字符串表示删除）',
            },
            occurrence: {
              type: 'number',
              description: '匹配第几个出现（默认 1，0 表示全部）',
              default: 1,
            },
          },
          required: ['search', 'replace'],
        },
      },
      backup: {
        type: 'boolean',
        description: '是否创建备份（默认 false）',
        default: false,
      },
    },
    required: ['path', 'patches'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patchesApplied: { type: 'number' },
          linesChanged: { type: 'number' },
          bytesDelta: { type: 'number' },
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

  permissions: ['fs:read', 'fs:write'],
  layer: ToolLayer.Atomic,
  category: ToolCategory.FileSystem,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<ApplyPatchOutput>> {
    const { path: filePath, patches, backup = false } = input as ApplyPatchInput;

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

      // 读取原始内容
      let content: string;
      try {
        content = await readFile(absolutePath, 'utf-8');
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return {
            success: false,
            error: `File not found: ${filePath}. Use file_write to create new files.`,
          };
        }
        throw err;
      }

      const originalContent = content;
      const originalBytes = Buffer.from(originalContent, 'utf-8').length;
      const originalLines = originalContent.split('\n').length;

      // 创建备份
      if (backup) {
        const backupPath = absolutePath + '.bak';
        await writeFile(backupPath, originalContent);
      }

      // 应用资源限制检查（使用统一默认值）
      const maxFileSize = context.resourceLimits?.maxFileSize || DEFAULT_RESOURCE_LIMITS.maxFileSize;
      if (originalBytes > maxFileSize) {
        return {
          success: false,
          error: `File size (${originalBytes} bytes) exceeds resource limit (${maxFileSize} bytes)`,
        };
      }

      // 应用每个补丁
      let patchesApplied = 0;
      const errors: string[] = [];

      for (let i = 0; i < patches.length; i++) {
        const patch = patches[i];
        if (!patch) continue;

        const result = applyPatch(content, patch);
        if (result.success) {
          content = result.result;
          patchesApplied++;
        } else {
          errors.push(`Patch ${i + 1}: ${result.error}`);
        }
      }

      // 如果没有任何补丁成功应用，返回错误
      if (patchesApplied === 0) {
        return {
          success: false,
          error: `No patches applied. Errors:\n${errors.join('\n')}`,
        };
      }

      // 确保父目录存在
      const parentDir = dirname(absolutePath);
      await mkdir(parentDir, { recursive: true });

      // 写回文件
      await writeFile(absolutePath, content);

      const newBytes = Buffer.from(content, 'utf-8').length;
      const newLines = content.split('\n').length;

      return {
        success: true,
        data: {
          path: filePath,
          patchesApplied,
          linesChanged: Math.abs(newLines - originalLines),
          bytesDelta: newBytes - originalBytes,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Unknown error applying patch',
      };
    }
  },
};
