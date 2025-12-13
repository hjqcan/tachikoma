/**
 * 项目上下文模块
 *
 * 提供项目级上下文自动加载，类似 CLAUDE.md 但 Provider 无关
 *
 * @module prompt/project
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContextMessage } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 项目上下文文件名（按优先级）
 */
export const PROJECT_CONTEXT_FILES = [
  'TACHIKOMA.md', // Tachikoma 专用
  'AGENT.md', // 通用 Agent 配置
  'AGENTS.md', // 复数形式
  'PROJECT.md', // 项目说明
  '.agentrc.md', // 隐藏配置
  '.tachikoma.md', // 隐藏 Tachikoma 配置
];

/**
 * 上下文级别
 */
export type ContextLevel = 'project' | 'parent' | 'global';

/**
 * 项目上下文文件
 */
export interface ProjectContextFile {
  /** 文件路径 */
  path: string;

  /** 文件内容 */
  content: string;

  /** 上下文级别 */
  level: ContextLevel;

  /** 文件名 */
  filename: string;
}

/**
 * 项目上下文
 */
export interface ProjectContext {
  /** 加载的文件列表 */
  files: ProjectContextFile[];

  /** 合并后的内容 */
  merged: string;

  /** 元数据 */
  metadata: ProjectContextMetadata;
}

/**
 * 项目上下文元数据
 */
export interface ProjectContextMetadata {
  /** 项目级文件路径 */
  projectLevel: string | null;

  /** 父级文件数量 */
  parentLevels: number;

  /** 是否有全局配置 */
  hasGlobal: boolean;

  /** 总文件数 */
  totalFiles: number;

  /** 加载时间（毫秒） */
  loadTimeMs: number;
}

// ============================================================================
// 项目上下文加载器
// ============================================================================

/**
 * 项目上下文加载器配置
 */
export interface ProjectContextLoaderConfig {
  /** 自定义文件名列表 */
  filenames: string[];

  /** 是否向上搜索父目录 */
  searchParents: boolean;

  /** 最大搜索深度 */
  maxDepth: number;

  /** 是否加载全局配置 */
  loadGlobal: boolean;

  /** 全局配置目录 */
  globalDir: string;
}

/**
 * 默认配置
 */
export const DEFAULT_PROJECT_CONTEXT_CONFIG: ProjectContextLoaderConfig = {
  filenames: PROJECT_CONTEXT_FILES,
  searchParents: true,
  maxDepth: 10,
  loadGlobal: true,
  globalDir: path.join(os.homedir(), '.tachikoma'),
};

/**
 * 项目上下文加载器
 */
export class ProjectContextLoader {
  private readonly config: ProjectContextLoaderConfig;

  constructor(config: Partial<ProjectContextLoaderConfig> = {}) {
    this.config = { ...DEFAULT_PROJECT_CONTEXT_CONFIG, ...config };
  }

  /**
   * 按层级加载项目上下文
   *
   * 搜索顺序：
   * 1. workDir/TACHIKOMA.md
   * 2. workDir/../TACHIKOMA.md
   * 3. ... 直到 $HOME 或达到最大深度
   * 4. $HOME/.tachikoma/TACHIKOMA.md
   */
  async loadProjectContext(workDir: string): Promise<ProjectContext> {
    const startTime = Date.now();
    const files: ProjectContextFile[] = [];
    // resolve workDir 以确保路径比较正确
    const rootDir = path.resolve(workDir);
    let currentDir = rootDir;
    const homeDir = os.homedir();
    let depth = 0;

    // 向上遍历目录
    while (
      depth < this.config.maxDepth &&
      currentDir !== path.dirname(currentDir)
    ) {
      // eslint-disable-next-line no-await-in-loop
      const foundFiles = await this.findContextFiles(currentDir);

      for (const file of foundFiles) {
        files.push({
          ...file,
          level: currentDir === rootDir ? 'project' : 'parent',
        });
      }

      // 如果不搜索父目录，或者已到达 home 目录，停止
      if (!this.config.searchParents || currentDir === homeDir) {
        break;
      }

      currentDir = path.dirname(currentDir);
      depth++;
    }

    // 加载全局配置
    if (this.config.loadGlobal) {
      const globalFiles = await this.findContextFiles(this.config.globalDir);
      for (const file of globalFiles) {
        files.push({
          ...file,
          level: 'global',
        });
      }
    }

    const loadTimeMs = Date.now() - startTime;

    return this.buildProjectContext(files, loadTimeMs);
  }

  /**
   * 在指定目录查找上下文文件
   */
  private async findContextFiles(
    dir: string
  ): Promise<Omit<ProjectContextFile, 'level'>[]> {
    const found: Omit<ProjectContextFile, 'level'>[] = [];

    for (const filename of this.config.filenames) {
      const filePath = path.join(dir, filename);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        found.push({
          path: filePath,
          content,
          filename,
        });
        // 每个目录只取第一个匹配的文件
        break;
      } catch {
        // 文件不存在，继续尝试下一个
      }
    }

