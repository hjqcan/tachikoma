/**
 * 工具类型定义
 * 
 * 完全兼容 MCP (Model Context Protocol) 标准
 * 参考：https://modelcontextprotocol.io/docs/concepts/tools
 */

import type { Tool } from '../types';

// ============================================================================
// MCP 标准类型
// ============================================================================

/**
 * 工具注解 (MCP 标准)
 * 
 * 提供工具行为的元数据描述
 */
export interface ToolAnnotations {
  /**
   * 目标受众
   * - 'user': 面向用户的工具（如显示结果）
   * - 'assistant': 面向助手的工具（如内部操作）
   */
  audience?: ('user' | 'assistant')[];
  
  /**
   * 优先级 (0-1)
   * 用于工具选择和推荐，数值越高优先级越高
   */
  priority?: number;
  
  /**
   * 是否幂等
   * true 表示多次执行结果相同（如读取文件）
   * false 表示有副作用（如写入文件）
   */
  idempotent?: boolean;
  
  /**
   * 预估执行时间（毫秒）
   * 用于超时控制和性能优化
   */
  estimatedDuration?: number;
  
  /**
   * 结果是否可缓存
   * true 表示结果可以缓存重用（如类型检查）
   */
  cacheable?: boolean;
}

// ============================================================================
// Tachikoma 扩展类型
// ============================================================================

/**
 * 工具权限枚举
 * 
 * 细粒度权限控制，每个工具必须声明所需权限
 */
export enum ToolPermission {
  /** 文件系统读取权限 */
  FileSystemRead = 'fs:read',
  /** 文件系统写入权限 */
  FileSystemWrite = 'fs:write',
  /** 文件系统删除权限 */
  FileSystemDelete = 'fs:delete',
  
  /** 网络读取权限（HTTP GET等） */
  NetworkRead = 'network:read',
  /** 网络写入权限（HTTP POST等） */
  NetworkWrite = 'network:write',
  
  /** Shell命令执行权限 */
  ShellExec = 'shell:exec',
  /** 进程创建权限 */
  ProcessSpawn = 'process:spawn',
  
  /** 环境变量读取权限 */
  EnvRead = 'env:read',
  
  /** Agent操作权限 */
  Agent = 'agent:spawn',
}

/**
 * 工具层级枚举（分层式行为空间）
 * 
 * 参考 PRD 3.4.1 分层式行为空间设计
 * - Layer 1: 原子函数调用 (10-20个) - 约束解码，Schema安全
 * - Layer 2: 沙盒工具 - 不占用函数调用上下文
 * - Layer 3: 软件包/API (代码执行) - 处理大量数据和内存计算
 */
export enum ToolLayer {
  /** Layer 1: 原子函数（固定数量10-20个） */
  Atomic = 'layer1',
  /** Layer 2: 沙盒工具（shell命令等） */
  Sandbox = 'layer2',
  /** Layer 3: 代码执行/MCP */
  CodeExecution = 'layer3',
}

/**
 * 工具分类枚举
 * 
 * 用于工具组织、查询和渐进披露
 */
export enum ToolCategory {
  /** 文件系统操作 */
  FileSystem = 'filesystem',
  /** Shell命令 */
  Shell = 'shell',
  /** 浏览器操作 */
  Browser = 'browser',
  /** 搜索工具 */
  Search = 'search',
  /** 通信工具 */
  Communication = 'communication',
  /** 数据处理 */
  DataProcessing = 'data',
  /** 智能体操作 */
  Agent = 'agent',
  /** 网络操作 */
  Network = 'network',
  /** MCP工具 */
  MCP = 'mcp',
}

/**
 * 工具执行元数据 (Codex-inspired)
 * 
 * 提供执行指标和诊断信息，不污染业务数据
 */
export interface ToolResultMeta {
  /** 执行时间（毫秒） */
  executionTime?: number;
  /** 退出码（命令类工具） */
  exitCode?: number;
  /** 输出是否被截断 */
  truncated?: boolean;
  /** 工具名称 */
  toolName?: string;
  /** 执行时间戳 */
  timestamp?: number;
  /** 其他元数据 */
  [key: string]: unknown;
}

