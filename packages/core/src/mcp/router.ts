/**
 * MCP 模式路由器
 *
 * 为 Worker 提供 Traditional/CodeExecution 双模式路由
 * 自动根据配置选择调用模式，集成 IPC 处理和日志过滤
 *
 * @module mcp/router
 */

import type { MCPServerConfig, MCPCallMode, MCPToolInfo, MCPToolCallResult } from './types';
import type { MCPClientManager, MCPCallOptions } from './client';
import {
  MCP_IPC_PREFIX,
  decodeMCPIPCMessage,
  createMCPIPCHandler,
  encodeMCPIPCMessage,
  type MCPIPCRequest,
  type MCPIPCRequestHandler,
} from './sandbox-ipc';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * MCP 路由配置
 */
export interface MCPRouterConfig {
  /** 默认调用模式 */
  defaultMode: MCPCallMode;
  /** 每个服务器的模式覆盖 */
  serverModes?: Record<string, MCPCallMode>;
  /** 是否启用日志 */
  enableLogging?: boolean;
}

/**
 * 路由决策结果
 */
export interface RouteDecision {
  /** 使用的调用模式 */
  mode: MCPCallMode;
  /** 决策原因 */
  reason: string;
}

/**
 * IPC 行处理结果
 */
export interface IPCLineResult {
  /** 是否为 IPC 消息 */
  isIPC: boolean;
  /** 如果是 IPC 消息，是否已处理 */
  handled: boolean;
  /** 处理后的响应（如果有） */
  response?: string;
}

// ============================================================================
// MCPModeRouter
// ============================================================================

/**
 * MCP 模式路由器
 *
 * @example
 * ```ts
 * const router = new MCPModeRouter(mcpClient, {
 *   defaultMode: 'CodeExecution',
 *   serverModes: { 'filesystem': 'Traditional' }
 * });
 *
 * // 自动选择模式执行
 * const result = await router.callTool('github', 'list_repos', {});
 *
 * // 处理子进程输出（过滤 IPC 行）
 * const lineResult = await router.processLine(stdout, sendToStdin);
 * if (!lineResult.isIPC) {
 *   console.log(stdout); // 非 IPC 行，正常输出
 * }
 * ```
 */
export class MCPModeRouter {
  private readonly client: MCPClientManager;
  private readonly config: MCPRouterConfig;
  private readonly ipcHandler: MCPIPCRequestHandler;

  constructor(client: MCPClientManager, config: Partial<MCPRouterConfig> = {}) {
    this.client = client;
    this.config = {
      defaultMode: 'traditional',
      enableLogging: true,
      ...config,
    };

    // 创建 IPC 处理器
    this.ipcHandler = createMCPIPCHandler(this.client);
  }

  /**
   * 根据服务器名确定调用模式
   */
  decideMode(serverName: string, serverConfig?: MCPServerConfig): RouteDecision {
    // 1. 检查服务器配置覆盖
    if (this.config.serverModes?.[serverName]) {
      return {
        mode: this.config.serverModes[serverName],
        reason: `Server-specific override for ${serverName}`,
      };
    }

    // 2. 检查服务器自身配置
    if (serverConfig?.mode) {
      return {
        mode: serverConfig.mode,
        reason: `Server config: ${serverConfig.mode}`,
      };
    }

    // 3. 使用默认模式
    return {
      mode: this.config.defaultMode,
      reason: `Default mode: ${this.config.defaultMode}`,
    };
  }

  /**
   * 调用 MCP 工具（自动选择模式）
   *
   * 模式分流说明：
   * - `traditional`: 通过 MCPClientManager 直接调用 MCP 服务器
   * - `code-execution`: 理论上应在沙盒中执行生成的代码包装器
   *   （当前实现：回退到 traditional 模式，因为沙盒执行需要 Worker 集成）
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
    options?: MCPCallOptions
  ): Promise<MCPToolCallResult> {
    const decision = this.decideMode(serverName);

    if (this.config.enableLogging) {
      console.debug(
        `[MCPModeRouter] Calling ${serverName}.${toolName} via ${decision.mode} (${decision.reason})`
      );
    }

    // 模式分流
    if (decision.mode === 'code-execution') {
      // code-execution 模式当前回退到 traditional
      // 真正的代码执行需要在沙盒环境中进行，通过 IPC 桥接
      // 这里先记录日志并回退，避免误导用户
      if (this.config.enableLogging) {
        console.debug(
          `[MCPModeRouter] Note: code-execution mode falling back to traditional ` +
            `(sandbox integration pending via IPC bridge)`
        );
      }
      // 回退到 traditional 调用
      return this.client.callTool(serverName, toolName, args, options);
    }

    // traditional 模式：直接通过 MCP 客户端调用
    return this.client.callTool(serverName, toolName, args, options);
  }

  /**
   * 列出服务器工具
   */
  async listTools(serverName: string): Promise<MCPToolInfo[]> {
    return this.client.listTools(serverName);
  }

  /**
   * 处理子进程输出行
   *
   * 检测并处理 MCP IPC 消息，返回处理结果
   *
   * @param line - 子进程输出的一行
   * @param sendToStdin - 发送响应到子进程 stdin 的函数
   * @returns IPC 处理结果
   */
  async processLine(
    line: string,
    sendToStdin: (data: string) => void
  ): Promise<IPCLineResult> {
    // 检查是否为 IPC 消息
    if (!line.startsWith(MCP_IPC_PREFIX)) {
      return { isIPC: false, handled: false };
    }

    const message = decodeMCPIPCMessage(line);
    if (!message) {
      return { isIPC: true, handled: false };
    }

    // 只处理请求类型
    if (message.type !== 'mcp_call') {
      return { isIPC: true, handled: false };
    }

    // 处理请求
    const request = message as MCPIPCRequest;
    const response = await this.ipcHandler(request);
    const responseStr = encodeMCPIPCMessage(response);

    // 发送响应
    sendToStdin(responseStr + '\n');

    return {
      isIPC: true,
      handled: true,
      response: responseStr,
    };
  }

  /**
   * 判断是否为 IPC 行（快速检查，不解析）
   */
  isIPCLine(line: string): boolean {
    return line.startsWith(MCP_IPC_PREFIX);
  }

  /**
   * 过滤输出行（移除 IPC 行）
   *
   * @param lines - 多行输出
   * @returns 过滤后的非 IPC 行
   */
  filterIPCLines(lines: string[]): string[] {
    return lines.filter((line) => !this.isIPCLine(line));
  }

  /**
   * 获取 IPC 前缀（供外部使用）
   */
  getIPCPrefix(): string {
    return MCP_IPC_PREFIX;
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 MCP 模式路由器
 */
export function createMCPModeRouter(
  client: MCPClientManager,
  config?: Partial<MCPRouterConfig>
): MCPModeRouter {
  return new MCPModeRouter(client, config);
}

/**
 * 检查输出行是否为 IPC 消息（静态方法）
 */
export function isMCPIPCLine(line: string): boolean {
  return line.startsWith(MCP_IPC_PREFIX);
}

/**
 * 过滤输出中的 IPC 行（静态方法）
 */
export function filterMCPIPCLines(output: string): string {
  return output
    .split('\n')
    .filter((line) => !isMCPIPCLine(line))
    .join('\n');
}
