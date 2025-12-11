/**
 * MCP (Model Context Protocol) 类型定义
 *
 * 支持双模式架构：
 * - Traditional: 传统 MCP 工具调用（callMCPTool）
 * - CodeExecution: 代码执行模式（import servers/*.ts）
 *
 * @module mcp/types
 */

// ============================================================================
// 传输模式与调用模式
// ============================================================================

/**
 * MCP 服务器传输模式
 *
 * - `stdio`: 通过标准输入/输出与子进程通信（本地服务器）
 * - `http`: 通过 HTTP/SSE 与远程服务器通信
 */
export type MCPTransport = 'stdio' | 'http';

/**
 * MCP 工具调用模式
 *
 * - `traditional`: 传统 MCP 工具调用，通过 SDK 直接调用
 *   - 优点：简单，兼容性好
 *   - 缺点：每次调用结果都经过 LLM 上下文
 *
 * - `code-execution`: 代码执行模式，Agent 生成代码调用 MCP
 *   - 优点：节省 80%+ Token，可组合，可测试
 *   - 缺点：需要沙盒环境，实现复杂度高
 */
export type MCPCallMode = 'traditional' | 'code-execution';

// ============================================================================
// 连接参数
// ============================================================================

/**
 * STDIO 传输参数
 *
 * 用于启动本地 MCP 服务器进程
 *
 * @example
 * ```ts
 * const params: MCPStdioParams = {
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
 *   env: { NODE_ENV: 'production' }
 * };
 * ```
 */
export interface MCPStdioParams {
  /** 启动命令（如 npx, node, python3, uvx） */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 环境变量（可选，与系统环境变量合并） */
  env?: Record<string, string>;
  /** 工作目录（可选） */
  cwd?: string;
}

/**
 * HTTP 传输参数
 *
 * 用于连接远程 MCP 服务器（如 FastMCP）
 *
 * @example
 * ```ts
 * const params: MCPHttpParams = {
 *   url: 'http://localhost:8000',
 *   headers: { 'Authorization': 'Bearer token' }
 * };
 * ```
 */
export interface MCPHttpParams {
  /** 服务器 URL */
  url: string;
  /** 请求头（可选） */
  headers?: Record<string, string>;
  /** 连接超时（毫秒，默认 30000） */
  timeout?: number;
}

/**
 * MCP 连接参数联合类型
 */
export type MCPConnectionParams = MCPStdioParams | MCPHttpParams;

// ============================================================================
// 服务器配置
// ============================================================================

/**
 * MCP 服务器配置
 *
 * 定义如何连接和使用一个 MCP 服务器
 *
 * @example STDIO 模式
 * ```ts
 * const config: MCPServerConfig = {
 *   name: 'filesystem',
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
 *   enabled: true,
 *   mode: 'traditional'
 * };
 * ```
 *
 * @example HTTP 模式
 * ```ts
 * const config: MCPServerConfig = {
 *   name: 'calculator',
 *   transport: 'http',
 *   url: 'http://localhost:8000',
 *   enabled: true,
 *   mode: 'code-execution'
 * };
 * ```
 */
export interface MCPServerConfig {
  /** 服务器名称（唯一标识符） */
  name: string;

  /** 服务器描述（可选，用于工具发现） */
  description?: string;

  /** 传输模式 */
  transport: MCPTransport;

  /** 是否启用此服务器（默认 true） */
  enabled?: boolean;

  /** 调用模式（默认 'traditional'） */
  mode?: MCPCallMode;

  // ========== STDIO 模式参数 ==========

  /** 启动命令（STDIO 模式必填） */
  command?: string;

  /** 命令参数（STDIO 模式使用） */
  args?: string[];

  /** 环境变量（STDIO 模式使用） */
  env?: Record<string, string>;

  /** 工作目录（STDIO 模式使用） */
  cwd?: string;

  // ========== HTTP 模式参数 ==========

  /** 服务器 URL（HTTP 模式必填） */
  url?: string;

  /** 请求头（HTTP 模式使用） */
  headers?: Record<string, string>;

  // ========== 通用参数 ==========

  /** 连接超时（毫秒，默认 30000） */
  connectionTimeout?: number;

  /** 调用超时（毫秒，默认 60000） */
  callTimeout?: number;

