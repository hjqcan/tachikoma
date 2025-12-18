/**
 * 文件系统 Blackboard 实现
 *
 * 基于共享文件系统的键值存储
 * 使用 `.tachikoma/collaboration/blackboard/` 目录存储条目
 *
 * 特性：
 * - 版本控制支持 CAS 操作
 * - TTL 过期机制
 * - 键变更监听
 * - 使用 base64url 编码避免 key 碰撞
 * - 使用临时文件+重命名实现类原子性 CAS
 *
 * @module collaboration/file-blackboard
 */

import { join } from 'node:path';
import type {
  BlackboardEntry,
  IBlackboard,
} from './types';
import {
  atomicWriteJson,
  readJsonFile,
  listDir,
  fileExists,
  safeDeleteFile,
  ensureDir,
} from '../orchestrator/session/utils';

/**
 * Base64url 编码（无需第三方库）
 */
function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * 文件系统 Blackboard
 */
export class FileBlackboard implements IBlackboard {
  private readonly blackboardDir: string;
  private readonly writerId: string;
  private readonly watchHandlers = new Map<string, Set<(entry: BlackboardEntry) => void>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollInterval: number;
  private readonly knownVersions = new Map<string, number>();

  constructor(
    rootDir: string,
    writerId: string,
    options: { pollInterval?: number } = {}
  ) {
    this.blackboardDir = join(rootDir, 'collaboration', 'blackboard');
    this.writerId = writerId;
    this.pollInterval = options.pollInterval ?? 1000;
  }

  /**
   * 获取条目文件路径
   * 
   * 使用 base64url 编码 key 避免碰撞
   */
  private getEntryPath(key: string): string {
    const encodedKey = base64urlEncode(key);
    return join(this.blackboardDir, `${encodedKey}.json`);
  }

  /**
   * 获取值
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = await this.getEntry(key);
    if (!entry) return null;

    // 验证 key 匹配（防止碰撞）
    if (entry.key !== key) {
      console.warn(`[FileBlackboard] Key mismatch: expected "${key}", got "${entry.key}"`);
      return null;
    }

    // 检查 TTL
    if (entry.ttl && Date.now() - entry.updatedAt > entry.ttl * 1000) {
      await this.delete(key);
      return null;
    }

    return entry.value as T;
  }

  /**
   * 设置值
   */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    await ensureDir(this.blackboardDir);

    const existing = await this.getEntry(key);
    const version = existing ? existing.version + 1 : 1;

    const entry: BlackboardEntry = {
      key, // 存储原始 key 用于验证
      value,
      writtenBy: this.writerId,
      version,
      updatedAt: Date.now(),
      ...(ttl !== undefined && { ttl }),
    };

    await atomicWriteJson(this.getEntryPath(key), entry);
    this.knownVersions.set(key, version);

