/**
 * server 对引擎的结构化端口（@tachikoma/core 的 ChatEngine/ChatSession 天然满足）。
 * 测试用 fake 实现脚本化事件，零网络零 pi 依赖。
 */

import type {
  ChatEventWire,
  CompactionResult,
  MemorySnapshot,
  ModelListing,
  ModelRef,
  SessionSummary,
  ThinkingLevel,
} from '@tachikoma/protocol';

export interface ServerSessionPort {
  readonly id: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel;
  readonly memoryStatus: MemorySnapshot;
  readonly activeTools: readonly string[];
  send(text: string, options?: { signal?: AbortSignal }): AsyncGenerator<ChatEventWire>;
  abort(): Promise<boolean>;
  respondToApproval(callId: string, approved: boolean): boolean;
  setModel(model: ModelRef): Promise<ModelRef>;
  setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
  compact(instructions?: string): Promise<CompactionResult>;
  close(): Promise<void>;
}

export interface ServerEnginePort {
  createSession(init?: {
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    title?: string;
  }): Promise<ServerSessionPort>;
  openSession(sessionId: string): Promise<ServerSessionPort | null>;
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(sessionId: string): Promise<boolean>;
  listModels(): Promise<ModelListing[]>;
}
