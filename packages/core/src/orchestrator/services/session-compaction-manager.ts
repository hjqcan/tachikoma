import { createHash } from 'node:crypto';
import type {
  SharedExecutionStateContract,
  SharedKnowledgeData,
  SharedSummaryState,
  SharedTodoSnapshot,
} from '../session';
import {
  mergeTodoSnapshotConstraint,
  normalizeSharedTodoSnapshot,
} from './todo-snapshot-context';

const TODO_HASH_REGEX = /todoSnapshotHash=([a-zA-Z0-9_-]+)/;
const SUMMARY_HASH_MARKER = 'sessionCompactionSummaryHash=';
const DEFAULT_MAX_CONSTRAINT_CHARS = 4_000;
const DEFAULT_KEEP_LAST_CONSTRAINTS = 6;
const DEFAULT_MAX_SUMMARY_ITEMS = 20;
const DEFAULT_MAX_SUMMARY_CHARS = 1_600;

export interface SessionCompactionOptions {
  maxConstraintChars?: number;
  keepLastConstraints?: number;
  maxSummaryItems?: number;
  maxSummaryChars?: number;
}

export interface SessionCompactionResult {
  constraints: string[];
  updated: boolean;
  mismatch: boolean;
  previousTodoHashes: string[];
  previousSummaryTodoHash?: string;
  compactionApplied: boolean;
  contract: SharedExecutionStateContract;
  contractUpdated: boolean;
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function normalizeConstraints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeInteger(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.max(min, value);
}

function extractTodoHash(constraint: string): string | null {
  const match = constraint.match(TODO_HASH_REGEX);
  if (!match || !match[1]) return null;
  return match[1];
}

function extractSummaryHash(constraint: string): string | null {
  const match = constraint.match(/sessionCompactionSummaryHash=([a-zA-Z0-9_-]+)/);
  if (!match || !match[1]) return null;
  return match[1];
}

function extractSummaryBlock(constraint: string): string {
  const start = constraint.indexOf('<summary>');
  const end = constraint.indexOf('</summary>');
  if (start === -1 || end === -1 || end <= start) return '';
  return constraint.slice(start + '<summary>'.length, end).trim();
}

function isSummaryConstraint(constraint: string): boolean {
  if (typeof constraint !== 'string') return false;
  return (
    constraint.includes(SUMMARY_HASH_MARKER) ||
    constraint.startsWith('Session compaction summary (todo_wins):')
  );
}

function splitSummaryConstraints(constraints: string[]): {
  normalConstraints: string[];
  summaryConstraint: string | null;
} {
  const normalConstraints: string[] = [];
  let summaryConstraint: string | null = null;
  for (const constraint of constraints) {
    if (isSummaryConstraint(constraint)) {
      summaryConstraint = constraint;
      continue;
    }
    normalConstraints.push(constraint);
  }
  return { normalConstraints, summaryConstraint };
}

function sanitizeSummaryItem(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function extractSummaryItems(summary: string): string[] {
  if (!summary.trim()) return [];
  return summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => sanitizeSummaryItem(line.slice(2)));
}

function buildSummaryText(args: {
  previousSummary?: string;
  compactedConstraints: string[];
  maxSummaryItems: number;
  maxSummaryChars: number;
}): string {
  const items: string[] = [];
  const seen = new Set<string>();

  const append = (value: string) => {
    const normalized = sanitizeSummaryItem(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    items.push(normalized);
  };

  for (const item of extractSummaryItems(args.previousSummary ?? '')) {
    append(item);
  }
  for (const item of args.compactedConstraints) {
    append(item);
  }

  const trimmedItems =
    items.length > args.maxSummaryItems
      ? items.slice(items.length - args.maxSummaryItems)
      : items;

  const lines = trimmedItems.map((item) => `- ${item}`);
  const summary = lines.join('\n');
  if (summary.length <= args.maxSummaryChars) return summary;
  return summary.slice(0, args.maxSummaryChars).trimEnd();
}

function formatSummaryConstraint(
  summaryState: SharedSummaryState,
  snapshot: SharedTodoSnapshot
): string {
  return [
    'Session compaction summary (todo_wins):',
    `- ${SUMMARY_HASH_MARKER}${summaryState.summaryHash}`,
    `- todoSnapshotHash=${snapshot.hash}`,
    `- todoRevision=${snapshot.revision}`,
    `- compactedConstraints=${summaryState.compactedConstraintCount}, retainedConstraints=${summaryState.retainedConstraintCount}`,
    '<summary>',
    summaryState.summary,
    '</summary>',
    '- Rule: this summary is historical context only. If it conflicts with todo snapshot, todo snapshot wins.',
  ].join('\n');
}

function normalizeSummaryState(value: unknown): SharedSummaryState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  const summaryHash = typeof record.summaryHash === 'string' ? record.summaryHash.trim() : '';
  const todoSnapshotHash =
    typeof record.todoSnapshotHash === 'string' ? record.todoSnapshotHash.trim() : '';
  const todoRevision = normalizeInteger(record.todoRevision, -1);
  const compactedConstraintCount = normalizeInteger(record.compactedConstraintCount, 0);
  const retainedConstraintCount = normalizeInteger(record.retainedConstraintCount, 0);
  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();

  if (!summary || !todoSnapshotHash || !summaryHash || todoRevision < 0) return null;

  return {
    summary,
    summaryHash,
    todoSnapshotHash,
    todoRevision,
    compactedConstraintCount,
    retainedConstraintCount,
    updatedAt,
  };
}

function mergeSummaryStateFromConstraint(
  summaryState: SharedSummaryState | null,
  summaryConstraint: string | null,
  snapshot: SharedTodoSnapshot
): SharedSummaryState | null {
  if (summaryState) return summaryState;
  if (!summaryConstraint) return null;

  const summary = extractSummaryBlock(summaryConstraint);
  if (!summary) return null;
  const summaryHash = extractSummaryHash(summaryConstraint) ?? hashText(summary);
  return {
    summary,
    summaryHash,
    todoSnapshotHash: snapshot.hash,
    todoRevision: snapshot.revision,
    compactedConstraintCount: 0,
    retainedConstraintCount: 0,
    updatedAt: Date.now(),
  };
}

export function normalizeExecutionStateContract(
  value: unknown
): SharedExecutionStateContract | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  const todoState = normalizeSharedTodoSnapshot(record.todoState);
  const summaryState = normalizeSummaryState(record.summaryState);
  const conflictPolicy = record.conflictPolicy === 'todo_wins' ? 'todo_wins' : null;
  if (!conflictPolicy) return null;

  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();

