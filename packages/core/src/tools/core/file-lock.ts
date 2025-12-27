/**
 * FileLockManager - 文件级锁管理器
 *
 * 防止多个 Worker/Agent 同时编辑同一文件导致内容损坏。
 * 参考 OpenCode 的 FileTime.withLock 机制。
 */

import { resolve } from 'node:path';

// =============================================================================
// 类型定义
// =============================================================================

interface LockEntry {
  /** 锁持有者ID (通常是 workerId 或 agentId) */
  ownerId: string;
  /** 获取锁的时间戳 */
  acquiredAt: number;
  /** 锁超时时间（毫秒），超过此时间锁自动释放 */
  timeout: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  ownerId: string;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// =============================================================================
// FileLockManager
// =============================================================================

/** 默认锁超时时间（5分钟） */
const DEFAULT_LOCK_TIMEOUT = 5 * 60 * 1000;

/** 默认等待超时时间（30秒） */
const DEFAULT_WAIT_TIMEOUT = 30 * 1000;

/**
 * 文件锁管理器
 *
 * 提供文件级互斥锁，确保同一时间只有一个 Worker 可以编辑特定文件。
 *
 * @example
 * ```typescript
 * const lockManager = FileLockManager.getInstance();
 *
 * await lockManager.withFileLock('/path/to/file.ts', 'worker-1', async () => {
 *   const content = await readFile(path);
 *   const modified = transform(content);
 *   await writeFile(path, modified);
 * });
 * ```
 */
export class FileLockManager {
  private static instance: FileLockManager | null = null;

  /** 当前持有的锁: path -> LockEntry */
  private locks = new Map<string, LockEntry>();

