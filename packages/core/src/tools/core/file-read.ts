/**
 * file_read 工具
 *
 * 读取文件内容，支持文本和二进制模式
 * 支持 Codex 风格的缩进感知读取模式
 */

import { readFile, stat } from 'node:fs/promises';
import type { Tool, ExecutionContext } from '../../types';
import type { FileReadInput, FileReadOutput, ToolResult } from '../types';
import {
  validatePath,
  ensureWorkDir,
  isBinaryFile,
  isBinaryContent,
  truncateOutput,
} from './utils';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';

// =============================================================================
// Constants (inspired by Codex)
// =============================================================================

/** Maximum characters per line before truncation */
const MAX_LINE_LENGTH = 500;

/** Tab width for indent calculation */
const TAB_WIDTH = 4;

/** Comment prefixes for header detection */
const COMMENT_PREFIXES = ['#', '//', '--', '/*', '*', '/**', '///'];

// =============================================================================
// Types
// =============================================================================

/** 读取模式 */
type ReadMode = 'full' | 'slice' | 'indentation';

/** 缩进感知配置 */
interface IndentationOptions {
  /** 锚点行号（1-indexed），默认使用 offset */
  anchorLine?: number;
  /** 向上扩展的最大缩进层级数，0 表示无限制 */
  maxLevels?: number;
  /** 是否包含同级代码块 */
  includeSiblings?: boolean;
  /** 是否包含头部注释 */
  includeHeader?: boolean;
  /** 最大返回行数上限 */
  maxLines?: number;
}

/** 文件读取输入（扩展版） */
interface ExtendedFileReadInput extends FileReadInput {
  /** 编码格式（默认 utf-8，binary 返回 base64） */
  encoding?: string;
  /** 最大输出长度（默认 50000） */
  maxOutput?: number;
  /** 起始行号（1-indexed），默认 1（仅 slice/indentation 模式） */
  offset?: number;
  /** 最大行数（仅 slice/indentation 模式有效，默认 2000） */
  limit?: number;
  /** 读取模式：full(整文件) | slice(范围) | indentation(缩进感知) */
  mode?: ReadMode;
  /** 缩进感知配置（仅 mode='indentation' 时有效） */
  indentation?: IndentationOptions;
  /** 是否在输出中显示行号（slice/indentation 默认 true，full 默认 false） */
  showLineNumbers?: boolean;
}

/** 文件读取输出（扩展版） */
interface ExtendedFileReadOutput extends FileReadOutput {
  /** 是否为二进制 */
  isBinary?: boolean;
  /** 是否被截断 */
  truncated?: boolean;
  /** 总行数 */
  totalLines?: number;
  /** 返回的行范围 */
  lineRange?: { start: number; end: number };
}

// =============================================================================
// Line Record for Indentation Mode
// =============================================================================

interface LineRecord {
  /** 1-indexed 行号 */
  number: number;
  /** 原始内容 */
  raw: string;
  /** 格式化后的显示内容 */
  display: string;
  /** 缩进空格数 */
  indent: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * 测量行的缩进（Tab 算作 TAB_WIDTH 个空格）
 */
function measureIndent(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === ' ') {
      indent++;
    } else if (char === '\t') {
      indent += TAB_WIDTH;
    } else {
      break;
    }
  }
  return indent;
}

/**
 * 检查是否为空行
 */
function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * 检查是否为注释行
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return COMMENT_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

/**
 * 格式化行（截断过长的行）
 */
function formatLine(line: string): string {
  if (line.length > MAX_LINE_LENGTH) {
    return line.slice(0, MAX_LINE_LENGTH) + '...';
  }
  return line;
}

/**
 * 计算有效缩进（空行继承前一行的缩进）
 */
function computeEffectiveIndents(records: LineRecord[]): number[] {
  const effective: number[] = [];
  let previousIndent = 0;
  
  for (const record of records) {
    if (isBlankLine(record.raw)) {
      effective.push(previousIndent);
    } else {
      previousIndent = record.indent;
      effective.push(previousIndent);
    }
  }
  
  return effective;
}

