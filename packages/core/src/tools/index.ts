/**
 * 工具模块入口
 *
 * 导出工具类型、核心工具和工具注册表
 */

import type { Tool } from '../types';

// 类型导出
export type {
  // 工具结果类型
  ToolResult,
  // 文件系统工具类型
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  FileWriteOutput,
  FileListInput,
  FileListOutput,
  FileInfo,
  // Shell工具类型
  ShellRunInput,
  ShellRunOutput,
  // 代码搜索工具类型
  CodeSearchInput,
  CodeSearchOutput,
  SearchMatch,
  // 补丁工具类型
  ApplyPatchInput,
  ApplyPatchOutput,
  ReplaceBetweenMarkersInput,
  ReplaceBetweenMarkersOutput,
  // 扩展工具类型
  RunTestsInput,
  RunTestsOutput,
  TypeCheckInput,
  TypeCheckOutput,
  PackageInfoInput,
  PackageInfoOutput,
  PackageManager,
  EnvGetInput,
  EnvGetOutput,
  ScriptRunInput,
  ScriptRunOutput,
  // MCP 标准类型
  ToolAnnotations,
} from './types';

// 枚举导出
export { ToolPermission, ToolLayer, ToolCategory } from './types';

// 权限和注册表导出
// 导出所有核心工具和管理类
export { PermissionValidator } from './permission-validator';
export { ToolRegistry, globalToolRegistry } from './registry';
export { SandboxToolWrapper, sandboxToolWrapper } from './sandbox-wrapper';
export { ToolChain } from './chain';
export { ProgressiveDisclosure, progressiveDisclosure } from './progressive-disclosure';
export { ToolExecutor, globalToolExecutor } from './tool-executor';
export { mergeEnv } from './env-utils';
export type { PermissionDeniedError, ToolNotFoundError, ToolDefinition } from './registry';
export type { ToolChainStep, ToolChainResult } from './chain';
export type { ToolMetadata, BasicToolDefinition } from './progressive-disclosure';
export type { ToolExecutionConfig } from './tool-executor';

// 导出常量
export { DEFAULT_RESOURCE_LIMITS, ENV_WHITELIST, SHELL_SAFETY } from './constants';

// 核心工具导出
export {
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
  applyPatchTool,
  replaceBetweenMarkersTool,
  // 扩展工具
  runTestsTool,
  typeCheckTool,
  packageInfoTool,
  envGetTool,
  // 安全工具函数
  DEFAULT_ENV_WHITELIST,
  isEnvAllowed,
  filterEnvRequests,
  isDangerousScript,
  DANGEROUS_SCRIPT_PATTERNS,
  truncateWithNotice,
  DEFAULT_MAX_OUTPUT,
  detectPackageManager,
} from './core';

// 工具注册表
import {
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
  applyPatchTool,
  replaceBetweenMarkersTool,
  runTestsTool,
  typeCheckTool,
  packageInfoTool,
  envGetTool,
} from './core';

// RAG工具
export { knowledgeRetrievalTool } from './rag';
export { knowledgeUpsertTool } from './rag/upsert';
import { knowledgeRetrievalTool } from './rag';
import { knowledgeUpsertTool } from './rag/upsert';

// 6.7 新增工具
export { webSearchTool } from './core/web-search';
export { deepResearchTool } from './core/deep-research';
export { spawnSubagentTool } from './core/spawn-subagent';
export { submitResultTool } from './core/submit-result';
// Browser tools are intentionally NOT exported from the default tools surface.
// Import from `@tachikoma/core/tools/browser` (or `../tools/browser` internally) when needed.

import { webSearchTool } from './core/web-search';
import { deepResearchTool } from './core/deep-research';
import { spawnSubagentTool } from './core/spawn-subagent';
import { submitResultTool } from './core/submit-result';

// 6.8 MCP Layer 3
export {
  MCPClientManager,
  MCPToolRegistrar,
  MCPModeRouter,
  // Types
  type MCPConfig,
  type MCPToolDefinition,
  type MCPServerConfig,
  type MCPConnectionStatus,
} from '../mcp';

/**
 * 基础工具集（无外部依赖，离线可用）
 *
 * 这些工具只依赖本地文件系统和Shell，不需要网络或外部服务
 */
export const baseTools: Tool[] = [
  // 文件系统工具
  fileReadTool,
  fileWriteTool,
  fileListTool,
  // Shell工具
  shellRunTool,
  // 代码工具
  codeSearchTool,
  applyPatchTool,
  replaceBetweenMarkersTool,
  // 扩展工具
  runTestsTool,
  typeCheckTool,
  packageInfoTool,
  envGetTool,
  // RAG 工具（本地向量存储）
  knowledgeRetrievalTool,
  knowledgeUpsertTool,
];

/**
 * Agent 工具集（子任务/结果提交）
 *
 * 这些工具需要与 Orchestrator 配合使用
 * - spawn_subagent: 创建子任务到 subtasks 目录
 * - submit_result: 提交结果到 artifacts 目录
 */
export const agentTools: Tool[] = [
  spawnSubagentTool,
  submitResultTool,
];

/**
 * 网络工具集（需要网络访问）
 *
 * ⚠️ 需要配置：
 * - SEARCH_API_KEY: 搜索API密钥
 * - SEARCH_PROVIDER: 提供商 (brave/serp/tavily)
 *
 * 无API Key时会fallback到DuckDuckGo（结果有限）
 */
export const networkTools: Tool[] = [
  webSearchTool,
  deepResearchTool,
];

/**
 * 默认工具集（基础 + Agent 工具）
 *
 * 只包含基础工具 + Agent工具，不包含网络/浏览器工具
 * 避免在禁网/无依赖环境下调用失败
 */
export const coreTools: Tool[] = [
  ...baseTools,
  ...agentTools,
];

/**
 * 完整工具集（包含基础 + Agent + 网络工具）
 *
 * ⚠️ 注意：
 * - 浏览器工具（Playwright）属于可选依赖，请从 `@tachikoma/core/tools/browser` 显式导入并自行合并
 */
export const allTools: Tool[] = [
  ...baseTools,
  ...agentTools,
  ...networkTools,
];

/**
 * 按能力获取工具集
 */
export function getToolsByCapability(capabilities: {
  network?: boolean;
  agent?: boolean;
}): Tool[] {
  const tools = [...baseTools];

  if (capabilities.agent !== false) {
    tools.push(...agentTools);
  }
  if (capabilities.network) {
    tools.push(...networkTools);
  }
  // Browser tools are opt-in and live in a separate module to avoid pulling Playwright
  // into bundles that don't need it (e.g. CLI single-run).

  return tools;
}

/**
 * 按名称查找工具
 */
export function getToolByName(name: string): Tool | undefined {
  return coreTools.find((tool) => tool.name === name);
}

/**
 * 获取所有工具名称
 */
export function getToolNames(): string[] {
  return coreTools.map((tool) => tool.name);
}

/**
 * 获取工具定义（用于 LLM 调用）
 */
export function getToolDefinitions(): {
  name: string;
  description: string;
  inputSchema: unknown;
}[] {
  return coreTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}
