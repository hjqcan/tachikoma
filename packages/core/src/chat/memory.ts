import type { GoodMemory, MemoryScope } from 'goodmemory';
import {
  createDeterministicMemoryExtractor,
  createGoodMemory,
  createLocalEmbeddingAdapter,
} from 'goodmemory';
import type { GoodMemoryRuntimeKit } from 'goodmemory/runtime-kit';
import { createGoodMemoryRuntimeKit } from 'goodmemory/runtime-kit';

import type { ChatRecalledMemory } from './types';

export interface CreateChatMemoryRuntimeInput {
  databasePath: string;
  userId: string;
}

export interface ChatMemoryRuntime {
  databasePath: string;
  kit: GoodMemoryRuntimeKit;
  /** 裸 GoodMemory 实例：记忆管理面（export/recall/forget）走它；注入 kit 的测试形态下缺席 */
  memory?: GoodMemory;
  scope(sessionId: string): MemoryScope;
}

/**
 * goodmemory 召回结果的桶级命中判定。
 * 空库时 buildContext 仍会渲染框架头（如"用户记忆上下文："），所以
 * "召回到了东西"必须看召回桶/元数据命中，不能只看渲染文本非空。
 */
export function recallHasHits(recall: unknown): boolean {
  if (!recall || typeof recall !== 'object') {
    return false;
  }
  for (const value of Object.values(recall)) {
    if (Array.isArray(value) && value.length > 0) {
      return true;
    }
  }
  const metadata = (recall as { metadata?: unknown }).metadata;
  if (metadata && typeof metadata === 'object') {
    const hits = (metadata as Record<string, unknown>).hits;
    if (Array.isArray(hits) && hits.length > 0) {
      return true;
    }
  }
  return false;
}

/** 记忆管理面/召回明细共用的扁平 UI 行（GoodMemory 各桶记录的投影） */
export interface ChatMemoryRecord {
  id: string;
  type: 'fact' | 'preference' | 'reference' | 'episode' | 'feedback' | 'archive' | 'experience';
  content: string;
  tags?: string[];
  importance?: number;
  createdAt?: string;
  /** 仅搜索/召回结果携带（recall 命中分） */
  score?: number;
}

const MEMORY_BUCKETS: Record<string, ChatMemoryRecord['type']> = {
  facts: 'fact',
  preferences: 'preference',
  references: 'reference',
  episodes: 'episode',
  feedback: 'feedback',
  archives: 'archive',
  experiences: 'experience',
};

function recordContent(record: Record<string, unknown>): string {
  if (typeof record.content === 'string') return record.content;
  if (typeof record.summary === 'string') return record.summary;
  if (typeof record.rule === 'string') return record.rule;
  if (typeof record.title === 'string') {
    return typeof record.pointer === 'string'
      ? `${record.title} — ${record.pointer}`
      : record.title;
  }
  if (typeof record.category === 'string' && 'value' in record) {
    return `${record.category}: ${JSON.stringify(record.value)}`;
  }
  // UserProfile：拼 identity 里的可读字段
  const identity = record.identity;
  if (identity && typeof identity === 'object') {
    const parts = Object.values(identity as Record<string, unknown>).filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    if (parts.length > 0) return parts.join(' · ');
  }
  return JSON.stringify(record);
}

/** 把 exportMemory/recall 的记录桶投影成扁平行；未知桶与非记录条目静默跳过 */
export function projectMemoryBuckets(buckets: unknown): ChatMemoryRecord[] {
  if (!buckets || typeof buckets !== 'object') return [];
  const rows: ChatMemoryRecord[] = [];
  for (const [bucket, type] of Object.entries(MEMORY_BUCKETS)) {
    const entries = (buckets as Record<string, unknown>)[bucket];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== 'string') continue;
      rows.push({
        id: record.id,
        type,
        content: recordContent(record),
        ...(Array.isArray(record.tags)
          ? { tags: record.tags.filter((t) => typeof t === 'string') }
          : {}),
        ...(typeof record.importance === 'number' ? { importance: record.importance } : {}),
        ...(typeof record.createdAt === 'string'
          ? { createdAt: record.createdAt }
          : typeof record.updatedAt === 'string'
            ? { createdAt: record.updatedAt }
            : {}),
      });
    }
  }
  return rows;
}

function truncate(text: string): string {
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/**
 * recall 结果 → 事件里的召回明细。以 metadata.hits 为准（durable 桶之外，
 * profile/workingMemory 等运行时命中也如实呈现），预览从各桶按 id 反查。
 */
export function projectRecalledMemories(recall: unknown): ChatRecalledMemory[] {
  if (!recall || typeof recall !== 'object') return [];
  const result = recall as Record<string, unknown>;
  const hits = (result.metadata as { hits?: unknown } | undefined)?.hits;
  if (!Array.isArray(hits)) return [];
  const findById = (id: string): Record<string, unknown> | undefined => {
    for (const [key, value] of Object.entries(result)) {
      if (key === 'metadata') continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object' && (entry as { id?: unknown }).id === id) {
            return entry as Record<string, unknown>;
          }
        }
      } else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.id === id || record.userId === id) return record;
      }
    }
    return undefined;
  };
  const rows: ChatRecalledMemory[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;
    const { id, type, score } = hit as { id?: unknown; type?: unknown; score?: unknown };
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    const source = findById(id);
    rows.push({
      id,
      type,
      preview: source ? truncate(recordContent(source)) : '',
      ...(typeof score === 'number' ? { score } : {}),
    });
  }
  return rows;
}

export function createChatMemoryRuntime(input: CreateChatMemoryRuntimeInput): ChatMemoryRuntime {
  const memory = createGoodMemory({
    storage: { provider: 'sqlite', url: input.databasePath },
    adapters: {
      assistedExtractor: createDeterministicMemoryExtractor(),
      embeddingAdapter: createLocalEmbeddingAdapter(),
    },
  });
  const kit = createGoodMemoryRuntimeKit({ memory });

  return {
    databasePath: input.databasePath,
    kit,
    memory,
    scope(sessionId) {
      return {
        userId: input.userId,
        workspaceId: 'tachikoma',
        agentId: 'tachikoma',
        sessionId,
      };
    },
  };
}
