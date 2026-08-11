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