    // 通知监听者
    await this.notifyWatchers(key, entry);
  }

  /**
   * 删除键
   */
  async delete(key: string): Promise<boolean> {
    const path = this.getEntryPath(key);
    if (!fileExists(path)) return false;

    await safeDeleteFile(path);
    this.knownVersions.delete(key);
    return true;
  }

  /**
   * 原子比较并设置
   * 
   * 使用乐观锁策略：
   * 1. 读取当前版本
   * 2. 写入新值（带版本号）
   * 3. 重新读取验证版本
   * 
   * 注意：这不是真正的跨进程原子操作，在高并发场景可能失败
   * 对于需要强一致性的场景，建议使用 Redis 后端
   */
  async compareAndSet(
    key: string,
    expectedVersion: number,
    newValue: unknown
  ): Promise<boolean> {
    const existing = await this.getEntry(key);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      return false;
    }

    // 计算新版本
    const newVersion = currentVersion + 1;

    // 直接写入（atomicWriteJson 使用临时文件+重命名，提供一定程度的原子性）
    const entry: BlackboardEntry = {
      key,
      value: newValue,
      writtenBy: this.writerId,
      version: newVersion,
      updatedAt: Date.now(),
    };

    await atomicWriteJson(this.getEntryPath(key), entry);

    // 验证写入成功（乐观锁验证）
    const verified = await this.getEntry(key);
    if (!verified || verified.version !== newVersion || verified.writtenBy !== this.writerId) {
      // 写入被覆盖，CAS 失败
      return false;
    }

    this.knownVersions.set(key, newVersion);
    await this.notifyWatchers(key, entry);
    return true;
  }

  /**
   * 批量获取
   */
  async mget(keys: string[]): Promise<(unknown | null)[]> {
    return Promise.all(keys.map(key => this.get(key)));
  }

  /**
   * 监听键变更
   */
  watch(key: string, handler: (entry: BlackboardEntry) => void): void {
    let handlers = this.watchHandlers.get(key);
    if (!handlers) {
      handlers = new Set();
      this.watchHandlers.set(key, handlers);
    }
    handlers.add(handler);

    // 记录当前版本
    this.getEntry(key).then(entry => {
      if (entry) {
        this.knownVersions.set(key, entry.version);
      }
    }).catch(() => {});

    this.startPolling();
  }

  /**
   * 取消监听
   */
  unwatch(key: string, handler: (entry: BlackboardEntry) => void): void {
    const handlers = this.watchHandlers.get(key);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.watchHandlers.delete(key);
      }
    }
    this.checkStopPolling();
  }

  /**
   * 列出所有键
   */
  async keys(pattern?: string): Promise<string[]> {
    const files = await listDir(this.blackboardDir).catch(() => []);
    const keys: string[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const entry = await readJsonFile<BlackboardEntry>(
        join(this.blackboardDir, file)
      );
      if (!entry) continue;

      // 检查 TTL
      if (entry.ttl && Date.now() - entry.updatedAt > entry.ttl * 1000) {
        await safeDeleteFile(join(this.blackboardDir, file));
        continue;
      }

      // 模式匹配
      if (pattern) {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        if (!regex.test(entry.key)) continue;
      }

      keys.push(entry.key);
    }

    return keys;
  }

  /**
   * 关闭 Blackboard
   */
  async close(): Promise<void> {
    this.stopPolling();
    this.watchHandlers.clear();
    this.knownVersions.clear();
  }

  /**
   * 获取条目
   */
  private async getEntry(key: string): Promise<BlackboardEntry | null> {
    const path = this.getEntryPath(key);
    if (!fileExists(path)) return null;
    return readJsonFile<BlackboardEntry>(path);
  }

  /**
   * 通知监听者
   */
  private async notifyWatchers(key: string, entry: BlackboardEntry): Promise<void> {
    const handlers = this.watchHandlers.get(key);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(entry);
      } catch (error) {
        console.error('[FileBlackboard] Watch handler error:', error);
      }
    }
  }

  /**
   * 启动轮询
   */
  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch(error => {
        console.error('[FileBlackboard] Poll error:', error);
      });
    }, this.pollInterval);
  }

  /**
   * 停止轮询
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 检查是否应停止轮询
   */
  private checkStopPolling(): void {
    if (this.watchHandlers.size === 0) {
      this.stopPolling();
    }
  }

  /**
   * 轮询变更
   */
  private async pollForChanges(): Promise<void> {
    for (const key of this.watchHandlers.keys()) {
      const entry = await this.getEntry(key);
      if (!entry) continue;

      // 检查 TTL
      if (entry.ttl && Date.now() - entry.updatedAt > entry.ttl * 1000) {
        continue; // 已过期，不通知
      }

      const knownVersion = this.knownVersions.get(key) ?? 0;
      if (entry.version > knownVersion) {
        this.knownVersions.set(key, entry.version);
        await this.notifyWatchers(key, entry);
      }
    }
  }
}

/**
 * 创建文件系统 Blackboard
 */
export function createFileBlackboard(
  rootDir: string,
  writerId: string,
  options?: { pollInterval?: number }
): FileBlackboard {
  return new FileBlackboard(rootDir, writerId, options);
}
