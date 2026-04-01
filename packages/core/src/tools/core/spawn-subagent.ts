/**
 * spawn_subagent - 生成子Agent/子任务工具
 *
 * 允许Agent定义并请求执行子任务
 * 子任务会保存到 subtasks 目录，供 Orchestrator 发现并调度执行
 *
 * @layer Atomic
 * @category Agent
 * @permissions Agent, FileSystemWrite
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';
import { buildTool } from '../build-tool';
import { getSpawnSubagentPrompt } from './prompts/spawn-subagent-prompt';
import { getDefaultModelFacingAliases } from '../model-facing-names';

/**
 * 子任务结果
 */
interface SpawnResult {
  /** 子任务ID */
  subtaskId: string;
  /** 当前状态 */
  status: 'pending';
  /** 子任务文件路径 */
  subtaskPath: string;
  /** 创建时间戳（用于排序，代替 queueOrder） */
  createdAt: number;
  /** 目标描述 */
  objective: string;
  /** 依赖列表 */
  dependencies: string[];
  /** 优先级 */
  priority: number;
  /** 提示信息 */
  message: string;
}

/**
 * 验证输入
 */
function validateInput(input: unknown): {
  valid: boolean;
  error?: string;
  data?: {
    objective: string;
    description?: string | undefined;
    constraints: string[];
    tools?: string[] | undefined;
    dependencies: string[];
    priority: number;
    timeout: number;
    context?: Record<string, unknown> | undefined;
  };
} {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  // 必填字段
  if (!obj.objective || typeof obj.objective !== 'string') {
    return { valid: false, error: 'objective is required and must be a string' };
  }
  if (obj.objective.trim().length === 0) {
    return { valid: false, error: 'objective cannot be empty' };
  }

  // 可选字段类型校验
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    return { valid: false, error: 'description must be a string' };
  }

  if (obj.constraints !== undefined) {
    if (!Array.isArray(obj.constraints)) {
      return { valid: false, error: 'constraints must be an array' };
    }
    for (const c of obj.constraints) {
      if (typeof c !== 'string') {
        return { valid: false, error: 'constraints must be an array of strings' };
      }
    }
  }

  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools)) {
      return { valid: false, error: 'tools must be an array' };
    }
    for (const t of obj.tools) {
      if (typeof t !== 'string') {
        return { valid: false, error: 'tools must be an array of strings' };
      }
    }
  }

  if (obj.dependencies !== undefined) {
    if (!Array.isArray(obj.dependencies)) {
      return { valid: false, error: 'dependencies must be an array' };
    }
    for (const d of obj.dependencies) {
      if (typeof d !== 'string') {
        return { valid: false, error: 'dependencies must be an array of strings' };
      }
    }
  }

  if (obj.priority !== undefined) {
    if (typeof obj.priority !== 'number' || obj.priority < 1 || obj.priority > 10) {
      return { valid: false, error: 'priority must be a number between 1 and 10' };
    }
  }

  if (obj.timeout !== undefined && typeof obj.timeout !== 'number') {
    return { valid: false, error: 'timeout must be a number' };
  }

  if (obj.context !== undefined && typeof obj.context !== 'object') {
    return { valid: false, error: 'context must be an object' };
  }

  return {
    valid: true,
    data: {
      objective: obj.objective as string,
      description: obj.description as string | undefined,
      constraints: (obj.constraints as string[]) ?? [],
      tools: obj.tools as string[] | undefined,
      dependencies: (obj.dependencies as string[]) ?? [],
      priority: (obj.priority as number) ?? 5,
      timeout: (obj.timeout as number) ?? 60000,
      context: obj.context as Record<string, unknown> | undefined,
    },
  };
}

/**
 * spawn_subagent 工具定义
 */
