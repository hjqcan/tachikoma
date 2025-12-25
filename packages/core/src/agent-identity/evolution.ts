/**
 * Core Memory 进化机制
 *
 * 实现 Agent 的学习与进化：
 * - 从成功任务中提取通用模式
 * - 学习用户偏好和工作模式
 * - 自动压缩过长的 Core Memory
 *
 * @module agent-identity/evolution
 */

import {
  IdentityLoader,
  type IdentityConfig,
  MAX_CORE_MEMORY_LENGTH,
  MAX_PREFERENCES_COUNT,
  MAX_WORK_PATTERNS_COUNT,
  DEFAULT_AGENT_ID,
} from './identity';

// ============================================================================
// 常量
// ============================================================================

/** 进化触发器类型 */
export type EvolutionTrigger =
  | 'task_success'
  | 'skill_learned'
  | 'remember_command'
  | 'explicit_feedback'
  | 'manual';

/** 学习内容类型 */
export type LearningType =
  | 'principle'      // 通用原则（进入 systemPrompt）
  | 'preference'     // 用户偏好
  | 'work_pattern'   // 工作模式
  | 'project_rule';  // 项目规则（写入 project.md）

/** 压缩策略 */
export type CompressionStrategy =
  | 'truncate_oldest'  // 截断最旧内容
  | 'summarize'        // 摘要压缩（需要 LLM）
  | 'priority_keep';   // 保留高优先级

/** 默认压缩阈值（超过此比例触发压缩） */
export const COMPRESSION_THRESHOLD_RATIO = 0.9;

/** 压缩后保留的比例 */
export const COMPRESSION_TARGET_RATIO = 0.7;

/** 单次学习内容最大长度 */
export const MAX_SINGLE_LEARNING_LENGTH = 500;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 学习记录
 */
export interface LearningRecord {
  /** 学习内容 */
  content: string;
  /** 内容类型 */
  type: LearningType;
  /** 触发来源 */
  trigger: EvolutionTrigger;
  /** 时间戳 */
  timestamp: number;
  /** 可选的上下文（如任务描述） */
  context?: string;
}

/**
 * 进化结果
 */
