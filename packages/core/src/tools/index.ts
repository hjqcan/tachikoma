/**
 * 工具模块入口
 *
 * 导出工具类型、核心工具和工具注册表
 */

import type { Tool } from '../types';
import { getToolPromptText } from './build-tool';

import {
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
  applyPatchTool,
  todoWriteTool,
  todoReadTool,
} from './core';

import { spawnSubagentTool } from './core/spawn-subagent';

// 类型导出
export type {
  // 工具结果类型
  ToolResult,
  ToolResultMeta,
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
  TodoItem,
  TodoWriteInput,
  TodoWriteOutput,
  TodoReadInput,
  TodoReadOutput,
  PackageManager,
  ScriptRunInput,
  ScriptRunOutput,
  // MCP 标准类型
  ToolAnnotations,
} from './types';

// 枚举导出
export { ToolPermission, ToolLayer, ToolCategory } from './types';

// 权限和注册表导出
export { PermissionValidator } from './permission-validator';
export { ToolRegistry, globalToolRegistry } from './registry';
export { SandboxToolWrapper, sandboxToolWrapper } from './sandbox-wrapper';
export { ToolChain } from './chain';
export { ProgressiveDisclosure, progressiveDisclosure } from './progressive-disclosure';
export { ToolExecutor, globalToolExecutor } from './tool-executor';
export { mergeEnv } from './env-utils';
export type { ToolDefinition } from './registry';
export type { PermissionDeniedError, ToolNotFoundError } from './errors';
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
  todoWriteTool,
  todoReadTool,
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

// Agent 核心工具导出
export { spawnSubagentTool };

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
 * 基础工具集（Claude Code 核心子集）
 *
 * 默认只暴露最小必要工具面，避免把一堆低价值工具塞给模型。
 */
export const baseTools: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
  applyPatchTool,
];

/**
 * Agent 工具集（同样保持最小集）
 */
export const agentTools: Tool[] = [
  spawnSubagentTool,
  todoWriteTool,
  todoReadTool,
];

/**
 * 预留扩展工具集
 *
 * 当前默认不暴露额外网络工具，避免模型工具面继续膨胀。
 */
export const networkTools: Tool[] = [];

/**
 * 当前不从公共入口暴露 dev server 专用工具。
 */
export const devTools: Tool[] = [];

/**
 * 默认工具集（最小 Claude Code 风格工具集）
 */
export const coreTools: Tool[] = [
  ...baseTools,
  ...agentTools,
];

/**
 * 完整工具集（当前与默认工具集一致）
 */
export const allTools: Tool[] = [
  ...baseTools,
  ...agentTools,
  ...networkTools,
];

/**
 * 按能力获取工具集
 *
 * @param capabilities.network - 预留参数，当前无额外网络工具
 * @param capabilities.agent - 启用 Agent 工具（默认 true）
 * @param capabilities.devServer - 预留参数，当前无额外 devServer 工具
 */
export function getToolsByCapability(capabilities: {
  network?: boolean;
  agent?: boolean;
  devServer?: boolean;
}): Tool[] {
  const tools = [...baseTools];

  if (capabilities.agent !== false) {
    tools.push(...agentTools);
  }
  if (capabilities.network) {
    tools.push(...networkTools);
  }
  if (capabilities.devServer) {
    tools.push(...devTools);
  }

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
    description: getToolPromptText(tool),
    inputSchema: tool.inputSchema,
  }));
}
