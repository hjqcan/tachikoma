import { createHash } from 'node:crypto';
import type {
  SharedTodoReplayEvent,
  SharedTodoReplayGuard,
  SharedTodoSnapshot,
} from '../session';

const TODO_HASH_MARKER = 'todoSnapshotHash=';
const DEFAULT_REPLAY_EVENT_LIMIT = 128;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function normalizeCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!value || typeof value !== 'object') return counts;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isFiniteNumber(raw) || raw < 0) continue;
    counts[key] = raw;
  }
  return counts;
}

function normalizeTodos(value: unknown): SharedTodoSnapshot['todos'] {
  if (!Array.isArray(value)) return [];
  const todos: SharedTodoSnapshot['todos'] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    const status = typeof record.status === 'string' ? record.status.trim() : '';
    if (!id || !content || !status) continue;
    const priority = typeof record.priority === 'string' ? record.priority : undefined;
    todos.push({
      id,
      content,
      status,
      ...(priority ? { priority } : {}),
    });
  }
  return todos;
}

export function normalizeSharedTodoSnapshot(value: unknown): SharedTodoSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const revision = record.revision;
  const pendingCount = record.pendingCount;
  const hash = record.hash;
  if (!isFiniteNumber(revision) || revision < 0 || !Number.isInteger(revision)) return null;
  if (!isFiniteNumber(pendingCount) || pendingCount < 0) return null;
  if (typeof hash !== 'string' || hash.trim().length === 0) return null;

  const updatedAt = isFiniteNumber(record.updatedAt) ? record.updatedAt : Date.now();
  const updatedByWorkerId =
    typeof record.updatedByWorkerId === 'string' && record.updatedByWorkerId.length > 0
      ? record.updatedByWorkerId
      : 'unknown';
  const subtaskId =
    typeof record.subtaskId === 'string' && record.subtaskId.length > 0
      ? record.subtaskId
      : 'unknown';
  const sourceTool = record.sourceTool === 'todoread' ? 'todoread' : 'todowrite';

  return {
    revision,
    pendingCount,
    hash: hash.trim(),
    counts: normalizeCounts(record.counts),
    todos: normalizeTodos(record.todos),
    updatedAt,
    updatedByWorkerId,
    subtaskId,
    sourceTool,
  };
}

export function formatTodoSnapshotConstraint(snapshot: SharedTodoSnapshot): string {
  const countEntries = Object.entries(snapshot.counts)
    .filter(([, value]) => value > 0)
    .map(([status, value]) => `${status}=${value}`)
    .join(', ');
  const todoPreview = snapshot.todos
    .slice(0, 5)
    .map((todo) => `[${todo.status}] ${todo.content}`)
    .join(' | ');

  const lines: string[] = [];
  lines.push('Todo execution snapshot (authoritative state, todo_wins):');
  lines.push(`- ${TODO_HASH_MARKER}${snapshot.hash}`);
  lines.push(`- revision=${snapshot.revision}, pending=${snapshot.pendingCount}`);
  if (countEntries) lines.push(`- counts: ${countEntries}`);
  if (todoPreview) lines.push(`- top todos: ${todoPreview}`);
  lines.push(
    '- Rule: treat this todo snapshot as execution source of truth during replan/resume. Do not re-open completed items.'
  );
  return lines.join('\n');
}

function extractTodoHash(constraint: string): string | null {
  const match = constraint.match(/todoSnapshotHash=([a-zA-Z0-9_-]+)/);
  if (!match || !match[1]) return null;
  return match[1];
}

export function collectTodoSnapshotHashes(constraints: string[]): string[] {
  const normalized = Array.isArray(constraints)
    ? constraints.filter((item): item is string => typeof item === 'string')
    : [];
  const hashes = normalized
    .map((item) => extractTodoHash(item))
    .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  return Array.from(new Set(hashes));
}

