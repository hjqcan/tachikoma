/**
 * file_write 工具
 *
 * 写入文件内容（带文件锁 + 可选编辑后验证）
 */

import { writeFile, appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { FileWriteInput, FileWriteOutput, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';
import { withFileLock } from './file-lock';
import { BuildGateService, type BuildGateResult } from '../../orchestrator/services/build-gate';
import {
  isTestInForbiddenLocation,
  suggestTestLocation,
  validateFileContent,
  hasDuplicateTestSuffix,
  dedupeTestSuffix,
} from '../../worker/file-validator';
import { LSP } from '../../lsp';


// Singleton BuildGateService instance
let buildGateService: BuildGateService | null = null;
function getBuildGateService(): BuildGateService {
  if (!buildGateService) {
    buildGateService = new BuildGateService({ useLsp: true });
  }
  return buildGateService;
}

/**
 * 获取锁持有者ID
 * 优先使用 workerId，否则使用 agentId，最后使用 taskId
 */
function getOwnerId(context: ExecutionContext): string {
  const ctx = context as unknown as { workerId?: string; agentId?: string };
  return ctx.workerId ?? ctx.agentId ?? context.taskId ?? 'unknown';
}

/**
 * Extended input with validation option
 */
interface FileWriteInputExtended extends FileWriteInput {
  /** 写入后是否验证类型检查（默认 false） */
  validateAfterEdit?: boolean;
}

/**
 * Extended output with validation result
 */
interface FileWriteOutputExtended extends FileWriteOutput {
  /** 验证结果（仅当 validateAfterEdit=true 时存在） */
  validation?: {
    passed: boolean;
    summary: string;
    errorCount: number;
  };
  /** LSP 诊断信息（如果有错误） */
  diagnostics?: string;
}


/**
 * file_write 工具定义
 */
export const fileWriteTool: Tool = {
  name: 'file_write',
  title: 'Write File',
  description: `写入内容到指定文件。
- 如果文件不存在则创建
- 父目录会自动创建
- 路径相对于工作目录
- 可选：validateAfterEdit=true 写入后验证类型检查，失败时自动回滚`,
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
      validateAfterEdit: {
        type: 'boolean',
        description: '写入后是否验证类型检查，失败时自动回滚（默认 false）',
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
          validation: {
            type: 'object',
            properties: {
              passed: { type: 'boolean' },
              summary: { type: 'string' },
              errorCount: { type: 'number' },
            },
          },
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

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<FileWriteOutputExtended>> {
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

    const { path: filePath, content, append = false, validateAfterEdit = false } = input as FileWriteInputExtended;

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

      const maxFileSize = context.resourceLimits?.maxFileSize || DEFAULT_RESOURCE_LIMITS.maxFileSize;
      const buffer = Buffer.from(content, 'utf-8');
      
      if (buffer.length > maxFileSize) {
        return {
          success: false,
          error: `Content size (${buffer.length} bytes) exceeds resource limit (${maxFileSize} bytes)`,
        };
      }

      // Pre-write validation: Block __tests__ folders
      if (isTestInForbiddenLocation(absolutePath)) {
        const componentName = absolutePath.match(/[/\\]([^/\\]+)\.[tj]sx?$/)?.[1]?.replace(/\.test$/, '') ?? 'Component';
        const suggestedPath = suggestTestLocation(absolutePath.replace('/__tests__', '').replace('\\__tests__', ''));
        return {
          success: false,
          error: `❌ VALIDATION ERROR: Tests must NOT be in __tests__ folders.\n\n` +
            `File: ${absolutePath}\n\n` +
            `Problem: __tests__ folders break import paths and cause "Failed to resolve import" errors.\n\n` +
            `Solution: Place the test file NEXT TO the component it tests.\n` +
            `For example: ${componentName}.test.tsx should be in the same folder as ${componentName}.tsx\n\n` +
            `Suggested location: ${suggestedPath}`,
        };
      }

      // Pre-write validation: Block duplicate test suffixes (e.g., .test.test.tsx)
      if (hasDuplicateTestSuffix(absolutePath)) {
        const suggestedPath = dedupeTestSuffix(absolutePath);
        return {
          success: false,
          error: `❌ VALIDATION ERROR: Duplicate test suffix detected.\n\n` +
            `File: ${absolutePath}\n\n` +
            `Problem: Test filenames must NOT contain ".test.test" or ".spec.spec".\n\n` +
            `Solution: Use a single suffix (e.g., Component.test.tsx).\n\n` +
            `Suggested location: ${suggestedPath}`,
        };
      }

      // Pre-write validation: Check content quality (e.g. imports)
      const violations = validateFileContent(absolutePath, content);
      if (violations.length > 0) {
        const errorMsg = violations.map(v => `❌ ${v.message}`).join('\n\n');
        return {
          success: false,
          error: `VALIDATION FAILED:\n\n${errorMsg}\n\nPlease correct the content and try again.`,
        };
      }

      // 使用文件锁防止并发编辑冲突
      const ownerId = getOwnerId(context);
      
      // Validation state (use object to allow mutation inside async closure)
      const state: {
        originalContent: string | null;
        validationResult: BuildGateResult | null;
        rolledBack: boolean;
      } = {
        originalContent: null,
        validationResult: null,
        rolledBack: false,
      };

      await withFileLock(absolutePath, ownerId, async () => {
        // 读取原始内容用于回滚
        if (validateAfterEdit) {
          try {
            state.originalContent = await readFile(absolutePath, 'utf-8');
          } catch {
            // 文件可能不存在，回滚时删除
            state.originalContent = null;
          }
        }

        // 写入新内容
        if (append) {
          await appendFile(absolutePath, buffer);
        } else {
          await writeFile(absolutePath, buffer);
        }

        // 验证类型检查
        if (validateAfterEdit) {
          const buildGate = getBuildGateService();
          state.validationResult = await buildGate.check(context.workDir);

          // 如果验证失败，回滚
          if (!state.validationResult.passed) {
            if (state.originalContent !== null) {
              await writeFile(absolutePath, state.originalContent);
            } else {
              // 文件原本不存在，删除新创建的文件
              const { unlink } = await import('node:fs/promises');
              await unlink(absolutePath).catch(() => undefined);
            }
            state.rolledBack = true;
          }
        }
      });

      // 如果验证失败并已回滚，返回失败
      if (state.validationResult && !state.validationResult.passed && state.rolledBack) {
        const errorSummary = BuildGateService.formatErrorsForWorker(state.validationResult);
        return {
          success: false,
          error: `Validation failed after edit (rolled back). ${state.validationResult.summary}\n${errorSummary}`,
          data: {
            path: filePath,
            bytesWritten: 0,
            validation: {
              passed: false,
              summary: state.validationResult.summary,
              errorCount: state.validationResult.errors.length,
            },
          },
        };
      }

      // 成功 - build result data object before assigning to result
      const resultData: FileWriteOutputExtended = {
        path: filePath,
        bytesWritten: buffer.length,
      };

      if (state.validationResult) {
        resultData.validation = {
          passed: state.validationResult.passed,
          summary: state.validationResult.summary,
          errorCount: state.validationResult.errors.length,
        };
      }

      const result: ToolResult<FileWriteOutputExtended> = {
        success: true,
        data: resultData,
      };

      // Register modified file for VerificationGate scoping
      context.registerModifiedFile?.(absolutePath);

      // OpenCode-style: Run LSP diagnostics and return errors to agent
      try {
        await LSP.touchFile(absolutePath, context.workDir, undefined, true);
        const diagnostics = await LSP.diagnostics(context.workDir);
        const fileErrors = diagnostics[absolutePath]?.filter(d => d.severity === 1) ?? [];
        
        if (fileErrors.length > 0) {
          const MAX_ERRORS = 10;
          const limitedErrors = fileErrors.slice(0, MAX_ERRORS);
          const hasMore = fileErrors.length > MAX_ERRORS;
          
          const errorMessages = limitedErrors.map(d => 
            `  Line ${d.range?.start?.line ?? 0}: ${d.message}`
          ).join('\n');
          
          const diagnosticsMsg = 
            `\n⚠️ This file has ${fileErrors.length} error(s). Please fix:\n` +
            `<file_diagnostics>\n${errorMessages}${hasMore ? `\n  ... and ${fileErrors.length - MAX_ERRORS} more` : ''}\n</file_diagnostics>\n` +
            `\nCommon fixes:\n` +
            `- If JSX syntax error: Rename .js to .jsx\n` +
            `- If "is not defined": Add missing import or configure globals\n` +
            `- If type error: Check function signatures and props`;
          
          result.data = {
            ...result.data!,
            diagnostics: diagnosticsMsg,
          };
        }
      } catch {
        // LSP not available, skip diagnostics
      }

      return result;

    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Unknown error writing file',
      };
    }
  },
};