  /** 等待队列: path -> Waiter[] */
  private waiters = new Map<string, Waiter[]>();

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager();
    }
    return FileLockManager.instance;
  }

  /**
   * 重置实例（仅用于测试）
   */
  static resetInstance(): void {
    if (FileLockManager.instance) {
      FileLockManager.instance.releaseAllLocks();
      FileLockManager.instance = null;
    }
  }

  /**
   * 规范化路径（用于锁 key）
   */
  private normalizePath(path: string): string {
    return resolve(path);
  }

  /**
   * 检查锁是否已过期
   */
  private isLockExpired(entry: LockEntry): boolean {
    return Date.now() > entry.acquiredAt + entry.timeout;
  }

  /**
   * 获取锁
   *
   * 如果锁已被其他 owner 持有，会等待直到锁可用或超时。
   *
   * @param path - 文件路径
   * @param ownerId - 锁持有者ID
   * @param options - 配置选项
   */
  async acquireLock(
    path: string,
    ownerId: string,
    options: {
      /** 锁超时时间（毫秒） */
      lockTimeout?: number;
      /** 等待锁的超时时间（毫秒） */
      waitTimeout?: number;
    } = {}
  ): Promise<void> {
    const normalizedPath = this.normalizePath(path);
    const lockTimeout = options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT;
    const waitTimeout = options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT;

    // 检查是否已持有锁
    const existingLock = this.locks.get(normalizedPath);
    if (existingLock) {
      // 同一 owner 重入：更新超时时间
      if (existingLock.ownerId === ownerId) {
        existingLock.acquiredAt = Date.now();
        existingLock.timeout = lockTimeout;
        return;
      }

      // 检查锁是否过期
      if (this.isLockExpired(existingLock)) {
        console.warn(
          `[FileLock] Force releasing expired lock on ${path} (owner: ${existingLock.ownerId})`
        );
        this.locks.delete(normalizedPath);
      } else {
        // 需要等待
        return this.waitForLock(normalizedPath, ownerId, lockTimeout, waitTimeout);
      }
    }

    // 立即获取锁
    this.locks.set(normalizedPath, {
      ownerId,
      acquiredAt: Date.now(),
      timeout: lockTimeout,
    });
  }

  /**
   * 等待锁可用
   */
  private waitForLock(
    normalizedPath: string,
    ownerId: string,
    lockTimeout: number,
    waitTimeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          // 获取锁
          this.locks.set(normalizedPath, {
            ownerId,
            acquiredAt: Date.now(),
            timeout: lockTimeout,
          });
          resolve();
        },
        reject,
        ownerId,
      };

      // 设置等待超时
      waiter.timeoutId = setTimeout(() => {
        this.removeWaiter(normalizedPath, waiter);
        reject(
          new Error(
            `Timeout waiting for file lock: ${normalizedPath} (held by ${this.locks.get(normalizedPath)?.ownerId ?? 'unknown'})`
          )
        );
      }, waitTimeout);

      // 加入等待队列
      const queue = this.waiters.get(normalizedPath) ?? [];
      queue.push(waiter);
      this.waiters.set(normalizedPath, queue);
    });
  }

  /**
   * 从等待队列移除 waiter
   */
  private removeWaiter(normalizedPath: string, waiter: Waiter): void {
    const queue = this.waiters.get(normalizedPath);
    if (queue) {
      const index = queue.indexOf(waiter);
      if (index >= 0) {
        queue.splice(index, 1);
        if (waiter.timeoutId) {
          clearTimeout(waiter.timeoutId);
        }
      }
      if (queue.length === 0) {
        this.waiters.delete(normalizedPath);
      }
    }
  }

  /**
   * 释放锁
   *
   * @param path - 文件路径
   * @param ownerId - 锁持有者ID（必须匹配才能释放）
   * @returns 是否成功释放
   */
  releaseLock(path: string, ownerId: string): boolean {
    const normalizedPath = this.normalizePath(path);
    const existingLock = this.locks.get(normalizedPath);

    if (!existingLock) {
      return false;
    }

    if (existingLock.ownerId !== ownerId) {
      console.warn(
        `[FileLock] Attempt to release lock by non-owner: ${path} (owner: ${existingLock.ownerId}, attempted: ${ownerId})`
      );
      return false;
    }

    this.locks.delete(normalizedPath);

    // 唤醒下一个等待者
    const queue = this.waiters.get(normalizedPath);
    if (queue && queue.length > 0) {
      const nextWaiter = queue.shift();
      if (!nextWaiter) return true;
      if (nextWaiter.timeoutId) {
        clearTimeout(nextWaiter.timeoutId);
      }
      if (queue.length === 0) {
        this.waiters.delete(normalizedPath);
      }
      // 异步唤醒，避免递归调用问题
      setImmediate(() => nextWaiter.resolve());
    }

    return true;
  }

  /**
   * RAII 风格的锁管理
   *
   * 自动获取锁、执行回调、释放锁。即使回调抛出异常也会释放锁。
   *
   * @param path - 文件路径
   * @param ownerId - 锁持有者ID
   * @param fn - 要执行的回调函数
   * @param options - 锁配置选项
   */
  async withFileLock<T>(
    path: string,
    ownerId: string,
    fn: () => Promise<T>,
    options?: {
      lockTimeout?: number;
      waitTimeout?: number;
    }
  ): Promise<T> {
    await this.acquireLock(path, ownerId, options);
    try {
      return await fn();
    } finally {
      this.releaseLock(path, ownerId);
    }
  }

  /**
   * 检查文件是否被锁定
   */
  isLocked(path: string): boolean {
    const normalizedPath = this.normalizePath(path);
    const lock = this.locks.get(normalizedPath);
    if (!lock) return false;
    if (this.isLockExpired(lock)) {
      this.locks.delete(normalizedPath);
      return false;
    }
    return true;
  }

  /**
   * 获取锁持有者
   */
  getLockOwner(path: string): string | null {
    const normalizedPath = this.normalizePath(path);
    const lock = this.locks.get(normalizedPath);
    if (!lock) return null;
    if (this.isLockExpired(lock)) {
      this.locks.delete(normalizedPath);
      return null;
    }
    return lock.ownerId;
  }

  /**
   * 释放所有锁（用于清理）
   */
  releaseAllLocks(): void {
    // 清理所有等待者
    for (const [, queue] of this.waiters) {
      for (const waiter of queue) {
        if (waiter.timeoutId) {
          clearTimeout(waiter.timeoutId);
        }
        waiter.reject(new Error('All locks released'));
      }
    }
    this.waiters.clear();
    this.locks.clear();
  }

  /**
   * 获取当前锁状态（用于调试）
   */
  getStatus(): { lockedFiles: string[]; waitingFiles: string[] } {
    const lockedFiles: string[] = [];
    const now = Date.now();

    for (const [path, lock] of this.locks) {
      if (now <= lock.acquiredAt + lock.timeout) {
        lockedFiles.push(path);
      }
    }

    return {
      lockedFiles,
      waitingFiles: Array.from(this.waiters.keys()),
    };
  }
}

// 导出单例获取函数
export function getFileLockManager(): FileLockManager {
  return FileLockManager.getInstance();
}

// 导出便捷函数
export async function withFileLock<T>(
  path: string,
  ownerId: string,
  fn: () => Promise<T>,
  options?: {
    lockTimeout?: number;
    waitTimeout?: number;
  }
): Promise<T> {
  return FileLockManager.getInstance().withFileLock(path, ownerId, fn, options);
}