/**
 * 工具执行结果
 */
export interface ToolResult<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 成功时的数据 */
  data?: T;
  /** 失败时的错误信息 */
  error?: string;
  /** 元数据（执行指标等，不污染data） */
  meta?: ToolResultMeta;
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

// ============================================================================
// run_tests 工具类型
// ============================================================================

/**
 * 测试运行输入
 */
export interface RunTestsInput {
  /** 测试文件路径或模式 (bun 模式必填；npm 模式可选，仅用于日志) */
  pattern?: string;
  /** 工作目录 (相对于上下文 workDir) */
  cwd?: string;
  /** 超时时间 (毫秒，默认 60000) */
  timeout?: number;
  /** 是否使用 bun test (默认 true，否则使用 npm test) */
  useBun?: boolean;
  /** 额外参数 (npm 模式下用于实际筛选，如 --testPathPattern) */
  extraArgs?: string[];
}

/**
 * 测试运行输出
 */
export interface RunTestsOutput {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 输出是否被截断 */
  truncated: boolean;
  /** 是否超时 */
  timedOut: boolean;
}

// ============================================================================
// type_check 工具类型
// ============================================================================

/**
 * 类型检查输入
 */
export interface TypeCheckInput {
  /** 工作目录 (相对于上下文 workDir) */
  cwd?: string;
  /** tsconfig 项目路径 (--project 参数) */
  project?: string;
  /** 超时时间 (毫秒，默认 120000) */
  timeout?: number;
}

/**
 * 类型检查输出
 */
export interface TypeCheckOutput {
  /** 是否通过类型检查 */
  passed: boolean;
  /** 错误数量 */
  errorCount: number;
  /** 诊断输出 */
  diagnostics: string;
  /** 输出是否被截断 */
  truncated: boolean;
}

// ============================================================================
// package_info 工具类型
// ============================================================================

/**
 * 包信息输入
 */
export interface PackageInfoInput {
  /** package.json 路径 (相对于上下文 workDir，默认 '.') */
  path?: string;
  /** 是否解析锁文件获取实际版本 */
  resolveLockfile?: boolean;
}

/** 检测到的包管理器类型 */
export type PackageManager = 'bun' | 'npm' | 'yarn' | 'pnpm' | 'unknown';

/**
 * 包信息输出
 */
export interface PackageInfoOutput {
  /** 包名 */
  name: string;
  /** 版本 */
  version: string;
  /** 生产依赖 */
  dependencies: Record<string, string>;
  /** 开发依赖 */
  devDependencies: Record<string, string>;
  /** Peer 依赖 */
  peerDependencies: Record<string, string>;
  /** 锁文件解析的实际版本 (key: packageName, value: resolvedVersion) */
  resolvedVersions?: Record<string, string>;
  /** 检测到的包管理器 */
  packageManager: PackageManager;
}

// ============================================================================
// env_get 工具类型
// ============================================================================

/**
 * 环境变量读取输入
 */
export interface EnvGetInput {
  /** 要读取的环境变量名称列表 */
  names: string[];
}

/**
 * 环境变量读取输出
 */
export interface EnvGetOutput {
  /** 成功读取的变量 */
  values: Record<string, string>;
  /** 被拒绝的变量 (不在白名单) */
  denied: string[];
  /** 不存在的变量 */
  missing: string[];
}

// ============================================================================
// script_run 兜底工具类型 (低优先级)
// ============================================================================

/**
 * 脚本运行输入
 */
export interface ScriptRunInput {
  /** 脚本名称 (package.json scripts 中的 key) */
  script: string;
  /** 工作目录 */
  cwd?: string;
  /** 超时时间 (毫秒，默认 60000) */
  timeout?: number;
  /** 是否使用 bun (默认 true，否则使用 npm) */
  useBun?: boolean;
  /** 额外参数 */
  args?: string[];
}

/**
 * 脚本运行输出
 */
export interface ScriptRunOutput {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 输出是否被截断 */
  truncated: boolean;
  /** 是否超时 */
  timedOut: boolean;
}

// ============================================================================
// 工具函数类型
// ============================================================================

/**
 * 创建工具函数类型
 */
export type CreateToolFn = () => Tool;
