/**
 * MCP Tool Bridge
 *
 * 将 Tachikoma Tool 接口转换为 Claude Agent SDK 可使用的 MCP Server 格式
 *
 * @module mcp/tool-bridge
 */

import type { Tool, ExecutionContext } from '../types';
import type { ToolResult } from '../tools/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * MCP Tool 定义（SDK 格式）
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * MCP Server 配置
 */
export interface MCPServerDefinition {
  name: string;
  tools: MCPToolDefinition[];
}

/**
 * Bridge 配置
 */
export interface ToolBridgeConfig {
  /** 服务器名称前缀 */
  serverName?: string;
  /** 是否包含工具元数据 */
  includeMetadata?: boolean;
  /** 工作目录 */
  workDir?: string;
  /** 环境变量 */
  env?: Record<string, string>;
}

// ============================================================================
// ToolToMCPBridge
// ============================================================================

/**
 * Tachikoma Tool → MCP Server 桥接器
 *
 * 将 Tachikoma 的 Tool 接口转换为 Claude Agent SDK 可使用的 MCP Server 格式，
 * 使 ClaudeAgentSDKBackend 能够使用 Tachikoma 定义的工具。
 *
 * @example
 * ```ts
 * const bridge = new ToolToMCPBridge({ serverName: 'tachikoma' });
 * const mcpServers = bridge.convertToMCPServers(tools);
 *
 * // 在 Claude Agent SDK 中使用
 * query({
 *   prompt: task.objective,
 *   options: { mcpServers }
 * });
 * ```
 */
export class ToolToMCPBridge {
  private readonly config: Required<ToolBridgeConfig>;
  private sdkAvailable: boolean | null = null;

  constructor(config: ToolBridgeConfig = {}) {
    this.config = {
      serverName: config.serverName ?? 'tachikoma-tools',
      includeMetadata: config.includeMetadata ?? true,
      workDir: config.workDir ?? process.cwd(),
      env: config.env ?? {},
    };
  }

  /**
   * 检查 Claude Agent SDK 是否可用
   */
  private async checkSDKAvailability(): Promise<boolean> {
    if (this.sdkAvailable !== null) return this.sdkAvailable;
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      this.sdkAvailable = true;
    } catch {
      this.sdkAvailable = false;
    }
    return this.sdkAvailable;
  }

  /**
   * 将 Tachikoma Tools 转换为 MCP Server 配置
   *
   * 使用 Claude Agent SDK 的 createSdkMcpServer() 创建内联 MCP 服务器
   *
   * @param tools - Tachikoma 工具列表
   * @param overrides - 覆盖工作目录/环境变量
   * @returns MCP Server 配置数组（用于 Claude Agent SDK 的 mcpServers 选项）
   */
  async convertToMCPServers(
    tools: Tool[],
    overrides?: Partial<Pick<ToolBridgeConfig, 'workDir' | 'env'>>
  ): Promise<unknown[]> {
    if (!tools || tools.length === 0) {
      return [];
    }

    // 检查 SDK 是否可用
    const sdkAvailable = await this.checkSDKAvailability();
    if (!sdkAvailable) {
      console.warn(
        '[ToolToMCPBridge] Claude Agent SDK not available. ' +
          `${tools.length} Tachikoma tools will NOT be bridged.`
      );
      return [];
    }

    try {
      // 动态导入 SDK
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const { createSdkMcpServer, tool } = sdk;

      // 确保函数存在
      if (typeof createSdkMcpServer !== 'function' || typeof tool !== 'function') {
        console.warn(
          '[ToolToMCPBridge] createSdkMcpServer or tool function not found in SDK. ' +
            'SDK version may be incompatible.'
        );
        return [];
      }

      // 创建 MCP 工具定义
      const context = this.buildContext(overrides);

      const mcpTools = tools.map((t) => this.createMCPTool(t, tool, context));

      // 创建 MCP Server
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = createSdkMcpServer({
        name: this.config.serverName,
        tools: mcpTools as any,
      });

      console.debug(
        `[ToolToMCPBridge] Bridged ${tools.length} tools to MCP server '${this.config.serverName}'`
      );

      return [server];
    } catch (error) {
      console.error(
        '[ToolToMCPBridge] Failed to create MCP server:',
        error instanceof Error ? error.message : error
      );
      return [];
    }
  }

  /**
   * 将单个 Tachikoma Tool 转换为 MCP Tool
   */
  private createMCPTool(
    tachikoma: Tool,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolFactory: any,
    context: ExecutionContext
  ): unknown {
    // 使用 SDK 的 tool() 函数创建 MCP Tool
    return toolFactory(
      tachikoma.name,
      tachikoma.description,
      tachikoma.inputSchema ?? { type: 'object', properties: {} },
      async (args: Record<string, unknown>): Promise<string> => {
        try {
          const result = await tachikoma.execute(args, context) as ToolResult;

          if (result.success) {
            // 成功：返回 JSON 字符串
            return typeof result.data === 'string'
              ? result.data
              : JSON.stringify(result.data, null, 2);
          } else {
            // 失败：返回错误信息
            return `Error: ${result.error ?? 'Unknown error'}`;
          }
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    );
  }

  /**
   * 构建执行上下文
   */
  private buildContext(
    overrides?: Partial<Pick<ToolBridgeConfig, 'workDir' | 'env'>>
  ): ExecutionContext {
    const workDir = overrides?.workDir ?? this.config.workDir;
    const env = { ...this.config.env, ...(overrides?.env ?? {}) };

    return {
      taskId: 'mcp-bridge',
      agentId: 'mcp-bridge',
      traceId: `bridge-${Date.now()}`,
      workDir,
      env,
    };
  }

  /**
   * 获取工具定义（不创建 MCP Server，仅返回定义）
   *
   * 用于调试或日志记录
   */
  getToolDefinitions(tools: Tool[]): MCPServerDefinition {
    return {
      name: this.config.serverName,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        handler: async () => {
          /* placeholder */
        },
      })),
    };
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 MCP Tool Bridge
 */
export function createToolBridge(config?: ToolBridgeConfig): ToolToMCPBridge {
  return new ToolToMCPBridge(config);
}

/**
 * 快速转换工具为 MCP Servers
 *
 * @param tools - Tachikoma 工具列表
 * @param config - 可选配置
 * @returns MCP Server 配置数组
 */
export async function bridgeToolsToMCP(
  tools: Tool[],
  config?: ToolBridgeConfig
): Promise<unknown[]> {
  const bridge = new ToolToMCPBridge(config);
  return bridge.convertToMCPServers(tools);
}