export interface EvolutionResult {
  success: boolean;
  /** 是否触发了压缩 */
  compressed: boolean;
  /** 添加的内容 */
  addedContent?: string;
  /** 压缩前长度 */
  originalLength?: number;
  /** 压缩后长度 */
  compressedLength?: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 进化配置
 */
export interface EvolutionConfig extends IdentityConfig {
  /** 压缩策略 */
  compressionStrategy?: CompressionStrategy;
  /** 是否自动保存（默认 true） */
  autoSave?: boolean;
}

/**
 * P1-4 安全防御：敏感信息脱敏
 *
 * 匹配常见的 token/密钥模式并替换为 [REDACTED]
 */
const SENSITIVE_PATTERNS = [
  // API Keys
  /\b(sk-[a-zA-Z0-9]{32,})\b/gi,           // OpenAI
  /\b(ghp_[a-zA-Z0-9]{36,})\b/gi,          // GitHub PAT
  /\b(gho_[a-zA-Z0-9]{36,})\b/gi,          // GitHub OAuth
  /\b(glpat-[a-zA-Z0-9]{20,})\b/gi,        // GitLab
  /\b(AKIA[A-Z0-9]{16})\b/g,               // AWS Access Key
  /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/gi,  // Slack
  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
  // Private keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
  // Generic secrets (conservative)
  /\b(password|passwd|pwd|secret|token|apikey|api_key)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
];

/**
 * Redact sensitive information from content
 *
 * Removes API keys, tokens, passwords, and other sensitive data
 * to prevent accidental exposure in SKILL.md files, logs, etc.
 */
export function redactSensitive(content: string): string {
  let redacted = content;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

/**
 * 规范化学习内容
 *
 * P1-4: 包含敏感信息脱敏
 */
function normalizeLearning(content: string): string {
  // 先脱敏，再 trim/截断
  let normalized = redactSensitive(content).trim();
  
  // 限制长度
  if (normalized.length > MAX_SINGLE_LEARNING_LENGTH) {
    normalized = normalized.slice(0, MAX_SINGLE_LEARNING_LENGTH) + '...';
  }
  
  return normalized;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0] ?? '';
}

/**
 * 截断压缩（保留最新内容）
 */
function truncateCompress(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  
  // 尝试在段落边界截断
  const targetLength = Math.floor(maxLength * COMPRESSION_TARGET_RATIO);
  const truncated = content.slice(-targetLength);
  
  // 找到第一个换行符，避免截断到段落中间
  const firstNewline = truncated.indexOf('\n');
  if (firstNewline > 0 && firstNewline < 100) {
    return truncated.slice(firstNewline + 1);
  }
  
  return truncated;
}

/**
 * 去重相似内容
 */
function deduplicateLearnings(existing: string[], newItem: string): boolean {
  const normalizedNew = newItem.toLowerCase().trim();
  
  for (const item of existing) {
    const normalizedExisting = item.toLowerCase().trim();
    
    // 完全相同
    if (normalizedExisting === normalizedNew) {
      return true;
    }
    
    // 高度相似（包含关系）
    if (
      normalizedExisting.includes(normalizedNew) ||
      normalizedNew.includes(normalizedExisting)
    ) {
      return true;
    }
  }
  
  return false;
}

// ============================================================================
// CoreMemoryEvolver
// ============================================================================

/**
 * Core Memory 进化器
 *
 * 负责 Agent 的学习与进化：
 * - 从成功任务中提取通用模式
 * - 学习用户偏好和工作模式
 * - 自动压缩过长的 Core Memory
 */
export class CoreMemoryEvolver {
  private readonly loader: IdentityLoader;
  private readonly config: EvolutionConfig;

  constructor(config: EvolutionConfig = {}) {
    this.loader = new IdentityLoader(config);
    this.config = {
      compressionStrategy: 'truncate_oldest',
      autoSave: true,
      ...config,
    };
  }

