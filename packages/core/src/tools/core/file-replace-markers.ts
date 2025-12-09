/**
 * replace_between_markers 工具
 *
 * 替换文件中两个标记之间的内容
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { validatePath, ensureWorkDir } from './utils';

/**
 * replace_between_markers 输入
 */
export interface ReplaceBetweenMarkersInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 开始标记（精确匹配） */
  startMarker: string;
  /** 结束标记（精确匹配） */
  endMarker: string;
  /** 新内容（不包含标记） */
  content: string;
  /** 是否包含标记本身（默认 false，只替换中间内容） */
  includeMarkers?: boolean;
  /** 匹配第几对标记（默认 1，0 表示全部） */
  occurrence?: number;
}

/**
 * replace_between_markers 输出
 */
export interface ReplaceBetweenMarkersOutput {
  /** 修改的文件路径 */
  path: string;
  /** 替换的区域数量 */
  regionsReplaced: number;
  /** 修改前后的行数差 */
  linesDelta: number;
  /** 修改前后的字节差 */
  bytesDelta: number;
}

/**
 * 在内容中查找标记对
 */
interface MarkerMatch {
  /** 起始位置（包含起始标记） */
  start: number;
  /** 结束位置（包含结束标记后） */
  end: number;
  /** 起始标记结束位置 */
  startMarkerEnd: number;
  /** 结束标记开始位置 */
  endMarkerStart: number;
}

function findMarkerPairs(
  content: string,
  startMarker: string,
  endMarker: string
): MarkerMatch[] {
  const matches: MarkerMatch[] = [];
  let searchStart = 0;

  while (true) {
    const startIndex = content.indexOf(startMarker, searchStart);
    if (startIndex === -1) break;

    const startMarkerEnd = startIndex + startMarker.length;
    const endIndex = content.indexOf(endMarker, startMarkerEnd);
    if (endIndex === -1) break;

    const endMarkerEnd = endIndex + endMarker.length;

    matches.push({
      start: startIndex,
      end: endMarkerEnd,
      startMarkerEnd,
      endMarkerStart: endIndex,
    });

    // 从结束标记之后继续搜索（避免重叠）
    searchStart = endMarkerEnd;
  }

  return matches;
}

/**
 * replace_between_markers 工具定义
 */
export const replaceBetweenMarkersTool: Tool = {
  name: 'replace_between_markers',
  description: `替换文件中两个标记之间的内容。适用于有清晰边界的代码块修改。

使用方法：
- 指定开始标记和结束标记
- 提供要替换的新内容
- 标记可以是注释、函数签名、HTML 标签等

示例 - 替换函数体：
{
  "path": "app.js",
  "startMarker": "function calculate() {",
  "endMarker": "}",
  "content": "\\n  return a + b;\\n",
  "includeMarkers": false
}

示例 - 替换整个区块：
{
  "path": "index.html",
  "startMarker": "<!-- HEADER_START -->",
  "endMarker": "<!-- HEADER_END -->",
  "content": "<header>New Header</header>",
  "includeMarkers": true
}

注意：
- startMarker 和 endMarker 必须精确匹配文件内容
- includeMarkers=false 时保留标记，只替换中间内容
- includeMarkers=true 时连同标记一起替换`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录）',
      },
      startMarker: {
        type: 'string',
        description: '开始标记（精确匹配）',
      },
      endMarker: {
        type: 'string',
        description: '结束标记（精确匹配）',
      },
      content: {
        type: 'string',
        description: '新内容',
      },
      includeMarkers: {
        type: 'boolean',
        description: '是否包含标记本身（默认 false）',
        default: false,
      },
      occurrence: {
        type: 'number',
        description: '匹配第几对标记（默认 1，0 表示全部）',
        default: 1,
      },
    },
    required: ['path', 'startMarker', 'endMarker', 'content'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          regionsReplaced: { type: 'number' },
          linesDelta: { type: 'number' },
          bytesDelta: { type: 'number' },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<ReplaceBetweenMarkersOutput>> {
    const {
      path: filePath,
      startMarker,
      endMarker,
      content: newContent,
      includeMarkers = false,
      occurrence = 1,
    } = input as ReplaceBetweenMarkersInput;

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
      let fileContent: string;
      try {
        fileContent = await readFile(absolutePath, 'utf-8');
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

      const originalContent = fileContent;
      const originalBytes = Buffer.from(originalContent, 'utf-8').length;
      const originalLines = originalContent.split('\n').length;

      // 找到所有标记对
      const matches = findMarkerPairs(fileContent, startMarker, endMarker);

      if (matches.length === 0) {
        // 提供诊断信息
        const hasStart = fileContent.includes(startMarker);
        const hasEnd = fileContent.includes(endMarker);
        let diagnostic = '';
        if (!hasStart) {
          diagnostic += `Start marker not found: "${startMarker.slice(0, 50)}${startMarker.length > 50 ? '...' : ''}"\n`;
        }
        if (!hasEnd) {
          diagnostic += `End marker not found: "${endMarker.slice(0, 50)}${endMarker.length > 50 ? '...' : ''}"\n`;
        }
        if (hasStart && hasEnd) {
          diagnostic += 'Both markers exist but end marker appears before start marker.';
        }
        return {
          success: false,
          error: `No matching marker pairs found.\n${diagnostic}`,
        };
      }

      // 确定要替换哪些匹配
      let matchesToReplace: MarkerMatch[];
      if (occurrence === 0) {
        // 替换全部
        matchesToReplace = matches;
      } else if (occurrence <= matches.length) {
        const match = matches[occurrence - 1];
        if (!match) {
          return {
            success: false,
            error: `Internal error: match at index ${occurrence - 1} is undefined`,
          };
        }
        matchesToReplace = [match];
      } else {
        return {
          success: false,
          error: `Only found ${matches.length} marker pair(s), but trying to replace occurrence #${occurrence}`,
        };
      }

      // 从后向前替换（保持索引有效）
      let result = fileContent;
      const sortedMatches = [...matchesToReplace].sort((a, b) => b.start - a.start);

      for (const match of sortedMatches) {
        if (includeMarkers) {
          // 替换整个区域（包含标记）
          result = result.slice(0, match.start) + newContent + result.slice(match.end);
        } else {
          // 只替换标记之间的内容
          result =
            result.slice(0, match.startMarkerEnd) +
            newContent +
            result.slice(match.endMarkerStart);
        }
      }

      // 确保父目录存在
      const parentDir = dirname(absolutePath);
      await mkdir(parentDir, { recursive: true });

      // 写回文件
      await writeFile(absolutePath, result);

      const newBytes = Buffer.from(result, 'utf-8').length;
      const newLines = result.split('\n').length;

      return {
        success: true,
        data: {
          path: filePath,
          regionsReplaced: matchesToReplace.length,
          linesDelta: newLines - originalLines,
          bytesDelta: newBytes - originalBytes,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Unknown error replacing markers',
      };
    }
  },
};
