/**
 * apply_patch 工具
 *
 * 应用增量补丁到文件，支持：
 * 1. 搜索/替换模式 (patches)
 * 2. 自由格式 context-based diff 模式 (freeform)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 搜索/替换模式的单个补丁操作
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
 * 解析后的 Hunk (freeform 模式)
 */
interface ParsedHunk {
  /** 上下文行（用于定位） */
  context: string;
  /** 要删除的行 */
  removedLines: string[];
  /** 要添加的行 */
  addedLines: string[];
  /** 原始 hunk 文本（用于错误报告） */
  raw: string;
}

/**
 * apply_patch 输入
 */
export interface ApplyPatchInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 搜索/替换模式的补丁操作列表 */
  patches?: PatchOperation[];
  /** 自由格式 unified diff 补丁内容 */
  freeform?: string;
  /** 是否创建备份（默认 false） */
  backup?: boolean;
}

/**
 * apply_patch 输出
 */
export interface ApplyPatchOutput {
  /** 修改的文件路径 */
  path: string;
  /** 应用的补丁/hunk 数量 */
  patchesApplied: number;
  /** 失败的 hunk 数量（仅 freeform 模式） */
  patchesFailed?: number;
  /** 修改前后的差异行数 */
  linesChanged: number;
  /** 修改前后的字节差 */
  bytesDelta: number;
  /** 警告信息（如上下文模糊匹配） */
  warnings?: string[];
  /** 错误信息（部分失败时） */
  errors?: string[];
}

// =============================================================================
// 搜索/替换模式
// =============================================================================

/**
 * 应用单个搜索/替换补丁
 */
function applySearchReplacePatch(
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

// =============================================================================
// Freeform 模式 (Context-based Diff 风格)
// =============================================================================

/**
 * 解析 freeform 补丁内容
 * 
 * 支持的语法（非标准 unified diff）：
 * @@ context line @@
 * -line to remove
 * +line to add
 *  unchanged context (optional)
 */
function parseFreeformPatch(patchContent: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = patchContent.split('\n');
  
  let currentHunk: ParsedHunk | null = null;
  let hunkRaw: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    
    // 跳过 Begin/End Patch 标记
    if (line.includes('*** Begin Patch') || line.includes('*** End Patch')) {
      continue;
    }
    
    // 跳过文件头 (--- a/ 和 +++ b/)
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    
    // @@ context @@ 标记开始新的 hunk
    const contextMatch = line.match(/^@@\s*(.+?)\s*@@$/);
    if (contextMatch) {
      // 保存之前的 hunk
      if (currentHunk && (currentHunk.removedLines.length > 0 || currentHunk.addedLines.length > 0)) {
        currentHunk.raw = hunkRaw.join('\n');
        hunks.push(currentHunk);
      }
      
      // 开始新 hunk
      currentHunk = {
        context: contextMatch[1]?.trim() ?? '',
        removedLines: [],
        addedLines: [],
        raw: '',
      };
      hunkRaw = [line];
      continue;
    }
    
    // 处理 hunk 内容
    if (currentHunk) {
      hunkRaw.push(line);
      
      if (line.startsWith('-')) {
        // 删除行
        currentHunk.removedLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        // 添加行
        currentHunk.addedLines.push(line.slice(1));
      }
      // 忽略以空格开头的上下文行（仅用于人类阅读）
    }
  }
  
  // 保存最后一个 hunk
  if (currentHunk && (currentHunk.removedLines.length > 0 || currentHunk.addedLines.length > 0)) {
    currentHunk.raw = hunkRaw.join('\n');
    hunks.push(currentHunk);
  }
  
  return hunks;
}

/**
 * 应用单个 hunk
 * 
 * @param markUsedLines - 已使用的行索引集合，避免重复匹配
 */
function applyHunk(
  content: string,
  hunk: ParsedHunk,
  usedLineIndices?: Set<number>
): { success: boolean; result: string; error?: string; warning?: string; usedLineIndex?: number } {
  const lines = content.split('\n');
  
  // 查找匹配上下文的行（优先精确匹配，必要时降级为子串匹配）
  const contextTrimmed = hunk.context.trim();
  if (!contextTrimmed) {
    return {
      success: false,
      result: content,
      error: 'Context line is empty. Use @@ <unique context line> @@',
    };
  }
  
  const exactMatches: number[] = [];
  const partialMatches: number[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const lineTrimmed = lines[i]?.trim() ?? '';
    if (lineTrimmed === contextTrimmed) {
      exactMatches.push(i);
      continue;
    }
    if (lineTrimmed.includes(contextTrimmed)) {
      partialMatches.push(i);
    }
  }
  
  const candidateMatches = exactMatches.length > 0 ? exactMatches : partialMatches;
  
  if (candidateMatches.length === 0) {
    return {
      success: false,
      result: content,
      error: `Context line not found: "${hunk.context}"`,
    };
  }
  
  if (candidateMatches.length > 1) {
    return {
      success: false,
      result: content,
      error: `Ambiguous context: ${candidateMatches.length} matches for "${hunk.context}". Provide a more specific line.`,
    };
  }
  
  const contextIndex = candidateMatches[0]!;
  if (usedLineIndices?.has(contextIndex)) {
    return {
      success: false,
      result: content,
      error: `Context line already used by a previous hunk: "${hunk.context}"`,
    };
  }
  
  let warning: string | undefined;
  if (exactMatches.length === 0) {
    warning = `Context matched by substring at line ${contextIndex + 1}. Consider using the full line for a unique match.`;
  }
  
  // 计算要修改的区域
  const startLine = contextIndex + 1;
  const removeCount = hunk.removedLines.length;
  
  // 验证要删除的行是否匹配
  if (removeCount > 0) {
    for (let i = 0; i < removeCount; i++) {
      const actualLine = lines[startLine + i]?.trim() ?? '';
      const expectedLine = hunk.removedLines[i]?.trim() ?? '';
      
      if (actualLine !== expectedLine) {
        return {
          success: false,
          result: content,
          error: `Line mismatch at position ${startLine + i + 1}. Expected: "${expectedLine}", Found: "${actualLine}"`,
        };
      }
    }
  }
  
  // 应用修改：删除旧行，插入新行
  lines.splice(startLine, removeCount, ...hunk.addedLines);
  
  const result: { success: boolean; result: string; warning?: string; usedLineIndex?: number } = { 
    success: true, 
    result: lines.join('\n'),
    usedLineIndex: contextIndex,
  };
  if (warning) {
    result.warning = warning;
  }
  return result;
}

