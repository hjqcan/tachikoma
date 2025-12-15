/**
 * 文件系统 Pub-Sub Hub 实现
 *
 * 基于共享文件系统的事件发布订阅
 * 使用 `.tachikoma/collaboration/events/` 目录存储事件
 *
 * 特性：
 * - 主题订阅和通配符订阅
 * - 事件持久化和回放
 * - 自动清理过期事件
 *
 * @module collaboration/file-pubsub-hub
 */

import { join } from 'node:path';
import type {
  CollaborationEvent,
  EventHandler,
  IPubSubHub,
} from './types';
import {
  atomicWriteJson,
  readJsonFile,
  listDir,
  safeDeleteFile,
  ensureDir,
  generateTimestampId,
} from '../orchestrator/session/utils';

/**
 * 文件系统 Pub-Sub Hub
 * 
 * 使用时间戳进行事件排序和去重，比 event.id 字符串比较更可靠
 */
export class FilePubSubHub implements IPubSubHub {
  private readonly eventsDir: string;
  private readonly publisherId: string;
  private readonly topicHandlers = new Map<string, Set<EventHandler>>();
  private readonly patternHandlers = new Map<string, Set<EventHandler>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 已处理的事件 ID 集合（用于去重） */
  private readonly processedEventIds = new Set<string>();
  /** 上次处理的最大时间戳（用于快速跳过旧事件） */
  private lastProcessedTimestamp = 0;
  private readonly pollInterval: number;
  private readonly eventTTL: number;

  constructor(
    rootDir: string,
    publisherId: string,
    options: { pollInterval?: number; eventTTL?: number } = {}
  ) {
    this.eventsDir = join(rootDir, 'collaboration', 'events');
    this.publisherId = publisherId;
    this.pollInterval = options.pollInterval ?? 500;
    this.eventTTL = options.eventTTL ?? 60000; // 默认 1 分钟
  }

  /**
   * 发布事件
   */
  async publish(topic: string, payload: unknown): Promise<void> {
    await ensureDir(this.eventsDir);

    const eventId = generateTimestampId('evt');
    const event: CollaborationEvent = {
      id: eventId,
      topic,
      publisherId: this.publisherId,
      payload,
      timestamp: Date.now(),
    };

    // 使用时间戳前缀确保按序排列
    const filename = `${Date.now()}-${eventId}.json`;
    await atomicWriteJson(join(this.eventsDir, filename), event);
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
    this.startPolling();
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
      }
    }
    this.checkStopPolling();
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
    this.startPolling();
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
      }
    }
    this.checkStopPolling();
  }

  /**
   * 关闭 Hub
   */
  async close(): Promise<void> {
    this.stopPolling();
    this.topicHandlers.clear();
    this.patternHandlers.clear();
  }

  /**
   * 检查主题是否匹配模式
   */
  private matchPattern(topic: string, pattern: string): boolean {
    // 支持简单通配符：'*' 匹配单级，'**' 匹配多级
    // 例如：'task:*' 匹配 'task:completed'，'task:**' 匹配 'task:worker:1:completed'
    const patternParts = pattern.split(':');
    const topicParts = topic.split(':');

    let patternIdx = 0;
    let topicIdx = 0;

    while (patternIdx < patternParts.length && topicIdx < topicParts.length) {
      const p = patternParts[patternIdx];

      if (p === '**') {
        // 匹配剩余所有
        return true;
      } else if (p === '*') {
        // 匹配单级
        patternIdx++;
        topicIdx++;
      } else if (p === topicParts[topicIdx]) {
        patternIdx++;
        topicIdx++;
      } else {
        return false;
      }
    }

    // 两边都消耗完才算匹配
    return patternIdx === patternParts.length && topicIdx === topicParts.length;
  }

  /**
   * 启动轮询
   */
  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollForEvents().catch(error => {
        console.error('[FilePubSubHub] Poll error:', error);
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
    if (this.topicHandlers.size === 0 && this.patternHandlers.size === 0) {
      this.stopPolling();
    }
  }

  /**
   * 轮询新事件
   * 
   * 使用时间戳和事件 ID 组合进行可靠的事件排序和去重
   */
  private async pollForEvents(): Promise<void> {
    const files = await listDir(this.eventsDir).catch(() => []);
    const now = Date.now();
    const newEvents: CollaborationEvent[] = [];

    // 按文件名排序（文件名格式: {timestamp}-{eventId}.json）
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;

      const filePath = join(this.eventsDir, file);
      const event = await readJsonFile<CollaborationEvent>(filePath);

      if (!event) continue;

      // 清理过期事件
      if (now - event.timestamp > this.eventTTL) {
        await safeDeleteFile(filePath);
        continue;
      }

      // 使用时间戳快速跳过旧事件
      if (event.timestamp < this.lastProcessedTimestamp) continue;

      // 使用 Set 精确去重（避免同一时间戳的事件重复处理）
      if (this.processedEventIds.has(event.id)) continue;

      // 跳过自己发布的事件
      if (event.publisherId === this.publisherId) continue;

      newEvents.push(event);
      
      // 更新已处理状态
      this.processedEventIds.add(event.id);
      if (event.timestamp > this.lastProcessedTimestamp) {
        this.lastProcessedTimestamp = event.timestamp;
      }

      // 防止内存无限增长：清理过期事件 ID
      // TTL 过期后清理对应的 ID（粗略估计：保留最近 1000 个）
      if (this.processedEventIds.size > 1000) {
        const idsArray = [...this.processedEventIds];
        this.processedEventIds.clear();
        for (const id of idsArray.slice(-500)) {
          this.processedEventIds.add(id);
        }
      }
    }

    // 分发事件
    for (const event of newEvents) {
      await this.dispatchEvent(event);
    }
  }

  /**
   * 分发事件
   */
  private async dispatchEvent(event: CollaborationEvent): Promise<void> {
    // 精确主题匹配
    const topicHandlers = this.topicHandlers.get(event.topic);
    if (topicHandlers) {
      for (const handler of topicHandlers) {
        try {
          await handler(event);
        } catch (error) {
          console.error('[FilePubSubHub] Handler error:', error);
        }
      }
    }

    // 模式匹配
    for (const [pattern, handlers] of this.patternHandlers) {
      if (this.matchPattern(event.topic, pattern)) {
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (error) {
            console.error('[FilePubSubHub] Pattern handler error:', error);
          }
        }
      }
    }
  }
}

/**
 * 创建文件系统 Pub-Sub Hub
 */
export function createFilePubSubHub(
  rootDir: string,
  publisherId: string,
  options?: { pollInterval?: number; eventTTL?: number }
): FilePubSubHub {
  return new FilePubSubHub(rootDir, publisherId, options);
}
