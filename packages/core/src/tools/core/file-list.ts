/**
 * file_list 工具
 *
 * 列出目录内容，支持排除大目录和结果限制
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { FileListInput, FileListOutput, FileInfo, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { FILE_LIST_DEFAULT_EXCLUDES, FILE_LIST_MAX_RESULTS } from '../constants';

/** 扩展的 FileListInput，包含新参数 */
interface ExtendedFileListInput extends FileListInput {
  /** 排除的目录/文件模式 */
  excludes?: string[];
  /** 最大返回结果数 */
  maxResults?: number;
}

/** 扩展的输出类型 */
interface ExtendedFileListOutput extends FileListOutput {
  /** 是否还有更多结果（未返回） */
  hasMore?: boolean;
  /** 已扫描的条目数（下界，包括未返回的） */
  totalScanned: number;
}

/**
 * 转义正则特殊字符（保留 glob 通配符 * 和 ?）
 */
function escapeRegexExceptGlob(str: string): string {
  // 转义所有正则特殊字符，除了 * 和 ?
  return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * 匹配 glob 模式（简单实现）
 */
function matchPattern(filename: string, pattern?: string): boolean {
  if (!pattern) return true;

  // 先转义正则特殊字符，再处理 glob 通配符
  const escaped = escapeRegexExceptGlob(pattern);
  const regex = new RegExp(
    '^' +
      escaped
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return regex.test(filename);
}

/**
 * 检查是否应该排除
 */
function shouldExclude(name: string, excludes: string[]): boolean {
  return excludes.some((exclude) => {
    // 精确匹配
    if (name === exclude) return true;
    // 简单通配符匹配
    if (exclude.includes('*')) {
      const escaped = escapeRegexExceptGlob(exclude);
      const regex = new RegExp(
        '^' + escaped.replace(/\*/g, '.*') + '$'
      );
      return regex.test(name);
    }
    return false;
  });
}

/** 遍历结果 */
interface TraversalResult {
  files: FileInfo[];
  /** 是否还有更多未返回的结果 */
  hasMore: boolean;
  /** 已扫描的条目数（包括未返回的） */
  totalScanned: number;
}

/**
 * 递归读取目录（带排除和限制，达到限制后短路返回）
 */
async function readDirRecursive(
  dirPath: string,
  basePath: string,
  options: {
    pattern?: string;
    excludes: string[];
    maxResults: number;
  },
  state: { files: FileInfo[]; hasMore: boolean; totalScanned: number } = {
    files: [],
    hasMore: false,
    totalScanned: 0,
  }
): Promise<TraversalResult> {
  // 已达限制，短路返回
  if (state.files.length >= options.maxResults) {
    state.hasMore = true;
    return { files: state.files, hasMore: true, totalScanned: state.totalScanned };
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return { files: state.files, hasMore: state.hasMore, totalScanned: state.totalScanned };
  }

  for (const entry of entries) {
    // 检查是否应该排除
    if (shouldExclude(entry.name, options.excludes)) {
      continue;
    }

    // 记录扫描数（下界）
    state.totalScanned++;

    // 达到限制后立即短路
    if (state.files.length >= options.maxResults) {
      state.hasMore = true;
      return { files: state.files, hasMore: true, totalScanned: state.totalScanned };
    }

    const fullPath = join(dirPath, entry.name);
    const relativePath = fullPath.substring(basePath.length + 1);

    if (entry.isDirectory()) {
      state.files.push({
        name: entry.name,
        path: relativePath,
        isDirectory: true,
        size: 0,
      });

      // 递归处理子目录，如果返回 hasMore 则短路
      const subResult = await readDirRecursive(fullPath, basePath, options, state);
      if (subResult.hasMore) {
        return subResult;
      }
    } else if (matchPattern(entry.name, options.pattern)) {
      try {
        const fileStat = await stat(fullPath);
        state.files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: false,
          size: fileStat.size,
        });
      } catch {
        // 如果无法 stat 文件，跳过
      }
    }
  }

  return { files: state.files, hasMore: state.hasMore, totalScanned: state.totalScanned };
}

/**
 * file_list 工具定义
 */
export const fileListTool: Tool = {
  name: 'file_list',
  title: 'List Files',
  description: `列出指定目录的内容。
- 支持递归列出子目录
- 支持文件名模式过滤（* 和 ? 通配符）
- ⚠️ 递归模式下 node_modules, .git 等大目录默认被排除
- 结果默认限制为 500 条，可通过 maxResults 调整
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
        description: '是否递归列出子目录（递归时自动排除 node_modules 等）',
        default: false,
      },
      pattern: {
        type: 'string',
        description: '文件名模式过滤（支持 * 和 ? 通配符）',
      },
      excludes: {
        type: 'array',
        items: { type: 'string' },
        description: '排除的目录/文件名（递归时默认排除常见大目录，设置 [] 可覆盖）',
        default: FILE_LIST_DEFAULT_EXCLUDES,
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数（默认 500）',
        default: 500,
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
          hasMore: { type: 'boolean', description: '是否还有更多未返回的结果' },
          totalScanned: { type: 'number', description: '实际扫描数量（未返回的也计入，下界）' },
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

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<ExtendedFileListOutput>> {
    const {
      path: dirPath = '.',
      recursive = false,
      pattern,
      excludes,
      maxResults,
    } = (input || {}) as ExtendedFileListInput;

    // 即使提供了 excludes，也默认包含 FILE_LIST_DEFAULT_EXCLUDES（除非用户明确不想，但为了安全起见，我们默认合并）
    // 防止 Agent 传空数组导致扫描 node_modules
    const defaultExcludes = recursive ? [...FILE_LIST_DEFAULT_EXCLUDES] : [];
    const userExcludes = excludes || [];
    const effectiveExcludes = Array.from(new Set([...defaultExcludes, ...userExcludes]));
    const effectiveMaxResults = maxResults ?? FILE_LIST_MAX_RESULTS;

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
      const absolutePath = validatePath(dirPath, baseDir);

      // 检查是否为目录
      const dirStat = await stat(absolutePath);
      if (!dirStat.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${dirPath}`,
        };
      }

      let files: FileInfo[];
      let hasMore = false;
      let totalScanned = 0;

      if (recursive) {
        const result = await readDirRecursive(absolutePath, absolutePath, {
          ...(pattern ? { pattern } : {}),
          excludes: effectiveExcludes,
          maxResults: effectiveMaxResults,
        });
        files = result.files;
        hasMore = result.hasMore;
        totalScanned = result.totalScanned;
      } else {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        files = [];

        for (const entry of entries) {
          if (!matchPattern(entry.name, pattern)) continue;

          totalScanned++;

          // 达到限制后短路
          if (files.length >= effectiveMaxResults) {
            hasMore = true;
            break;
          }

          const fullPath = join(absolutePath, entry.name);

          if (entry.isDirectory()) {
            files.push({
              name: entry.name,
              path: entry.name,
              isDirectory: true,
              size: 0,
            });
          } else {
            try {
              const fileStat = await stat(fullPath);
              files.push({
                name: entry.name,
                path: entry.name,
                isDirectory: false,
                size: fileStat.size,
              });
            } catch {
              // 跳过无法 stat 的文件
            }
          }
        }
      }

      const response: ExtendedFileListOutput = {
        files,
        count: files.length,
        totalScanned,
      };

      if (hasMore) {
        response.hasMore = true;
      }

      return {
        success: true,
        data: response,
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
