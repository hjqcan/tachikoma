import { describe, expect, test } from 'bun:test';
import type { SharedKnowledgeData, SharedTodoSnapshot } from '../src/orchestrator/session/types';
import {
  applySessionCompaction,
  resolveExecutionStateContract,
} from '../src/orchestrator/services/session-compaction-manager';

function makeTodoSnapshot(overrides: Partial<SharedTodoSnapshot> = {}): SharedTodoSnapshot {
  return {
    revision: 4,
    pendingCount: 1,
    counts: { pending: 1, in_progress: 0, completed: 2, blocked: 0, cancelled: 0 },
    hash: 'todohash111111111',
    updatedAt: 1_000,
    updatedByWorkerId: 'worker-1',
    subtaskId: '1.2',
    sourceTool: 'todowrite',
    todos: [
      { id: 't1', content: '完成目录结构改造', status: 'completed' },
      { id: 't2', content: '实现 compaction manager', status: 'in_progress' },
      { id: 't3', content: '补集成测试', status: 'pending' },
    ],
    ...overrides,
  };
}

describe('session-compaction-manager', () => {
  test('应在约束过多时生成 summary 并保留最近约束 + todo 快照', () => {
    const snapshot = makeTodoSnapshot();
    const data: SharedKnowledgeData = {
      todoState: snapshot,
    };

    const constraints = Array.from({ length: 14 }, (_, i) =>
      `Constraint ${i + 1}: ${'x'.repeat(120)}`
    );
    const result = applySessionCompaction({
      constraints,
      data,
      options: {
        keepLastConstraints: 4,
        maxConstraintChars: 800,
      },
      now: 2_000,
    });

    expect(result.compactionApplied).toBeTrue();
    expect(result.constraints.some((item) => item.includes('sessionCompactionSummaryHash='))).toBeTrue();
    expect(result.constraints.some((item) => item.includes('todoSnapshotHash=todohash111111111'))).toBeTrue();
    expect(result.contract.summaryState?.todoSnapshotHash).toBe('todohash111111111');
    expect(result.contract.conflictPolicy).toBe('todo_wins');
  });

  test('当 summary 中 todo hash 与最新快照不一致时应标记 mismatch', () => {
    const snapshot = makeTodoSnapshot({ hash: 'newhash222222222' });
    const data: SharedKnowledgeData = {
      todoState: snapshot,
      executionStateContract: {
        conflictPolicy: 'todo_wins',
        updatedAt: 500,
        todoState: {
          ...snapshot,
          hash: 'oldhash000000000',
          revision: 2,
        },
        summaryState: {
          summary: '- old summary',
          summaryHash: 'sumhash-old',
          todoSnapshotHash: 'oldhash000000000',
          todoRevision: 2,
          compactedConstraintCount: 3,
          retainedConstraintCount: 2,
          updatedAt: 500,
        },
      },
    };

    const result = applySessionCompaction({
      constraints: ['legacy constraint'],
      data,
      options: {
        keepLastConstraints: 2,
      },
      now: 5_000,
    });

    expect(result.mismatch).toBeTrue();
    expect(result.previousSummaryTodoHash).toBe('oldhash000000000');
    expect(result.contract.todoState?.hash).toBe('newhash222222222');
  });

  test('resolveExecutionStateContract 应在无 contract 时回退 legacy todoState', () => {
    const snapshot = makeTodoSnapshot({ hash: 'legacyhash333333333' });
    const data: SharedKnowledgeData = {
      todoState: snapshot,
    };

    const resolved = resolveExecutionStateContract(data);
    expect(resolved.todoState?.hash).toBe('legacyhash333333333');
    expect(resolved.conflictPolicy).toBe('todo_wins');
  });
});
