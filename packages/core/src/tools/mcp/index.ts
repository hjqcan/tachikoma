/**
 * MCP Layer 3 集成基础
 *
 * 提供与Model Context Protocol (MCP)服务器集成的基础设施
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolPermission, ToolCategory } from '../types';

// ============================================================================
// MCP 类型定义
// ============================================================================

/**
 * MCP工具定义（符合MCP协议规范）
 */
export interface MCPToolDefinition {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 输入Schema (JSON Schema) */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP工具调用请求
 */
export interface MCPToolCallRequest {
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * MCP工具调用结果
 */
export interface MCPToolCallResult {
  /** 是否成功 */
  isError?: boolean;
  /** 结果内容 */
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}

/**
 * MCP服务器信息
 */
export interface MCPServerInfo {
  /** 服务器名称 */
  name: string;
  /** 版本 */
  version: string;
  /** 协议版本 */
  protocolVersion: string;
  /** 能力 */
  capabilities: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
}

// ============================================================================
// MCP Client 接口
// ============================================================================

/**
 * MCP客户端接口
 *
 * 定义与MCP服务器通信的抽象接口
 */
export interface IMCPClient {
  /** 连接到MCP服务器 */
  connect(): Promise<void>;
  
  /** 断开连接 */
  disconnect(): Promise<void>;
  
  /** 获取服务器信息 */
  getServerInfo(): Promise<MCPServerInfo>;
  
  /** 列出可用工具 */
  listTools(): Promise<MCPToolDefinition[]>;
  
  /** 调用工具 */
  callTool(request: MCPToolCallRequest): Promise<MCPToolCallResult>;
  
  /** 是否已连接 */
  isConnected(): boolean;
}

// ============================================================================
// MCP Tool Adapter
// ============================================================================

/**
 * MCP工具适配器配置
 */
export interface MCPToolAdapterConfig {
  /** MCP服务器URL或命令 */
  server: string;
  /** 连接超时 */
  timeout?: number;
  /** 自动重连 */
  autoReconnect?: boolean;
}

/**
 * MCP工具适配器
 *
 * 将MCP工具转换为Tachikoma Tool接口
 */
export class MCPToolAdapter {
  private client: IMCPClient | null = null;
  private tools: Map<string, Tool> = new Map();

  constructor(_config: MCPToolAdapterConfig) {
    // Config stored for future use when implementing actual MCP client
  }

  /**
   * 初始化连接
   */
  async initialize(client: IMCPClient): Promise<void> {
    this.client = client;
    await this.client.connect();
    await this.loadTools();
  }

  /**
   * 加载MCP工具并转换为Tachikoma Tool
   */
  private async loadTools(): Promise<void> {
    if (!this.client) return;

    const mcpTools = await this.client.listTools();

    for (const mcpTool of mcpTools) {
      const tool = this.convertMCPTool(mcpTool);
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * 将MCP工具转换为Tachikoma Tool
   */
  private convertMCPTool(mcpTool: MCPToolDefinition): Tool {
    const adapter = this;

    return {
      name: `mcp_${mcpTool.name}`,
      title: mcpTool.name,
      description: mcpTool.description,
      layer: ToolLayer.CodeExecution,
      category: ToolCategory.MCP,
      permissions: [ToolPermission.NetworkRead],
      
      inputSchema: mcpTool.inputSchema,
      outputSchema: {
        type: 'object',
        properties: {
          content: { type: 'array' },
          isError: { type: 'boolean' },
        },
      },
      
      annotations: {
        idempotent: false,
        cacheable: false,
        estimatedDuration: 5000,
      },

      async execute(
        input: unknown,
        _context: ExecutionContext
      ): Promise<ToolResult> {
        if (!adapter.client?.isConnected()) {
          return {
            success: false,
            error: 'MCP client not connected',
          };
        }

        try {
          const result = await adapter.client.callTool({
            name: mcpTool.name,
            arguments: input as Record<string, unknown>,
          });

          if (result.isError) {
            return {
              success: false,
              error: result.content[0]?.text || 'MCP tool execution failed',
            };
          }

          return {
            success: true,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown MCP error',
          };
        }
      },
    };
  }

  /**
   * 获取所有转换后的工具
   */
  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取指定工具
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    this.tools.clear();
  }
}

// ============================================================================
// Tool Router
// ============================================================================

/**
 * 工具路由器
 *
 * 统一管理本地工具和MCP工具的路由
 */
export class ToolRouter {
  private localTools: Map<string, Tool> = new Map();
  private mcpAdapters: Map<string, MCPToolAdapter> = new Map();

  /**
   * 注册本地工具
   */
  registerLocalTool(tool: Tool): void {
    this.localTools.set(tool.name, tool);
  }

  /**
   * 注册MCP适配器
   */
  registerMCPAdapter(name: string, adapter: MCPToolAdapter): void {
    this.mcpAdapters.set(name, adapter);
  }

  /**
   * 获取工具（本地优先）
   */
  getTool(name: string): Tool | undefined {
    // 先查找本地工具
    const localTool = this.localTools.get(name);
    if (localTool) return localTool;

    // 再查找MCP工具
    for (const adapter of this.mcpAdapters.values()) {
      const mcpTool = adapter.getTool(name);
      if (mcpTool) return mcpTool;
    }

    return undefined;
  }

  /**
   * 列出所有工具
   */
  listTools(): Tool[] {
    const tools: Tool[] = [...this.localTools.values()];

    for (const adapter of this.mcpAdapters.values()) {
      tools.push(...adapter.getTools());
    }

    return tools;
  }

  /**
   * 执行工具
   */
  async execute(
    toolName: string,
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const tool = this.getTool(toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}`,
      };
    }

    return tool.execute(input, context) as Promise<ToolResult>;
  }

  /**
   * 关闭所有连接
   */
  async close(): Promise<void> {
    for (const adapter of this.mcpAdapters.values()) {
      await adapter.close();
    }
    this.mcpAdapters.clear();
  }
}