  /**
   * 进化系统提示词
   *
   * 从学习内容中提取通用原则，追加到 coreMemory.systemPrompt
   */
  async evolveSystemPrompt(
    learnings: string[],
    trigger: EvolutionTrigger = 'manual',
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<EvolutionResult> {
    if (learnings.length === 0) {
      return { success: true, compressed: false };
    }

    try {
      const identity = await this.loader.loadOrCreate(agentId);
      const originalLength = identity.coreMemory.systemPrompt.length;

      // 格式化新学习内容
      const timestamp = formatTimestamp(Date.now());
      const formattedLearnings = learnings
        .map((l) => normalizeLearning(l))
        .filter(Boolean)
        .map((l) => `- ${l}`)
        .join('\n');

      if (!formattedLearnings) {
        return { success: true, compressed: false };
      }

      const newSection = `\n### Learned on ${timestamp} (${trigger})\n\n${formattedLearnings}\n`;

      // 追加内容
      let newPrompt = identity.coreMemory.systemPrompt + newSection;

      // 检查是否需要压缩
      let compressed = false;
      const threshold = Math.floor(MAX_CORE_MEMORY_LENGTH * COMPRESSION_THRESHOLD_RATIO);
      
      if (newPrompt.length > threshold) {
        const targetLength = Math.floor(MAX_CORE_MEMORY_LENGTH * COMPRESSION_TARGET_RATIO);
        newPrompt = this.compressSystemPrompt(newPrompt, targetLength);
        compressed = true;
      }

      // 更新 Identity
      identity.coreMemory.systemPrompt = newPrompt;

      if (this.config.autoSave) {
        const saveResult = await this.loader.save(identity);
        if (!saveResult.success) {
          return {
            success: false,
            compressed,
            error: `Failed to save identity: ${saveResult.error}`,
          };
        }
      }

      return {
        success: true,
        compressed,
        addedContent: formattedLearnings,
        originalLength,
        compressedLength: newPrompt.length,
      };
    } catch (error) {
      return {
        success: false,
        compressed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 压缩系统提示词
   */
  private compressSystemPrompt(content: string, targetLength: number): string {
    switch (this.config.compressionStrategy) {
      case 'truncate_oldest':
        return truncateCompress(content, targetLength);
      
      case 'summarize':
        // TODO: 需要 LLM 支持
        console.warn('[CoreMemoryEvolver] Summarize strategy not yet implemented, falling back to truncate');
        return truncateCompress(content, targetLength);
      
      case 'priority_keep':
        // TODO: 需要优先级标记支持
        console.warn('[CoreMemoryEvolver] Priority keep strategy not yet implemented, falling back to truncate');
        return truncateCompress(content, targetLength);
      
      default:
        return truncateCompress(content, targetLength);
    }
  }

  /**
   * 学习用户偏好
   */
  async learnPreference(
    preference: string,
    _trigger: EvolutionTrigger = 'manual',
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<EvolutionResult> {
    const normalized = normalizeLearning(preference);
    if (!normalized) {
      return { success: false, compressed: false, error: 'Empty preference' };
    }

    try {
      const identity = await this.loader.loadOrCreate(agentId);

      // 去重检查
      if (deduplicateLearnings(identity.coreMemory.preferences, normalized)) {
        return { success: true, compressed: false };
      }

      let compressed = false;

      // 限制数量
      if (identity.coreMemory.preferences.length >= MAX_PREFERENCES_COUNT) {
        identity.coreMemory.preferences.shift();
        compressed = true;
      }

      identity.coreMemory.preferences.push(normalized);

      if (this.config.autoSave) {
        const saveResult = await this.loader.save(identity);
        if (!saveResult.success) {
          return {
            success: false,
            compressed,
            error: `Failed to save identity: ${saveResult.error}`,
          };
        }
      }

      return {
        success: true,
        compressed,
        addedContent: normalized,
      };
    } catch (error) {
      return {
        success: false,
        compressed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 学习工作模式
   */
  async learnWorkPattern(
    pattern: string,
    _trigger: EvolutionTrigger = 'manual',
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<EvolutionResult> {
    const normalized = normalizeLearning(pattern);
    if (!normalized) {
      return { success: false, compressed: false, error: 'Empty pattern' };
    }

    try {
      const identity = await this.loader.loadOrCreate(agentId);

      // 去重检查
      if (deduplicateLearnings(identity.coreMemory.workPatterns, normalized)) {
        return { success: true, compressed: false };
      }

      let compressed = false;

      // 限制数量
      if (identity.coreMemory.workPatterns.length >= MAX_WORK_PATTERNS_COUNT) {
        identity.coreMemory.workPatterns.shift();
        compressed = true;
      }

      identity.coreMemory.workPatterns.push(normalized);

      if (this.config.autoSave) {
        const saveResult = await this.loader.save(identity);
        if (!saveResult.success) {
          return {
            success: false,
            compressed,
            error: `Failed to save identity: ${saveResult.error}`,
          };
        }
      }

      return {
        success: true,
        compressed,
        addedContent: normalized,
      };
    } catch (error) {
      return {
        success: false,
        compressed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 批量学习
   *
   * 根据 LearningRecord 类型自动路由到对应的学习方法
   */
  async learn(records: LearningRecord[], agentId: string = DEFAULT_AGENT_ID): Promise<{
    success: boolean;
    results: EvolutionResult[];
  }> {
    const results: EvolutionResult[] = [];
    const principles: string[] = [];

    for (const record of records) {
      switch (record.type) {
        case 'principle':
          principles.push(record.content);
          break;
        
        case 'preference':
          // eslint-disable-next-line no-await-in-loop -- Sequential processing for consistent state
          results.push(await this.learnPreference(record.content, record.trigger, agentId));
          break;
        
        case 'work_pattern':
          // eslint-disable-next-line no-await-in-loop -- Sequential processing for consistent state
          results.push(await this.learnWorkPattern(record.content, record.trigger, agentId));
          break;
        
        case 'project_rule':
          // P1-1: project_rule 未实现，显式返回错误而不是静默忽略
          results.push({
            success: false,
            compressed: false,
            error: `Learning type 'project_rule' is not yet implemented. Content: '${record.content.slice(0, 50)}...'`,
          });
          break;
      }
    }

    // 批量处理原则类学习
    if (principles.length > 0) {
      const trigger = records.find((r) => r.type === 'principle')?.trigger ?? 'manual';
      results.push(await this.evolveSystemPrompt(principles, trigger, agentId));
    }

    return {
      success: results.every((r) => r.success),
      results,
    };
  }

  /**
   * 任务成功后的自动学习钩子
   */
  async onTaskSuccess(
    _taskDescription: string,
    learnings: string[],
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<EvolutionResult> {
    // P1-2: 统一通过 loader 操作，受 autoSave 控制
    const identity = await this.loader.loadOrCreate(agentId);
    identity.tasksCompleted++;

    if (learnings.length === 0) {
      // 仅增加任务计数
      if (this.config.autoSave) {
        const saveResult = await this.loader.save(identity);
        if (!saveResult.success) {
          return { success: false, compressed: false, error: saveResult.error ?? 'Unknown save error' };
        }
      }
      return { success: true, compressed: false };
    }

    // 进化系统提示词（会自行保存）
    // 但需要先保存 tasksCompleted 的更新
    if (this.config.autoSave) {
      await this.loader.save(identity);
    }
    return this.evolveSystemPrompt(learnings, 'task_success', agentId);
  }

  /**
   * 技能学习后的自动学习钩子
   */
  async onSkillLearned(
    skillName: string,
    skillSummary: string | undefined,
    agentId: string = DEFAULT_AGENT_ID
  ): Promise<EvolutionResult> {
    // P1-2: 统一通过 loader 操作，受 autoSave 控制
    const identity = await this.loader.loadOrCreate(agentId);
    
    // 记录学习的技能（去重）
    if (!identity.skillsLearned.includes(skillName)) {
      identity.skillsLearned.push(skillName);
    }

    if (this.config.autoSave) {
      const saveResult = await this.loader.save(identity);
      if (!saveResult.success) {
        return { success: false, compressed: false, error: saveResult.error ?? 'Unknown save error' };
      }
    }

    // 如果有摘要，也进化系统提示词
    if (skillSummary) {
      return this.evolveSystemPrompt(
        [`Learned skill '${skillName}': ${skillSummary}`],
        'skill_learned',
        agentId
      );
    }

    return { success: true, compressed: false };
  }

  /**
   * 获取当前 Identity 统计
   */
  async getStats(agentId: string = DEFAULT_AGENT_ID): Promise<{
    sessionsCount: number;
    tasksCompleted: number;
    skillsLearned: number;
    preferencesCount: number;
    workPatternsCount: number;
    systemPromptLength: number;
  } | null> {
    const identity = await this.loader.load(agentId);
    if (!identity) {
      return null;
    }

    return {
      sessionsCount: identity.sessionsCount,
      tasksCompleted: identity.tasksCompleted,
      skillsLearned: identity.skillsLearned.length,
      preferencesCount: identity.coreMemory.preferences.length,
      workPatternsCount: identity.coreMemory.workPatterns.length,
      systemPromptLength: identity.coreMemory.systemPrompt.length,
    };
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 Core Memory 进化器
 */
export function createCoreMemoryEvolver(config: EvolutionConfig = {}): CoreMemoryEvolver {
  return new CoreMemoryEvolver(config);
}
