/**
 * expand_commit 工具
 *
 * Worker 在执行期发现某个任务过大时，用此工具向 Orchestrator 提交“扩展/细分”请求。
 *
 * 关键语义：
 * - 本工具本身 **不直接修改** `tasks.json`
 * - Orchestrator 会在审批阶段统一落盘（tasks.json 写回 + 角色继承写回 taskmeta）
 * - 审批通过后工具返回 committed=true
 *
 * @layer Atomic
 * @category Agent
 * @permissions Agent (orchestrator-mediated)
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';

type ExpandStrategy = 'serial' | 'parallel';

interface ExpandCommitSubtaskSpec {
  title: string;
  description: string;
  details?: string | undefined;
  testStrategy?: string | undefined;
}

interface ExpandCommitInput {
  /** 目标 task/subtask id（默认当前子任务 id） */
  targetId?: string | undefined;
  /** 新的子任务列表（至少 2 个） */
  subtasks: ExpandCommitSubtaskSpec[];
  /** 并行策略：serial=默认串行，parallel=全部可并行 */
  strategy?: ExpandStrategy | undefined;
  /** 强制覆盖（当目标已经存在 subtasks 时） */
  force?: boolean | undefined;
}

interface ExpandCommitOutput {
  committed: boolean;
  targetId: string;
  subtaskCount: number;
  strategy: ExpandStrategy;
}

function validateInput(input: unknown): { ok: boolean; error?: string; data?: ExpandCommitInput } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Input must be an object' };
  const obj = input as Record<string, unknown>;
  const subtasksRaw = obj.subtasks;
  if (!Array.isArray(subtasksRaw)) return { ok: false, error: 'Missing required field: subtasks (array)' };
  if (subtasksRaw.length < 2) return { ok: false, error: 'subtasks must contain at least 2 items' };

  const subtasks: ExpandCommitSubtaskSpec[] = [];
  for (const item of subtasksRaw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'Each subtask must be an object' };
    const it = item as Record<string, unknown>;
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    const description = typeof it.description === 'string' ? it.description.trim() : '';
    if (!title) return { ok: false, error: 'Each subtask requires a non-empty title' };
    if (!description) return { ok: false, error: 'Each subtask requires a non-empty description' };
    const details = typeof it.details === 'string' ? it.details : undefined;
    const testStrategy = typeof it.testStrategy === 'string' ? it.testStrategy : undefined;
    subtasks.push({ title, description, ...(details ? { details } : {}), ...(testStrategy ? { testStrategy } : {}) });
  }

  const targetId = typeof obj.targetId === 'string' ? obj.targetId.trim() : undefined;
  const strategyRaw = typeof obj.strategy === 'string' ? obj.strategy : undefined;
  const strategy: ExpandStrategy = strategyRaw === 'parallel' ? 'parallel' : 'serial';
  const force = obj.force === true;

  return {
    ok: true,
    data: {
      ...(targetId ? { targetId } : {}),
      subtasks,
      strategy,
      ...(force ? { force } : {}),
    },
  };
}

export const expandCommitTool: Tool = {
  name: 'expand_commit',
  title: 'Expand Commit',
  description:
    '提交执行期“任务细分/扩展”请求（由 Orchestrator 统一落盘到 tasks.json）。\n' +
    '\n' +
    '使用场景：当当前任务过大/可能超过调用预算/需要拆分为多个更小的可执行单元时。\n' +
    '\n' +
    '注意：\n' +
    '- 本工具不直接写 tasks.json；Orchestrator 会在审批阶段提交并触发重规划。\n' +
    '- 提交后你应停止继续对该父任务做实现工作，等待新的子任务被调度执行。',
  inputSchema: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: '目标 task/subtask id（可选，默认当前子任务）' },
      subtasks: {
        type: 'array',
        description: '子任务列表（至少 2 个）',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            details: { type: 'string' },
            testStrategy: { type: 'string' },
          },
          required: ['title', 'description'],
        },
      },
      strategy: { type: 'string', enum: ['serial', 'parallel'], description: '串行/并行策略（默认 serial）' },
      force: { type: 'boolean', description: '强制覆盖已有 subtasks（默认 false）' },
    },
    required: ['subtasks'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      committed: { type: 'boolean' },
      targetId: { type: 'string' },
      subtaskCount: { type: 'number' },
      strategy: { type: 'string', enum: ['serial', 'parallel'] },
    },
  },
  annotations: {
    audience: ['assistant'],
    priority: 0.9,
    idempotent: false,
    cacheable: false,
  },
  layer: ToolLayer.Atomic,
  category: ToolCategory.Agent,
  async execute(input: unknown, _context: ExecutionContext): Promise<ToolResult<ExpandCommitOutput>> {
    const v = validateInput(input);
    if (!v.ok || !v.data) {
      return { success: false, error: v.error ?? 'Invalid input' };
    }

    const targetId = v.data.targetId ?? 'current';
    const strategy: ExpandStrategy = v.data.strategy ?? 'serial';

    return {
      success: true,
      data: {
        committed: true,
        targetId,
        subtaskCount: v.data.subtasks.length,
        strategy,
      },
    };
  },
};


