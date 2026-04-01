/**
 * Memory Block 分层架构
 *
 * 实现 Letta-Code 风格的分层 Memory Blocks：
 * - 全局块（~/.tachikoma/memory/）：persona, preferences
 * - 项目块（${project}/.tachikoma/memory/）：project, skills, loaded_skills
 *
 * @module agent-identity/blocks
 */

import * as fs from 'node:fs';
import { writeFile, rename, mkdir, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ============================================================================
// 常量与类型
// ============================================================================

/**
 * Block 作用域
 */
export type BlockScope = 'global' | 'project';

/**
 * Block 标签（全部可用的 block 名称）
 */
export const BLOCK_LABELS = {
  /** 全局块：跨项目共享 */
  GLOBAL: ['persona', 'preferences'] as const,
  /** 项目块：按 workDir 隔离 */
  PROJECT: ['project', 'skills', 'loaded_skills'] as const,
  /** 只读块：由工具管理，用户不能直接写入 */
  READ_ONLY: ['skills', 'loaded_skills'] as const,
} as const;

/** 全局块标签类型 */
export type GlobalBlockLabel = (typeof BLOCK_LABELS.GLOBAL)[number];
/** 项目块标签类型 */
export type ProjectBlockLabel = (typeof BLOCK_LABELS.PROJECT)[number];
/** 只读块标签类型 */
export type ReadOnlyBlockLabel = (typeof BLOCK_LABELS.READ_ONLY)[number];
/** 所有块标签类型 */
export type BlockLabel = GlobalBlockLabel | ProjectBlockLabel;

/**
 * Memory Block 接口
 */
export interface MemoryBlock {
  /** 块标签（唯一标识） */
  label: BlockLabel;
  /** 块内容（Markdown 文本） */
  value: string;
  /** 块描述（用于 LLM 理解） */
  description?: string;
  /** 是否只读（由工具管理，用户不能直接写入） */
  readOnly: boolean;
  /** 作用域 */
  scope: BlockScope;
  /** 最后修改时间 */
  updatedAt?: number;
  /** 文件超过大小限制，内容被拒绝加载 */
  oversized?: boolean;
  /** 原始文件大小（字节，仅当 oversized 时填充） */
  originalSize?: number;
}

/**
 * Block 操作配置
 */
export interface BlockConfig {
  /** 全局块存储目录（默认：~/.tachikoma/memory） */
  globalDir?: string;
  /** 项目块存储目录（默认：${workDir}/.tachikoma/memory） */
  projectDir?: string;
  /** 当前工作目录 */
  workDir: string;
  /** 最大文件大小（字节，默认 100KB） */
  maxFileSize?: number;
}

/**
 * BlockLoader/Writer 配置（已解析）
 */
interface ResolvedConfig {
  globalDir: string;
  projectDir: string;
  maxFileSize: number;
}

// ============================================================================
// 默认值
// ============================================================================

/** 默认全局目录 */
export const DEFAULT_GLOBAL_MEMORY_DIR = join(homedir(), '.tachikoma', 'memory');
/** 默认最大文件大小 100KB */
export const DEFAULT_MAX_FILE_SIZE = 100 * 1024;
/** 块文件扩展名 */
export const BLOCK_FILE_EXTENSION = '.md';

/**
 * 受信任的调用来源（允许绕过只读保护）
 */
export const TRUSTED_SOURCES = [
  'skill-command',
  'skill-blocks-sync',
  'system-init',
] as const;

export type TrustedSource = (typeof TRUSTED_SOURCES)[number];

// ============================================================================
// 默认 Block 内容
// ============================================================================

/** 默认 Block 描述 */
export const BLOCK_DESCRIPTIONS: Record<BlockLabel, string> = {
  persona: 'Agent 的人格与身份（谨慎修改）',
  preferences: '用户偏好与工作习惯（通过 /remember 更新）',
  project: '项目规则与约束（通过 /remember 或手动编辑）',
  skills: '可用技能列表（由 skill tool 管理，只读）',
  loaded_skills: '已加载技能内容（由 /skill load 管理，只读）',
};

/** 默认空块内容 */
export const DEFAULT_BLOCK_CONTENT: Record<BlockLabel, string> = {
  persona: `# Persona

You are Tachikoma, a helpful AI assistant.
`,
  preferences: `# Preferences

(No preferences recorded yet. Use /remember to add.)
`,
  project: `# Project Rules

(No project-specific rules defined yet.)
`,
  skills: `(No skills discovered. Run skill refresh to update.)
`,
  loaded_skills: `(No skills loaded. Use /skill load <name> to load.)
`,
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析配置
 */
function resolveConfig(config: BlockConfig): ResolvedConfig {
  return {
    globalDir: config.globalDir ?? DEFAULT_GLOBAL_MEMORY_DIR,
    projectDir: config.projectDir ?? join(config.workDir, '.tachikoma', 'memory'),
    maxFileSize: config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
  };
}

/**
 * 获取块的作用域
 */
export function getBlockScope(label: BlockLabel): BlockScope {
  if ((BLOCK_LABELS.GLOBAL as readonly string[]).includes(label)) {
    return 'global';
  }
  return 'project';
}

/**
 * 判断是否为只读块
 */
export function isReadOnlyBlock(label: BlockLabel): boolean {
  return (BLOCK_LABELS.READ_ONLY as readonly string[]).includes(label);
}

/**
 * 获取块文件路径
 */
function getBlockFilePath(
  label: BlockLabel,
  resolvedConfig: ResolvedConfig
): string {
  const scope = getBlockScope(label);
  const dir = scope === 'global' ? resolvedConfig.globalDir : resolvedConfig.projectDir;
  return join(dir, `${label}${BLOCK_FILE_EXTENSION}`);
}

/**
 * 规范化文本（统一换行、去除非法字符）
 */
function normalizeContent(content: string): string {
  // 统一换行符为 LF
  let normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 去除 NUL 字符
  normalized = normalized.replace(/\0/g, '');
  // 确保以换行结尾
  if (!normalized.endsWith('\n')) {
    normalized += '\n';
  }
  return normalized;
}

/**
 * 生成临时文件名
 */
function getTempFilePath(targetPath: string): string {
  const suffix = randomBytes(8).toString('hex');
  return `${targetPath}.tmp.${suffix}`;
}

// ============================================================================
// BlockLoader
// ============================================================================

/**
 * Block 加载器
 *
 * 从文件系统加载 Memory Blocks
 */
export class BlockLoader {
  private readonly config: ResolvedConfig;

  constructor(blockConfig: BlockConfig) {
    this.config = resolveConfig(blockConfig);
  }

  /**
   * 加载单个块
   *
   * @param label - 块标签
   * @returns MemoryBlock 或 null（如果文件不存在）
   * 
   * 安全特性：
   * - 先 stat 检查文件大小，再 read（防止 OOM）
   * - 超过 maxFileSize 的文件返回 oversized 占位符，不读取内容
   */
  async load(label: BlockLabel): Promise<MemoryBlock | null> {
    const filePath = getBlockFilePath(label, this.config);

    try {
      // P0-1 修复：先 stat 检查大小，防止读取超大文件
      const stats = fs.statSync(filePath);
      
      // 超过大小限制，返回占位符而不是读取文件
      if (stats.size > this.config.maxFileSize) {
        console.warn(
          `[BlockLoader] Block '${label}' file exceeds size limit ` +
          `(${stats.size} > ${this.config.maxFileSize} bytes). ` +
          `Content not loaded to prevent OOM.`
        );
        return {
          label,
          value: `(Block '${label}' was not loaded: file size ${stats.size} bytes exceeds limit of ${this.config.maxFileSize} bytes. Please reduce the file size.)`,
          description: BLOCK_DESCRIPTIONS[label],
          readOnly: isReadOnlyBlock(label),
          scope: getBlockScope(label),
          updatedAt: stats.mtimeMs,
          oversized: true,
          originalSize: stats.size,
        };
      }
      
      const content = await readFile(filePath, 'utf-8');
      
      return {
        label,
        value: content,
        description: BLOCK_DESCRIPTIONS[label],
        readOnly: isReadOnlyBlock(label),
        scope: getBlockScope(label),
        updatedAt: stats.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 加载单个块，如果不存在则返回默认内容
   */
  async loadOrDefault(label: BlockLabel): Promise<MemoryBlock> {
    const existing = await this.load(label);
    if (existing) {
      return existing;
    }

    return {
      label,
      value: DEFAULT_BLOCK_CONTENT[label],
      description: BLOCK_DESCRIPTIONS[label],
      readOnly: isReadOnlyBlock(label),
      scope: getBlockScope(label),
    };
  }

  /**
   * 按作用域加载所有块
   *
   * @param scope - 作用域（'global' | 'project'）
   * @returns 块列表
   */
  async loadByScope(scope: BlockScope): Promise<MemoryBlock[]> {
    const labels = scope === 'global' ? BLOCK_LABELS.GLOBAL : BLOCK_LABELS.PROJECT;
    const blocks: MemoryBlock[] = [];

    for (const label of labels) {
      // eslint-disable-next-line no-await-in-loop -- Sequential load is intentional for predictable ordering
      const block = await this.loadOrDefault(label);
      blocks.push(block);
    }

    return blocks;
  }

  /**
   * 加载所有块（全局 + 项目）
   */
  async loadAll(): Promise<MemoryBlock[]> {
    const globalBlocks = await this.loadByScope('global');
    const projectBlocks = await this.loadByScope('project');
    return [...globalBlocks, ...projectBlocks];
  }
}

// ============================================================================
// BlockWriter
// ============================================================================

/**
 * Block 写入结果
 */
export interface BlockWriteResult {
  success: boolean;
  label: BlockLabel;
  filePath: string;
  error?: string;
}

/**
 * Block 写入选项
 */
export interface BlockWriteOptions {
  /**
   * 是否强制写入只读块（仅限受信调用者）
   * 
   * 只有 /skill 命令等受信同步流程才应设置此项
   */
  forceReadOnly?: boolean;
  /**
   * 调用来源（用于审计）
   */
  source?: string;
}

/**
 * Block 写入器
 *
 * 使用原子写入（写入临时文件 → rename）确保数据完整性
 */
export class BlockWriter {
  private readonly config: ResolvedConfig;

  constructor(blockConfig: BlockConfig) {
    this.config = resolveConfig(blockConfig);
  }

  /**
   * 写入块内容
   *
   * @param label - 块标签
   * @param content - 块内容
   * @param options - 写入选项
   * @returns 写入结果
   */
  async write(
    label: BlockLabel,
    content: string,
    options: BlockWriteOptions = {}
  ): Promise<BlockWriteResult> {
    const filePath = getBlockFilePath(label, this.config);

    // 1. 只读检查（除非 forceReadOnly + 受信来源）
    if (isReadOnlyBlock(label)) {
      if (!options.forceReadOnly) {
        return {
          success: false,
          label,
          filePath,
          error: `Block '${label}' is read-only. Use skill tool or /skill command to modify.`,
        };
      }
      // P1-2 修复：forceReadOnly 必须提供受信来源
      if (!options.source || !(TRUSTED_SOURCES as readonly string[]).includes(options.source)) {
        return {
          success: false,
          label,
          filePath,
          error: `forceReadOnly requires a trusted source. Provided: '${options.source ?? '(none)'}'. Allowed: ${TRUSTED_SOURCES.join(', ')}.`,
        };
      }
    }

    // 2. 规范化内容
    const normalized = normalizeContent(content);

    // 3. 大小检查
    const sizeBytes = Buffer.byteLength(normalized, 'utf-8');
    if (sizeBytes > this.config.maxFileSize) {
      return {
        success: false,
        label,
        filePath,
        error: `Content exceeds max file size (${sizeBytes} > ${this.config.maxFileSize} bytes).`,
      };
    }

    // 4. 确保目录存在
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    // 5. 原子写入
    const tempPath = getTempFilePath(filePath);
    try {
      await writeFile(tempPath, normalized, 'utf-8');
      await rename(tempPath, filePath);

      return {
        success: true,
        label,
        filePath,
      };
    } catch (error) {
      // 清理临时文件
      try {
        await rm(tempPath, { force: true });
      } catch {
        // ignore cleanup errors
      }

      return {
        success: false,
        label,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 批量写入多个块
   */
  async writeMultiple(
    blocks: { label: BlockLabel; content: string }[],
    options: BlockWriteOptions = {}
  ): Promise<BlockWriteResult[]> {
    const results: BlockWriteResult[] = [];
    for (const { label, content } of blocks) {
      // eslint-disable-next-line no-await-in-loop -- Sequential write is intentional for error handling
      const result = await this.write(label, content, options);
      results.push(result);
    }
    return results;
  }

  /**
   * 删除块文件（慎用）
   * 
   * P1-1 修复：只读块需要 forceReadOnly + 受信来源
   */
  async delete(
    label: BlockLabel,
    options: BlockWriteOptions = {}
  ): Promise<{ success: boolean; error?: string }> {
    const filePath = getBlockFilePath(label, this.config);

    // P1-1 修复：删除也需要只读检查
    if (isReadOnlyBlock(label)) {
      if (!options.forceReadOnly) {
        return {
          success: false,
          error: `Block '${label}' is read-only. Cannot delete without forceReadOnly and trusted source.`,
        };
      }
      if (!options.source || !(TRUSTED_SOURCES as readonly string[]).includes(options.source)) {
        return {
          success: false,
          error: `forceReadOnly delete requires a trusted source. Provided: '${options.source ?? '(none)'}'. Allowed: ${TRUSTED_SOURCES.join(', ')}.`,
        };
      }
    }

    try {
      await rm(filePath, { force: true });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 BlockLoader
 */
export function createBlockLoader(config: BlockConfig): BlockLoader {
  return new BlockLoader(config);
}

/**
 * 创建 BlockWriter
 */
export function createBlockWriter(config: BlockConfig): BlockWriter {
  return new BlockWriter(config);
}

/**
 * 获取全局 blocks 目录
 */
export function getGlobalBlocksDir(): string {
  return DEFAULT_GLOBAL_MEMORY_DIR;
}

/**
 * 获取项目 blocks 目录
 */
export function getProjectBlocksDir(workDir: string): string {
  return join(workDir, '.tachikoma', 'memory');
}
