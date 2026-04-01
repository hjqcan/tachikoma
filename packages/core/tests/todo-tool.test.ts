import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext } from '../src/types';
import type { TodoReadOutput, TodoWriteOutput } from '../src/tools/types';
import { todoReadTool, todoWriteTool } from '../src/tools/core/todo';

describe('todo tools', () => {
  let workDir = '';
  let context: ExecutionContext;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'tachikoma-todo-'));
    context = {
      taskId: 'task-1',
      agentId: 'agent-1',
      traceId: 'trace-1',
      workDir,
      env: {
        SESSION_ID: 'session-1',
      },
    };
  });

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test('should persist todo state with revision and counts', async () => {
    const first = await todoWriteTool.execute(
      {
        todos: [
          { id: 't1', content: 'plan', status: 'pending', priority: 'high' },
          { id: 't2', content: 'wait api', status: 'blocked', priority: 'medium' },
        ],
      },
      context
    );
    expect(first.success).toBe(true);

    const firstData = (first as { data: TodoWriteOutput }).data;
    expect(firstData.revision).toBe(1);
    expect(firstData.pendingCount).toBe(1);
    expect(firstData.counts.pending).toBe(1);
    expect(firstData.counts.blocked).toBe(1);

    const second = await todoWriteTool.execute(
      {
        baseRevision: 1,
        todos: [
          { id: 't1', content: 'plan', status: 'in_progress', priority: 'high' },
          { id: 't2', content: 'wait api', status: 'blocked', priority: 'medium' },
        ],
      },
      context
    );
    expect(second.success).toBe(true);

    const secondData = (second as { data: TodoWriteOutput }).data;
    expect(secondData.revision).toBe(2);
    expect(secondData.pendingCount).toBe(1);
    expect(secondData.counts.in_progress).toBe(1);
    expect(secondData.counts.blocked).toBe(1);

    const readResult = await todoReadTool.execute({}, context);
    expect(readResult.success).toBe(true);

    const readData = (readResult as { data: TodoReadOutput }).data;
    expect(readData.revision).toBe(2);
    expect(readData.counts.in_progress).toBe(1);
    expect(readData.counts.blocked).toBe(1);
  });

  test('should reject invalid status transition pending -> completed', async () => {
    const initial = await todoWriteTool.execute(
      {
        todos: [{ id: 't1', content: 'step', status: 'pending', priority: 'medium' }],
      },
      context
    );
    expect(initial.success).toBe(true);

    const invalid = await todoWriteTool.execute(
      {
        baseRevision: 1,
        todos: [{ id: 't1', content: 'step', status: 'completed', priority: 'medium' }],
      },
      context
    );
    expect(invalid.success).toBe(false);
    expect((invalid as { error?: string }).error).toContain('Invalid todo status transition');
  });

  test('should allow invalid transition in warn mode and return warnings', async () => {
    const warnContext: ExecutionContext = {
      ...context,
      env: {
        ...context.env,
        TACHIKOMA_TODO_FSM_STRICT_MODE: 'false',
      },
    };

    const initial = await todoWriteTool.execute(
      {
        todos: [{ id: 't1', content: 'step', status: 'pending', priority: 'medium' }],
      },
      warnContext
    );
    expect(initial.success).toBe(true);

    const warned = await todoWriteTool.execute(
      {
        baseRevision: 1,
        todos: [{ id: 't1', content: 'step', status: 'completed', priority: 'medium' }],
      },
      warnContext
    );
    expect(warned.success).toBe(true);

    const warnedData = (warned as { data: TodoWriteOutput }).data;
    expect(warnedData.fsm?.strictMode).toBe(false);
    expect(warnedData.fsm?.violationCount).toBe(1);
    expect(warnedData.warnings?.length).toBe(1);
    expect(warnedData.warnings?.[0]?.code).toBe('TODO_FSM_INVALID_TRANSITION');
  });

  test('should reject stale baseRevision', async () => {
    const initial = await todoWriteTool.execute(
      {
        todos: [{ id: 't1', content: 'step', status: 'pending', priority: 'medium' }],
      },
      context
    );
    expect(initial.success).toBe(true);

    const stale = await todoWriteTool.execute(
      {
        baseRevision: 0,
        todos: [{ id: 't1', content: 'step', status: 'in_progress', priority: 'medium' }],
      },
      context
    );
    expect(stale.success).toBe(false);
    expect((stale as { error?: string }).error).toContain('Todo revision mismatch');
  });

  test('should reject multiple in_progress todos', async () => {
    const result = await todoWriteTool.execute(
      {
        todos: [
          { id: 't1', content: 'step 1', status: 'in_progress', priority: 'high' },
          { id: 't2', content: 'step 2', status: 'in_progress', priority: 'medium' },
        ],
      },
      context
    );
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toContain('Only one todo item may be in_progress');
  });
});