  return {
    ...(todoState ? { todoState } : {}),
    ...(summaryState ? { summaryState } : {}),
    conflictPolicy,
    updatedAt,
  };
}

export function resolveExecutionStateContract(
  data: SharedKnowledgeData
): SharedExecutionStateContract {
  const contract = normalizeExecutionStateContract(data.executionStateContract);
  const todoFromContract = contract?.todoState;
  const todoFromLegacy = normalizeSharedTodoSnapshot(data.todoState);
  let todoState: SharedTodoSnapshot | undefined;
  if (todoFromContract && todoFromLegacy) {
    if (todoFromLegacy.revision > todoFromContract.revision) {
      todoState = todoFromLegacy;
    } else if (todoFromLegacy.revision < todoFromContract.revision) {
      todoState = todoFromContract;
    } else {
      todoState = todoFromLegacy.updatedAt >= todoFromContract.updatedAt
        ? todoFromLegacy
        : todoFromContract;
    }
  } else {
    todoState = todoFromContract ?? todoFromLegacy ?? undefined;
  }

  return {
    ...(todoState ? { todoState } : {}),
    ...(contract?.summaryState ? { summaryState: contract.summaryState } : {}),
    conflictPolicy: 'todo_wins',
    updatedAt: contract?.updatedAt ?? Date.now(),
  };
}

function areConstraintsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function applySessionCompaction(args: {
  constraints: string[];
  data: SharedKnowledgeData;
  options?: SessionCompactionOptions;
  now?: number;
}): SessionCompactionResult {
  const now = args.now ?? Date.now();
  const maxChars = args.options?.maxConstraintChars ?? DEFAULT_MAX_CONSTRAINT_CHARS;
  const keepLast = Math.max(1, args.options?.keepLastConstraints ?? DEFAULT_KEEP_LAST_CONSTRAINTS);
  const maxSummaryItems = Math.max(1, args.options?.maxSummaryItems ?? DEFAULT_MAX_SUMMARY_ITEMS);
  const maxSummaryChars = Math.max(200, args.options?.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS);

  const originalConstraints = normalizeConstraints(args.constraints);
  const contract = resolveExecutionStateContract(args.data);
  const snapshot = contract.todoState;
  if (!snapshot) {
    return {
      constraints: originalConstraints,
      updated: false,
      mismatch: false,
      previousTodoHashes: [],
      compactionApplied: false,
      contract,
      contractUpdated: false,
    };
  }

  const { normalConstraints, summaryConstraint } = splitSummaryConstraints(originalConstraints);
  const mergedTodo = mergeTodoSnapshotConstraint(normalConstraints, snapshot);
  const mergedConstraints = mergedTodo.constraints;
  const todoConstraint = mergedConstraints.find((item) => extractTodoHash(item) !== null);
  const nonTodoConstraints = mergedConstraints.filter((item) => extractTodoHash(item) === null);
  const charCount = nonTodoConstraints.reduce((sum, item) => sum + item.length, 0);
  const shouldCompact =
    nonTodoConstraints.length > keepLast || charCount > maxChars;

  const fallbackSummaryState = mergeSummaryStateFromConstraint(
    contract.summaryState ?? null,
    summaryConstraint,
    snapshot
  );

  let nextSummaryState = fallbackSummaryState;
  let compactionApplied = false;

  if (shouldCompact) {
    const retainedConstraintCount = Math.min(keepLast, nonTodoConstraints.length);
    const compactedConstraints = nonTodoConstraints.slice(0, nonTodoConstraints.length - retainedConstraintCount);
    const retainedConstraints = nonTodoConstraints.slice(nonTodoConstraints.length - retainedConstraintCount);
    const summaryText = buildSummaryText({
      ...(fallbackSummaryState?.summary
        ? { previousSummary: fallbackSummaryState.summary }
        : {}),
      compactedConstraints,
      maxSummaryItems,
      maxSummaryChars,
    });
    const summaryHash = hashText(
      `${summaryText}|${snapshot.hash}|${snapshot.revision}|${compactedConstraints.length}|${retainedConstraints.length}`
    );
    nextSummaryState = {
      summary: summaryText,
      summaryHash,
      todoSnapshotHash: snapshot.hash,
      todoRevision: snapshot.revision,
      compactedConstraintCount: compactedConstraints.length,
      retainedConstraintCount: retainedConstraints.length,
      updatedAt: now,
    };
    compactionApplied = true;
  } else if (nextSummaryState) {
    nextSummaryState = {
      ...nextSummaryState,
      todoSnapshotHash: snapshot.hash,
      todoRevision: snapshot.revision,
      updatedAt: now,
    };
  }

  const finalConstraints: string[] = [];
  if (nextSummaryState) {
    finalConstraints.push(formatSummaryConstraint(nextSummaryState, snapshot));
  }
  if (compactionApplied) {
    const retainedConstraintCount = Math.min(keepLast, nonTodoConstraints.length);
    finalConstraints.push(...nonTodoConstraints.slice(nonTodoConstraints.length - retainedConstraintCount));
  } else {
    finalConstraints.push(...nonTodoConstraints);
  }
  if (todoConstraint) {
    finalConstraints.push(todoConstraint);
  }

  const nextContractBase: Omit<SharedExecutionStateContract, 'updatedAt'> = {
    ...(snapshot ? { todoState: snapshot } : {}),
    ...(nextSummaryState ? { summaryState: nextSummaryState } : {}),
    conflictPolicy: 'todo_wins',
  };
  const previousContractBase: Omit<SharedExecutionStateContract, 'updatedAt'> = {
    ...(contract.todoState ? { todoState: contract.todoState } : {}),
    ...(contract.summaryState ? { summaryState: contract.summaryState } : {}),
    conflictPolicy: 'todo_wins',
  };
  const contractChanged =
    JSON.stringify(previousContractBase) !== JSON.stringify(nextContractBase);
  const nextContract: SharedExecutionStateContract = {
    ...nextContractBase,
    updatedAt: contractChanged ? now : contract.updatedAt,
  };

  const previousSummaryTodoHash = fallbackSummaryState?.todoSnapshotHash;
  const summaryMismatch =
    typeof previousSummaryTodoHash === 'string' &&
    previousSummaryTodoHash.length > 0 &&
    previousSummaryTodoHash !== snapshot.hash;

  const constraintsChanged = !areConstraintsEqual(originalConstraints, finalConstraints);

  return {
    constraints: finalConstraints,
    updated: constraintsChanged || contractChanged,
    mismatch: mergedTodo.mismatch || summaryMismatch,
    previousTodoHashes: mergedTodo.previousHashes,
    ...(previousSummaryTodoHash ? { previousSummaryTodoHash } : {}),
    compactionApplied,
    contract: nextContract,
    contractUpdated: contractChanged,
  };
}
