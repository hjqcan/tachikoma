/**
 * 文件系统记忆存储
 *
 * 将记忆持久化到文件系统，支持跨会话恢复
 *
 * 目录结构:
 * .tachikoma/memories/
 * ├── fact/
 * │   ├── project-config.json
 * │   └── code-standards.json
 * ├── episodic/
 * │   └── 2025-12-13-session.json
 * ├── procedural/
 * │   └── common-operations.json
 * └── working/
 *     ├── current-task.json
 *     └── todos.json
 *
 * @module prompt/memory/file-store
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  IMemoryStore,
  MemoryEntry,
  MemoryType,
  RetrieveOptions,
} from './types';
import { DEFAULT_RETRIEVE_OPTIONS } from './types';

// ============================================================================
// 文件系统存储
// ============================================================================

/**
 * 文件系统记忆存储配置
 */
export interface FileStoreConfig {
  /** 基础目录 */
  baseDir: string;

  /** 是否自动初始化目录 */
  autoInit: boolean;

  /** 文件编码 */
  encoding: BufferEncoding;

  /** 是否在写入时格式化 JSON */
  prettyPrint: boolean;
}

/**
 * 默认配置
 */
export const DEFAULT_FILE_STORE_CONFIG: Omit<FileStoreConfig, 'baseDir'> = {
  autoInit: true,
  encoding: 'utf-8',
  prettyPrint: true,
};

/**
 * 文件系统记忆存储
 */
export class FileSystemMemoryStore implements IMemoryStore {
  private readonly config: FileStoreConfig;
  private initialized = false;

  // 内存缓存（加速读取）
  private cache = new Map<string, MemoryEntry>();
  private cacheLoaded = false;

  constructor(workDir: string, config: Partial<FileStoreConfig> = {}) {
    this.config = {
      ...DEFAULT_FILE_STORE_CONFIG,
      baseDir: path.join(workDir, '.tachikoma', 'memories'),
      ...config,
    };
  }

  // ========================================
  // IMemoryStore 实现
  // ========================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const types: MemoryType[] = ['fact', 'episodic', 'procedural', 'working'];

    for (const type of types) {
      const dir = path.join(this.config.baseDir, type);
      await fs.mkdir(dir, { recursive: true });
    }

    this.initialized = true;