    return found;
  }

  /**
   * 构建项目上下文
   */
  private buildProjectContext(
    files: ProjectContextFile[],
    loadTimeMs: number
  ): ProjectContext {
    // 反转顺序：全局 -> parent -> project（优先级从低到高）
    const sorted = [...files].reverse();

    const metadata: ProjectContextMetadata = {
      projectLevel: sorted.find((f) => f.level === 'project')?.path ?? null,
      parentLevels: sorted.filter((f) => f.level === 'parent').length,
      hasGlobal: sorted.some((f) => f.level === 'global'),
      totalFiles: sorted.length,
      loadTimeMs,
    };

    // 合并内容
    const merged = this.mergeContents(sorted);

    return {
      files: sorted,
      merged,
      metadata,
    };
  }

  /**
   * 合并多个上下文文件内容
   */
  private mergeContents(files: ProjectContextFile[]): string {
    if (files.length === 0) {
      return '';
    }

    const sections: string[] = [];

    for (const file of files) {
      const levelLabel = this.getLevelLabel(file.level);
      sections.push(`<!-- ${levelLabel}: ${file.filename} -->`);
      sections.push(file.content);
    }

    return sections.join('\n\n---\n\n');
  }

  private getLevelLabel(level: ContextLevel): string {
    switch (level) {
      case 'global':
        return 'Global Config';
      case 'parent':
        return 'Parent Config';
      case 'project':
        return 'Project Config';
    }
  }
}

// ============================================================================
// 项目上下文注入器
// ============================================================================

/**
 * 项目上下文注入器
 */
export class ProjectContextInjector {
  private readonly loader: ProjectContextLoader;
  private cachedContext: ProjectContext | null = null;
  private cachedWorkDir: string | null = null;

  constructor(loader?: ProjectContextLoader) {
    this.loader = loader ?? new ProjectContextLoader();
  }

  /**
   * 注入项目上下文到消息列表开头
   */
  async injectProjectContext(
    messages: ContextMessage[],
    workDir: string
  ): Promise<ContextMessage[]> {
    const context = await this.getProjectContext(workDir);

    if (!context.merged) {
      return messages;
    }

    const projectMessage: ContextMessage = {
      id: 'project-context',
      role: 'system',
      content: this.formatProjectContext(context),
      timestamp: Date.now(),
      format: 'full',
    };

    // 防止重复注入
    const cleanedMessages = messages.filter((m) => m.id !== projectMessage.id);

    // 插入到其他 system 消息之后
    const firstNonSystem = cleanedMessages.findIndex((m) => m.role !== 'system');
    if (firstNonSystem === -1) {
      return [...cleanedMessages, projectMessage];
    }

    return [
      ...cleanedMessages.slice(0, firstNonSystem),
      projectMessage,
      ...cleanedMessages.slice(firstNonSystem),
    ];
  }

  /**
   * 获取项目上下文（带缓存）
   */
  async getProjectContext(workDir: string): Promise<ProjectContext> {
    // 规范化路径以确保缓存命中
    const normalizedPath = this.normalizePath(workDir);

    // 使用缓存
    if (this.cachedContext && this.cachedWorkDir === normalizedPath) {
      return this.cachedContext;
    }

    const context = await this.loader.loadProjectContext(normalizedPath);
    this.cachedContext = context;
    this.cachedWorkDir = normalizedPath;

    return context;
  }

  /**
   * 规范化路径（去除末尾斜杠，解析为绝对路径）
   */
  private normalizePath(p: string): string {
    const resolved = path.resolve(p);
    // 去除末尾斜杠（但保留根目录）
    return resolved.endsWith(path.sep) && resolved !== path.sep
      ? resolved.slice(0, -1)
      : resolved;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cachedContext = null;
    this.cachedWorkDir = null;
  }

  /**
   * 格式化项目上下文为消息内容
   */
  private formatProjectContext(context: ProjectContext): string {
    const parts = ['## Project Context'];

    if (context.metadata.projectLevel) {
      parts.push(
        `\n_Loaded from: ${path.basename(context.metadata.projectLevel)}_`
      );
    }

    if (context.metadata.parentLevels > 0) {
      parts.push(`\n_Includes ${context.metadata.parentLevels} parent config(s)_`);
    }

    if (context.metadata.hasGlobal) {
      parts.push('\n_Includes global config_');
    }

    parts.push('\n' + context.merged);

    return parts.join('\n');
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建项目上下文加载器
 */
export function createProjectContextLoader(
  config?: Partial<ProjectContextLoaderConfig>
): ProjectContextLoader {
  return new ProjectContextLoader(config);
}

/**
 * 创建项目上下文注入器
 */
export function createProjectContextInjector(
  loader?: ProjectContextLoader
): ProjectContextInjector {
  return new ProjectContextInjector(loader);
}
