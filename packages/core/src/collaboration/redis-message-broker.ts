/**
 * Redis Message Broker 实现
 *
 * 基于 Redis Streams 的 Request-Response 消息传递
 * 支持跨 Session 协作和优先级队列
 *
 * @module collaboration/redis-message-broker
 */

import type {
  CollaborationRequest,
  CollaborationResponse,
  RequestHandler,
  IMessageBroker,
} from './types';
import type { RedisConfig, IRedisClient } from './redis-agent-registry';

/**
 * Redis 扩展客户端接口（支持 Streams）
 */
export interface IRedisStreamClient extends IRedisClient {
  xadd(key: string, id: string, ...args: string[]): Promise<string>;
  xread(options: { BLOCK?: number; COUNT?: number }, ...streams: string[]): Promise<unknown[] | null>;
  xdel(key: string, id: string): Promise<number>;
  xrange(key: string, start: string, end: string, count?: number): Promise<unknown[]>;
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Redis Message Broker
 */
export class RedisMessageBroker implements IMessageBroker {
  private readonly prefix: string;
  private readonly agentId: string;
  private readonly requestHandlers = new Set<RequestHandler>();
  private client: IRedisStreamClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollInterval: number;
  private readonly defaultTimeout: number;
  private processingRequest = false;

  /** 等待响应的请求映射 */
  private pendingResponses = new Map<
    string,
    {
      resolve: (response: CollaborationResponse) => void;
      reject: (error: Error) => void;
      timeoutTimer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly config: RedisConfig,
    agentId: string,
    private readonly createClient: (url: string) => Promise<IRedisStreamClient>,
    options: { pollInterval?: number; defaultTimeout?: number } = {}
  ) {
    this.prefix = config.prefix ?? 'tachikoma:collab';
    this.agentId = agentId;
    this.pollInterval = options.pollInterval ?? 100;
    this.defaultTimeout = options.defaultTimeout ?? 30000;
  }

  /**
   * 初始化连接
   */
  private async ensureConnected(): Promise<IRedisStreamClient> {
    if (!this.client) {
      this.client = await this.createClient(this.config.url);
    }
    return this.client;
  }

  /**
   * 获取 Agent 收件箱 Stream 键名
   */
  private getInboxKey(agentId: string): string {
    return `${this.prefix}:inbox:${agentId}`;
  }

  /**
   * 获取响应键名
   */
  private getResponseKey(requestId: string): string {
    return `${this.prefix}:response:${requestId}`;
  }

  /**
   * 发送请求并等待响应
   */
  async request(
    req: Omit<CollaborationRequest, 'id' | 'createdAt'>
  ): Promise<CollaborationResponse> {
    const client = await this.ensureConnected();
    const requestId = generateId();
    const request: CollaborationRequest = {
      ...req,
      id: requestId,
      createdAt: Date.now(),
    };

    // 发送到目标 Agent 的收件箱
    await client.xadd(
      this.getInboxKey(req.toAgentId),
      '*',
      'data', JSON.stringify(request)
    );

    // 等待响应
    return new Promise((resolve, reject) => {
      const timeout = req.timeout || this.defaultTimeout;

      const timeoutTimer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      this.pendingResponses.set(requestId, { resolve, reject, timeoutTimer });

      // 开始轮询响应
      this.pollForResponse(requestId);
    });
  }

  /**
   * 发送请求不等待响应
   */
  async send(
    req: Omit<CollaborationRequest, 'id' | 'createdAt'>
  ): Promise<void> {
    const client = await this.ensureConnected();
    const requestId = generateId();
    const request: CollaborationRequest = {
      ...req,
      id: requestId,
      createdAt: Date.now(),
    };

    await client.xadd(
      this.getInboxKey(req.toAgentId),
      '*',
      'data', JSON.stringify(request)
    );
  }

  /**
   * 监听请求
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandlers.add(handler);
    this.startPolling();
  }

  /**
   * 移除请求监听
   */
  offRequest(handler: RequestHandler): void {
    this.requestHandlers.delete(handler);
    if (this.requestHandlers.size === 0) {
      this.stopPolling();
    }
  }