    // 预加载缓存
    if (!this.cacheLoaded) {
      await this.loadCache();
    }
  }

  async save(entry: MemoryEntry, options?: { touchUpdatedAt?: boolean }): Promise<void> {
    await this.ensureInitialized();

    // 默认更新时间戳，除非明确禁用
    if (options?.touchUpdatedAt !== false) {
      entry.metadata.updatedAt = Date.now();
    }

    const filePath = this.getEntryPath(entry);
    const content = this.config.prettyPrint
      ? JSON.stringify(entry, null, 2)
      : JSON.stringify(entry);

    await fs.writeFile(filePath, content, this.config.encoding);

    // 更新缓存
    this.cache.set(entry.id, entry);
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {}
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    const opts = { ...DEFAULT_RETRIEVE_OPTIONS, ...options };
    const allEntries = await this.getAll(opts.type);

    // 关键词匹配（包括 entry.id、content、tags）
    const queryLower = query.toLowerCase();
    const matched = allEntries.filter((entry) => {
      // ID 匹配
      if (entry.id.toLowerCase().includes(queryLower)) {
        return true;
      }

      // 内容匹配
      if (entry.content.toLowerCase().includes(queryLower)) {
        return true;
      }

      // 标签匹配
      if (entry.metadata.tags.some((t) => t.toLowerCase().includes(queryLower))) {
        return true;
      }

      return false;
    });

    // 过滤条件
    const minImportance = opts.minImportance ?? 0;
    const filtered = matched.filter((entry) => {
      // 重要性过滤
      if (entry.metadata.importance < minImportance) {
        return false;
      }

      // 标签过滤（AND 语义：必须包含所有指定的 tags）
      if (opts.tags && opts.tags.length > 0) {
        const hasAllTags = opts.tags.every((t) =>
          entry.metadata.tags.includes(t)
        );
        if (!hasAllTags) {
          return false;
        }
      }

      return true;
    });

    // 按重要性排序
    filtered.sort((a, b) => b.metadata.importance - a.metadata.importance);

    // 限制数量
    const result = filtered.slice(0, opts.limit);

    // 更新访问统计（不更新 updatedAt）
    if (opts.updateAccessStats) {
      for (const entry of result) {
        entry.metadata.accessCount++;
        entry.metadata.lastAccessedAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        await this.save(entry, { touchUpdatedAt: false });
      }
    }

    return result;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    // 先检查缓存
    if (this.cache.has(id)) {
      return this.cache.get(id) ?? null;
    }

    // 从文件系统查找
    const allEntries = await this.getAll();
    return allEntries.find((e) => e.id === id) ?? null;
  }

  async getAll(type?: MemoryType): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    const types: MemoryType[] = type
      ? [type]
      : ['fact', 'episodic', 'procedural', 'working'];

    // 如果缓存已加载，直接从缓存返回
    if (this.cacheLoaded) {
      const entries: MemoryEntry[] = [];
      for (const entry of this.cache.values()) {
        if (types.includes(entry.type)) {
          entries.push(entry);
        }
      }
      return entries;
    }

    // 首次加载：从文件系统读取
    const entries: MemoryEntry[] = [];

    for (const t of types) {
      const dir = path.join(this.config.baseDir, t);

      try {
        // eslint-disable-next-line no-await-in-loop
        const files = await fs.readdir(dir);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          try {
            const filePath = path.join(dir, file);
            // eslint-disable-next-line no-await-in-loop
            const content = await fs.readFile(filePath, this.config.encoding);
            const entry = JSON.parse(content) as MemoryEntry;

            entries.push(entry);
            this.cache.set(entry.id, entry);
          } catch {
            // 跳过无效文件
          }
        }
      } catch {
        // 目录不存在，跳过
      }
    }

    return entries;
  }

  /**
   * 强制刷新缓存
   *
   * 清除内存缓存并重新从文件系统加载
   */
  async refresh(): Promise<void> {
    this.cache.clear();
    this.cacheLoaded = false;
    await this.loadCache();
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    const entry = await this.get(id);
    if (!entry) return false;

    const filePath = this.getEntryPath(entry);

    try {
      await fs.unlink(filePath);
      this.cache.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(maxAgeMs?: number): Promise<number> {
    await this.ensureInitialized();

    const now = Date.now();
    const maxAge = maxAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 默认 7 天
    let cleaned = 0;

    const allEntries = await this.getAll();

    for (const entry of allEntries) {
      const age = now - entry.metadata.updatedAt;

      // 跳过高重要性记忆
      if (entry.metadata.importance > 80) continue;

      // 删除过期记忆
      if (age > maxAge) {
        const deleted = await this.delete(entry.id);
        if (deleted) cleaned++;
        continue;
      }

      // 删除明确过期的记忆
      if (entry.metadata.expiresAt && now > entry.metadata.expiresAt) {
        const deleted = await this.delete(entry.id);
        if (deleted) cleaned++;
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {
    this.cache.clear();
    this.cacheLoaded = false;
  }

  // ========================================
  // 辅助方法
  // ========================================

  /**
   * 获取存储统计
   */
  async getStats(): Promise<FileStoreStats> {
    await this.ensureInitialized();

    const allEntries = await this.getAll();
    const byType: Record<MemoryType, number> = {
      fact: 0,
      episodic: 0,
      procedural: 0,
      working: 0,
    };

    for (const entry of allEntries) {
      byType[entry.type]++;
    }

    return {
      totalEntries: allEntries.length,
      byType,
      cacheSize: this.cache.size,
      baseDir: this.config.baseDir,
    };
  }

  // ========================================
  // 私有方法
  // ========================================

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.config.autoInit) {
      await this.initialize();
    } else {
      throw new Error(
        'FileSystemMemoryStore not initialized. Call initialize() first or set autoInit=true.'
      );
    }
  }

  private getEntryPath(entry: MemoryEntry): string {
    const sanitizedId = entry.id.replace(/[^a-zA-Z0-9-_]/g, '_');
    return path.join(this.config.baseDir, entry.type, `${sanitizedId}.json`);
  }

  private async loadCache(): Promise<void> {
    await this.getAll();
    this.cacheLoaded = true;
  }
}

/**
 * 存储统计
 */
export interface FileStoreStats {
  totalEntries: number;
  byType: Record<MemoryType, number>;
  cacheSize: number;
  baseDir: string;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建文件系统记忆存储
 */
export function createFileSystemMemoryStore(
  workDir: string,
  config?: Partial<FileStoreConfig>
): FileSystemMemoryStore {
  return new FileSystemMemoryStore(workDir, config);
}
