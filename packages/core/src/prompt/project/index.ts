/**
 * 项目上下文模块
 *
 * 提供项目级上下文自动加载，类似 CLAUDE.md 但 Provider 无关
 *
 * @module prompt/project
 */

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContextMessage } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 项目上下文文件名（按优先级）
 * 
 * 兼容 agents.md 规范 (https://agents.md):
 * - AGENTS.md - agents.md 标准格式
 * - CLAUDE.md - Claude Code / Anthropic
 * - CURSOR.md / .cursorrules - Cursor
 * - COPILOT.md - GitHub Copilot
 */
export const PROJECT_CONTEXT_FILES = [
  // Tachikoma 专用（最高优先级）
  'TACHIKOMA.md',
  '.tachikoma.md',
  // agents.md 标准格式
  'AGENTS.md',
  'AGENT.md',
  '.agentrc.md',
  // Claude Code 兼容
  'CLAUDE.md',
  // Cursor 兼容
  'CURSOR.md',
  '.cursorrules',
  // GitHub Copilot 兼容
  'COPILOT.md',
  '.github/copilot-instructions.md',
  // 通用项目说明
  'CONTEXT.md',
  'PROJECT.md',
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

  /** 文件树摘要 (optional) */
  fileTree?: string;

  /** 环境摘要 (optional) */
  environmentSummary?: string;

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

  /** 全局配置目录列表（优先于 globalDir） */
  globalDirs?: string[];

  /** 全局配置文件（绝对路径） */
  globalFiles?: string[];

  /** 是否注入文件树摘要 */
  includeFileTree?: boolean;

  /** 文件树最大深度 */
  fileTreeMaxDepth?: number;

  /** 文件树最大条目数 */
  fileTreeMaxEntries?: number;

  /** 文件树忽略列表 */
  fileTreeIgnore?: string[];

  /** 是否注入环境摘要 */
  includeEnvironment?: boolean;

  /** 是否在环境摘要中包含时间戳 */
  includeEnvironmentTime?: boolean;

  /** 最大文件大小（字节） */
  maxFileSize?: number;

  /** 项目上下文缓存 TTL（毫秒，未设置则仅在 workDir 变化时刷新） */
  cacheTtlMs?: number;
}

/**
 * 项目上下文配置（包含开关）
 */
export interface ProjectContextConfig extends ProjectContextLoaderConfig {
  enabled?: boolean;
}

const DEFAULT_FILE_TREE_IGNORE = [
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  '.tachikoma',
];

const DEFAULT_GLOBAL_FILES = [
  path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  path.join(os.homedir(), '.claude', 'AGENTS.md'),
];

/**
 * 默认配置
 */
export const DEFAULT_PROJECT_CONTEXT_CONFIG: ProjectContextLoaderConfig = {
  filenames: PROJECT_CONTEXT_FILES,
  searchParents: true,
  maxDepth: 10,
  loadGlobal: true,
  globalDir: path.join(os.homedir(), '.tachikoma'),
  globalFiles: DEFAULT_GLOBAL_FILES,
  includeFileTree: true,
  fileTreeMaxDepth: 3,
  fileTreeMaxEntries: 200,
  fileTreeIgnore: DEFAULT_FILE_TREE_IGNORE,
  includeEnvironment: true,
  includeEnvironmentTime: false,
  maxFileSize: 100 * 1024,
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
    const seenPaths = new Set<string>();
    const pushFile = (
      file: Omit<ProjectContextFile, 'level'>,
      level: ContextLevel
    ) => {
      const resolvedPath = path.resolve(file.path);
      if (seenPaths.has(resolvedPath)) {
        return;
      }
      seenPaths.add(resolvedPath);
      files.push({
        ...file,
        level,
      });
    };
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
        pushFile(file, currentDir === rootDir ? 'project' : 'parent');
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
      const globalDirs = this.resolveGlobalDirs();
      for (const dir of globalDirs) {
        // eslint-disable-next-line no-await-in-loop
        const dirFiles = await this.findContextFiles(dir);
        for (const file of dirFiles) {
          pushFile(file, 'global');
        }
      }

      const explicitFiles = await this.findExplicitFiles(
        this.config.globalFiles ?? []
      );
      for (const file of explicitFiles) {
        pushFile(file, 'global');
      }
    }

    const loadTimeMs = Date.now() - startTime;

    const fileTree = await this.buildFileTreeSummary(rootDir);
    const environmentSummary = await this.buildEnvironmentSummary(rootDir);

    return this.buildProjectContext(files, loadTimeMs, {
      ...(fileTree ? { fileTree } : {}),
      ...(environmentSummary ? { environmentSummary } : {}),
    });
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
        const entry = await this.readContextFile(filePath, filename);
        if (entry) {
          found.push(entry);
          // 每个目录只取第一个存在/可读取的上下文文件（按优先级）
          break;
        }
      } catch {
        // 文件不存在或不可读，继续尝试下一个
      }
    }

    return found;
  }

  private async readContextFile(
    filePath: string,
    filename: string
  ): Promise<Omit<ProjectContextFile, 'level'> | null> {
    const maxFileSize = this.config.maxFileSize ?? DEFAULT_PROJECT_CONTEXT_CONFIG.maxFileSize ?? 0;
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      return null;
    }

    if (!stats.isFile()) {
      return null;
    }

    if (maxFileSize > 0 && stats.size > maxFileSize) {
      const content = [
        `<!-- skipped: ${filename} exceeds max file size (${stats.size} > ${maxFileSize} bytes) -->`,
        '',
        `File '${filename}' was not loaded because it exceeds the max file size limit.`,
      ].join('\n');
      return {
        path: filePath,
        content,
        filename,
      };
    }

    const content = await fs.readFile(filePath, 'utf-8');
    return {
      path: filePath,
      content,
      filename,
    };
  }

  private resolveGlobalDirs(): string[] {
    if (Array.isArray(this.config.globalDirs)) {
      return this.config.globalDirs;
    }
    return [this.config.globalDir];
  }

  private async findExplicitFiles(
    filePaths: string[]
  ): Promise<Omit<ProjectContextFile, 'level'>[]> {
    const found: Omit<ProjectContextFile, 'level'>[] = [];

    for (const filePath of filePaths) {
      if (!filePath) {
        continue;
      }

      try {
        const entry = await this.readContextFile(
          filePath,
          this.formatFilename(filePath)
        );
        if (entry) {
          found.push(entry);
        }
      } catch {
        // 文件不存在或不可读，忽略
      }
    }

    return found;
  }

  private formatFilename(filePath: string): string {
    const resolved = path.resolve(filePath);
    const homeDir = os.homedir();
    if (resolved.startsWith(homeDir + path.sep)) {
      return path.relative(homeDir, resolved);
    }
    return path.basename(resolved);
  }

  private async buildFileTreeSummary(rootDir: string): Promise<string | null> {
    if (!this.config.includeFileTree) {
      return null;
    }

    const maxDepth = this.config.fileTreeMaxDepth ?? 3;
    const maxEntries = this.config.fileTreeMaxEntries ?? 200;
    const ignoreList = this.config.fileTreeIgnore ?? DEFAULT_FILE_TREE_IGNORE;
    const ignored = new Set(ignoreList);

    const lines: string[] = ['.'];
    let entries = 0;
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) {
        return;
      }

      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      dirents.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const dirent of dirents) {
        if (truncated) {
          return;
        }
        if (ignored.has(dirent.name)) {
          continue;
        }
        if (entries >= maxEntries) {
          lines.push(`${'  '.repeat(depth + 1)}...`);
          truncated = true;
          return;
        }

        entries += 1;
        const suffix = dirent.isDirectory() ? '/' : '';
        lines.push(`${'  '.repeat(depth + 1)}${dirent.name}${suffix}`);

        if (dirent.isDirectory() && depth < maxDepth) {
          await walk(path.join(dir, dirent.name), depth + 1);
        }
      }
    };

    await walk(rootDir, 0);

    if (lines.length <= 1) {
      return null;
    }

    return lines.join('\n');
  }

  private async buildEnvironmentSummary(rootDir: string): Promise<string | null> {
    if (!this.config.includeEnvironment) {
      return null;
    }

    const lines = [
      `- workdir: ${path.resolve(rootDir)}`,
      `- platform: ${process.platform} ${process.arch}`,
    ];
    if (this.config.includeEnvironmentTime) {
      lines.push(`- date: ${new Date().toISOString()}`);
    }

    const gitInfo = await this.findGitInfo(rootDir);
    if (gitInfo) {
      const detail = gitInfo.branch
        ? `branch: ${gitInfo.branch}`
        : gitInfo.commit
          ? `detached: ${gitInfo.commit}`
          : '';
      const suffix = detail ? ` (${detail})` : '';
      lines.push(`- git: ${gitInfo.root}${suffix}`);
    }

    return lines.join('\n');
  }

  private async findGitInfo(
    startDir: string
  ): Promise<{ root: string; branch?: string; commit?: string } | null> {
    let currentDir = path.resolve(startDir);

    while (true) {
      const gitPath = path.join(currentDir, '.git');
      try {
        const stat = await fs.stat(gitPath);
        let gitDir = gitPath;

        if (stat.isFile()) {
          const gitFile = await fs.readFile(gitPath, 'utf-8');
          const match = gitFile.match(/gitdir:\s*(.+)\s*/i);
          if (match?.[1]) {
            gitDir = path.resolve(currentDir, match[1].trim());
          }
        }

        const headPath = path.join(gitDir, 'HEAD');
        const head = await fs.readFile(headPath, 'utf-8');
        const headText = head.trim();

        if (headText.startsWith('ref:')) {
          const ref = headText.replace('ref:', '').trim();
          const branch = ref.startsWith('refs/heads/')
            ? ref.slice('refs/heads/'.length)
            : ref;
          return { root: currentDir, branch };
        }

        if (headText) {
          return { root: currentDir, commit: headText.slice(0, 12) };
        }

        return { root: currentDir };
      } catch {
        // Not a git directory, continue walking up
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  /**
   * 构建项目上下文
   */
  private buildProjectContext(
    files: ProjectContextFile[],
    loadTimeMs: number,
    extras?: { fileTree?: string; environmentSummary?: string }
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

    const context: ProjectContext = {
      files: sorted,
      merged,
      metadata,
    };
    if (extras?.fileTree) {
      context.fileTree = extras.fileTree;
    }
    if (extras?.environmentSummary) {
      context.environmentSummary = extras.environmentSummary;
    }

    return context;
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

    if (!this.hasProjectContext(context)) {
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

  private hasProjectContext(context: ProjectContext): boolean {
    return Boolean(
      (context.merged && context.merged.trim().length > 0) ||
      (context.fileTree && context.fileTree.trim().length > 0) ||
      (context.environmentSummary && context.environmentSummary.trim().length > 0)
    );
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

    if (context.merged) {
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
    }

    if (context.environmentSummary) {
      parts.push('\n### Environment');
      parts.push(context.environmentSummary);
    }

    if (context.fileTree) {
      parts.push('\n### File Tree');
      parts.push('```');
      parts.push(context.fileTree);
      parts.push('```');
    }

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
