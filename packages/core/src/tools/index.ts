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

export { knowledgeRetrievalTool } from './rag';
export { knowledgeUpsertTool } from './rag/upsert';
import { knowledgeRetrievalTool } from './rag';
import { knowledgeUpsertTool } from './rag/upsert';

/**
 * MVP 核心工具集
 */
export const coreTools: Tool[] = [
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
  // RAG 工具
  knowledgeRetrievalTool,
  knowledgeUpsertTool,
];

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
