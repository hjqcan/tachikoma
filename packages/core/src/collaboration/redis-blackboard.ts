/**
 * Redis Blackboard 实现
 *
 * 基于 Redis 的共享键值存储
 * 支持跨 Session 共享状态、CAS 和 TTL
 *
 * @module collaboration/redis-blackboard
 */

import type {
  BlackboardEntry,
  IBlackboard,
} from './types';
import type { RedisConfig, IRedisClient } from './redis-agent-registry';

/**
 * Redis 扩展客户端接口（支持 Watch/Multi）
 */
export interface IRedisWatchClient extends IRedisClient {
  watch(key: string): Promise<void>;
  multi(): IRedisTransaction;
}

/**
 * Redis 事务接口
 */
export interface IRedisTransaction {
  set(key: string, value: string, options?: { EX?: number }): IRedisTransaction;
  exec(): Promise<unknown[] | null>;
  discard(): Promise<void>;
}

/**
 * Redis Blackboard
 */
export class RedisBlackboard implements IBlackboard {
  private readonly prefix: string;
  private readonly writerId: string;
  private client: IRedisWatchClient | null = null;
  private subscribeClient: IRedisClient | null = null;
  private readonly watchHandlers = new Map<string, Set<(entry: BlackboardEntry) => void>>();
  private readonly subscribedKeys = new Set<string>();

  constructor(
    private readonly config: RedisConfig,
    writerId: string,
    private readonly createClient: (url: string) => Promise<IRedisWatchClient>
  ) {
    this.prefix = config.prefix ?? 'tachikoma:collab';
    this.writerId = writerId;
  }

  /**
   * 初始化连接
   */
  private async ensureConnected(): Promise<IRedisWatchClient> {
    if (!this.client) {
      this.client = await this.createClient(this.config.url);
    }
    return this.client;
  }

  /**
   * 获取条目键名
   */
  private getEntryKey(key: string): string {
    return `${this.prefix}:bb:${key}`;
  }

  /**
   * 获取变更频道名
   */
  private getChangeChannel(key: string): string {
    return `${this.prefix}:bb_change:${key}`;
  }

  /**
   * 获取值
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    const client = await this.ensureConnected();
    const data = await client.get(this.getEntryKey(key));
    if (!data) return null;

    try {
      const entry = JSON.parse(data) as BlackboardEntry<T>;

      // 检查 TTL（Redis 自动处理，但双重检查）
      if (entry.ttl && Date.now() - entry.updatedAt > entry.ttl * 1000) {
        return null;
      }

      return entry.value;
    } catch {
      return null;
    }
  }

  /**
   * 设置值
   */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const client = await this.ensureConnected();

    // 获取现有版本
    const existingData = await client.get(this.getEntryKey(key));
    let version = 1;
    if (existingData) {
      try {
        const existing = JSON.parse(existingData) as BlackboardEntry;
        version = existing.version + 1;
      } catch {
        // Ignore
      }
    }

    const entry: BlackboardEntry = {
      key,
      value,
      writtenBy: this.writerId,
      version,
      updatedAt: Date.now(),
      ...(ttl !== undefined && { ttl }),
    };

    const options = ttl ? { EX: ttl } : undefined;
    await client.set(this.getEntryKey(key), JSON.stringify(entry), options);

    // 发布变更通知
    await client.publish(this.getChangeChannel(key), JSON.stringify(entry));
  }

  /**
   * 删除键
   */
  async delete(key: string): Promise<boolean> {
    const client = await this.ensureConnected();
    const result = await client.del(this.getEntryKey(key));
    return result > 0;
  }

  /**
   * 原子比较并设置（使用 WATCH/MULTI/EXEC）
   */
  async compareAndSet(
    key: string,
    expectedVersion: number,
    newValue: unknown
  ): Promise<boolean> {
    const client = await this.ensureConnected();
    const entryKey = this.getEntryKey(key);

    // 使用 WATCH 实现乐观锁
    await client.watch(entryKey);

    const existingData = await client.get(entryKey);
    let currentVersion = 0;
    if (existingData) {
      try {
        const existing = JSON.parse(existingData) as BlackboardEntry;
        currentVersion = existing.version;
      } catch {
        // Ignore
      }
    }

    if (currentVersion !== expectedVersion) {
      // 版本不匹配，取消 WATCH
      const tx = client.multi();
      await tx.discard();
      return false;
    }

    const entry: BlackboardEntry = {
      key,
      value: newValue,
      writtenBy: this.writerId,
      version: currentVersion + 1,
      updatedAt: Date.now(),
    };

    const tx = client.multi();
    tx.set(entryKey, JSON.stringify(entry));
    const result = await tx.exec();

    if (result === null) {
      // 事务失败（key 被其他客户端修改）
      return false;
    }

    // 发布变更通知
    await client.publish(this.getChangeChannel(key), JSON.stringify(entry));
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

    // 订阅变更通知
    this.subscribeToKeyChanges(key).catch(error => {
      console.error('[RedisBlackboard] Watch error:', error);
    });
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
        this.unsubscribeFromKeyChanges(key).catch(() => {});
      }
    }
  }

  /**
   * 列出所有键
   */
  async keys(pattern?: string): Promise<string[]> {
    const client = await this.ensureConnected();
    const redisPattern = pattern
      ? `${this.prefix}:bb:${pattern.replace(/\*/g, '*')}`
      : `${this.prefix}:bb:*`;

    const redisKeys = await client.keys(redisPattern);
    const prefix = `${this.prefix}:bb:`;

    return redisKeys
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length));
  }

  /**
   * 关闭 Blackboard
   */
  async close(): Promise<void> {
    if (this.subscribeClient) {
      for (const key of this.subscribedKeys) {
        try {
          await this.subscribeClient.unsubscribe(this.getChangeChannel(key));
        } catch {
          // Ignore
        }
      }
      try {
        await this.subscribeClient.quit();
      } catch {
        // Ignore
      }
      this.subscribeClient = null;
    }

    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // Ignore
      }
      this.client = null;
    }

    this.watchHandlers.clear();
    this.subscribedKeys.clear();
  }

  /**
   * 订阅键变更
   */
  private async subscribeToKeyChanges(key: string): Promise<void> {
    if (this.subscribedKeys.has(key)) return;

    if (!this.subscribeClient) {
      this.subscribeClient = await this.createClient(this.config.url);
    }

    const channel = this.getChangeChannel(key);
    await this.subscribeClient.subscribe(channel, (message) => {
      try {
        const entry = JSON.parse(message) as BlackboardEntry;
        const handlers = this.watchHandlers.get(key);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(entry);
            } catch (error) {
              console.error('[RedisBlackboard] Watch handler error:', error);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    this.subscribedKeys.add(key);
  }

  /**
   * 取消订阅键变更
   */
  private async unsubscribeFromKeyChanges(key: string): Promise<void> {
    if (!this.subscribedKeys.has(key)) return;
    if (!this.subscribeClient) return;

    await this.subscribeClient.unsubscribe(this.getChangeChannel(key));
    this.subscribedKeys.delete(key);
  }
}

/**
 * 创建 Redis Blackboard
 */
export function createRedisBlackboard(
  config: RedisConfig,
  writerId: string,
  createClient: (url: string) => Promise<IRedisWatchClient>
): RedisBlackboard {
  return new RedisBlackboard(config, writerId, createClient);
}
