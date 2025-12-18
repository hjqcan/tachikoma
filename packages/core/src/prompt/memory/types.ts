/**
 * 记忆系统类型定义
 *
 * 支持持久化记忆存储，用于跨会话恢复
 *
 * @module prompt/memory/types
 */

// ============================================================================
// 记忆类型
// ============================================================================

/**
 * 记忆类型
 */
export type MemoryType =
  | 'fact' // 事实记忆：项目配置、代码规范等
  | 'episodic' // 情景记忆：之前的对话、决策历史
  | 'procedural' // 程序记忆：常用操作步骤
  | 'working'; // 工作记忆：当前任务状态

/**
 * 记忆条目
 */
export interface MemoryEntry {
  /** 唯一 ID */
  id: string;

  /** 记忆类型 */
  type: MemoryType;

  /** 记忆内容 */
  content: string;

  /** 元数据 */
  metadata: MemoryMetadata;
}

/**
 * 记忆元数据
 */
export interface MemoryMetadata {
  /** 创建时间 */
  createdAt: number;

  /** 更新时间 */
  updatedAt: number;

  /** 访问次数 */
  accessCount: number;

  /** 最后访问时间 */
  lastAccessedAt: number;

  /** 重要性分数 (0-100) */
  importance: number;

  /** 标签 */
  tags: string[];

  /** 来源（可选） */
  source?: string | undefined;

  /** 过期时间（可选） */
  expiresAt?: number | undefined;
}

/**
 * 检索选项
 */
export interface RetrieveOptions {
  /** 限制记忆类型 */
  type?: MemoryType | undefined;

  /** 最大返回数量 */
  limit?: number | undefined;

  /** 最小重要性分数 */
  minImportance?: number | undefined;

  /** 标签过滤 */
  tags?: string[] | undefined;

  /** 是否更新访问统计 */
  updateAccessStats?: boolean | undefined;
}

// ============================================================================
// 记忆存储接口
// ============================================================================

/**
 * 记忆存储接口
 */
export interface IMemoryStore {
  /**
   * 初始化存储
   */
  initialize(): Promise<void>;

  /**
   * 存储记忆
   */
  save(entry: MemoryEntry): Promise<void>;

  /**
   * 检索记忆
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<MemoryEntry[]>;

  /**
   * 通过 ID 获取记忆
   */
  get(id: string): Promise<MemoryEntry | null>;

  /**
   * 获取所有记忆
   */
  getAll(type?: MemoryType): Promise<MemoryEntry[]>;

  /**
   * 删除记忆
   */
  delete(id: string): Promise<boolean>;

  /**
   * 清理过期记忆
   */
  cleanup(maxAgeMs?: number): Promise<number>;

  /**
   * 关闭存储
   */
  close(): Promise<void>;
}

// ============================================================================
// 工厂函数类型
// ============================================================================

/**
 * 创建记忆条目
 */
export function createMemoryEntry(
  type: MemoryType,
  content: string,
  options: Partial<Omit<MemoryEntry, 'id' | 'type' | 'content' | 'metadata'>> & {
    metadata?: Partial<MemoryMetadata>;
  } = {}
): MemoryEntry {
  const now = Date.now();

  return {
    id: `${type}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    content,
    metadata: {
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessedAt: now,
      importance: 50,
      tags: [],
      ...options.metadata,
    },
  };
}

/**
 * 默认检索选项
 */
export const DEFAULT_RETRIEVE_OPTIONS: Required<Omit<RetrieveOptions, 'type' | 'tags'>> = {
  limit: 10,
  minImportance: 0,
  updateAccessStats: true,
};
