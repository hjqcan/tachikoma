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
  Toolset,
  WorkspaceState,
} from '@tachikoma/protocol';

export interface ServerSessionPort {
  readonly id: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel;
  readonly memoryStatus: MemorySnapshot;
  readonly activeTools: readonly string[];
  /** live 会话的工作区授予；null = 零工具 */
  readonly workspace: WorkspaceState | null;
  send(text: string, options?: { signal?: AbortSignal }): AsyncGenerator<ChatEventWire>;
  abort(): Promise<boolean>;
  respondToApproval(callId: string, approved: boolean, scope?: 'call' | 'session'): boolean;
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
    /** 会话级工作区授予（不持久化；重开回到引擎默认） */
    workDir?: string;
    toolset?: Toolset;
  }): Promise<ServerSessionPort>;
  openSession(sessionId: string): Promise<ServerSessionPort | null>;
  listSessions(): Promise<SessionSummary[]>;
  deleteSession(sessionId: string): Promise<boolean>;
  listModels(): Promise<ModelListing[]>;
  /** 从转录导出文本回合历史；账本缺失/缺"人"侧时 server 用它重建重放缓存 */
  history(sessionId: string): Promise<ChatEventWire[]>;
}
