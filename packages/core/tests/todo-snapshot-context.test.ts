import { describe, expect, test } from 'bun:test';
import {
  appendTodoReplayEvent,
  collectTodoSnapshotHashes,
  createTodoReplayEvent,
  createTodoReplayEventId,
  formatTodoSnapshotConstraint,
  mergeTodoSnapshotConstraint,
  normalizeTodoReplayGuard,
} from '../src/orchestrator/services/todo-snapshot-context';
import type { SharedTodoSnapshot } from '../src/orchestrator/session/types';

function makeSnapshot(overrides: Partial<SharedTodoSnapshot> = {}): SharedTodoSnapshot {
  return {
    revision: 3,
    pendingCount: 1,
    counts: { pending: 1, in_progress: 0, completed: 2, blocked: 0, cancelled: 0 },
    hash: 'abc123def4567890',
    updatedAt: 1000,
    updatedByWorkerId: 'worker-1',
    subtaskId: '1.1',
    sourceTool: 'todowrite',
    todos: [
      { id: 't1', content: 'A', status: 'completed' },
      { id: 't2', content: 'B', status: 'pending' },
      { id: 't3', content: 'C', status: 'completed' },
    ],
    ...overrides,
  };
}

describe('todo-snapshot-context', () => {
  test('mergeTodoSnapshotConstraint 应替换旧 todoSnapshotHash 并保持单条约束', () => {
    const oldSnapshot = makeSnapshot({ hash: 'oldhash0000000000', revision: 2 });
    const nextSnapshot = makeSnapshot({ hash: 'newhash1111111111', revision: 3 });

    const oldConstraint = formatTodoSnapshotConstraint(oldSnapshot);
    const merged = mergeTodoSnapshotConstraint(
      ['keep-this', oldConstraint, 'keep-that'],
      nextSnapshot
    );

    expect(merged.updated).toBeTrue();
    expect(merged.mismatch).toBeTrue();
    expect(merged.previousHashes).toContain('oldhash0000000000');
    expect(merged.constraints.filter((item) => item.includes('todoSnapshotHash=')).length).toBe(1);
    expect(merged.constraints.join('\n')).toContain('todoSnapshotHash=newhash1111111111');
    expect(merged.constraints).toContain('keep-this');
    expect(merged.constraints).toContain('keep-that');
  });

  test('collectTodoSnapshotHashes 应提取并去重 hash', () => {
    const c1 = 'foo todoSnapshotHash=abc123 bar';
    const c2 = 'todoSnapshotHash=abc123';
    const c3 = 'todoSnapshotHash=def456';
    const hashes = collectTodoSnapshotHashes([c1, c2, c3, 'no-hash']);
    expect(hashes).toEqual(['abc123', 'def456']);
  });

  test('createTodoReplayEventId 应在相同输入下稳定，输入变化时变化', () => {
    const snapshot = makeSnapshot({ hash: 'stablehash0000001', revision: 9 });
    const same1 = createTodoReplayEventId({
      subtaskId: '2.1',
      objective: 'Fix API tests',
      snapshot,
    });
    const same2 = createTodoReplayEventId({
      subtaskId: '2.1',
      objective: 'Fix   API tests',
      snapshot,
    });
    const changed = createTodoReplayEventId({
      subtaskId: '2.1',
      objective: 'Fix API smoke tests',
      snapshot,
    });

    expect(same1).toBe(same2);
    expect(changed).not.toBe(same1);
  });

  test('appendTodoReplayEvent 应去重并按容量裁剪', () => {
    const snapshot = makeSnapshot({ hash: 'replayhash0000001', revision: 4 });
    const eventA = createTodoReplayEvent({
      subtaskId: '1.1',
      objective: 'Implement feature A',
      snapshot,
      recordedAt: 10,
    });
    const eventB = createTodoReplayEvent({
      subtaskId: '1.2',
      objective: 'Implement feature B',
      snapshot,
      recordedAt: 11,
    });
    const eventC = createTodoReplayEvent({
      subtaskId: '1.3',
      objective: 'Implement feature C',
      snapshot,
      recordedAt: 12,
    });

    const guard0 = normalizeTodoReplayGuard(null);
    const guard1 = appendTodoReplayEvent(guard0, eventA, 2);
    const guard1Dup = appendTodoReplayEvent(guard1.guard, eventA, 2);
    const guard2 = appendTodoReplayEvent(guard1.guard, eventB, 2);
    const guard3 = appendTodoReplayEvent(guard2.guard, eventC, 2);

    expect(guard1.updated).toBeTrue();
    expect(guard1Dup.updated).toBeFalse();
    expect(guard2.guard.events.length).toBe(2);
    expect(guard3.guard.events.length).toBe(2);
    expect(guard3.guard.events[0]?.eventId).toBe(eventB.eventId);
    expect(guard3.guard.events[1]?.eventId).toBe(eventC.eventId);
  });

  test('normalizeTodoReplayGuard 应过滤非法记录', () => {
    const raw = {
      updatedAt: 123,
      events: [
        {
          eventId: 'e1',
          subtaskId: '1.1',
          objectiveHash: 'o1',
          todoHash: 'h1',
          todoRevision: 1,
          recordedAt: 11,
        },
        {
          eventId: '',
          subtaskId: '1.2',
          objectiveHash: 'o2',
          todoHash: 'h2',
          todoRevision: 2,
          recordedAt: 12,
        },
        {
          eventId: 'e3',
          subtaskId: '1.3',
          objectiveHash: 'o3',
          todoHash: 'h3',
          todoRevision: -1,
          recordedAt: 13,
        },
      ],
    };

    const normalized = normalizeTodoReplayGuard(raw);
    expect(normalized.updatedAt).toBe(123);
    expect(normalized.events.length).toBe(1);
    expect(normalized.events[0]?.eventId).toBe('e1');
  });
});