/**
 * 解析文件为行记录
 */
function parseLines(content: string): LineRecord[] {
  const lines = content.split('\n');
  return lines.map((line, index) => ({
    number: index + 1,
    raw: line,
    display: formatLine(line),
    indent: measureIndent(line),
  }));
}

/**
 * 去除首尾空行
 */
function trimEmptyLines(records: LineRecord[]): LineRecord[] {
  // 去除开头的空行
  let start = 0;
  while (start < records.length && isBlankLine(records[start]!.raw)) {
    start++;
  }
  
  // 去除结尾的空行
  let end = records.length;
  while (end > start && isBlankLine(records[end - 1]!.raw)) {
    end--;
  }
  
  return records.slice(start, end);
}

// =============================================================================
// Reading Modes
// =============================================================================

/**
 * Slice 模式：简单的行范围读取
 */
function readSlice(records: LineRecord[], offset: number, limit: number): LineRecord[] {
  if (offset > records.length) {
    return [];
  }
  
  const startIndex = offset - 1; // 转换为 0-indexed
  const endIndex = Math.min(startIndex + limit, records.length);
  
  return records.slice(startIndex, endIndex);
}

/**
 * Indentation 模式：缩进感知读取
 * 
 * 算法原理（参考 Codex）：
 * 1. 从锚点行开始，计算其缩进级别
 * 2. 根据 maxLevels 计算允许的最小缩进
 * 3. 双向扩展（向上和向下），只收集缩进 >= minIndent 的行
 * 4. 可选包含同级块和头部注释
 */
function readIndentation(
  records: LineRecord[],
  offset: number,
  limit: number,
  options: IndentationOptions
): LineRecord[] | null {
  const {
    anchorLine = offset,
    maxLevels = 0,
    includeSiblings = false,
    includeHeader = true,
    maxLines,
  } = options;
  
  // 验证锚点行 - 返回 null 表示需要报错（而非静默返回空）
  if (anchorLine < 1 || anchorLine > records.length) {
    return null; // 调用方需处理此情况
  }
  
  const anchorIndex = anchorLine - 1;
  const effectiveIndents = computeEffectiveIndents(records);
  const anchorIndent = effectiveIndents[anchorIndex]!;
  
  // 计算最小缩进
  const minIndent = maxLevels === 0 
    ? 0 
    : Math.max(0, anchorIndent - maxLevels * TAB_WIDTH);
  
  // 最终限制
  const finalLimit = Math.min(limit, maxLines ?? limit, records.length);
  
  // 只请求一行时直接返回
  if (finalLimit === 1) {
    return [records[anchorIndex]!];
  }
  
  // 使用双端队列进行双向扩展
  const result: LineRecord[] = [records[anchorIndex]!];
  
  // 游标
  let upIndex = anchorIndex - 1;   // 向上
  let downIndex = anchorIndex + 1; // 向下
  let upMinIndentCount = 0;        // 向上遇到 minIndent 的次数
  // downMinIndentCount 不再需要，因为向下遇到 minIndent 立即停止
  
  while (result.length < finalLimit) {
    let progressed = false;
    
    // 向上扩展
    if (upIndex >= 0) {
      const upIndent = effectiveIndents[upIndex]!;
      const upRecord = records[upIndex]!;
      
      if (upIndent >= minIndent) {
        // 是否允许添加这一行
        let canAdd = true;
        
        // 如果不包含同级，到达 minIndent 时需要特殊处理
        if (upIndent === minIndent && !includeSiblings) {
          const isHeader = includeHeader && isCommentLine(upRecord.raw);
          canAdd = isHeader || upMinIndentCount === 0;
          if (canAdd) {
            upMinIndentCount++;
          } else {
            // 停止向上扩展
            upIndex = -1;
          }
        }
        
        if (canAdd && upIndex >= 0) {
          result.unshift(upRecord);
          upIndex--;
          progressed = true;
        }
        
        if (result.length >= finalLimit) break;
      } else {
        // 缩进不足，停止向上
        upIndex = -1;
      }
    }
    
    // 向下扩展
    if (downIndex < records.length) {
      const downIndent = effectiveIndents[downIndex]!;
      const downRecord = records[downIndex]!;
      
      if (downIndent >= minIndent) {
        // 是否允许添加这一行
        let canAdd = true;
        
        // 如果不包含同级，到达 minIndent 时需要特殊处理
        // 修复：向下时第一个 minIndent 行也不应包含（与向上行为对称）
        if (downIndent === minIndent && !includeSiblings) {
          // 第一个 minIndent 行是代码块的结束行（如右括号），应该停止
          canAdd = false;
          downIndex = records.length;
        }
        
        if (canAdd && downIndex < records.length) {
          result.push(downRecord);
          downIndex++;
          progressed = true;
        }
      } else {
        // 缩进不足，停止向下
        downIndex = records.length;
      }
    }
    
    // 无法继续扩展
    if (!progressed) break;
  }
  
  return trimEmptyLines(result);
}

