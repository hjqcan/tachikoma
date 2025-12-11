/**
 * Tachikoma MCP 服务器代理 - 入口
 *
 * @module servers
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  MCPToolResult,
  MCPContentItem,
  ToolCallOptions,
  ToolParamSchema,
  ToolMetadata,
  ServerProxyConfig,
  ToolFunction,
} from './_types';

export {
  parseTextContent,
  parseJsonContent,
  successResult,
  errorResult,
} from './_types';

// ============================================================================
// 客户端导出
// ============================================================================

export type { RuntimeEnvironment, IMCPClient } from './_client';

export {
  detectEnvironment,
  setMCPClient,
  getMCPClient,
  clearMCPClient,
  callMCPTool,
  createToolCaller,
} from './_client';
