import type { MemoryScope } from 'goodmemory';
import {
  createDeterministicMemoryExtractor,
  createGoodMemory,
  createLocalEmbeddingAdapter,
} from 'goodmemory';
import type { GoodMemoryRuntimeKit } from 'goodmemory/runtime-kit';
import { createGoodMemoryRuntimeKit } from 'goodmemory/runtime-kit';

export interface CreateChatMemoryRuntimeInput {
  databasePath: string;
  userId: string;
}

export interface ChatMemoryRuntime {
  databasePath: string;
  kit: GoodMemoryRuntimeKit;
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
