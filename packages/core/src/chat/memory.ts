/**
 * Chat 记忆层 —— GoodMemory 适配
 *
 * Memory-First：持久记忆接入用户自研的 GoodMemory（~/workspace/GoodMemory，npm: goodmemory）。
 * 通过窄结构类型（GoodMemoryLike）对接：core 只依赖 recall/buildContext/remember 三个方法的
 * 形状，不 import goodmemory 的深层类型，0.7.x 小版本漂移不破坏编译。
 *
 * 生命周期（由 ChatEngine 调用）：
 * - 回复前：recallContext(query) → 命中则把片段注入本次 system prompt（recall-before-reply）
 * - 回合后：rememberTurn(user, assistant) → 交给 GoodMemory 的治理管线做抽取/去重/写入
 * - 记忆层任何失败都不得影响对话本身（调用方负责吞掉异常并降级）
 */

import type { ChatMessage } from './types';

export interface ChatMemoryScope {
  userId: string;
  tenantId?: string;
  workspaceId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface ChatMemoryContext {
  /** 注入 system prompt 的记忆片段（GoodMemory 的 system_prompt_fragment 输出） */
  content: string;
  estimatedTokens?: number;
}

/** ChatEngine 消费的记忆接口；GoodMemory 是默认实现，测试可注入 fake */
export interface ChatMemory {
  recallContext(input: { sessionId: string; query: string }): Promise<ChatMemoryContext | null>;
  rememberTurn(input: {
    sessionId: string;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
  }): Promise<void>;
}

// =============================================================================
// GoodMemory 窄接口（结构类型）
// =============================================================================

export type GoodMemoryRecallResultLike = Record<string, unknown>;

export interface GoodMemoryLike {
  recall(input: {
    scope: ChatMemoryScope;
    query: string;
    retrievalProfile?: 'general_chat' | 'coding_agent';
  }): Promise<GoodMemoryRecallResultLike>;
  buildContext(input: {
    recall: GoodMemoryRecallResultLike;
    output?: 'json' | 'markdown' | 'system_prompt_fragment' | 'developer_prompt_fragment';
    maxTokens?: number;
  }): Promise<{ content: string; estimatedTokens: number }>;
  remember(input: {
    scope: ChatMemoryScope;
    messages: { role: 'user' | 'assistant'; content: string; observedAt?: string }[];
  }): Promise<unknown>;
}

export interface GoodMemoryChatMemoryOptions {
  memory: GoodMemoryLike;
  /** 持久维度（userId 必填；sessionId 由每次调用补充） */
  scope: Omit<ChatMemoryScope, 'sessionId'>;
  /** 注入片段的 token 预算，默认 512 */
  maxMemoryTokens?: number;
  retrievalProfile?: 'general_chat' | 'coding_agent';
}

/**
 * 判断召回是否真的命中。
 * 空库时 buildContext 仍会渲染框架头（如 "用户记忆上下文："），
 * 所以不能用 content 非空判断——要看记忆桶与 metadata.hits。
 */
export function hasRecallHits(recall: GoodMemoryRecallResultLike): boolean {
  // 任一记忆桶非空即命中（facts/preferences/references/... 都是顶层数组）
  for (const value of Object.values(recall)) {
    if (Array.isArray(value) && value.length > 0) return true;
  }
  // 用户档案是对象桶，单独判断
  const profile = recall.profile;
  if (profile && typeof profile === 'object' && Object.keys(profile).length > 0) {
    return true;
  }
  const metadata = recall.metadata;
  if (metadata && typeof metadata === 'object') {
    const hits = (metadata as Record<string, unknown>).hits;
    if (Array.isArray(hits) && hits.length > 0) return true;
  }
  return false;
}

export function createGoodMemoryChatMemory(options: GoodMemoryChatMemoryOptions): ChatMemory {
  const maxTokens = options.maxMemoryTokens ?? 512;
  const retrievalProfile = options.retrievalProfile ?? 'general_chat';

  return {
    async recallContext({ sessionId, query }) {
      const scope: ChatMemoryScope = { ...options.scope, sessionId };
      const recall = await options.memory.recall({ scope, query, retrievalProfile });
      if (!hasRecallHits(recall)) return null;
      const context = await options.memory.buildContext({
        recall,
        output: 'system_prompt_fragment',
        maxTokens,
      });
      if (!context.content.trim()) return null;
      return {
        content: context.content,
        estimatedTokens: context.estimatedTokens,
      };
    },

    async rememberTurn({ sessionId, userMessage, assistantMessage }) {
      const scope: ChatMemoryScope = { ...options.scope, sessionId };
      await options.memory.remember({
        scope,
        messages: [
          {
            role: 'user',
            content: userMessage.content,
            observedAt: new Date(userMessage.createdAt).toISOString(),
          },
          {
            role: 'assistant',
            content: assistantMessage.content,
            observedAt: new Date(assistantMessage.createdAt).toISOString(),
          },
        ],
      });
    },
  };
}