  /** 是否自动重连（默认 true） */
  autoReconnect?: boolean;

  /** 最大重试次数（默认 3） */
  maxRetries?: number;

  /** 重试基础延迟（毫秒，默认 1000） */
  retryBaseDelay?: number;

  /** 生成的包装器路径（代码执行模式使用，自动生成） */
  generatedWrapperPath?: string;
}

// ============================================================================
// 工具信息
// ============================================================================

/**
 * MCP 工具定义（来自 MCP 服务器）
 *
 * 符合 MCP 协议规范的工具定义
 */
export interface MCPToolDefinition {
  /** 工具名称 */
  name: string;

  /** 工具描述 */
  description?: string;

  /** 输入 Schema (JSON Schema) */
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
}

/**
 * MCP 工具调用请求
 */
export interface MCPToolCallRequest {
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * MCP 工具调用结果内容项
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
 * MCP 工具调用结果
 */
export interface MCPToolCallResult {
  /** 是否为错误 */
  isError?: boolean;
  /** 结果内容 */
  content: MCPContentItem[];
}

/**
 * Tachikoma 扩展的 MCP 工具信息
 *
 * 在 MCPToolDefinition 基础上增加 Tachikoma 特有字段
 */
export interface MCPToolInfo extends MCPToolDefinition {
  /** 所属服务器名称 */
  serverName: string;

  /** 服务器中的原始工具名称 */
  originalName: string;

  /** Tachikoma 中的工具名称（格式：mcp_{serverName}_{toolName}） */
  tachikomaName: string;

  /** 生成的包装器文件路径（代码执行模式使用） */
  generatedWrapperPath?: string;

  /** 调用模式（继承自服务器配置或覆盖） */
  mode?: MCPCallMode;

  /** 估计的 Token 消耗（仅定义部分） */
  estimatedTokens?: number;
}

// ============================================================================
// 服务器信息
// ============================================================================

/**
 * MCP 服务器能力
 */
export interface MCPServerCapabilities {
  /** 是否支持工具 */
  tools?: boolean;
  /** 是否支持资源 */
  resources?: boolean;
  /** 是否支持提示词 */
  prompts?: boolean;
  /** 是否支持采样 */
  sampling?: boolean;
  /** 是否支持日志 */
  logging?: boolean;
}

/**
 * MCP 服务器信息
 *
 * 连接后从服务器获取的元数据
 */
export interface MCPServerInfo {
  /** 服务器名称 */
  name: string;
  /** 版本 */
  version: string;
  /** 协议版本 */
  protocolVersion: string;
  /** 服务器能力 */
  capabilities: MCPServerCapabilities;
}

// ============================================================================
// 客户端状态
// ============================================================================

/**
 * MCP 客户端连接状态
 */
export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * MCP 客户端状态
 */
export interface MCPClientState {
  /** 服务器名称 */
  serverName: string;
  /** 连接状态 */
  status: MCPConnectionStatus;
  /** 服务器信息（已连接时可用） */
  serverInfo?: MCPServerInfo;
  /** 可用工具列表（已连接时可用） */
  tools?: MCPToolInfo[];
  /** 最后错误（错误状态时可用） */
  lastError?: string;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 最后活动时间 */
  lastActivityAt: number;
}

// ============================================================================
// 全局配置
// ============================================================================

/**
 * MCP 全局配置
 *
 * 从 .tachikoma/mcp.json 或环境变量加载
 */
export interface MCPConfig {
  /** 服务器列表 */
  servers: MCPServerConfig[];

  /** 全局默认调用模式（默认 'traditional'） */
  defaultMode?: MCPCallMode;

  /** 全局连接超时（毫秒，默认 30000） */
  defaultConnectionTimeout?: number;

  /** 全局调用超时（毫秒，默认 60000） */
  defaultCallTimeout?: number;

  /** 是否启用工具缓存（默认 true） */
  enableToolCache?: boolean;

  /** 工具缓存 TTL（毫秒，默认 300000 = 5分钟） */
  toolCacheTTL?: number;

  /** 故障摘除阈值（连续失败次数，默认 3） */
  circuitBreakerThreshold?: number;

  /** 故障摘除恢复时间（毫秒，默认 60000） */
  circuitBreakerRecoveryTime?: number;