/**
 * 应用 freeform 补丁
 */
function applyFreeformPatch(
  content: string,
  patchContent: string
): { success: boolean; result: string; hunksApplied: number; hunksFailed: number; errors: string[]; warnings: string[] } {
  const hunks = parseFreeformPatch(patchContent);
  
  if (hunks.length === 0) {
    return {
      success: false,
      result: content,
      hunksApplied: 0,
      hunksFailed: 0,
      errors: ['No valid hunks found in freeform patch. Use @@ context @@ to mark hunk boundaries.'],
      warnings: [],
    };
  }
  
  let currentContent = content;
  let hunksApplied = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  const usedLineIndices = new Set<number>();
  
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (!hunk) continue;
    
    const result = applyHunk(currentContent, hunk, usedLineIndices);
    if (result.success) {
      currentContent = result.result;
      hunksApplied++;
      if (result.usedLineIndex !== undefined) {
        usedLineIndices.add(result.usedLineIndex);
      }
      if (result.warning) {
        warnings.push(`Hunk ${i + 1}: ${result.warning}`);
      }
    } else {
      errors.push(`Hunk ${i + 1}: ${result.error}`);
    }
  }
  
  const hunksFailed = hunks.length - hunksApplied;
  
  return {
    success: hunksApplied > 0,
    result: currentContent,
    hunksApplied,
    hunksFailed,
    errors,
    warnings,
  };
}

// =============================================================================
// 工具定义
// =============================================================================

/**
 * apply_patch 工具定义
 */
export const applyPatchTool: Tool = {
  name: 'apply_patch',
  title: 'Apply Patch',
  description: `对文件应用增量补丁。支持两种模式：

**模式 1: 搜索/替换 (patches)**
\`\`\`json
{
  "path": "app.js",
  "patches": [
    { "search": "const old = 1;", "replace": "const new = 2;" }
  ]
}
\`\`\`

**模式 2: 自由格式 Context Diff (freeform)** ⭐ 推荐
\`\`\`
{
  "path": "app.js",
  "freeform": "@@ function foo @@\\n-  const old = 1;\\n+  const new = 2;"
}
\`\`\`

Freeform 语法（非标准 unified diff）：
- \`@@ context line @@\` - 定位上下文（建议提供完整且唯一的行）
- \`-line\` - 删除此行
- \`+line\` - 添加此行

注意：
- patches 模式要求精确匹配（包括空格）
- freeform 模式按行匹配，优先精确匹配；仅子串匹配会给出 warning`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录）',
      },
      patches: {
        type: 'array',
        description: '搜索/替换模式的补丁操作列表',
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
      freeform: {
        type: 'string',
        description: `自由格式 diff 补丁（非标准 unified diff）。语法：
@@ 上下文行 @@（建议唯一完整行）
-要删除的行
+要添加的行`,
      },
      backup: {
        type: 'boolean',
        description: '是否创建备份（默认 false）',
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
    const { path: filePath, patches, freeform, backup = false } = input as ApplyPatchInput;

    // 验证输入：必须提供 patches 或 freeform 之一
    if (!patches && !freeform) {
      return {
        success: false,
        error: 'Must provide either "patches" array or "freeform" string',
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

      // 应用资源限制检查
      const maxFileSize = context.resourceLimits?.maxFileSize || DEFAULT_RESOURCE_LIMITS.maxFileSize;
      if (originalBytes > maxFileSize) {
        return {
          success: false,
          error: `File size (${originalBytes} bytes) exceeds resource limit (${maxFileSize} bytes)`,
        };
      }

      let patchesApplied = 0;
      let patchesFailed = 0;
      const errors: string[] = [];
      const warnings: string[] = [];

      // 模式 1: Freeform (优先)
      if (freeform) {
        const result = applyFreeformPatch(content, freeform);
        content = result.result;
        patchesApplied = result.hunksApplied;
        patchesFailed = result.hunksFailed;
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      }
      // 模式 2: 搜索/替换
      else if (patches) {
        for (let i = 0; i < patches.length; i++) {
          const patch = patches[i];
          if (!patch) continue;

          const result = applySearchReplacePatch(content, patch);
          if (result.success) {
            content = result.result;
            patchesApplied++;
          } else {
            patchesFailed++;
            errors.push(`Patch ${i + 1}: ${result.error}`);
          }
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

      // 构建输出，包含部分成功的警告和错误
      const output: ApplyPatchOutput = {
        path: filePath,
        patchesApplied,
        linesChanged: Math.abs(newLines - originalLines),
        bytesDelta: newBytes - originalBytes,
      };
      
      if (patchesFailed > 0) {
        output.patchesFailed = patchesFailed;
      }
      if (warnings.length > 0) {
        output.warnings = warnings;
      }
      if (errors.length > 0) {
        output.errors = errors;
      }

      return {
        success: true,
        data: output,
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

// 导出解析函数用于测试
export { parseFreeformPatch, applyHunk };
