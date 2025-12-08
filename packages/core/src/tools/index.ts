/**
 * 工具模块入口
 *
 * 导出工具类型、核心工具和工具注册表
 */

import type { Tool } from '../types';

// 类型导出
export type {
  ToolResult,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  FileWriteOutput,
  FileListInput,
  FileListOutput,
  FileInfo,
  ShellRunInput,
  ShellRunOutput,
  CodeSearchInput,
  CodeSearchOutput,
  SearchMatch,
} from './types';

// 核心工具导出
export {
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
} from './core';

// 工具注册表
import {
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
} from './core';

/**
 * MVP 核心工具集
 */
export const coreTools: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
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
