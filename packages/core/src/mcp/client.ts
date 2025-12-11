/**
 * MCP 客户端管理器
 *
 * 基于 @modelcontextprotocol/sdk 实现，支持 STDIO 和 HTTP 双传输模式
 *
 * 功能：
 * - 连接管理（建立/断开/重连）
 * - 工具列表获取与缓存
 * - 工具调用（带超时、重试、故障摘除）
 * - 指标收集
 *
 * @module mcp/client
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {
  MCPServerConfig,
  MCPToolInfo,
  MCPToolCallResult,
  MCPClientState,
  MCPConnectionStatus,
  MCPCallMetrics,
  MCPConfig,
  MCPContentItem,
} from './types';
import {
  isStdioConfig,
  isHttpConfig,
  generateTachikomaToolName,
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_CALL_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY,
  DEFAULT_TOOL_CACHE_TTL,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_RECOVERY_TIME,
  DEFAULT_CALL_MODE,
} from './types';

// ============================================================================
// 类型定义
// ============================================================================

/** Transport 类型（使用 any 绕过 SDK 类型不兼容问题） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTransport = any;

/**
 * MCP 客户端实例
 */
interface MCPClientInstance {
  /** SDK Client 实例 */
  client: Client;
  /** Transport 实例 */
  transport: AnyTransport;
  /** 服务器配置 */
  config: MCPServerConfig;
  /** 客户端状态 */
  state: MCPClientState;
  /** 工具缓存 */
  toolsCache?: {
    tools: MCPToolInfo[];
    cachedAt: number;
  };
}

/**
 * 调用选项
 */
export interface MCPCallOptions {
  /** 调用超时（毫秒） */
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 是否跳过故障摘除检查 */
  skipCircuitBreaker?: boolean;
}

// ============================================================================
// MCPClientManager
// ============================================================================

/**
 * MCP 客户端管理器
 *
 * 管理多个 MCP 服务器的连接，提供工具列表获取和调用能力
 *
 * @example
 * ```ts
 * const manager = new MCPClientManager();
 *
 * // 连接服务器
 * await manager.connect({
 *   name: 'filesystem',
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
 * });
 *
 * // 列出工具
 * const tools = await manager.listTools('filesystem');
 *
 * // 调用工具
 * const result = await manager.callTool('filesystem', 'read_file', {
 *   path: '/workspace/README.md',
 * });
 *
 * // 断开连接
 * await manager.disconnect('filesystem');
 * ```
 */
export class MCPClientManager {
  /** 客户端实例映射 */
  private clients = new Map<string, MCPClientInstance>();

  /** 全局配置 */
  private globalConfig: Partial<MCPConfig>;

  /** 指标回调 */
  private metricsCallback?: (metrics: MCPCallMetrics) => void;

  constructor(config: Partial<MCPConfig> = {}) {
    this.globalConfig = config;
  }

  // ==========================================================================
  // 连接管理
  // ==========================================================================

