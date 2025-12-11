/**
 * MCP Tool 公共类型定义
 *
 * 用于 servers/ 目录下的工具包装器和代码执行模式
 *
 * @module servers/_types
 */

// ============================================================================
// 工具调用相关类型
// ============================================================================

/**
 * MCP 工具调用结果
 */
export interface MCPToolResult<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 原始 MCP 内容（可选） */
  rawContent?: MCPContentItem[];
}

/**
 * MCP 内容项
 */
export interface MCPContentItem {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

/**
 * 工具调用选项
 */
export interface ToolCallOptions {
  /** 调用超时（毫秒） */
  timeout?: number;
  /** 是否跳过故障摘除检查 */
  skipCircuitBreaker?: boolean;
  /** 是否返回原始 MCP 内容 */
  includeRawContent?: boolean;
}

// ============================================================================
// 工具定义相关类型
// ============================================================================

/**
 * 工具参数 Schema（简化版 JSON Schema）
 */
export interface ToolParamSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  items?: ToolParamSchema;
  properties?: Record<string, ToolParamSchema>;
}

/**
 * 工具定义元数据
 */
export interface ToolMetadata {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 所属服务器 */
  serverName: string;
  /** 参数 Schema */
  inputSchema: {
    type: 'object';
    properties?: Record<string, ToolParamSchema>;
    required?: string[];
  };
}

// ============================================================================
// 服务器代理类型
// ============================================================================

/**
 * 服务器代理配置
 */
export interface ServerProxyConfig {
  /** 服务器名称 */
  name: string;
  /** 服务器描述 */
  description?: string;
  /** 可用工具列表 */
  tools: string[];
}

/**
 * 通用工具函数类型
 */
export type ToolFunction<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  options?: ToolCallOptions
) => Promise<MCPToolResult<TOutput>>;

// ============================================================================
// 工具包装器辅助类型
// ============================================================================

/**
 * 解析 MCP 文本内容
 */
export function parseTextContent(items: MCPContentItem[]): string {
  return items
    .filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text!)
    .join('\n');
}

/**
 * 解析 MCP JSON 内容
 */
export function parseJsonContent<T = unknown>(items: MCPContentItem[]): T | null {
  const text = parseTextContent(items);
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * 创建成功结果
 */
export function successResult<T>(data: T, rawContent?: MCPContentItem[]): MCPToolResult<T> {
  const result: MCPToolResult<T> = {
    success: true,
    data,
  };
  if (rawContent) {
    result.rawContent = rawContent;
  }
  return result;
}

/**
 * 创建错误结果
 */
export function errorResult<T = unknown>(error: string): MCPToolResult<T> {
  return {
    success: false,
    error,
  };
}
