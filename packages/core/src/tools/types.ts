/**
 * MVP 核心工具类型定义
 */

import type { Tool } from '../types';

/**
 * 工具执行结果
 */
export interface ToolResult<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
}

/**
 * 文件读取输入
 */
export interface FileReadInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 编码（默认 utf-8） */
  encoding?: string;
}

/**
 * 文件读取输出
 */
export interface FileReadOutput {
  /** 文件内容 */
  content: string;
  /** 文件大小（字节） */
  size: number;
}

/**
 * 文件写入输入
 */
export interface FileWriteInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 文件内容 */
  content: string;
  /** 是否追加（默认 false） */
  append?: boolean;
}

/**
 * 文件写入输出
 */
export interface FileWriteOutput {
  /** 写入的文件路径 */
  path: string;
  /** 写入的字节数 */
  bytesWritten: number;
}

/**
 * 文件列表输入
 */
export interface FileListInput {
  /** 目录路径（相对于工作目录） */
  path: string;
  /** 是否递归（默认 false） */
  recursive?: boolean;
  /** 文件模式过滤（glob 模式） */
  pattern?: string;
}

/**
 * 文件信息
 */
export interface FileInfo {
  /** 文件名 */
  name: string;
  /** 相对路径 */
  path: string;
  /** 是否为目录 */
  isDirectory: boolean;
  /** 文件大小（字节） */
  size: number;
}

/**
 * 文件列表输出
 */
export interface FileListOutput {
  /** 文件列表 */
  files: FileInfo[];
  /** 总数量 */
  count: number;
}

/**
 * Shell 命令输入
 */
export interface ShellRunInput {
  /** 命令 */
  command: string;
  /** 工作目录（相对于上下文 workDir） */
  cwd?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * Shell 命令输出
 */
export interface ShellRunOutput {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
}

/**
 * 代码搜索输入
 */
export interface CodeSearchInput {
  /** 搜索模式 */
  pattern: string;
  /** 搜索路径（相对于工作目录） */
  path?: string;
  /** 是否正则表达式 */
  regex?: boolean;
  /** 是否区分大小写 */
  caseSensitive?: boolean;
  /** 文件类型过滤（如 .ts, .js） */
  fileTypes?: string[];
  /** 最大结果数 */
  maxResults?: number;
}

/**
 * 搜索匹配
 */
export interface SearchMatch {
  /** 文件路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 匹配的行内容 */
  content: string;
}

/**
 * 代码搜索输出
 */
export interface CodeSearchOutput {
  /** 匹配列表 */
  matches: SearchMatch[];
  /** 总匹配数 */
  count: number;
}

/**
 * 创建工具函数类型
 */
export type CreateToolFn = () => Tool;