  /**
   * 连接到 MCP 服务器
   *
   * @param serverConfig - 服务器配置
   * @throws 连接失败时抛出错误
   */
  async connect(serverConfig: MCPServerConfig): Promise<void> {
    const { name } = serverConfig;

    // 检查是否已连接
    const existing = this.clients.get(name);
    if (existing) {
      if (existing.state.status === 'connected') {
        return; // 已连接，直接返回
      }
      // 断开旧连接
      await this.disconnect(name);
    }

    // 初始化状态
    const state: MCPClientState = {
      serverName: name,
      status: 'connecting',
      consecutiveFailures: 0,
      lastActivityAt: Date.now(),
    };

    try {
      // 创建 Transport
      const transport = this.createTransport(serverConfig);

      // 创建 Client
      const client = new Client({
        name: 'tachikoma',
        version: '1.0.0',
      });

      // 连接
      const timeout = serverConfig.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
      await this.withTimeout(client.connect(transport), timeout, 'Connection timeout');

      // 更新状态
      state.status = 'connected';
      state.lastActivityAt = Date.now();

      // 获取服务器信息（可选）
      try {
        const serverInfo = client.getServerVersion();
        if (serverInfo) {
          state.serverInfo = {
            name: serverInfo.name,
            version: serverInfo.version,
            protocolVersion: 'unknown', // SDK 版本可能不提供此字段
            capabilities: {
              tools: true, // 假设支持工具
            },
          };
        }
      } catch {
        // 忽略服务器信息获取失败
      }

      // 存储客户端实例
      this.clients.set(name, {
        client,
        transport,
        config: serverConfig,
        state,
      });
    } catch (error) {
      state.status = 'error';
      state.lastError = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to MCP server '${name}': ${state.lastError}`);
    }
  }

  /**
   * 断开 MCP 服务器连接
   *
   * @param serverName - 服务器名称
   */
  async disconnect(serverName: string): Promise<void> {
    const instance = this.clients.get(serverName);
    if (!instance) {
      return; // 不存在，直接返回
    }

    try {
      await instance.client.close();
    } catch {
      // 忽略关闭错误
    }

    try {
      await instance.transport.close();
    } catch {
      // 忽略关闭错误
    }

    this.clients.delete(serverName);
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.clients.keys());
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  /**
   * 获取连接状态
   *
   * @param serverName - 服务器名称
   * @returns 连接状态，不存在返回 undefined
   */
  getConnectionStatus(serverName: string): MCPConnectionStatus | undefined {
    return this.clients.get(serverName)?.state.status;
  }

  /**
   * 获取客户端状态
   *
   * @param serverName - 服务器名称
   * @returns 客户端状态，不存在返回 undefined
   */
  getClientState(serverName: string): MCPClientState | undefined {
    return this.clients.get(serverName)?.state;
  }

  /**
   * 检查是否已连接
   *
   * @param serverName - 服务器名称
   */
  isConnected(serverName: string): boolean {
    return this.clients.get(serverName)?.state.status === 'connected';
  }

  // ==========================================================================
  // 工具操作
  // ==========================================================================

  /**
   * 列出服务器的可用工具
   *
   * @param serverName - 服务器名称
   * @param forceRefresh - 是否强制刷新缓存
   * @returns 工具列表
   */
  async listTools(serverName: string, forceRefresh = false): Promise<MCPToolInfo[]> {
    const instance = this.clients.get(serverName);
    if (!instance) {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }

    // 检查缓存
    const cacheTTL = this.globalConfig.toolCacheTTL ?? DEFAULT_TOOL_CACHE_TTL;
    if (
      !forceRefresh &&
      instance.toolsCache &&
      Date.now() - instance.toolsCache.cachedAt < cacheTTL
    ) {
      return instance.toolsCache.tools;
    }

    // 获取工具列表
    const result = await instance.client.listTools();

    // 转换为 MCPToolInfo
    const tools: MCPToolInfo[] = result.tools.map((tool) => {
      const info: MCPToolInfo = {
        name: tool.name,
        inputSchema: tool.inputSchema as MCPToolInfo['inputSchema'],
        serverName,
        originalName: tool.name,
        tachikomaName: generateTachikomaToolName(serverName, tool.name),
      };
      // 只在有值时设置可选字段
      if (tool.description) {
        info.description = tool.description;
      }
      if (instance.config.mode) {
        info.mode = instance.config.mode;
      }
      return info;
    });

    // 更新缓存
    instance.toolsCache = {
      tools,
      cachedAt: Date.now(),
    };

    // 更新状态
    instance.state.tools = tools;

    return tools;
  }

  /**
   * 调用工具
   *
   * @param serverName - 服务器名称
   * @param toolName - 工具名称
   * @param args - 调用参数
   * @param options - 调用选项
   * @returns 调用结果
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options: MCPCallOptions = {}
  ): Promise<MCPToolCallResult> {
    const instance = this.clients.get(serverName);
    if (!instance) {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }

    // 故障摘除检查
    if (!options.skipCircuitBreaker && this.isCircuitOpen(instance)) {
      throw new Error(
        `MCP server '${serverName}' is temporarily unavailable (circuit breaker open)`
      );
    }

    const timeout = options.timeout ?? instance.config.callTimeout ?? DEFAULT_CALL_TIMEOUT;
    const maxRetries = options.maxRetries ?? instance.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseDelay = instance.config.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY;

    const metrics: MCPCallMetrics = {
      serverName,
      toolName,
      mode: instance.config.mode ?? DEFAULT_CALL_MODE,
      startTime: Date.now(),
      endTime: 0,
      latency: 0,
      success: false,
      retryCount: 0,
    };

    let lastError: Error | undefined;

    // 重试循环
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // 指数退避
        const delay = retryBaseDelay * Math.pow(2, attempt - 1);
        await this.sleep(delay);
        metrics.retryCount = attempt;
      }

      try {
        const result = await this.withTimeout(
          instance.client.callTool({
            name: toolName,
            arguments: args,
          }),
          timeout,
          `Tool call timeout: ${toolName}`
        );

        // 成功
        metrics.endTime = Date.now();
        metrics.latency = metrics.endTime - metrics.startTime;
        metrics.success = true;

        // 重置故障计数
        instance.state.consecutiveFailures = 0;
        instance.state.lastActivityAt = Date.now();

        // 记录指标
        this.recordMetrics(metrics);

        // 解析结果
        const resultObj = result as {
          isError?: boolean;
          content?: {
            type: string;
            text?: string;
            data?: string;
            mimeType?: string;
            resource?: unknown;
          }[];
        };

        const content: MCPContentItem[] = (resultObj.content ?? []).map((item) => {
          if (item.type === 'text') {
            const contentItem: MCPContentItem = { type: 'text' };
            if (item.text !== undefined) {
              contentItem.text = item.text;
            }
            return contentItem;
          }
          if (item.type === 'image') {
            const contentItem: MCPContentItem = { type: 'image' };
            if (item.data !== undefined) {
              contentItem.data = item.data;
            }
            if (item.mimeType !== undefined) {
              contentItem.mimeType = item.mimeType;
            }
            return contentItem;
          }
          if (item.type === 'resource' && item.resource) {
            const contentItem: MCPContentItem = { type: 'resource' };
            contentItem.resource = item.resource as NonNullable<MCPContentItem['resource']>;
            return contentItem;
          }
          return { type: 'text' as const, text: JSON.stringify(item) };
        });

        return {
          isError: resultObj.isError ?? false,
          content,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 更新故障计数和活动时间
        instance.state.consecutiveFailures++;
        instance.state.lastError = lastError.message;
        instance.state.lastActivityAt = Date.now(); // 每次调用都更新，用于 circuit breaker 恢复计时
      }
    }

    // 所有重试都失败 - 更新最后活动时间
    instance.state.lastActivityAt = Date.now();
    metrics.endTime = Date.now();
    metrics.latency = metrics.endTime - metrics.startTime;
    if (lastError) {
      metrics.error = lastError.message;
    }

    // 记录指标
    this.recordMetrics(metrics);

    throw new Error(
      `Failed to call tool '${toolName}' on server '${serverName}' after ${maxRetries + 1} attempts: ${lastError?.message}`
    );
  }

  // ==========================================================================
  // 指标
  // ==========================================================================

  /**
   * 设置指标回调
   *
   * @param callback - 指标回调函数
   */
  setMetricsCallback(callback: (metrics: MCPCallMetrics) => void): void {
    this.metricsCallback = callback;
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 创建 Transport
   */
  private createTransport(config: MCPServerConfig): AnyTransport {
    if (isStdioConfig(config)) {
      // 构建参数对象，只包含有值的字段
      const params: {
        command: string;
        args: string[];
        env?: Record<string, string>;
        cwd?: string;
      } = {
        command: config.command,
        args: config.args ?? [],
      };
      if (config.env) {
        params.env = config.env;
      }
      if (config.cwd) {
        params.cwd = config.cwd;
      }
      return new StdioClientTransport(params);
    }

    if (isHttpConfig(config)) {
      // 构建 HTTP transport 参数
      const url = new URL(config.url);

      // StreamableHTTPClientTransport 第二个参数可选：requestInit
      // 支持传入 headers 和其他 fetch 选项
      if (config.headers && Object.keys(config.headers).length > 0) {
        return new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: config.headers,
          },
        });
      }

      return new StreamableHTTPClientTransport(url);
    }

    throw new Error(
      `Invalid MCP server config for '${config.name}': unsupported transport '${config.transport}'`
    );
  }

  /**
   * 包装 Promise 添加超时（带 timer 清理）
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  /**
   * 检查故障摘除器是否打开
   */
  private isCircuitOpen(instance: MCPClientInstance): boolean {
    const threshold =
      this.globalConfig.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    const recoveryTime =
      this.globalConfig.circuitBreakerRecoveryTime ?? DEFAULT_CIRCUIT_BREAKER_RECOVERY_TIME;

    if (instance.state.consecutiveFailures < threshold) {
      return false;
    }

    // 检查是否超过恢复时间
    const timeSinceLastActivity = Date.now() - instance.state.lastActivityAt;
    if (timeSinceLastActivity > recoveryTime) {
      // 半开状态：允许尝试
      return false;
    }

    return true;
  }

  /**
   * 记录指标
   */
  private recordMetrics(metrics: MCPCallMetrics): void {
    if (this.metricsCallback) {
      this.metricsCallback(metrics);
    }
  }

  /**
   * 休眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // 静态工厂方法
  // ==========================================================================

  /**
   * 从配置创建并连接多个服务器
   *
   * @param config - MCP 配置
   * @returns 已连接的客户端管理器
   */
  static async fromConfig(config: MCPConfig): Promise<MCPClientManager> {
    const manager = new MCPClientManager(config);

    // 连接所有启用的服务器
    const enabledServers = config.servers.filter((s) => s.enabled !== false);

    await Promise.all(
      enabledServers.map(async (serverConfig) => {
        try {
          await manager.connect(serverConfig);
        } catch (error) {
          console.warn(
            `[MCPClientManager] Failed to connect to server '${serverConfig.name}':`,
            error
          );
        }
      })
    );

    return manager;
  }
}

// ============================================================================
// 单例管理
// ============================================================================

let globalClientManager: MCPClientManager | null = null;

/**
 * 获取全局 MCP 客户端管理器
 *
 * @param config - 初始化配置（仅首次调用时使用）
 * @returns 全局客户端管理器实例
 */
export function getMCPClientManager(config?: Partial<MCPConfig>): MCPClientManager {
  if (!globalClientManager) {
    globalClientManager = new MCPClientManager(config);
  }
  return globalClientManager;
}

/**
 * 重置全局客户端管理器（用于测试）
 */
export async function resetMCPClientManager(): Promise<void> {
  if (globalClientManager) {
    await globalClientManager.disconnectAll();
    globalClientManager = null;
  }
}
