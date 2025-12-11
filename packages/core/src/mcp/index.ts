/**
 * MCP (Model Context Protocol) 模块入口
 *
 * 提供 MCP 客户端与代码执行集成的双模式架构
 *
 * @module mcp
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 传输与调用模式
  MCPTransport,
  MCPCallMode,
  // 连接参数
  MCPStdioParams,
  MCPHttpParams,
  MCPConnectionParams,
  // 服务器配置
  MCPServerConfig,
  // 工具定义
  MCPToolDefinition,
  MCPToolCallRequest,
  MCPContentItem,
  MCPToolCallResult,
  MCPToolInfo,
  // 服务器信息
  MCPServerCapabilities,
  MCPServerInfo,
  // 客户端状态
  MCPConnectionStatus,
  MCPClientState,
  // 全局配置
  MCPConfig,
  // 指标
  MCPCallMetrics,
} from './types';

// ============================================================================
// 常量导出
// ============================================================================

export {
  // 默认值常量
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_CALL_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY,
  DEFAULT_TOOL_CACHE_TTL,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_RECOVERY_TIME,
  DEFAULT_CALL_MODE,
  DEFAULT_SERVERS_DIR,
  DEFAULT_MCP_CONFIG,
  // 辅助函数
  isStdioConfig,
  isHttpConfig,
  getConnectionParams,
  generateTachikomaToolName,
} from './types';

// ============================================================================
// 配置导出
// ============================================================================

export {
  // 配置文件路径
  MCP_CONFIG_FILENAME,
  TACHIKOMA_CONFIG_DIR,
  // 环境变量名
  ENV_MCP_SERVERS,
  ENV_MCP_DEFAULT_MODE,
  ENV_MCP_SERVERS_DIR,
  // 配置加载函数
  loadMCPConfig,
  loadMCPConfigFromFile,
  loadMCPConfigFromEnv,
  parseStandardMCPConfig,
  // 配置工具函数
  mergeConfigs,
  normalizeServerConfig,
  validateMCPConfig,
  createExampleMCPConfig,
  serializeMCPConfig,
} from './config';

export type { MCPConfigError } from './config';

// ============================================================================
// 客户端导出
// ============================================================================

export {
  MCPClientManager,
  getMCPClientManager,
  resetMCPClientManager,
} from './client';

export type { MCPCallOptions } from './client';

// ============================================================================
// 代码生成器导出
// ============================================================================

export {
  MCPCodeGenerator,
  generateServerWrappers,
  defaultGenerator,
} from './generator';

export type {
  GeneratorOptions,
  GeneratorResult,
  GeneratedFile,
  GeneratorError,
} from './generator';

// ============================================================================
// Sandbox IPC 导出
// ============================================================================

export {
  MCP_IPC_PREFIX,
  decodeMCPIPCMessage,
  encodeMCPIPCMessage,
  generateRequestId,
  sendMCPIPCRequest,
  handleMCPIPCResponse,
  createMCPIPCHandler,
  processMCPIPCLine,
} from './sandbox-ipc';

export type {
  MCPIPCRequest,
  MCPIPCResponse,
  MCPIPCContentItem,
  MCPIPCMessage,
  MCPIPCRequestHandler,
} from './sandbox-ipc';

// ============================================================================
// 路由器导出
// ============================================================================

export {
  MCPModeRouter,
  createMCPModeRouter,
  isMCPIPCLine,
  filterMCPIPCLines,
} from './router';

export type {
  MCPRouterConfig,
  RouteDecision,
  IPCLineResult,
} from './router';

// ============================================================================
// 工具发现导出
// ============================================================================

export {
  ToolDiscovery,
  createToolDiscovery,
  discoverTools,
  generateToolsBrief,
} from './discovery';

export type {
  ServerDirectory,
  ToolSummary,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoveryError,
} from './discovery';

// ============================================================================
// 工具注册器导出
// ============================================================================

export { MCPToolRegistrar, createMCPToolRegistrar } from './registrar';

export type {
  MCPToolRegistrarConfig,
  RegisterResult,
} from './registrar';