/**
 * 格式化输出行（添加行号前缀）
 */
function formatOutputLines(records: LineRecord[], showLineNumbers = true): string {
  if (showLineNumbers) {
    return records.map(r => `L${r.number}: ${r.display}`).join('\n');
  }
  return records.map(r => r.display).join('\n');
}

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * file_read 工具定义
 */
export const fileReadTool: Tool = {
  name: 'file_read',
  title: 'Read File',
  description: `读取指定文件的内容。路径相对于工作目录。

**读取模式**:
- \`full\`: 读取整个文件（默认，大文件会截断）
- \`slice\`: 按行范围读取，使用 offset 和 limit 参数
- \`indentation\`: 🌟 缩进感知读取，智能识别代码块

**缩进感知模式 (mode='indentation')**:
从锚点行开始，向上/下扩展到代码块边界。非常适合读取函数、类等结构化代码。
参数：
- anchorLine: 锚点行号（默认使用 offset）
- maxLevels: 向上扩展的层级数（0=无限制）
- includeSiblings: 是否包含同级代码块
- includeHeader: 是否包含头部注释

**示例**:
\`\`\`json
// 读取第 100 行所在的函数
{ "path": "app.ts", "offset": 100, "mode": "indentation", "limit": 100 }

// 读取第 50-100 行
{ "path": "app.ts", "offset": 50, "limit": 50, "mode": "slice" }
\`\`\``,
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
      offset: {
        type: 'number',
        description: '起始行号（1-indexed），默认 1',
        default: 1,
      },
      limit: {
        type: 'number',
        description: '最大行数，默认 2000',
        default: 2000,
      },
      mode: {
        type: 'string',
        enum: ['full', 'slice', 'indentation'],
        description: '读取模式：full(整文件) | slice(范围) | indentation(缩进感知)',
        default: 'full',
      },
      indentation: {
        type: 'object',
        description: '缩进感知配置（仅 mode="indentation" 时有效）',
        properties: {
          anchorLine: {
            type: 'number',
            description: '锚点行号（1-indexed），默认使用 offset',
          },
          maxLevels: {
            type: 'number',
            description: '向上扩展的最大缩进层级数，0 表示无限制',
            default: 0,
          },
          includeSiblings: {
            type: 'boolean',
            description: '是否包含同级代码块',
            default: false,
          },
          includeHeader: {
            type: 'boolean',
            description: '是否包含头部注释',
            default: true,
          },
          maxLines: {
            type: 'number',
            description: '最大返回行数上限',
          },
        },
      },
      showLineNumbers: {
        type: 'boolean',
        description: '是否在输出中显示行号前缀。full模式默认false，slice/indentation模式默认true',
        default: false,
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
          totalLines: { type: 'number' },
          lineRange: {
            type: 'object',
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
            },
          },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<ExtendedFileReadOutput>> {
    const {
      path: filePath,
      encoding,
      offset = 1,
      limit = 2000,
      mode = 'full',
      indentation,
      showLineNumbers,
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
      // P1-A: 使用 effectiveCwd 作为基础目录
      const baseDir = context.effectiveCwd ?? context.workDir;
      const absolutePath = validatePath(filePath, baseDir);

      // 应用资源限制（使用统一默认值）
      const maxFileSize = context.resourceLimits?.maxFileSize || DEFAULT_RESOURCE_LIMITS.maxFileSize;
      const maxOutputSize = context.resourceLimits?.maxOutputSize || DEFAULT_RESOURCE_LIMITS.maxOutputSize;

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

      // 二进制文件直接返回 base64，不支持行模式
      if (isBinary) {
        const content = buffer.toString('base64');
        const truncatedContent = truncateOutput(content, maxOutputSize);
        const truncated = truncatedContent.length !== content.length;

        return {
          success: true,
          data: {
            content: truncatedContent,
            size: fileStat.size,
            isBinary: true,
            truncated,
          },
        };
      }

      // 文本文件处理
      const textContent = buffer.toString('utf-8');
      const records = parseLines(textContent);
      const totalLines = records.length;

      // 验证 offset
      if (offset < 1) {
        return {
          success: false,
          error: 'offset must be >= 1 (1-indexed line number)',
        };
      }

      if (limit < 1) {
        return {
          success: false,
          error: 'limit must be >= 1',
        };
      }

      let outputRecords: LineRecord[];
      let lineRange: { start: number; end: number };

      switch (mode) {
        case 'slice': {
          outputRecords = readSlice(records, offset, limit);
          if (outputRecords.length === 0 && offset > totalLines) {
            return {
              success: false,
              error: `offset (${offset}) exceeds file length (${totalLines} lines)`,
            };
          }
          break;
        }

        case 'indentation': {
          // 验证 anchorLine（如果提供）
          const anchorLine = indentation?.anchorLine ?? offset;
          if (anchorLine < 1 || anchorLine > totalLines) {
            return {
              success: false,
              error: `anchorLine (${anchorLine}) exceeds file length (${totalLines} lines)`,
            };
          }
          const result = readIndentation(records, offset, limit, indentation ?? {});
          // readIndentation 在越界时返回 null
          if (result === null) {
            return {
              success: false,
              error: `anchorLine exceeds file length (${totalLines} lines)`,
            };
          }
          outputRecords = result;
          break;
        }

        case 'full':
        default: {
          // Full mode: 返回原始文件内容，不进行行级处理
          // 截断检查
          const truncatedContent = truncateOutput(textContent, maxOutputSize);
          const truncated = truncatedContent.length !== textContent.length;

          return {
            success: true,
            data: {
              content: truncatedContent,
              size: fileStat.size,
              isBinary: false,
              truncated,
              totalLines,
              lineRange: { start: 1, end: totalLines },
            },
          };
        }
      }

      // 计算行范围 (slice/indentation 模式)
      const firstRecord = outputRecords[0];
      const lastRecord = outputRecords[outputRecords.length - 1];
      if (firstRecord && lastRecord) {
        lineRange = {
          start: firstRecord.number,
          end: lastRecord.number,
        };
      } else {
        lineRange = { start: 0, end: 0 };
      }

      // 决定是否显示行号：用户可自定义，否则 slice/indentation 默认 true
      const effectiveShowLineNumbers = showLineNumbers ?? true;
      
      // 格式化输出
      const content = formatOutputLines(outputRecords, effectiveShowLineNumbers);

      // 截断检查
      const truncatedContent = truncateOutput(content, maxOutputSize);
      const truncated = truncatedContent.length !== content.length;

      return {
        success: true,
        data: {
          content: truncatedContent,
          size: fileStat.size,
          isBinary: false,
          truncated,
          totalLines,
          lineRange,
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
