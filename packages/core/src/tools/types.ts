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
 * apply_patch 输入
 */
export interface ApplyPatchInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 补丁操作列表 */
  patches: {
    /** 要匹配的精确文本 */
    search: string;
    /** 替换内容（空字符串表示删除） */
    replace: string;
    /** 匹配第几个出现（默认 1，0 表示全部） */
    occurrence?: number;
  }[];
  /** 是否创建备份（默认 false） */
  backup?: boolean;
}

/**
 * apply_patch 输出
 */
export interface ApplyPatchOutput {
  /** 修改的文件路径 */
  path: string;
  /** 应用的补丁数量 */
  patchesApplied: number;
  /** 修改前后的差异行数 */
  linesChanged: number;
  /** 修改前后的字节差 */
  bytesDelta: number;
}

/**
 * replace_between_markers 输入
 */
export interface ReplaceBetweenMarkersInput {
  /** 文件路径（相对于工作目录） */
  path: string;
  /** 开始标记（精确匹配） */
  startMarker: string;
  /** 结束标记（精确匹配） */
  endMarker: string;
  /** 新内容（不包含标记） */
  content: string;
  /** 是否包含标记本身（默认 false，只替换中间内容） */
  includeMarkers?: boolean;
  /** 匹配第几对标记（默认 1，0 表示全部） */
  occurrence?: number;
}

/**
 * replace_between_markers 输出
 */
export interface ReplaceBetweenMarkersOutput {
  /** 修改的文件路径 */
  path: string;
  /** 替换的区域数量 */
  regionsReplaced: number;
  /** 修改前后的行数差 */
  linesDelta: number;
  /** 修改前后的字节差 */
  bytesDelta: number;
}

/**
 * 创建工具函数类型
 */
export type CreateToolFn = () => Tool;
