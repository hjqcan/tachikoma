/**
 * Session Store
 *
 * 会话持久化存储，支持检查点管理
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionState, Checkpoint, ConversationMessage } from './types';

// =============================================================================
// 常量
// =============================================================================

const SESSION_FILE = 'session.json';
const CHECKPOINTS_DIR = 'checkpoints';

// =============================================================================
// SessionStore 类
// =============================================================================

/**
 * 会话存储管理器
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  /**
   * 创建新会话
   */
  async createSession(workDir: string): Promise<SessionState> {
    const sessionId = `conv-${randomUUID().substring(0, 8)}`;
    const now = Date.now();

    const session: SessionState = {
      sessionId,
      createdAt: now,
      lastActiveAt: now,
      workDir,
      messages: [],
      completedSubtasks: [],
      pendingSubtasks: [],
      checkpoints: [],
      variables: {},
      waitingForUser: false,
    };

    await this.saveSession(session);
    return session;
  }

  /**
   * 获取会话
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    try {
      const sessionPath = this.getSessionPath(sessionId);
      const content = await readFile(join(sessionPath, SESSION_FILE), 'utf-8');
      return JSON.parse(content) as SessionState;
    } catch {
      return null;
    }
  }

  /**
   * 保存会话
   */
  async saveSession(session: SessionState): Promise<void> {
    const sessionPath = this.getSessionPath(session.sessionId);
    await mkdir(sessionPath, { recursive: true });

    session.lastActiveAt = Date.now();
    await writeFile(
      join(sessionPath, SESSION_FILE),
      JSON.stringify(session, null, 2),
      'utf-8'
    );
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    const sessionPath = this.getSessionPath(sessionId);
    await rm(sessionPath, { recursive: true, force: true });
  }

  /**
   * 列出所有会话
   */
  async listSessions(): Promise<SessionState[]> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const sessions: SessionState[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('conv-')) {
          const session = await this.getSession(entry.name);
          if (session) {
            sessions.push(session);
          }
        }
      }

      // 按最后活动时间排序
      return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Message Management
  // ---------------------------------------------------------------------------

  /**
   * 添加消息
   */
  async addMessage(
    sessionId: string,
    message: Omit<ConversationMessage, 'id' | 'timestamp'>
  ): Promise<ConversationMessage> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fullMessage: ConversationMessage = {
      ...message,
      id: `msg-${randomUUID().substring(0, 8)}`,
      timestamp: Date.now(),
    };

    session.messages.push(fullMessage);
    await this.saveSession(session);

    return fullMessage;
  }

  // ---------------------------------------------------------------------------
  // Checkpoint Management
  // ---------------------------------------------------------------------------

  /**
   * 创建检查点
   */
  async createCheckpoint(
    sessionId: string,
    description: string
  ): Promise<Checkpoint> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpoint: Checkpoint = {
      id: `ckpt-${randomUUID().substring(0, 8)}`,
      timestamp: Date.now(),
      description,
      messageIndex: session.messages.length,
    };

    session.checkpoints.push(checkpoint);
    await this.saveSession(session);

    return checkpoint;
  }

  /**
   * 回滚到检查点
   */
  async rollbackToCheckpoint(
    sessionId: string,
    checkpointId: string
  ): Promise<SessionState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpointIndex = session.checkpoints.findIndex(
      (c) => c.id === checkpointId
    );
    if (checkpointIndex === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const checkpoint = session.checkpoints[checkpointIndex];
    if (!checkpoint) {
      throw new Error(`Checkpoint data is undefined: ${checkpointId}`);
    }

    // 截断消息历史
    session.messages = session.messages.slice(0, checkpoint.messageIndex);

    // 移除此检查点之后的所有检查点
    session.checkpoints = session.checkpoints.slice(0, checkpointIndex + 1);

    // 重置执行状态
    session.currentPlan = undefined;
    session.completedSubtasks = [];
    session.pendingSubtasks = [];
    session.waitingForUser = false;
    session.pendingQuestion = undefined;

    await this.saveSession(session);
    return session;
  }

  /**
   * 获取最近的检查点
   */
  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const session = await this.getSession(sessionId);
    if (!session || session.checkpoints.length === 0) {
      return null;
    }
    return session.checkpoints[session.checkpoints.length - 1] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * 获取会话目录路径
   */
  private getSessionPath(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  /**
   * 获取检查点目录路径
   */
  private getCheckpointsPath(sessionId: string): string {
    return join(this.getSessionPath(sessionId), CHECKPOINTS_DIR);
  }
}
