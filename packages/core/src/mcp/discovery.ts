/**
 * MCP 工具发现模块
 *
 * 实现 Progressive Disclosure 模式：
 * - 通过文件系统探索发现可用服务器和工具
 * - 按需加载工具定义，减少初始 token 消耗
 * - 支持工具元数据缓存
 *
 * @module mcp/discovery
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { DEFAULT_SERVERS_DIR } from './types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 服务器目录信息
 */
export interface ServerDirectory {
  /** 服务器名称 */
  name: string;
  /** 目录路径 */
  path: string;
  /** 工具文件列表 */
  toolFiles: string[];
  /** 是否有 index.ts */
  hasIndex: boolean;
  /** 元数据文件（如果存在） */
  metadataFile?: string;
}

/**
 * 工具摘要（轻量级，用于列表展示）
 */
export interface ToolSummary {
  /** 服务器名称 */
  serverName: string;
  /** 工具名称 */
  toolName: string;
  /** 工具描述（简短） */
  description?: string;
  /** 源文件路径 */
  filePath: string;
}

/**
 * 发现选项
 */
export interface DiscoveryOptions {
  /** 服务器目录路径 */
  serversDir?: string;
  /** 排除的目录名 */
  excludeDirs?: string[];
  /** 是否包含私有目录（以 _ 开头） */
  includePrivate?: boolean;
}

/**
 * 发现结果
 */
export interface DiscoveryResult {
  /** 发现的服务器 */
  servers: ServerDirectory[];
  /** 工具摘要列表 */
  tools: ToolSummary[];
  /** 错误（非致命） */
  errors: DiscoveryError[];
}

/**
 * 发现错误
 */
export interface DiscoveryError {
  /** 路径 */
  path: string;
  /** 错误信息 */
  message: string;
}

// ============================================================================
// ToolDiscovery
// ============================================================================

/**
 * MCP 工具发现器
 *
 * @example
 * ```ts
 * const discovery = new ToolDiscovery();
 *
 * // 发现所有可用服务器
 * const result = await discovery.discover();
 * console.log(result.servers); // ['filesystem', 'github', ...]
 *
 * // 获取服务器的工具列表（轻量级）
 * const tools = await discovery.listServerTools('filesystem');
 *
 * // 加载完整工具定义
 * const toolInfo = await discovery.loadToolMetadata('filesystem', 'read_file');
 * ```
 */
export class ToolDiscovery {
  private readonly serversDir: string;
  private readonly excludeDirs: Set<string>;
  private readonly includePrivate: boolean;

  // 缓存
  private serverCache: Map<string, ServerDirectory> = new Map();
  private toolSummaryCache: Map<string, ToolSummary[]> = new Map();

  constructor(options: DiscoveryOptions = {}) {
    this.serversDir = options.serversDir ?? DEFAULT_SERVERS_DIR;
    this.excludeDirs = new Set(
      options.excludeDirs ?? ['node_modules', '.git', 'dist', 'build']
    );
    this.includePrivate = options.includePrivate ?? false;
  }