export function mergeTodoSnapshotConstraint(
  constraints: string[],
  snapshot: SharedTodoSnapshot
): {
  constraints: string[];
  updated: boolean;
  previousHashes: string[];
  mismatch: boolean;
} {
  const normalized = Array.isArray(constraints)
    ? constraints.filter((item): item is string => typeof item === 'string')
    : [];
  const nextConstraint = formatTodoSnapshotConstraint(snapshot);
  const currentHash = snapshot.hash;
  const previousHashes = collectTodoSnapshotHashes(normalized);
  const hasCurrent = previousHashes.includes(currentHash);
  const mismatch = previousHashes.some((hash) => hash !== currentHash);

  if (hasCurrent && !mismatch) {
    return {
      constraints: normalized,
      updated: false,
      previousHashes,
      mismatch: false,
    };
  }

  const withoutOldTodoSnapshot = normalized.filter((item) => extractTodoHash(item) === null);
  return {
    constraints: [...withoutOldTodoSnapshot, nextConstraint],
    updated: true,
    previousHashes,
    mismatch,
  };
}

function normalizeObjective(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function createTodoReplayEventId(args: {
  subtaskId: string;
  objective: string;
  snapshot: SharedTodoSnapshot;
}): string {
  const objective = normalizeObjective(args.objective);
  const payload = `${args.subtaskId}|${objective}|${args.snapshot.revision}|${args.snapshot.hash}`;
  return hashText(payload);
}

export function createTodoReplayEvent(args: {
  subtaskId: string;
  objective: string;
  snapshot: SharedTodoSnapshot;
  recordedAt?: number;
}): SharedTodoReplayEvent {
  const objective = normalizeObjective(args.objective);
  return {
    eventId: createTodoReplayEventId(args),
    subtaskId: args.subtaskId,
    objectiveHash: hashText(objective),
    todoHash: args.snapshot.hash,
    todoRevision: args.snapshot.revision,
    recordedAt: args.recordedAt ?? Date.now(),
  };
}

export function normalizeTodoReplayGuard(value: unknown): SharedTodoReplayGuard {
  if (!value || typeof value !== 'object') {
    return { events: [], updatedAt: 0 };
  }

  const record = value as Record<string, unknown>;
  const rawEvents = Array.isArray(record.events) ? record.events : [];
  const events: SharedTodoReplayEvent[] = [];

  for (const item of rawEvents) {
    if (!item || typeof item !== 'object') continue;
    const event = item as Record<string, unknown>;
    const eventId = typeof event.eventId === 'string' ? event.eventId.trim() : '';
    const subtaskId = typeof event.subtaskId === 'string' ? event.subtaskId.trim() : '';
    const objectiveHash =
      typeof event.objectiveHash === 'string' ? event.objectiveHash.trim() : '';
    const todoHash = typeof event.todoHash === 'string' ? event.todoHash.trim() : '';
    const todoRevision = event.todoRevision;
    const recordedAt = event.recordedAt;

    if (!eventId || !subtaskId || !objectiveHash || !todoHash) continue;
    if (!isFiniteNumber(todoRevision) || todoRevision < 0 || !Number.isInteger(todoRevision)) continue;
    if (!isFiniteNumber(recordedAt) || recordedAt < 0) continue;

    events.push({
      eventId,
      subtaskId,
      objectiveHash,
      todoHash,
      todoRevision,
      recordedAt,
    });
  }

  const updatedAt = isFiniteNumber(record.updatedAt) ? record.updatedAt : 0;
  return { events, updatedAt };
}

export function hasTodoReplayEvent(guard: SharedTodoReplayGuard, eventId: string): boolean {
  return guard.events.some((event) => event.eventId === eventId);
}

export function appendTodoReplayEvent(
  guard: SharedTodoReplayGuard,
  event: SharedTodoReplayEvent,
  maxEvents = DEFAULT_REPLAY_EVENT_LIMIT
): { guard: SharedTodoReplayGuard; updated: boolean } {
  if (hasTodoReplayEvent(guard, event.eventId)) {
    return { guard, updated: false };
  }

  const keep = Math.max(1, Math.floor(maxEvents));
  const events = [...guard.events, event];
  const trimmed = events.length > keep ? events.slice(events.length - keep) : events;

  return {
    guard: {
      events: trimmed,
      updatedAt: event.recordedAt,
    },
    updated: true,
  };
}
