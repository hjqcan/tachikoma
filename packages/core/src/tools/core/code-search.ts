/**
 * code_search 工具
 *
 * 搜索代码中的模式
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { CodeSearchInput, CodeSearchOutput, SearchMatch, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';

/** 搜索匹配内容最大长度 */
const MAX_MATCH_CONTENT_LENGTH = 200;

/**
 * 检查文件类型是否匹配
 */
function matchFileType(filePath: string, fileTypes?: string[]): boolean {
  if (!fileTypes || fileTypes.length === 0) return true;

  const ext = extname(filePath).toLowerCase();
  return fileTypes.some((type) => {
    const normalizedType = type.startsWith('.') ? type.toLowerCase() : `.${type.toLowerCase()}`;
    return ext === normalizedType;
  });
}

/**
 * 递归搜索目录
 */
async function searchDirectory(
  dirPath: string,
  basePath: string,
  pattern: RegExp,
  fileTypes: string[] | undefined,
  maxResults: number,
  matches: SearchMatch[]
): Promise<void> {
  if (matches.length >= maxResults) return;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= maxResults) break;

      const fullPath = join(dirPath, entry.name);

      // 跳过隐藏文件和 node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      if (entry.isDirectory()) {
        await searchDirectory(fullPath, basePath, pattern, fileTypes, maxResults, matches);
      } else if (matchFileType(entry.name, fileTypes)) {
        await searchFile(fullPath, basePath, pattern, maxResults, matches);
      }
    }
  } catch {
    // 忽略无法访问的目录
  }
}

/**
 * 搜索单个文件
 */
async function searchFile(
  filePath: string,
  basePath: string,
  pattern: RegExp,
  maxResults: number,
  matches: SearchMatch[]
): Promise<void> {
  if (matches.length >= maxResults) return;

  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // 计算相对路径
    const relativePath = filePath.substring(basePath.length + 1);

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;

      const line = lines[i];
      if (line && pattern.test(line)) {
        matches.push({
          file: relativePath,
          line: i + 1,
          content: line.trim().substring(0, MAX_MATCH_CONTENT_LENGTH),
        });
      }
    }
  } catch {
    // 忽略无法读取的文件（可能是二进制）
  }
}

/**
 * code_search 工具定义
 */
export const codeSearchTool: Tool = {
  name: 'code_search',
  title: 'Code Search',
  description: `在代码文件中搜索指定模式。
- 支持正则表达式和普通字符串匹配
- 支持文件类型过滤
- 自动跳过 node_modules 和隐藏文件
- 匹配内容自动截断（最大 200 字符）`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式',
      },
      path: {
        type: 'string',
        description: '搜索路径（相对于工作目录，默认为当前目录）',
        default: '.',
      },
      regex: {
        type: 'boolean',
        description: '是否为正则表达式（默认 false，使用字符串匹配）',
        default: false,
      },
      caseSensitive: {
        type: 'boolean',
        description: '是否区分大小写（默认 false）',
        default: false,
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description: '文件类型过滤（如 [".ts", ".js"]）',
      },
      maxResults: {
        type: 'number',
        description: '最大结果数（默认 50）',
        default: 50,
      },
    },
    required: ['pattern'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                line: { type: 'number' },
                content: { type: 'string' },
              },
            },
          },
          count: { type: 'number' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.8,
    idempotent: true,
    cacheable: true,
  },

  permissions: ['fs:read'],
  layer: ToolLayer.Atomic,
  category: ToolCategory.FileSystem,

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<CodeSearchOutput>> {
    const {
      pattern: patternStr,
      path: searchPath = '.',
      regex = false,
      caseSensitive = false,
      fileTypes,
      maxResults = 50,
    } = input as CodeSearchInput;

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      const absolutePath = validatePath(searchPath, context.workDir);

      // 构建正则表达式
      let pattern: RegExp;
      try {
        if (regex) {
          pattern = new RegExp(patternStr, caseSensitive ? '' : 'i');
        } else {
          // 转义特殊字符用于字符串匹配
          const escaped = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(escaped, caseSensitive ? '' : 'i');
        }
      } catch {
        return {
          success: false,
          error: `Invalid regex pattern: ${patternStr}`,
        };
      }

      const matches: SearchMatch[] = [];

      // 检查路径类型
      const pathStat = await stat(absolutePath);

      if (pathStat.isDirectory()) {
        await searchDirectory(absolutePath, absolutePath, pattern, fileTypes, maxResults, matches);
      } else {
        await searchFile(absolutePath, context.workDir, pattern, maxResults, matches);
      }

      return {
        success: true,
        data: {
          matches,
          count: matches.length,
        },
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === 'ENOENT') {
        return {
          success: false,
          error: `Path not found: ${searchPath}`,
        };
      }

      return {
        success: false,
        error: err.message || 'Unknown error searching code',
      };
    }
  },
};
