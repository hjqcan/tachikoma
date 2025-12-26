/**
 * todowrite / todoread tools (inspired by opencode)
 *
 * Lightweight task tracking for multi-step work.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type {
  ToolResult,
  TodoItem,
  TodoPriority,
  TodoReadOutput,
  TodoStatus,
  TodoWriteInput,
  TodoWriteOutput,
} from '../types';
import { ToolCategory, ToolLayer, ToolPermission } from '../types';
import { ensureWorkDir } from './utils';

const VALID_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed', 'cancelled']);
const VALID_PRIORITIES = new Set<TodoPriority>(['high', 'medium', 'low']);

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const trimmed = sessionId.trim();
  if (!trimmed) return undefined;
  // Prevent path traversal / filesystem injection via env-provided session id.
  // Keep it stable and filesystem-safe.
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function getTodoPath(context: ExecutionContext): string {
  const sessionId = normalizeSessionId(context.env?.SESSION_ID as string | undefined);
  if (sessionId) {
    return join(context.workDir, '.tachikoma', 'sessions', sessionId, 'shared', 'todo.json');
  }
  return join(context.workDir, '.tachikoma', 'todo.json');
}

function normalizeTodoItem(raw: unknown, index: number): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (!content) return null;

  const statusRaw = typeof record.status === 'string' ? record.status : 'pending';
  const priorityRaw = typeof record.priority === 'string' ? record.priority : 'medium';
  const status: TodoStatus = VALID_STATUSES.has(statusRaw as TodoStatus)
    ? (statusRaw as TodoStatus)
    : 'pending';
  const priority: TodoPriority = VALID_PRIORITIES.has(priorityRaw as TodoPriority)
    ? (priorityRaw as TodoPriority)
    : 'medium';
  const id =
    typeof record.id === 'string' && record.id.trim().length > 0
      ? record.id
      : `todo-${Date.now()}-${index}`;

  return { id, content, status, priority };
}

async function readTodos(path: string): Promise<TodoItem[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as TodoItem[];
    }
    if (Array.isArray(parsed?.todos)) {
      return parsed.todos as TodoItem[];
    }
  } catch {
    // Ignore missing/invalid file.
  }
  return [];
}

async function writeTodos(path: string, todos: TodoItem[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(todos, null, 2), 'utf-8');
}

export const todoWriteTool: Tool = {
  name: 'todowrite',
  title: 'Todo Write',
  description: `Create or update a structured todo list for the current session.
- Use for multi-step tasks
- Keep only one item in_progress at a time`,
  category: ToolCategory.Agent,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemRead, ToolPermission.FileSystemWrite],
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full todo list to persist',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier' },
            content: { type: 'string', description: 'Brief task description' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
          },
          required: ['content'],
        },
      },
    },
    required: ['todos'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          pendingCount: { type: 'number' },
          todos: { type: 'array' },
        },
      },
    },
  },
  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<TodoWriteOutput>> {
    const payload = input as TodoWriteInput;
    if (!Array.isArray(payload?.todos)) {
      return { success: false, error: 'todos must be an array' };
    }

    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) {
      return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };
    }

    const normalized: TodoItem[] = [];
    for (const [index, raw] of payload.todos.entries()) {
      if (raw && typeof raw === 'object') {
        const item = normalizeTodoItem(raw, index);
        if (item) normalized.push(item);
      }
    }

    const todoPath = getTodoPath(context);
    await writeTodos(todoPath, normalized);

    const pendingCount = normalized.filter(
      (item) => item.status === 'pending' || item.status === 'in_progress'
    ).length;
    return {
      success: true,
      data: {
        todos: normalized,
        pendingCount,
      },
    };
  },
};

export const todoReadTool: Tool = {
  name: 'todoread',
  title: 'Todo Read',
  description: 'Read the current todo list for the session.',
  category: ToolCategory.Agent,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemRead],
  inputSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          pendingCount: { type: 'number' },
          todos: { type: 'array' },
        },
      },
    },
  },
  async execute(_input: unknown, context: ExecutionContext): Promise<ToolResult<TodoReadOutput>> {
    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) {
      return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };
    }

    const todoPath = getTodoPath(context);
    const todos = await readTodos(todoPath);
    const pendingCount = todos.filter(
      (item) => item.status === 'pending' || item.status === 'in_progress'
    ).length;

    return {
      success: true,
      data: {
        todos,
        pendingCount,
      },
    };
  },
};
