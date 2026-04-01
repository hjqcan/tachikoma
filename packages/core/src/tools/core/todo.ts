/**
 * todowrite / todoread tools (inspired by opencode)
 *
 * Lightweight task tracking for multi-step work.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutionContext } from '../../types';
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
import { buildTool } from '../build-tool';
import { getTodoReadPrompt, getTodoWritePrompt } from './prompts/todo-prompt';

interface TodoStateFile {
  revision: number;
  todos: TodoItem[];
  updatedAt: number;
}

type TodoValidationCode =
  | 'TODO_DUPLICATE_ID'
  | 'TODO_FSM_MULTIPLE_IN_PROGRESS'
  | 'TODO_FSM_INVALID_TRANSITION';

interface TodoValidationIssue {
  code: TodoValidationCode;
  message: string;
}

const VALID_STATUSES = new Set<TodoStatus>([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
]);
const VALID_PRIORITIES = new Set<TodoPriority>(['high', 'medium', 'low']);
const VALID_TRANSITIONS: Record<TodoStatus, ReadonlySet<TodoStatus>> = {
  pending: new Set(['pending', 'in_progress', 'cancelled']),
  in_progress: new Set(['in_progress', 'completed', 'blocked', 'cancelled']),
  blocked: new Set(['blocked', 'in_progress', 'cancelled']),
  completed: new Set(['completed']),
  cancelled: new Set(['cancelled']),
};

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

function createTodoCounts(): Record<TodoStatus, number> {
  return {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  };
}

function countTodoStatuses(todos: TodoItem[]): Record<TodoStatus, number> {
  const counts = createTodoCounts();
  for (const todo of todos) {
    counts[todo.status] += 1;
  }
  return counts;
}

function getPendingCount(todos: TodoItem[]): number {
  const counts = countTodoStatuses(todos);
  return counts.pending + counts.in_progress;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function resolveTodoFsmStrictMode(context: ExecutionContext): boolean {
  const fromEnv = parseBooleanEnv(context.env?.TACHIKOMA_TODO_FSM_STRICT_MODE);
  if (fromEnv !== undefined) return fromEnv;
  // 保持工具独立调用时的安全默认值：严格阻断。
  return true;
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

async function readTodoState(path: string): Promise<TodoStateFile> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const todos = parsed
        .map((item, index) => normalizeTodoItem(item, index))
        .filter((item): item is TodoItem => Boolean(item));
      return {
        revision: 0,
        todos,
        updatedAt: Date.now(),
      };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).todos)) {
      const parsedRecord = parsed as Record<string, unknown>;
      const rawTodos = parsedRecord.todos as unknown[];
      const todos = rawTodos
        .map((item, index) => normalizeTodoItem(item, index))
        .filter((item): item is TodoItem => Boolean(item));
      const rawRevision = parsedRecord.revision;
      const revision =
        typeof rawRevision === 'number' && Number.isInteger(rawRevision) && rawRevision >= 0
          ? rawRevision
          : 0;
      return {
        revision,
        todos,
        updatedAt: Date.now(),
      };
    }
  } catch {
    // Ignore missing/invalid file.
  }
  return {
    revision: 0,
    todos: [],
    updatedAt: Date.now(),
  };
}

async function writeTodoState(path: string, state: TodoStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
}

function validateTodoList(nextTodos: TodoItem[], prevTodos: TodoItem[]): TodoValidationIssue | null {
  const idSet = new Set<string>();
  for (const todo of nextTodos) {
    if (idSet.has(todo.id)) {
      return {
        code: 'TODO_DUPLICATE_ID',
        message: `Duplicate todo id detected: ${todo.id}`,
      };
    }
    idSet.add(todo.id);
  }

  const inProgressCount = nextTodos.filter((todo) => todo.status === 'in_progress').length;
  if (inProgressCount > 1) {
    return {
      code: 'TODO_FSM_MULTIPLE_IN_PROGRESS',
      message: 'Only one todo item may be in_progress at a time.',
    };
  }

  const prevStatusById = new Map<string, TodoStatus>();
  for (const todo of prevTodos) {
    prevStatusById.set(todo.id, todo.status);
  }

  for (const todo of nextTodos) {
    const previousStatus = prevStatusById.get(todo.id);
    if (!previousStatus) continue;
    if (previousStatus === todo.status) continue;
    if (!VALID_TRANSITIONS[previousStatus].has(todo.status)) {
      return {
        code: 'TODO_FSM_INVALID_TRANSITION',
        message: `Invalid todo status transition for "${todo.id}": ${previousStatus} -> ${todo.status}`,
      };
    }
  }

  return null;
}

export const todoWriteTool = buildTool({
  name: 'todowrite',
  title: 'Todo Write',
  description: `Create or update a structured todo list for the current session.
- Use for multi-step tasks
- Keep only one item in_progress at a time
- Respect todo state transitions`,
  searchHint: 'track checklist progress tasks plan session work',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  prompt: getTodoWritePrompt,
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
              enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
          },
          required: ['content'],
        },
      },
      baseRevision: {
        type: 'number',
        description:
          'Optional optimistic concurrency guard. If provided, must match current todo revision.',
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
          revision: { type: 'number' },
          pendingCount: { type: 'number' },
          counts: { type: 'object' },
          todos: { type: 'array' },
          warnings: { type: 'array' },
          fsm: { type: 'object' },
        },
      },
    },
  },
  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<TodoWriteOutput>> {
    const payload = input as TodoWriteInput;
    if (!Array.isArray(payload?.todos)) {
      return { success: false, error: 'todos must be an array' };
    }
    if (
      payload.baseRevision !== undefined &&
      (!Number.isInteger(payload.baseRevision) || payload.baseRevision < 0)
    ) {
      return { success: false, error: 'baseRevision must be a non-negative integer when provided' };
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
    const currentState = await readTodoState(todoPath);
    const strictMode = resolveTodoFsmStrictMode(context);
    if (
      payload.baseRevision !== undefined &&
      payload.baseRevision !== currentState.revision
    ) {
      return {
        success: false,
        error: `Todo revision mismatch: expected ${payload.baseRevision}, actual ${currentState.revision}`,
      };
    }

    const validationIssue = validateTodoList(normalized, currentState.todos);
    if (validationIssue) {
      const isFsmViolation =
        validationIssue.code === 'TODO_FSM_INVALID_TRANSITION' ||
        validationIssue.code === 'TODO_FSM_MULTIPLE_IN_PROGRESS';
      if (strictMode || !isFsmViolation) {
        return {
          success: false,
          error: validationIssue.message,
          meta: {
            code: validationIssue.code,
            strictMode,
          },
        };
      }
    }

    const nextState: TodoStateFile = {
      revision: currentState.revision + 1,
      todos: normalized,
      updatedAt: Date.now(),
    };
    await writeTodoState(todoPath, nextState);

    const counts = countTodoStatuses(normalized);
    const pendingCount = getPendingCount(normalized);
    return {
      success: true,
      data: {
        todos: normalized,
        pendingCount,
        revision: nextState.revision,
        counts,
        ...(validationIssue
          ? {
              warnings: [
                {
                  code: validationIssue.code as
                    | 'TODO_FSM_INVALID_TRANSITION'
                    | 'TODO_FSM_MULTIPLE_IN_PROGRESS',
                  message: validationIssue.message,
                },
              ],
            }
          : {}),
        fsm: {
          strictMode,
          violationCount: validationIssue ? 1 : 0,
        },
      },
    };
  },
});

export const todoReadTool = buildTool({
  name: 'todoread',
  title: 'Todo Read',
  description: 'Read the current todo list for the session.',
  searchHint: 'read checklist progress todos session state',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  prompt: getTodoReadPrompt,
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
          revision: { type: 'number' },
          pendingCount: { type: 'number' },
          counts: { type: 'object' },
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
    const state = await readTodoState(todoPath);
    const counts = countTodoStatuses(state.todos);
    const pendingCount = getPendingCount(state.todos);

    return {
      success: true,
      data: {
        todos: state.todos,
        pendingCount,
        revision: state.revision,
        counts,
      },
    };
  },
});