  /** servers/ 目录路径（代码执行模式使用，默认 './servers'） */
  serversDir?: string;
}

// ============================================================================
// 调用指标
// ============================================================================

/**
 * MCP 调用指标
 *
 * 用于评估 Token 节省和性能
 */
export interface MCPCallMetrics {
  /** 服务器名称 */
  serverName: string;
  /** 工具名称 */
  toolName: string;
  /** 调用模式 */
  mode: MCPCallMode;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 延迟（毫秒） */
  latency: number;
  /** 是否成功 */
  success: boolean;
  /** 估计的输入 Token */
  inputTokensEstimate?: number;
  /** 估计的输出 Token */
  outputTokensEstimate?: number;
  /** 重试次数 */
  retryCount: number;
  /** 错误信息（失败时） */
  error?: string;
}

// ============================================================================
// 默认配置常量
// ============================================================================

/** 默认连接超时（毫秒） */
export const DEFAULT_CONNECTION_TIMEOUT = 30000;

/** 默认调用超时（毫秒） */
export const DEFAULT_CALL_TIMEOUT = 60000;

/** 默认重试次数 */
export const DEFAULT_MAX_RETRIES = 3;

/** 默认重试基础延迟（毫秒） */
export const DEFAULT_RETRY_BASE_DELAY = 1000;

/** 默认工具缓存 TTL（毫秒） */
export const DEFAULT_TOOL_CACHE_TTL = 300000;

/** 默认故障摘除阈值 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;

/** 默认故障摘除恢复时间（毫秒） */
export const DEFAULT_CIRCUIT_BREAKER_RECOVERY_TIME = 60000;

/** 默认调用模式 */
export const DEFAULT_CALL_MODE: MCPCallMode = 'traditional';

/** 默认 servers 目录 */
export const DEFAULT_SERVERS_DIR = './servers';

/**
 * 默认 MCP 配置
 */
export const DEFAULT_MCP_CONFIG: MCPConfig = {
  servers: [],
  defaultMode: DEFAULT_CALL_MODE,
  defaultConnectionTimeout: DEFAULT_CONNECTION_TIMEOUT,
  defaultCallTimeout: DEFAULT_CALL_TIMEOUT,
  enableToolCache: true,
  toolCacheTTL: DEFAULT_TOOL_CACHE_TTL,
  circuitBreakerThreshold: DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  circuitBreakerRecoveryTime: DEFAULT_CIRCUIT_BREAKER_RECOVERY_TIME,
  serversDir: DEFAULT_SERVERS_DIR,
};

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 提取 STDIO 参数
 */
export function isStdioConfig(
  config: MCPServerConfig
): config is MCPServerConfig & { transport: 'stdio'; command: string } {
  return config.transport === 'stdio' && typeof config.command === 'string';
}

/**
 * 提取 HTTP 参数
 */
export function isHttpConfig(
  config: MCPServerConfig
): config is MCPServerConfig & { transport: 'http'; url: string } {
  return config.transport === 'http' && typeof config.url === 'string';
}

/**
 * 获取服务器的连接参数
 */
export function getConnectionParams(config: MCPServerConfig): MCPConnectionParams {
  if (isStdioConfig(config)) {
    const params: MCPStdioParams = {
      command: config.command,
      args: config.args || [],
    };
    if (config.env !== undefined) {
      params.env = config.env;
    }
    if (config.cwd !== undefined) {
      params.cwd = config.cwd;
    }
    return params;
  }

  if (isHttpConfig(config)) {
    const params: MCPHttpParams = {
      url: config.url,
      timeout: config.connectionTimeout || DEFAULT_CONNECTION_TIMEOUT,
    };
    if (config.headers !== undefined) {
      params.headers = config.headers;
    }
    return params;
  }

  throw new Error(
    `Invalid MCP server config for '${config.name}': missing required fields for ${config.transport} transport`
  );
}

/**
 * 生成 Tachikoma 工具名称
 *
 * 格式：mcp_{serverName}_{toolName}
 */
export function generateTachikomaToolName(serverName: string, toolName: string): string {
  // 清理名称：只保留字母数字和下划线
  const cleanServerName = serverName.replace(/[^a-zA-Z0-9_]/g, '_');
  const cleanToolName = toolName.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp_${cleanServerName}_${cleanToolName}`;
}