  /**
   * 发现所有可用服务器和工具
   */
  async discover(): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      servers: [],
      tools: [],
      errors: [],
    };

    try {
      const entries = await readdir(this.serversDir, { withFileTypes: true });

      for (const entry of entries) {
        // 跳过非目录
        if (!entry.isDirectory()) continue;

        // 跳过排除的目录
        if (this.excludeDirs.has(entry.name)) continue;

        // 跳过私有目录（以 _ 开头）
        if (!this.includePrivate && entry.name.startsWith('_')) continue;

        try {
          const serverDir = await this.scanServerDirectory(entry.name);
          if (serverDir) {
            result.servers.push(serverDir);
            this.serverCache.set(entry.name, serverDir);

            // 提取工具摘要
            const summaries = this.extractToolSummaries(serverDir);
            result.tools.push(...summaries);
            this.toolSummaryCache.set(entry.name, summaries);
          }
        } catch (error) {
          result.errors.push({
            path: join(this.serversDir, entry.name),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      result.errors.push({
        path: this.serversDir,
        message: `Failed to read servers directory: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return result;
  }

  /**
   * 列出可用服务器名称
   */
  async listServers(): Promise<string[]> {
    if (this.serverCache.size === 0) {
      await this.discover();
    }
    return Array.from(this.serverCache.keys());
  }

  /**
   * 获取服务器信息
   */
  async getServerInfo(serverName: string): Promise<ServerDirectory | null> {
    if (!this.serverCache.has(serverName)) {
      await this.discover();
    }
    return this.serverCache.get(serverName) ?? null;
  }

  /**
   * 列出服务器的工具摘要
   */
  async listServerTools(serverName: string): Promise<ToolSummary[]> {
    if (!this.toolSummaryCache.has(serverName)) {
      await this.discover();
    }
    return this.toolSummaryCache.get(serverName) ?? [];
  }

  /**
   * 生成工具简介（用于 LLM 提示）
   *
   * 格式紧凑，减少 token 消耗
   */
  async generateToolBrief(serverName?: string): Promise<string> {
    const lines: string[] = [];

    if (serverName) {
      // 使用带描述的工具列表
      const tools = await this.listServerToolsWithDescriptions(serverName);
      lines.push(`## ${serverName}`);
      for (const tool of tools) {
        lines.push(`- ${tool.toolName}: ${tool.description ?? 'No description'}`);
      }
    } else {
      const servers = await this.listServers();
      for (const server of servers) {
        // eslint-disable-next-line no-await-in-loop -- Sequential is intentional for server iteration
        const tools = await this.listServerToolsWithDescriptions(server);
        lines.push(`## ${server} (${tools.length} tools)`);
        for (const tool of tools) {
          lines.push(`- ${tool.toolName}: ${tool.description ?? 'No description'}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.serverCache.clear();
    this.toolSummaryCache.clear();
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 扫描服务器目录
   */
  private async scanServerDirectory(serverName: string): Promise<ServerDirectory | null> {
    const dirPath = join(this.serversDir, serverName);

    try {
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) {
        return null;
      }

      const entries = await readdir(dirPath);
      const toolFiles: string[] = [];
      let hasIndex = false;
      let metadataFile: string | undefined;

      for (const entry of entries) {
        if (entry === 'index.ts' || entry === 'index.js') {
          hasIndex = true;
        } else if (entry === 'metadata.json' || entry === 'manifest.json') {
          metadataFile = entry;
        } else if (
          (entry.endsWith('.ts') || entry.endsWith('.js')) &&
          !entry.startsWith('_') &&
          !entry.endsWith('.d.ts') &&
          !entry.endsWith('.test.ts') &&
          !entry.endsWith('.spec.ts')
        ) {
          toolFiles.push(entry);
        }
      }

      const result: ServerDirectory = {
        name: serverName,
        path: dirPath,
        toolFiles,
        hasIndex,
      };
      if (metadataFile) {
        result.metadataFile = metadataFile;
      }
      return result;
    } catch {
      return null;
    }
  }

  /**
   * 从服务器目录提取工具摘要
   */
  private extractToolSummaries(server: ServerDirectory): ToolSummary[] {
    return server.toolFiles.map((file) => {
      // 移除扩展名 (.ts 或 .js)
      const toolName = basename(file).replace(/\.(ts|js)$/, '');
      return {
        serverName: server.name,
        toolName,
        filePath: join(server.path, file),
      };
    });
  }

  /**
   * 从 metadata.json 加载工具描述
   *
   * @param serverName - 服务器名称
   * @returns 工具名 -> 描述的映射
   */
  async loadMetadata(serverName: string): Promise<Record<string, string>> {
    const serverInfo = await this.getServerInfo(serverName);
    if (!serverInfo || !serverInfo.metadataFile) {
      return {};
    }

    const metadataPath = join(serverInfo.path, serverInfo.metadataFile);

    try {
      const content = await readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(content) as {
        tools?: { name: string; description?: string }[];
      };

      if (!metadata.tools || !Array.isArray(metadata.tools)) {
        return {};
      }

      const descriptions: Record<string, string> = {};
      for (const tool of metadata.tools) {
        if (tool.name && tool.description) {
          descriptions[tool.name] = tool.description;
        }
      }
      return descriptions;
    } catch {
      return {};
    }
  }

  /**
   * 获取带描述的工具摘要列表
   *
   * @param serverName - 服务器名称
   * @returns 包含描述的工具摘要
   */
  async listServerToolsWithDescriptions(serverName: string): Promise<ToolSummary[]> {
    const tools = await this.listServerTools(serverName);
    const descriptions = await this.loadMetadata(serverName);

    return tools.map((tool) => {
      const result: ToolSummary = {
        serverName: tool.serverName,
        toolName: tool.toolName,
        filePath: tool.filePath,
      };
      const desc = descriptions[tool.toolName];
      if (desc) {
        result.description = desc;
      }
      return result;
    });
  }

  /**
   * 生成工具简介（增强版，带描述）
   *
   * @param serverName - 可选，指定服务器
   * @returns Markdown 格式的工具简介
   */
  async generateToolBriefEnhanced(serverName?: string): Promise<string> {
    const lines: string[] = [];

    if (serverName) {
      const tools = await this.listServerToolsWithDescriptions(serverName);
      lines.push(`## ${serverName}`);
      for (const tool of tools) {
        lines.push(`- ${tool.toolName}: ${tool.description ?? 'No description'}`);
      }
    } else {
      const servers = await this.listServers();
      for (const server of servers) {
        // eslint-disable-next-line no-await-in-loop -- Sequential is intentional for server iteration
        const tools = await this.listServerToolsWithDescriptions(server);
        lines.push(`## ${server} (${tools.length} tools)`);
        for (const tool of tools) {
          lines.push(`- ${tool.toolName}: ${tool.description ?? 'No description'}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建工具发现器
 */
export function createToolDiscovery(options?: DiscoveryOptions): ToolDiscovery {
  return new ToolDiscovery(options);
}

/**
 * 快速发现所有工具
 */
export async function discoverTools(
  serversDir?: string
): Promise<DiscoveryResult> {
  const options: DiscoveryOptions = {};
  if (serversDir !== undefined) {
    options.serversDir = serversDir;
  }
  const discovery = new ToolDiscovery(options);
  return discovery.discover();
}

/**
 * 生成可用工具简介
 */
export async function generateToolsBrief(
  serversDir?: string
): Promise<string> {
  const options: DiscoveryOptions = {};
  if (serversDir !== undefined) {
    options.serversDir = serversDir;
  }
  const discovery = new ToolDiscovery(options);
  return discovery.generateToolBrief();
}
