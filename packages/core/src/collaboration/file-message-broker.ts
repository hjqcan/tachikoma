/**
 * 文件系统 Message Broker 实现
 *
 * 基于共享文件系统的 Request-Response 消息传递
 * 使用 `.tachikoma/collaboration/inbox/{agentId}/` 目录存储请求
 *
 * 特性：
 * - 按优先级排序的请求队列
 * - 高优先级可插队但不打断当前执行
 * - 超时自动清理
 *
 * @module collaboration/file-message-broker
 */

import { join } from 'node:path';
import type {
  CollaborationRequest,
  CollaborationResponse,
  RequestHandler,
  IMessageBroker,
} from './types';
import {
  atomicWriteJson,
  readJsonFile,
  listDir,
  fileExists,
  safeDeleteFile,
  ensureDir,
  generateTimestampId,
} from '../orchestrator/session/utils';

/**
 * 文件系统 Message Broker
 */
export class FileMessageBroker implements IMessageBroker {
  private readonly inboxDir: string;
  private readonly agentId: string;
  private readonly requestHandlers = new Set<RequestHandler>();
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
    rootDir: string,
    agentId: string,
    options: { pollInterval?: number; defaultTimeout?: number } = {}
  ) {
    this.inboxDir = join(rootDir, 'collaboration', 'inbox');
    this.agentId = agentId;
    this.pollInterval = options.pollInterval ?? 500;
    this.defaultTimeout = options.defaultTimeout ?? 30000;
  }

  /**
   * 获取 Agent 收件箱目录
   */
  private getAgentInboxDir(agentId: string): string {
    return join(this.inboxDir, agentId);
  }

  /**
   * 获取请求文件路径
   */
  private getRequestPath(toAgentId: string, requestId: string): string {
    return join(this.getAgentInboxDir(toAgentId), `req-${requestId}.json`);
  }

  /**
   * 获取响应文件路径
   */
  private getResponsePath(toAgentId: string, requestId: string): string {
    return join(this.getAgentInboxDir(toAgentId), `res-${requestId}.json`);
  }

  /**
   * 发送请求并等待响应
   */
  async request(
    req: Omit<CollaborationRequest, 'id' | 'createdAt'>
  ): Promise<CollaborationResponse> {
    const requestId = generateTimestampId('req');
    const request: CollaborationRequest = {
      ...req,
      id: requestId,
      createdAt: Date.now(),
    };

    // 确保目标收件箱存在
    await ensureDir(this.getAgentInboxDir(req.toAgentId));

    // 写入请求
    await atomicWriteJson(
      this.getRequestPath(req.toAgentId, requestId),
      request
    );

    // 等待响应
    return new Promise((resolve, reject) => {
      const timeout = req.timeout || this.defaultTimeout;

      const timeoutTimer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        // 清理请求文件
        safeDeleteFile(this.getRequestPath(req.toAgentId, requestId)).catch(() => {});
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      this.pendingResponses.set(requestId, { resolve, reject, timeoutTimer });

      // 开始轮询响应
      this.pollForResponse(req.toAgentId, requestId);
    });
  }

  /**
   * 发送请求不等待响应
   */
  async send(
    req: Omit<CollaborationRequest, 'id' | 'createdAt'>
  ): Promise<void> {
    const requestId = generateTimestampId('req');
    const request: CollaborationRequest = {
      ...req,
      id: requestId,
      createdAt: Date.now(),
    };

    await ensureDir(this.getAgentInboxDir(req.toAgentId));
    await atomicWriteJson(
      this.getRequestPath(req.toAgentId, requestId),
      request
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
    const myInbox = this.getAgentInboxDir(this.agentId);
    const files = await listDir(myInbox).catch(() => []);
    const requests: CollaborationRequest[] = [];

    for (const file of files) {
      if (!file.startsWith('req-') || !file.endsWith('.json')) continue;

      const request = await readJsonFile<CollaborationRequest>(
        join(myInbox, file)
      );
      if (request) {
        // 检查是否超时
        if (Date.now() - request.createdAt > request.timeout) {
          // 删除过期请求
          await safeDeleteFile(join(myInbox, file));
          continue;
        }
        requests.push(request);
      }
    }

    // 按优先级排序（高优先级在前），优先级相同按时间排序
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
  }

  /**
   * 轮询响应
   * 
   * 响应方会将响应写入发送方（this.agentId）的 inbox，
   * 所以这里应该轮询自己的 inbox 而不是目标的 inbox
   */
  private pollForResponse(targetAgentId: string, requestId: string): void {
    const checkResponse = async () => {
      const pending = this.pendingResponses.get(requestId);
      if (!pending) return;

      // 响应在自己的 inbox 中，因为响应方写入到 request.fromAgentId 的 inbox
      const responsePath = this.getResponsePath(this.agentId, requestId);
      if (fileExists(responsePath)) {
        const response = await readJsonFile<CollaborationResponse>(responsePath);
        if (response) {
          clearTimeout(pending.timeoutTimer);
          this.pendingResponses.delete(requestId);

          // 清理响应文件
          await safeDeleteFile(responsePath);
          // 清理请求文件（在目标的 inbox 中）
          await safeDeleteFile(this.getRequestPath(targetAgentId, requestId));

          pending.resolve(response);
          return;
        }
      }

      // 继续轮询
      setTimeout(checkResponse, this.pollInterval);
    };

    checkResponse().catch(error => {
      const pending = this.pendingResponses.get(requestId);
      if (pending) {
        clearTimeout(pending.timeoutTimer);
        this.pendingResponses.delete(requestId);
        pending.reject(error);
      }
    });
  }

  /**
   * 启动请求轮询
   */
  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.processIncomingRequests().catch(error => {
        console.error('[FileMessageBroker] Poll error:', error);
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

    // 处理最高优先级的请求
    const request = requests[0];
    if (!request) return;

    this.processingRequest = true;

    try {
      // 调用所有处理器（取第一个成功的响应）
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

        // 写入响应到发送方的收件箱
        await ensureDir(this.getAgentInboxDir(request.fromAgentId));
        await atomicWriteJson(
          this.getResponsePath(request.fromAgentId, request.id),
          fullResponse
        );
      }

      // 删除已处理的请求
      await safeDeleteFile(
        join(this.getAgentInboxDir(this.agentId), `req-${request.id}.json`)
      );
    } finally {
      this.processingRequest = false;
    }
  }
}

/**
 * 创建文件系统 Message Broker
 */
export function createFileMessageBroker(
  rootDir: string,
  agentId: string,
  options?: { pollInterval?: number; defaultTimeout?: number }
): FileMessageBroker {
  return new FileMessageBroker(rootDir, agentId, options);
}
