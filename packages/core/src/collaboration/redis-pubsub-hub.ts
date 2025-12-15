/**
 * Redis Pub-Sub Hub 实现
 *
 * 基于 Redis Pub/Sub 的事件发布订阅
 * 支持跨 Session 实时事件传递
 *
 * @module collaboration/redis-pubsub-hub
 */

import type {
  CollaborationEvent,
  EventHandler,
  IPubSubHub,
} from './types';
import type { RedisConfig, IRedisClient } from './redis-agent-registry';

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Redis Pub-Sub Hub
 */
export class RedisPubSubHub implements IPubSubHub {
  private readonly prefix: string;
  private readonly publisherId: string;
  private readonly topicHandlers = new Map<string, Set<EventHandler>>();
  private readonly patternHandlers = new Map<string, Set<EventHandler>>();
  private publishClient: IRedisClient | null = null;
  private subscribeClient: IRedisClient | null = null;
  private subscribedTopics = new Set<string>();
  private subscribedPatterns = new Set<string>();

  constructor(
    private readonly config: RedisConfig,
    publisherId: string,
    private readonly createClient: (url: string) => Promise<IRedisClient>
  ) {
    this.prefix = config.prefix ?? 'tachikoma:collab';
    this.publisherId = publisherId;
  }

  /**
   * 初始化发布客户端
   */
  private async ensurePublishClient(): Promise<IRedisClient> {
    if (!this.publishClient) {
      this.publishClient = await this.createClient(this.config.url);
    }
    return this.publishClient;
  }

  /**
   * 初始化订阅客户端
   */
  private async ensureSubscribeClient(): Promise<IRedisClient> {
    if (!this.subscribeClient) {
      this.subscribeClient = await this.createClient(this.config.url);
    }
    return this.subscribeClient;
  }

  /**
   * 获取主题频道名
   */
  private getChannel(topic: string): string {
    return `${this.prefix}:event:${topic}`;
  }

  /**
   * 发布事件
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    const client = await this.ensurePublishClient();

    const event: CollaborationEvent = {
      id: generateId(),
      topic,
      publisherId: this.publisherId,
      payload,
      timestamp: Date.now(),
    };

    await client.publish(this.getChannel(topic), JSON.stringify(event));
  }

  /**
   * 订阅主题
   */
  subscribe(topic: string, handler: EventHandler): void {
    let handlers = this.topicHandlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topicHandlers.set(topic, handlers);
    }
    handlers.add(handler);

    // 异步订阅 Redis 频道
    this.subscribeToChannel(topic).catch(error => {
      console.error('[RedisPubSubHub] Subscribe error:', error);
    });
  }

  /**
   * 取消订阅
   */
  unsubscribe(topic: string, handler: EventHandler): void {
    const handlers = this.topicHandlers.get(topic);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.topicHandlers.delete(topic);
        this.unsubscribeFromChannel(topic).catch(() => {});
      }
    }
  }

  /**
   * 通配符订阅
   */
  subscribePattern(pattern: string, handler: EventHandler): void {
    let handlers = this.patternHandlers.get(pattern);
    if (!handlers) {
      handlers = new Set();
      this.patternHandlers.set(pattern, handlers);
    }
    handlers.add(handler);

    // 注意：Redis 的 PSUBSCRIBE 需要单独实现
    // 这里使用简化版：订阅特定模式
    this.subscribeToPattern(pattern).catch(error => {
      console.error('[RedisPubSubHub] Pattern subscribe error:', error);
    });
  }

  /**
   * 取消通配符订阅
   */
  unsubscribePattern(pattern: string, handler: EventHandler): void {
    const handlers = this.patternHandlers.get(pattern);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.patternHandlers.delete(pattern);
        this.unsubscribeFromPattern(pattern).catch(() => {});
      }
    }
  }

  /**
   * 关闭 Hub
   */
  async close(): Promise<void> {
    if (this.subscribeClient) {
      for (const topic of this.subscribedTopics) {
        try {
          await this.subscribeClient.unsubscribe(this.getChannel(topic));
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

    if (this.publishClient) {
      try {
        await this.publishClient.quit();
      } catch {
        // Ignore
      }
      this.publishClient = null;
    }

    this.topicHandlers.clear();
    this.patternHandlers.clear();
    this.subscribedTopics.clear();
    this.subscribedPatterns.clear();
  }

  /**
   * 订阅 Redis 频道
   */
  private async subscribeToChannel(topic: string): Promise<void> {
    if (this.subscribedTopics.has(topic)) return;

    const client = await this.ensureSubscribeClient();
    const channel = this.getChannel(topic);

    await client.subscribe(channel, (message) => {
      this.handleMessage(message, topic);
    });

    this.subscribedTopics.add(topic);
  }

  /**
   * 取消订阅 Redis 频道
   */
  private async unsubscribeFromChannel(topic: string): Promise<void> {
    if (!this.subscribedTopics.has(topic)) return;
    if (!this.subscribeClient) return;

    await this.subscribeClient.unsubscribe(this.getChannel(topic));
    this.subscribedTopics.delete(topic);
  }

  /**
   * 订阅模式（简化实现）
   */
  private async subscribeToPattern(pattern: string): Promise<void> {
    if (this.subscribedPatterns.has(pattern)) return;
    // 注意：完整实现需要 PSUBSCRIBE，这里使用轮询替代
    this.subscribedPatterns.add(pattern);
  }

  /**
   * 取消订阅模式
   */
  private async unsubscribeFromPattern(pattern: string): Promise<void> {
    this.subscribedPatterns.delete(pattern);
  }

  /**
   * 处理消息
   */
  private handleMessage(message: string, topic: string): void {
    try {
      const event = JSON.parse(message) as CollaborationEvent;

      // 跳过自己发布的事件
      if (event.publisherId === this.publisherId) return;

      // 精确主题匹配
      const handlers = this.topicHandlers.get(topic);
      if (handlers) {
        for (const handler of handlers) {
          try {
            void handler(event);
          } catch (error) {
            console.error('[RedisPubSubHub] Handler error:', error);
          }
        }
      }

      // 模式匹配
      for (const [pattern, patternHandlers] of this.patternHandlers) {
        if (this.matchPattern(topic, pattern)) {
          for (const handler of patternHandlers) {
            try {
              void handler(event);
            } catch (error) {
              console.error('[RedisPubSubHub] Pattern handler error:', error);
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * 检查主题是否匹配模式
   */
  private matchPattern(topic: string, pattern: string): boolean {
    const patternParts = pattern.split(':');
    const topicParts = topic.split(':');

    let patternIdx = 0;
    let topicIdx = 0;

    while (patternIdx < patternParts.length && topicIdx < topicParts.length) {
      const p = patternParts[patternIdx];

      if (p === '**') {
        return true;
      } else if (p === '*') {
        patternIdx++;
        topicIdx++;
      } else if (p === topicParts[topicIdx]) {
        patternIdx++;
        topicIdx++;
      } else {
        return false;
      }
    }

    return patternIdx === patternParts.length && topicIdx === topicParts.length;
  }
}

/**
 * 创建 Redis Pub-Sub Hub
 */
export function createRedisPubSubHub(
  config: RedisConfig,
  publisherId: string,
  createClient: (url: string) => Promise<IRedisClient>
): RedisPubSubHub {
  return new RedisPubSubHub(config, publisherId, createClient);
}
