/**
 * 工具模块入口
 *
 * 导出工具类型、核心工具和工具注册表
 */

import type { Tool } from '../types';

import {
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  shellBgTool,
  codeSearchTool,
  applyPatchTool,
  replaceBetweenMarkersTool,
  runTestsTool,
  typeCheckTool,
  packageInfoTool,
  packageInstallTool,
  envGetTool,
  // devServerTool 从 core 导入但不放入 baseTools
  devServerTool,
} from './core';

// RAG 工具导入
import { knowledgeRetrievalTool } from './rag';
import { knowledgeUpsertTool } from './rag/upsert';

// 网络/Agent 工具导入
import { webSearchTool } from './core/web-search';
import { deepResearchTool } from './core/deep-research';
import { spawnSubagentTool } from './core/spawn-subagent';
import { submitResultTool } from './core/submit-result';
import { createSkillTool } from './core/create-skill';

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
  ReplaceBetweenMarkersInput,
  ReplaceBetweenMarkersOutput,
  // 扩展工具类型
  RunTestsInput,
  RunTestsOutput,
  TypeCheckInput,
  TypeCheckOutput,
  PackageInfoInput,
  PackageInfoOutput,
  PackageInstallInput,
  PackageInstallOutput,
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
  devServerTool,
  codeSearchTool,
  applyPatchTool,
  replaceBetweenMarkersTool,
  // 扩展工具
  runTestsTool,
  typeCheckTool,
  packageInfoTool,
  packageInstallTool,
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

// RAG工具导出
export { knowledgeRetrievalTool } from './rag';
export { knowledgeUpsertTool } from './rag/upsert';

// 新增工具导出 (使用已导入的变量)
export {
  webSearchTool,
  deepResearchTool,
  spawnSubagentTool,
  submitResultTool,
  createSkillTool,
};

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
 * 基础工具集（无外部依赖，离线可用，低风险）
 *
 * 这些工具只依赖本地文件系统和Shell，不需要网络或外部服务
 * 不包含长期进程管理（devServer）或浏览器自动化
 */
export const baseTools: Tool[] = [
  // 文件系统工具
  fileReadTool,
  fileWriteTool,
  fileListTool,
  // Shell工具
  shellRunTool,
  shellBgTool,
  // 代码工具
  codeSearchTool,
  applyPatchTool,
  replaceBetweenMarkersTool,
  // 扩展工具
  runTestsTool,
  typeCheckTool,
  packageInfoTool,
  packageInstallTool,
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
 * - create_skill: 动态创建新技能
 */
export const agentTools: Tool[] = [
  spawnSubagentTool,
  submitResultTool,
  createSkillTool,
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
 * 开发服务器工具集（高副作用，需显式启用）
 *
 * 这些工具涉及长期进程管理和端口监听，具有较高副作用
 * 需要通过 getToolsByCapability({ devServer: true }) 显式启用
 */
export const devTools: Tool[] = [
  devServerTool,
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
 *
 * @param capabilities.network - 启用网络工具（web_search, deep_research）
 * @param capabilities.agent - 启用 Agent 工具（默认 true）
 * @param capabilities.devServer - 启用开发服务器工具（默认 false，高副作用）
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
