/**
 * MCP 工具注册器
 *
 * 自动将 MCP 服务器工具转换为 Tachikoma Tool 接口并注册到 ToolRegistry
 *
 * @module mcp/registrar
 */

import type { Tool, ExecutionContext } from '../types';
import type { ToolResult } from '../tools/types';
import { ToolLayer, ToolPermission, ToolCategory } from '../tools/types';
import type { ToolRegistry } from '../tools/registry';
import type { MCPClientManager, MCPCallOptions } from './client';
import type { MCPToolInfo, MCPToolCallResult } from './types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * MCP 工具注册配置
 */
export interface MCPToolRegistrarConfig {
  /** 工具名前缀（默认 'mcp:'） */
  prefix?: string;
  /** 默认超时（毫秒） */
  defaultTimeout?: number;
  /** 注册时是否跳过已存在的工具 */
  skipExisting?: boolean;
  /** 是否在 ToolResult.meta 中包含原始内容（默认 false） */
  includeRawContent?: boolean;
}

/**
 * 注册结果
 */
export interface RegisterResult {
  /** 成功注册的工具数量 */
  registered: number;
  /** 跳过的工具数量（已存在） */
  skipped: number;
  /** 失败的工具（名称 -> 错误） */
  failed: Map<string, Error>;
  /** 已注册的工具 ID 列表 */
  toolIds: string[];
}

// ============================================================================
// MCPToolRegistrar
// ============================================================================

/**
 * MCP 工具注册器
 *
 * 将 MCP 服务器的工具自动转换并注册到 ToolRegistry
 *
 * @example
 * ```ts
 * const registrar = new MCPToolRegistrar(mcpClient, toolRegistry);
 *
 * // 注册单个服务器的所有工具
 * await registrar.registerServer('github');
 *
 * // 注册所有已连接服务器的工具
 * await registrar.registerAll();
 *
 * // 清理（注销已注册的 MCP 工具）
 * registrar.unregisterAll();
 * ```
 */
export class MCPToolRegistrar {
  private readonly client: MCPClientManager;
  private readonly registry: ToolRegistry;
  private readonly config: Required<MCPToolRegistrarConfig>;
  private readonly registeredTools = new Set<string>();

  constructor(
    client: MCPClientManager,
    registry: ToolRegistry,
    config: MCPToolRegistrarConfig = {}
  ) {
    this.client = client;
    this.registry = registry;
    this.config = {
      prefix: 'mcp:',
      defaultTimeout: 30000,
      skipExisting: true,
      includeRawContent: false,
      ...config,
    };
  }

  /**
   * 注册指定服务器的所有工具
   *
   * @param serverName - 服务器名称
   * @returns 注册结果
   */
  async registerServer(serverName: string): Promise<RegisterResult> {
    const result: RegisterResult = {
      registered: 0,
      skipped: 0,
      failed: new Map(),
      toolIds: [],
    };

    try {
      // 获取服务器工具列表
      const tools = await this.client.listTools(serverName);

      for (const mcpTool of tools) {
        const toolId = this.buildToolId(serverName, mcpTool.name);

        try {
          // 检查是否已存在
          if (this.registry.getByName(toolId)) {
            if (this.config.skipExisting) {
              result.skipped++;
              continue;
            }
            // 如果不跳过，先注销
            this.registry.unregister(toolId);
          }

          // 转换并注册
          const tool = this.convertToTool(serverName, mcpTool);
          this.registry.register(tool);
          this.registeredTools.add(toolId);
          result.toolIds.push(toolId);
          result.registered++;
        } catch (error) {
          result.failed.set(
            toolId,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    } catch (error) {
      result.failed.set(
        serverName,
        error instanceof Error ? error : new Error(String(error))
      );
    }

    return result;
  }

  /**
   * 注册所有已连接服务器的工具
   *
   * @returns 注册结果（合并所有服务器）
   */
  async registerAll(): Promise<RegisterResult> {
    const result: RegisterResult = {
      registered: 0,
      skipped: 0,
      failed: new Map(),
      toolIds: [],
    };

    const connectedServers = this.client.getConnectedServers();

    for (const serverName of connectedServers) {
      // eslint-disable-next-line no-await-in-loop -- Sequential server registration
      const serverResult = await this.registerServer(serverName);
      result.registered += serverResult.registered;
      result.skipped += serverResult.skipped;
      result.toolIds.push(...serverResult.toolIds);
      for (const [key, value] of serverResult.failed) {
        result.failed.set(key, value);
      }
    }

    return result;
  }

  /**
   * 注销所有已注册的 MCP 工具
   */
  unregisterAll(): void {
    for (const toolId of this.registeredTools) {
      this.registry.unregister(toolId);
    }
    this.registeredTools.clear();
  }

  /**
   * 注销指定服务器的工具
   */
  unregisterServer(serverName: string): number {
    const prefix = `${this.config.prefix}${serverName}:`;
    let count = 0;

    for (const toolId of this.registeredTools) {
      if (toolId.startsWith(prefix)) {
        this.registry.unregister(toolId);
        this.registeredTools.delete(toolId);
        count++;
      }
    }

    return count;
  }

  /**
   * 获取已注册的工具 ID 列表
   */
  getRegisteredToolIds(): string[] {
    return Array.from(this.registeredTools);
  }

  /**
   * 构建工具 ID
   */
  private buildToolId(serverName: string, toolName: string): string {
    return `${this.config.prefix}${serverName}:${toolName}`;
  }

  /**
   * 将 MCP 工具转换为 Tachikoma Tool
   */
  private convertToTool(serverName: string, mcpTool: MCPToolInfo): Tool {
    const toolId = this.buildToolId(serverName, mcpTool.name);
    const client = this.client;
    const timeout = this.config.defaultTimeout;
    const includeRaw = this.config.includeRawContent;

    const tool: Tool = {
      name: toolId,
      title: mcpTool.name,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      category: ToolCategory.MCP,
      layer: ToolLayer.CodeExecution,
      permissions: [ToolPermission.NetworkRead],
      inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
      annotations: {
        priority: 0.5, // MCP tools have medium priority
      },
      execute: async (
        input: unknown,
        _context: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          const options: MCPCallOptions = { timeout };
          const result: MCPToolCallResult = await client.callTool(
            serverName,
            mcpTool.name,
            input as Record<string, unknown>,
            options
          );

          // 转换 MCP 结果为 ToolResult
          if (result.isError) {
            const errorText = result.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
            const errResult: ToolResult = {
              success: false,
              error: errorText || 'MCP tool call failed',
            };
            // 包含原始内容（如果配置启用）
            if (includeRaw && result.content.length > 0) {
              errResult.meta = { rawContent: result.content };
            }
            return errResult;
          }

          // 提取文本内容
          const textContent = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');

          // 尝试解析 JSON
          let data: unknown = textContent;
          try {
            data = JSON.parse(textContent);
          } catch {
            // 保持原始文本
          }

          const successResult: ToolResult = {
            success: true,
            data,
          };

          // 包含原始内容（图片、资源等非文本类型）
          if (includeRaw && result.content.length > 0) {
            successResult.meta = { rawContent: result.content };
          }

          return successResult;
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };

    return tool;
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 MCP 工具注册器
 */
export function createMCPToolRegistrar(
  client: MCPClientManager,
  registry: ToolRegistry,
  config?: MCPToolRegistrarConfig
): MCPToolRegistrar {
  return new MCPToolRegistrar(client, registry, config);
}