export const spawnSubagentTool = buildTool({
  name: 'spawn_subagent',
  aliases: getDefaultModelFacingAliases('spawn_subagent'),
  title: 'Spawn Sub-Agent',
  description: `创建一个子任务/子Agent来处理特定目标。

使用场景：
- 将复杂任务分解为可并行执行的子任务
- 委托专门的子任务（如代码审查、测试生成）
- 需要独立上下文的任务

⚠️ 路径约定：
- 子任务定义写入 tasks.json（由 Orchestrator 管理）
- Session 模式下通过 sessionId 隔离`,
  searchHint: 'delegate task subagent parallel isolated context',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  prompt: getSpawnSubagentPrompt,

  layer: ToolLayer.Atomic,
  category: ToolCategory.Agent,
  permissions: [ToolPermission.Agent, ToolPermission.FileSystemWrite],

  annotations: {
    idempotent: false,
    cacheable: false,
    estimatedDuration: 1000,
    priority: 5,
  },

  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: '子任务的目标（清晰、可执行的任务描述）',
      },
      description: {
        type: 'string',
        description: '详细描述（可选）',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: '子任务的约束条件',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '子任务可用的工具列表（不指定则继承父任务）',
      },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: '依赖的其他子任务ID（这些任务完成后才会执行）',
      },
      priority: {
        type: 'number',
        description: '优先级（1-10，10最高，默认5）',
        default: 5,
        minimum: 1,
        maximum: 10,
      },
      timeout: {
        type: 'number',
        description: '最大执行时间（毫秒，默认60000）',
        default: 60000,
      },
      context: {
        type: 'object',
        description: '传递给子任务的上下文数据',
      },
    },
    required: ['objective'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      subtaskId: { type: 'string' },
      status: { type: 'string', enum: ['pending'] },
      subtaskPath: { type: 'string' },
      createdAt: { type: 'number' },
      objective: { type: 'string' },
      dependencies: { type: 'array', items: { type: 'string' } },
      priority: { type: 'number' },
      message: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<SpawnResult>> {
    // 输入校验
    const validation = validateInput(input);
    if (!validation.valid || !validation.data) {
      return {
        success: false,
        error: `Invalid input: ${validation.error}`,
      };
    }

    const {
      objective,
      description,
      constraints,
      tools,
      dependencies,
      priority,
      timeout,
      context: subtaskContext,
    } = validation.data;

    // 使用高精度时间戳确保唯一性和排序
    const createdAt = Date.now();
    // 添加随机后缀避免同一毫秒内的冲突
    const subtaskId = `subtask-${createdAt}-${Math.random().toString(36).slice(2, 8)}`;

    // 构建 subtasks 目录路径
    // 优先使用 session 路径（如果 SESSION_ID 存在）
    const sessionId = context.env?.SESSION_ID as string | undefined;
    const workerId = context.env?.WORKER_ID as string | undefined;
    
    let subtasksDir: string;
    if (sessionId && workerId) {
      // Session 模式：写入 session 目录结构
      // {workDir}/.tachikoma/sessions/{sessionId}/workers/{workerId}/subtasks/
      subtasksDir = join(
        context.workDir, '.tachikoma', 'sessions', sessionId, 'workers', workerId, 'subtasks'
      );
    } else if (sessionId) {
      // 只有 sessionId，写入 orchestrator 级别
      // {workDir}/.tachikoma/sessions/{sessionId}/orchestrator/subtasks/
      subtasksDir = join(
        context.workDir, '.tachikoma', 'sessions', sessionId, 'orchestrator', 'subtasks'
      );
    } else {
      // 默认模式：写入全局 subtasks 目录
      subtasksDir = join(context.workDir, '.tachikoma', 'subtasks');
    }

    try {
      await mkdir(subtasksDir, { recursive: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        success: false,
        error: `Failed to create subtasks directory: ${subtasksDir}. Reason: ${err.message}`,
      };
    }

    // 构建子任务定义（使用 createdAt 作为排序依据，避免并发竞态）
    const subtaskDefinition = {
      id: subtaskId,
      parentTaskId: context.taskId,
      parentAgentId: context.agentId,
      status: 'pending' as const,
      objective,
      description,
      constraints: [`工作目录: ${context.workDir}`, ...constraints],
      tools, // 如果 undefined，Orchestrator 会使用默认工具集
      dependencies,
      priority,
      timeout,
      context: subtaskContext,
      // 使用时间戳排序，无需 queueOrder（避免并发竞态）
      createdAt,
      createdBy: context.agentId,
    };

    // 写入子任务文件
    const subtaskPath = join(subtasksDir, `${subtaskId}.json`);

    try {
      await writeFile(subtaskPath, JSON.stringify(subtaskDefinition, null, 2), 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        success: false,
        error: `Failed to write subtask file: ${subtaskPath}. Reason: ${err.message}`,
      };
    }

    return {
      success: true,
      data: {
        subtaskId,
        status: 'pending',
        subtaskPath,
        createdAt,
        objective,
        dependencies,
        priority,
        message:
          `子任务 ${subtaskId} 已创建，等待 Orchestrator 调度执行。` +
          (dependencies.length > 0 ? ` 依赖: ${dependencies.join(', ')}` : ''),
      },
    };
  },
});

export default spawnSubagentTool;
