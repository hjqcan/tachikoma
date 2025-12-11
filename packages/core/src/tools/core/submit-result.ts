/**
 * submit_result - 提交任务结果工具
 *
 * 允许Agent提交任务执行结果
 * 结果会写入到 Worker 的 artifacts 目录
 *
 * @layer Atomic
 * @category Agent
 * @permissions FileSystemWrite
 */

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';

/**
 * 提交结果输出
 */
interface SubmitResultOutput {
  /** 是否成功接受 */
  accepted: boolean;
  /** 提交ID */
  submissionId: string;
  /** 结果文件路径 */
  resultPath: string;
  /** 时间戳 */
  timestamp: number;
  /** 结果状态 */
  status: 'success' | 'partial' | 'failed';
  /** 是否为最终结果 */
  isFinal: boolean;
  /** 摘要 */
  summary?: string | undefined;
}

/**
 * 验证输入
 */
function validateInput(input: unknown): {
  valid: boolean;
  error?: string;
  data?: {
    result: unknown;
    status: 'success' | 'partial' | 'failed';
    summary?: string | undefined;
    isFinal: boolean;
    metadata?: Record<string, unknown> | undefined;
    filename: string;
  };
} {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  // 必填字段
  if (!('result' in obj)) {
    return { valid: false, error: 'Missing required field: result' };
  }
  if (!('status' in obj)) {
    return { valid: false, error: 'Missing required field: status' };
  }

  // status 枚举校验
  const validStatuses = ['success', 'partial', 'failed'];
  if (!validStatuses.includes(obj.status as string)) {
    return {
      valid: false,
      error: `Invalid status: ${obj.status}. Must be one of: ${validStatuses.join(', ')}`,
    };
  }

  // 可选字段类型校验
  if (obj.summary !== undefined && typeof obj.summary !== 'string') {
    return { valid: false, error: 'summary must be a string' };
  }
  if (obj.isFinal !== undefined && typeof obj.isFinal !== 'boolean') {
    return { valid: false, error: 'isFinal must be a boolean' };
  }
  if (obj.metadata !== undefined && typeof obj.metadata !== 'object') {
    return { valid: false, error: 'metadata must be an object' };
  }
  if (obj.filename !== undefined && typeof obj.filename !== 'string') {
    return { valid: false, error: 'filename must be a string' };
  }

  return {
    valid: true,
    data: {
      result: obj.result,
      status: obj.status as 'success' | 'partial' | 'failed',
      summary: obj.summary as string | undefined,
      isFinal: (obj.isFinal as boolean) ?? true,
      metadata: obj.metadata as Record<string, unknown> | undefined,
      filename: (obj.filename as string) ?? 'result',
    },
  };
}

/**
 * submit_result 工具定义
 */
export const submitResultTool: Tool = {
  name: 'submit_result',
  title: 'Submit Result',
  description: `提交任务执行结果。结果会保存到 artifacts 目录，供 Orchestrator 读取聚合。

使用场景：
- 完成子任务后提交结果
- 报告部分进度
- 提交失败信息

结果文件格式：JSON，包含 result、status、summary、metadata 等字段。`,

  layer: ToolLayer.Atomic,
  category: ToolCategory.Agent,
  permissions: [ToolPermission.FileSystemWrite],

  annotations: {
    idempotent: false,
    cacheable: false,
    priority: 10, // 高优先级
  },

  inputSchema: {
    type: 'object',
    properties: {
      result: {
        description: '任务执行结果（任意JSON可序列化数据）',
      },
      status: {
        type: 'string',
        enum: ['success', 'partial', 'failed'],
        description: '结果状态：success-成功，partial-部分完成，failed-失败',
      },
      summary: {
        type: 'string',
        description: '结果摘要说明（人类可读）',
      },
      isFinal: {
        type: 'boolean',
        description: '是否为最终结果（默认true）',
        default: true,
      },
      metadata: {
        type: 'object',
        description: '附加元数据（如执行时间、token消耗等）',
      },
      filename: {
        type: 'string',
        description: '自定义文件名（不含扩展名，默认 "result"）',
      },
    },
    required: ['result', 'status'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      accepted: { type: 'boolean' },
      submissionId: { type: 'string' },
      resultPath: { type: 'string' },
      timestamp: { type: 'number' },
      status: { type: 'string', enum: ['success', 'partial', 'failed'] },
      isFinal: { type: 'boolean' },
      summary: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<SubmitResultOutput>> {
    // 输入校验
    const validation = validateInput(input);
    if (!validation.valid || !validation.data) {
      return {
        success: false,
        error: `Invalid input: ${validation.error}`,
      };
    }

    const { result, status, summary, isFinal, metadata, filename } = validation.data;

    const timestamp = Date.now();
    const submissionId = `submission-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

    // 构建 artifacts 目录路径
    // 使用 workDir/.tachikoma/artifacts/ 作为标准路径
    const artifactsDir = join(context.workDir, '.tachikoma', 'artifacts');

    try {
      // 确保目录存在
      await mkdir(artifactsDir, { recursive: true });

      // 检查目录可写性
      const dirStat = await stat(artifactsDir);
      if (!dirStat.isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${artifactsDir}`,
        };
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        success: false,
        error: `Failed to create artifacts directory: ${artifactsDir}. Reason: ${err.message}`,
      };
    }

    // 构建结果对象
    const resultData = {
      submissionId,
      taskId: context.taskId,
      agentId: context.agentId,
      status,
      isFinal,
      result,
      summary,
      metadata: {
        ...metadata,
        submittedAt: new Date(timestamp).toISOString(),
      },
      timestamp,
    };

    // 写入结果文件（非最终结果使用时间戳后缀避免覆盖）
    const resultFilename = isFinal ? `${filename}.json` : `${filename}-${timestamp}.json`;
    const resultPath = join(artifactsDir, resultFilename);

    try {
      await mkdir(dirname(resultPath), { recursive: true });
      await writeFile(resultPath, JSON.stringify(resultData, null, 2), 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        success: false,
        error: `Failed to write result file: ${resultPath}. Reason: ${err.message}`,
      };
    }

    return {
      success: true,
      data: {
        accepted: true,
        submissionId,
        resultPath,
        timestamp,
        status,
        isFinal,
        summary,
      },
    };
  },
};

export default submitResultTool;