  /**
   * 获取待处理请求（按优先级排序）
   */
  async getPendingRequests(): Promise<CollaborationRequest[]> {
    const client = await this.ensureConnected();
    const inboxKey = this.getInboxKey(this.agentId);

    // 读取所有消息
    const entries = await client.xrange(inboxKey, '-', '+', 100);
    const requests: CollaborationRequest[] = [];

    for (const entry of entries) {
      const [, fields] = entry as [string, string[]];
      const dataIndex = fields.indexOf('data');
      if (dataIndex === -1 || dataIndex + 1 >= fields.length) continue;

      try {
        const request = JSON.parse(fields[dataIndex + 1] as string) as CollaborationRequest;

        // 检查是否超时
        if (Date.now() - request.createdAt > request.timeout) {
          continue;
        }

        requests.push(request);
      } catch {
        // Ignore parse errors
      }
    }

    // 按优先级排序（高优先级在前）
    return requests.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * 关闭 Broker
   */
  async close(): Promise<void> {
    this.stopPolling();

    // 清理所有待处理响应
    for (const [, pending] of this.pendingResponses) {
      clearTimeout(pending.timeoutTimer);
      pending.reject(new Error('Broker closed'));
    }
    this.pendingResponses.clear();
    this.requestHandlers.clear();

    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // Ignore
      }
      this.client = null;
    }
  }

  /**
   * 轮询响应
   */
  private pollForResponse(requestId: string): void {
    const checkResponse = async () => {
      const pending = this.pendingResponses.get(requestId);
      if (!pending) return;

      try {
        const client = await this.ensureConnected();
        const data = await client.get(this.getResponseKey(requestId));

        if (data) {
          const response = JSON.parse(data) as CollaborationResponse;
          clearTimeout(pending.timeoutTimer);
          this.pendingResponses.delete(requestId);

          // 清理响应键
          await client.del(this.getResponseKey(requestId));

          pending.resolve(response);
          return;
        }
      } catch {
        // Continue polling
      }

      // 继续轮询
      setTimeout(checkResponse, this.pollInterval);
    };

    checkResponse().catch(() => {});
  }

  /**
   * 启动请求轮询
   */
  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.processIncomingRequests().catch(error => {
        console.error('[RedisMessageBroker] Poll error:', error);
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
   * 处理收到的请求
   */
  private async processIncomingRequests(): Promise<void> {
    if (this.processingRequest) return;
    if (this.requestHandlers.size === 0) return;

    const requests = await this.getPendingRequests();
    if (requests.length === 0) return;

    const request = requests[0];
    if (!request) return;

    this.processingRequest = true;

    try {
      const client = await this.ensureConnected();

      // 调用处理器
      let response: Omit<CollaborationResponse, 'requestId' | 'fromAgentId' | 'respondedAt'> | null = null;

      for (const handler of this.requestHandlers) {
        try {
          response = await handler(request);
          break;
        } catch (error) {
          response = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (response) {
        const fullResponse: CollaborationResponse = {
          ...response,
          requestId: request.id,
          fromAgentId: this.agentId,
          respondedAt: Date.now(),
        };

        // 写入响应（带 TTL）
        await client.set(
          this.getResponseKey(request.id),
          JSON.stringify(fullResponse),
          { EX: 60 }
        );
      }

      // 从收件箱删除已处理的消息
      // 注意：需要找到对应的 message ID
      const inboxKey = this.getInboxKey(this.agentId);
      const entries = await client.xrange(inboxKey, '-', '+', 100);

      for (const entry of entries) {
        const [messageId, fields] = entry as [string, string[]];
        const dataIndex = fields.indexOf('data');
        if (dataIndex === -1 || dataIndex + 1 >= fields.length) continue;

        try {
          const msg = JSON.parse(fields[dataIndex + 1] as string) as CollaborationRequest;
          if (msg.id === request.id) {
            await client.xdel(inboxKey, messageId);
            break;
          }
        } catch {
          // Ignore
        }
      }
    } finally {
      this.processingRequest = false;
    }
  }
}

/**
 * 创建 Redis Message Broker
 */
export function createRedisMessageBroker(
  config: RedisConfig,
  agentId: string,
  createClient: (url: string) => Promise<IRedisStreamClient>,
  options?: { pollInterval?: number; defaultTimeout?: number }
): RedisMessageBroker {
  return new RedisMessageBroker(config, agentId, createClient, options);
}
