/**
 * 工作记忆管理器
 *
 * 管理当前任务状态，支持：
 * - 待办事项持久化
 * - 发现和决策记录
 * - 上下文快照
 *
 * @module prompt/memory/working-memory
 */

import type { IMemoryStore } from './types';
import { createMemoryEntry } from './types';
import type { AgentNotes, TodoItem, ContextMessage } from '../types';

// ============================================================================
// 工作记忆管理器
// ============================================================================

/**
 * 工作记忆管理器配置
 */
export interface WorkingMemoryConfig {
  /** 会话 ID */
  sessionId: string;

  /** 是否自动保存 */
  autoSave: boolean;

  /** 自动保存间隔（毫秒） */
  autoSaveInterval: number;

  /** 最大快照数量 */
  maxSnapshots: number;
}

/**
 * 默认配置
 */
export const DEFAULT_WORKING_MEMORY_CONFIG: WorkingMemoryConfig = {
  sessionId: `session-${Date.now()}`,
  autoSave: true,
  autoSaveInterval: 30000, // 30 秒
  maxSnapshots: 10,
};

/**
 * 工作记忆管理器
 */
export class WorkingMemoryManager {
  private readonly store: IMemoryStore;
  private readonly config: WorkingMemoryConfig;

  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private isDirty = false;
  private currentNotes: AgentNotes | null = null;

  constructor(
    store: IMemoryStore,
    config: Partial<WorkingMemoryConfig> = {}
  ) {
    this.store = store;
    this.config = { ...DEFAULT_WORKING_MEMORY_CONFIG, ...config };
  }

  // ========================================
  // 初始化和清理
  // ========================================

  /**
   * 初始化工作记忆
   */
  async initialize(): Promise<void> {
    await this.store.initialize();

    // 尝试恢复上次的工作记忆
    const todos = await this.loadTodos();
    if (todos.length > 0) {
      this.currentNotes = {
        todos,
        findings: await this.loadFindings(),
        decisions: await this.loadDecisions(),
        lastUpdatedAt: Date.now(),
      };
    }

    // 启动自动保存
    if (this.config.autoSave) {
      this.startAutoSave();
    }
  }

  /**
   * 关闭工作记忆
   */
  async close(): Promise<void> {
    this.stopAutoSave();

    // 保存当前状态
    if (this.isDirty && this.currentNotes) {
      await this.saveNotes(this.currentNotes);
    }

    await this.store.close();
  }

  // ========================================
  // 待办事项
  // ========================================

  /**
   * 保存待办事项
   */
  async saveTodos(notes: AgentNotes): Promise<void> {
    const entry = createMemoryEntry('working', JSON.stringify(notes.todos), {
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        importance: 90,
        tags: ['todos', this.config.sessionId],
      },
    });

    // 使用固定 ID 以便覆盖
    entry.id = `todos-${this.config.sessionId}`;

    await this.store.save(entry);
    this.currentNotes = notes;
    this.isDirty = false;
  }

  /**
   * 加载待办事项
   */
  async loadTodos(): Promise<TodoItem[]> {
    // 使用 get() 按固定 ID 查找
    const entry = await this.store.get(`todos-${this.config.sessionId}`);

    if (entry) {
      try {
        return JSON.parse(entry.content) as TodoItem[];
      } catch {
        return [];
      }
    }

    return [];
  }

  // ========================================
  // 发现和决策
  // ========================================

  /**
   * 添加发现
   */
  async addFinding(finding: string): Promise<void> {
    const entry = createMemoryEntry('working', finding, {
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        importance: 60,
        tags: ['finding', this.config.sessionId],
      },
    });

    await this.store.save(entry);
    this.isDirty = true;
  }

  /**
   * 加载发现
   */
  async loadFindings(): Promise<string[]> {
    const entries = await this.store.retrieve('', {
      type: 'working',
      tags: ['finding', this.config.sessionId],
      limit: 50,
    });

    return entries.map((e) => e.content);
  }

  /**
   * 添加决策
   */
  async addDecision(decision: string): Promise<void> {
    const entry = createMemoryEntry('working', decision, {
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        importance: 70,
        tags: ['decision', this.config.sessionId],
      },
    });

    await this.store.save(entry);
    this.isDirty = true;
  }

  /**
   * 加载决策
   */
  async loadDecisions(): Promise<string[]> {
    const entries = await this.store.retrieve('', {
      type: 'working',
      tags: ['decision', this.config.sessionId],
      limit: 50,
    });

    return entries.map((e) => e.content);
  }

  // ========================================
  // 上下文快照
  // ========================================

  /**
   * 保存上下文快照
   */
  async saveContextSnapshot(
    messages: ContextMessage[],
    reason: string
  ): Promise<void> {
    const snapshot: ContextSnapshot = {
      reason,
      messageCount: messages.length,
      summary: this.generateQuickSummary(messages),
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
    };

    const entry = createMemoryEntry('episodic', JSON.stringify(snapshot), {
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        importance: 50,
        tags: ['snapshot', this.config.sessionId],
      },
    });

    await this.store.save(entry);

    // 清理旧快照
    await this.cleanupOldSnapshots();
  }

  /**
   * 加载最近的快照
   */
  async loadRecentSnapshots(limit = 5): Promise<ContextSnapshot[]> {
    const entries = await this.store.retrieve('', {
      type: 'episodic',
      tags: ['snapshot', this.config.sessionId],
      limit,
    });

    return entries
      .map((e) => {
        try {
          return JSON.parse(e.content) as ContextSnapshot;
        } catch {
          return null;
        }
      })
      .filter((s): s is ContextSnapshot => s !== null);
  }

  // ========================================
  // 私有方法
  // ========================================

  private async saveNotes(notes: AgentNotes): Promise<void> {
    await this.saveTodos(notes);
  }

  private generateQuickSummary(messages: ContextMessage[]): string {
    return messages
      .slice(-5)
      .map((m) => `${m.role}: ${m.content.slice(0, 100)}...`)
      .join('\n');
  }

  private async cleanupOldSnapshots(): Promise<void> {
    const allSnapshots = await this.store.retrieve('', {
      type: 'episodic',
      tags: ['snapshot', this.config.sessionId],
      limit: 100,
    });

    if (allSnapshots.length <= this.config.maxSnapshots) return;

    // 删除最老的快照
    const toDelete = allSnapshots.slice(this.config.maxSnapshots);
    for (const entry of toDelete) {
      await this.store.delete(entry.id);
    }
  }

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(async () => {
      if (this.isDirty && this.currentNotes) {
        await this.saveNotes(this.currentNotes);
      }
    }, this.config.autoSaveInterval);
  }

  private stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }
}

/**
 * 上下文快照
 */
export interface ContextSnapshot {
  reason: string;
  messageCount: number;
  summary: string;
  timestamp: number;
  sessionId: string;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建工作记忆管理器
 */
export function createWorkingMemoryManager(
  store: IMemoryStore,
  config?: Partial<WorkingMemoryConfig>
): WorkingMemoryManager {
  return new WorkingMemoryManager(store, config);
}
