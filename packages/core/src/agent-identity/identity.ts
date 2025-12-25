/**
 * Agent Identity 持久化
 *
 * 实现 Letta-Code 风格的 Agent 身份持久化：
 * - 跨会话保持 Agent 身份
 * - 记录会话统计（任务数、学习的技能）
 * - 存储可进化的 Core Memory
 *
 * 存储位置：~/.tachikoma/agents/{agentId}.json
 *
 * @module agent-identity/identity
 */

import * as fs from 'node:fs';
import { writeFile, rename, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ============================================================================
// 常量
// ============================================================================

/** Agent 存储目录 */
export const DEFAULT_AGENTS_DIR = join(homedir(), '.tachikoma', 'agents');

/** 默认 Agent ID */
export const DEFAULT_AGENT_ID = 'default';

/** Identity 文件扩展名 */
export const IDENTITY_FILE_EXTENSION = '.json';

/** 最大 Core Memory 长度（字符） */
export const MAX_CORE_MEMORY_LENGTH = 8000;

/** 最大偏好/模式条目数 */
export const MAX_PREFERENCES_COUNT = 50;
export const MAX_WORK_PATTERNS_COUNT = 50;

/** Identity 文件最大大小（字节，默认 100KB） */
export const DEFAULT_MAX_IDENTITY_FILE_SIZE = 100 * 1024;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Core Memory - Agent 的核心记忆
 *
 * 包含进化的系统提示词、用户偏好、工作模式
 */
export interface CoreMemory {
  /**
   * 进化的系统提示词片段
   *
   * 这是从学习中提取的通用原则，会注入到 system prompt
   */
  systemPrompt: string;

  /**
   * 用户偏好列表
   *
   * 例如：输出风格、语言偏好、工作方式
   */
  preferences: string[];

  /**
   * 工作模式列表
   *
   * 例如：测试优先、增量提交、文档规范
   */
  workPatterns: string[];
}

/**
 * Agent Identity - Agent 身份信息
 *
 * 跨会话保持，记录 Agent 的成长历史
 */
export interface AgentIdentity {
  /** 唯一标识符 */
  id: string;

  /** 创建时间 (Unix timestamp ms) */
  createdAt: number;

  /** 最后活跃时间 (Unix timestamp ms) */
  lastActiveAt: number;

  /** 会话总数 */
  sessionsCount: number;

  /** 完成的任务数 */
  tasksCompleted: number;

  /** 学习的技能名称列表 */
  skillsLearned: string[];

  /** 核心记忆 */
  coreMemory: CoreMemory;

  /** 版本号（用于未来迁移） */
  version: number;
}

/**
 * Identity 加载配置
 */
export interface IdentityConfig {
  /** Agent 存储目录（默认：~/.tachikoma/agents） */
  agentsDir?: string;
  /** Identity 文件最大大小（字节，默认 100KB） */
  maxFileSize?: number;
}

/**
 * Identity 操作结果
 */
export interface IdentityResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// 默认值
// ============================================================================

/** 当前 Identity 版本 */
export const CURRENT_IDENTITY_VERSION = 1;

/**
 * 创建默认 Core Memory
 */
export function createDefaultCoreMemory(): CoreMemory {
  return {
    systemPrompt: '',
    preferences: [],
    workPatterns: [],
  };
}

/**
 * 创建默认 Agent Identity
 */
export function createDefaultIdentity(agentId: string): AgentIdentity {
  const now = Date.now();
  return {
    id: agentId,
    createdAt: now,
    lastActiveAt: now,
    sessionsCount: 0,
    tasksCompleted: 0,
    skillsLearned: [],
    coreMemory: createDefaultCoreMemory(),
    version: CURRENT_IDENTITY_VERSION,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * Agent ID 允许的字符集（防止路径穿越/奇怪文件名）
 *
 * - 以字母或数字开头
 * - 只允许字母、数字、`-`、`_`
 * - 最长 64
 */
const AGENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function assertValidAgentId(agentId: string): string {
  const trimmed = agentId.trim();
  if (!AGENT_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid agentId '${agentId}'. Expected pattern ${AGENT_ID_PATTERN.toString()} (e.g. 'default', 'agent-1').`
    );
  }
  return trimmed;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

class IdentityFileTooLargeError extends Error {
  readonly filePath: string;
  readonly size: number;
  readonly maxFileSize: number;

  constructor(args: { filePath: string; size: number; maxFileSize: number }) {
    super(
      `Identity file exceeds max file size (${args.size} > ${args.maxFileSize} bytes): ${args.filePath}`
    );
    this.name = 'IdentityFileTooLargeError';
    this.filePath = args.filePath;
    this.size = args.size;
    this.maxFileSize = args.maxFileSize;
  }
}

/**
 * 获取 Identity 文件路径
 */
function getIdentityFilePath(agentId: string, agentsDir: string): string {
  const safeId = assertValidAgentId(agentId);
  return join(agentsDir, `${safeId}${IDENTITY_FILE_EXTENSION}`);
}

/**
 * 生成临时文件名
 */
function getTempFilePath(targetPath: string): string {
  const suffix = randomBytes(8).toString('hex');
  return `${targetPath}.tmp.${suffix}`;
}

/**
 * 验证 Identity 数据结构
 */
function validateIdentity(data: unknown): data is AgentIdentity {
  if (typeof data !== 'object' || data === null) return false;

  const obj = data as Record<string, unknown>;

  return (
    typeof obj.id === 'string' &&
    typeof obj.createdAt === 'number' &&
    typeof obj.sessionsCount === 'number' &&
    typeof obj.tasksCompleted === 'number' &&
    Array.isArray(obj.skillsLearned) &&
    typeof obj.coreMemory === 'object' &&
    obj.coreMemory !== null
  );
}

/**
 * 迁移旧版本 Identity 到当前版本
 */
function migrateIdentity(data: Record<string, unknown>): AgentIdentity {
  const version = typeof data.version === 'number' ? data.version : 0;

  // 确保所有必需字段存在
  const identity: AgentIdentity = {
    id: typeof data.id === 'string' ? data.id : DEFAULT_AGENT_ID,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
    lastActiveAt: typeof data.lastActiveAt === 'number' ? data.lastActiveAt : Date.now(),
    sessionsCount: typeof data.sessionsCount === 'number' ? data.sessionsCount : 0,
    tasksCompleted: typeof data.tasksCompleted === 'number' ? data.tasksCompleted : 0,
    skillsLearned: normalizeStringArray(data.skillsLearned),
    coreMemory: createDefaultCoreMemory(),
    version: CURRENT_IDENTITY_VERSION,
  };

  // 迁移 coreMemory
  if (typeof data.coreMemory === 'object' && data.coreMemory !== null) {
    const cm = data.coreMemory as Record<string, unknown>;
    identity.coreMemory = {
      systemPrompt: typeof cm.systemPrompt === 'string' ? cm.systemPrompt : '',
      preferences: normalizeStringArray(cm.preferences),
      workPatterns: normalizeStringArray(cm.workPatterns),
    };
  }

  // 版本迁移钩子（未来扩展）
  if (version < CURRENT_IDENTITY_VERSION) {
    // 目前无需迁移逻辑
    console.debug(`[Identity] Migrated identity from v${version} to v${CURRENT_IDENTITY_VERSION}`);
  }

  return identity;
}

// ============================================================================
// Identity 加载器
// ============================================================================

/**
 * Identity 加载器
 *
 * 负责从文件系统加载和保存 Agent Identity
 */
export class IdentityLoader {
  private readonly agentsDir: string;
  private readonly maxFileSize: number;

  constructor(config: IdentityConfig = {}) {
    this.agentsDir = config.agentsDir ?? DEFAULT_AGENTS_DIR;
    this.maxFileSize = config.maxFileSize ?? DEFAULT_MAX_IDENTITY_FILE_SIZE;
  }

  /**
   * 加载 Agent Identity
   *
   * @param agentId - Agent ID（默认：'default'）
   * @returns Identity 或 null（如果不存在）
   */
  async load(agentId: string = DEFAULT_AGENT_ID): Promise<AgentIdentity | null> {
    const safeId = assertValidAgentId(agentId);
    const filePath = getIdentityFilePath(safeId, this.agentsDir);

    try {
      // P0: 先检查文件大小，避免读取超大文件导致 OOM
      const stats = await stat(filePath);
      if (stats.size > this.maxFileSize) {
        throw new IdentityFileTooLargeError({
          filePath,
          size: stats.size,
          maxFileSize: this.maxFileSize,
        });
      }

      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // 始终通过迁移确保字段完整（向后兼容）
      // 即使结构有效，也可能缺少新版本的字段（如 lastActiveAt）
      if (!validateIdentity(data)) {
        console.warn(`[IdentityLoader] Identity '${agentId}' has invalid structure, attempting migration`);
      }
      
      const migrated = migrateIdentity(data);
      // 文件名是权威来源：避免文件内容里的 id 与请求的 agentId 不一致导致“另存为”或路径风险
      migrated.id = safeId;
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async quarantineIdentityFile(args: {
    agentId: string;
    reason: 'corrupt' | 'oversized';
  }): Promise<void> {
    const filePath = getIdentityFilePath(args.agentId, this.agentsDir);
    const suffix = `${args.reason}.${Date.now()}.${randomBytes(4).toString('hex')}`;
    const quarantinePath = `${filePath}.${suffix}`;
    try {
      await rename(filePath, quarantinePath);
      console.warn(`[IdentityLoader] Quarantined identity file: ${quarantinePath}`);
    } catch {
      // best-effort
    }
  }

  /**
   * 加载 Identity，如果不存在则创建默认
   */
  async loadOrCreate(agentId: string = DEFAULT_AGENT_ID): Promise<AgentIdentity> {
    const safeId = assertValidAgentId(agentId);

    try {
      const existing = await this.load(safeId);
      if (existing) {
        return existing;
      }
    } catch (error) {
      // 仅对“可恢复”的错误进行隔离并重建（避免把权限/IO 错误吞掉）
      if (error instanceof SyntaxError) {
        await this.quarantineIdentityFile({ agentId: safeId, reason: 'corrupt' });
      } else if (error instanceof IdentityFileTooLargeError) {
        await this.quarantineIdentityFile({ agentId: safeId, reason: 'oversized' });
      } else {
        throw error;
      }
    }

    const newIdentity = createDefaultIdentity(safeId);
    const saved = await this.save(newIdentity);
    if (!saved.success) {
      throw new Error(saved.error ?? 'Failed to create new identity');
    }
    console.debug(`[IdentityLoader] Created new identity for agent '${safeId}'`);
    return newIdentity;
  }

  /**
   * 保存 Agent Identity
   *
   * 使用原子写入确保数据完整性
   */
  async save(identity: AgentIdentity): Promise<IdentityResult<void>> {
    let filePath: string;
    try {
      filePath = getIdentityFilePath(identity.id, this.agentsDir);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // 更新最后活跃时间
    identity.lastActiveAt = Date.now();

    // 确保目录存在
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });

    // 原子写入
    const tempPath = getTempFilePath(filePath);
    try {
      const content = JSON.stringify(identity, null, 2);
      await writeFile(tempPath, content, 'utf-8');
      await rename(tempPath, filePath);

      return { success: true };
    } catch (error) {
      // 清理临时文件
      try {
        await rm(tempPath, { force: true });
      } catch {
        // ignore cleanup errors
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 删除 Agent Identity
   */
  async delete(agentId: string): Promise<boolean> {
    let filePath: string;
    try {
      filePath = getIdentityFilePath(agentId, this.agentsDir);
    } catch {
      return false;
    }
    try {
      await rm(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出所有 Agent ID
   */
  async listAgents(): Promise<string[]> {
    try {
      const files = fs.readdirSync(this.agentsDir);
      return files
        .filter((f) => f.endsWith(IDENTITY_FILE_EXTENSION))
        .map((f) => f.slice(0, -IDENTITY_FILE_EXTENSION.length));
    } catch {
      return [];
    }
  }

  /**
   * 检查 Identity 是否存在
   */
  async exists(agentId: string): Promise<boolean> {
    let filePath: string;
    try {
      filePath = getIdentityFilePath(agentId, this.agentsDir);
    } catch {
      return false;
    }
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Identity 更新器
// ============================================================================

/**
 * Identity 更新器
 *
 * 提供便捷的 Identity 更新方法
 */
export class IdentityUpdater {
  private readonly loader: IdentityLoader;

  constructor(config: IdentityConfig = {}) {
    this.loader = new IdentityLoader(config);
  }

  /**
   * 增加会话计数
   */
  async incrementSessionCount(agentId: string = DEFAULT_AGENT_ID): Promise<void> {
    const identity = await this.loader.loadOrCreate(agentId);
    identity.sessionsCount++;
    await this.loader.save(identity);
  }

  /**
   * 增加任务完成计数
   */
  async incrementTasksCompleted(agentId: string = DEFAULT_AGENT_ID): Promise<void> {
    const identity = await this.loader.loadOrCreate(agentId);
    identity.tasksCompleted++;
    await this.loader.save(identity);
  }

  /**
   * 记录学习的技能
   */
  async addLearnedSkill(
    skillName: string,
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<void> {
    const identity = await this.loader.loadOrCreate(agentId);
    if (!identity.skillsLearned.includes(skillName)) {
      identity.skillsLearned.push(skillName);
      await this.loader.save(identity);
    }
  }

  /**
   * 添加用户偏好
   */
  async addPreference(
    preference: string,
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<void> {
    const identity = await this.loader.loadOrCreate(agentId);

    // 避免重复
    if (identity.coreMemory.preferences.includes(preference)) {
      return;
    }

    // 限制数量
    if (identity.coreMemory.preferences.length >= MAX_PREFERENCES_COUNT) {
      identity.coreMemory.preferences.shift(); // 移除最旧的
    }

    identity.coreMemory.preferences.push(preference);
    await this.loader.save(identity);
  }

  /**
   * 添加工作模式
   */
  async addWorkPattern(
    pattern: string,
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<void> {
    const identity = await this.loader.loadOrCreate(agentId);

    // 避免重复
    if (identity.coreMemory.workPatterns.includes(pattern)) {
      return;
    }

    // 限制数量
    if (identity.coreMemory.workPatterns.length >= MAX_WORK_PATTERNS_COUNT) {
      identity.coreMemory.workPatterns.shift(); // 移除最旧的
    }

    identity.coreMemory.workPatterns.push(pattern);
    await this.loader.save(identity);
  }

  /**
   * 追加系统提示词
   */
  async appendSystemPrompt(
    content: string,
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<void> {
    const identity = await this.loader.loadOrCreate(agentId);

    const newPrompt = identity.coreMemory.systemPrompt
      ? `${identity.coreMemory.systemPrompt}\n\n${content}`
      : content;

    // 限制长度
    if (newPrompt.length > MAX_CORE_MEMORY_LENGTH) {
      // 简单截断策略（保留最新内容）
      identity.coreMemory.systemPrompt = newPrompt.slice(-MAX_CORE_MEMORY_LENGTH);
      console.warn('[IdentityUpdater] Core memory systemPrompt truncated to max length');
    } else {
      identity.coreMemory.systemPrompt = newPrompt;
    }

    await this.loader.save(identity);
  }

  /**
   * 获取 Core Memory 用于 Prompt 注入
   */
  async getCoreMemoryForPrompt(agentId: string = DEFAULT_AGENT_ID): Promise<string | null> {
    const identity = await this.loader.load(agentId);
    if (!identity) {
      return null;
    }

    const parts: string[] = [];

    // System prompt 进化内容
    if (identity.coreMemory.systemPrompt) {
      parts.push(`## Learned Principles\n\n${identity.coreMemory.systemPrompt}`);
    }

    // 用户偏好
    if (identity.coreMemory.preferences.length > 0) {
      parts.push(`## User Preferences\n\n${identity.coreMemory.preferences.map((p) => `- ${p}`).join('\n')}`);
    }

    // 工作模式
    if (identity.coreMemory.workPatterns.length > 0) {
      parts.push(`## Work Patterns\n\n${identity.coreMemory.workPatterns.map((p) => `- ${p}`).join('\n')}`);
    }

    if (parts.length === 0) {
      return null;
    }

    return `# Agent Core Memory\n\n${parts.join('\n\n')}`;
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 Identity 加载器
 */
export function createIdentityLoader(config: IdentityConfig = {}): IdentityLoader {
  return new IdentityLoader(config);
}

/**
 * 创建 Identity 更新器
 */
export function createIdentityUpdater(config: IdentityConfig = {}): IdentityUpdater {
  return new IdentityUpdater(config);
}

/**
 * 获取 Agent 存储目录
 */
export function getAgentsDir(): string {
  return DEFAULT_AGENTS_DIR;
}

/**
 * 从环境变量或默认值获取 Agent ID
 */
export function getAgentIdFromEnv(): string {
  return process.env.TACHIKOMA_AGENT_ID ?? DEFAULT_AGENT_ID;
}
