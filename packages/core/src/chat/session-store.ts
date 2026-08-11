/**
 * Chat 会话存储
 *
 * 轻量 JSON 文件持久化：一个会话一个文件，原子写（tmp + rename）。
 * 刻意不复用 orchestrator 的 SessionStore/SessionFileManager——chat 会话
 * 没有计划/子任务/worker 概念，存储结构必须保持与对话同样简单。
 */

import { mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatProvider, ChatSessionState, ChatSessionSummary } from './types';
import { getChatSessionMessages } from './transcript';

const SESSION_FILE_SUFFIX = '.json';
/** 会话 ID 只允许安全字符，防止路径穿越 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ChatSessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatSessionStoreError';
  }
}

export function generateChatSessionId(now = Date.now()): string {
  return `chat-${now}-${randomUUID().slice(0, 8)}`;
}

export class ChatSessionStore {
  constructor(private readonly dir: string) {}

  private pathFor(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new ChatSessionStoreError(`非法会话 ID: ${sessionId}`);
    }
    return join(this.dir, `${sessionId}${SESSION_FILE_SUFFIX}`);
  }

  async create(init: {
    provider: ChatProvider;
    model: string;
    title?: string;
  }): Promise<ChatSessionState> {
    const now = Date.now();
    const state: ChatSessionState = {
      sessionId: generateChatSessionId(now),
      createdAt: now,
      updatedAt: now,
      provider: init.provider,
      model: init.model,
      transcript: [],
      ...(init.title && { title: init.title }),
    };
    await this.save(state);
    return state;
  }

  async load(sessionId: string): Promise<ChatSessionState | null> {
    const path = this.pathFor(sessionId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ChatSessionState;
      if (
        typeof parsed.sessionId !== 'string' ||
        !Array.isArray(parsed.transcript) ||
        typeof parsed.provider !== 'string' ||
        typeof parsed.model !== 'string'
      ) {
        return null;
      }
      return parsed;
    } catch {
      // 损坏文件按不存在处理，不让单个坏会话拖垮列表/启动
      return null;
    }
  }

  async save(state: ChatSessionState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathFor(state.sessionId);
    const tmpPath = `${path}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    await rename(tmpPath, path);
  }

  async list(): Promise<ChatSessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const sessionIds = entries
      .filter((entry) => entry.endsWith(SESSION_FILE_SUFFIX))
      .map((entry) => entry.slice(0, -SESSION_FILE_SUFFIX.length))
      .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId));
    const states = await Promise.all(sessionIds.map((sessionId) => this.load(sessionId)));
    const summaries: ChatSessionSummary[] = [];
    for (const state of states) {
      if (!state) continue;
      summaries.push({
        sessionId: state.sessionId,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        provider: state.provider,
        model: state.model,
        messageCount: getChatSessionMessages(state).length,
        ...(state.title && { title: state.title }),
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  async delete(sessionId: string): Promise<void> {
    const path = this.pathFor(sessionId);
    await rm(path, { force: true });
  }
}
