/**
 * Skill Creation Module
 *
 * 基于反思结果生成 SKILL.md（知识型技能）
 * 参考 Letta 的 Skill Learning 两阶段设计（Reflection + Creation）
 *
 * @module skills/learning/creation
 */

import { mkdir, writeFile, access, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReflectionResult, FailureMode } from './reflection';
import { redactSensitive } from '../../agent-identity/evolution';

const SKILL_MD_FILENAME = 'SKILL.md';
const SKILL_META_FILENAME = '.tachikoma-skill-meta.json';

type SkillSource = 'auto' | 'manual';

interface SkillMetaFile {
  name: string;
  score: number;
  createdAt: number;
  updatedAt: number;
  source?: SkillSource | undefined;
  taskDescription?: string | undefined;
  toolCallCount?: number | undefined;
  durationMs?: number | undefined;
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 创建技能的配置
 */
export interface SkillCreationConfig {
  /** 技能存储目录 */
  skillsDir: string;
  /** 是否覆盖已存在的技能 */
  overwrite?: boolean | undefined;
  /** 自动更新相似技能（命中去重策略时覆盖已有技能） */
  autoUpdateSimilar?: boolean | undefined;
  /**
   * 目录内最多保留的技能数量（Top-K 高质量技能）
   *
   * 超过上限时，基于 meta.score 淘汰最低分技能。
   */
  maxSkills?: number | undefined;
  /** 用户指导（可选，追加到技能内容） */
  userGuidance?: string | undefined;
  /** 生成后刷新技能列表的回调 */
  onCreated?: ((skillPath: string) => Promise<void>) | undefined;
}

/**
 * 创建技能的输入
 */
export interface SkillCreationInput {
  /** 反思结果 */
  reflection: ReflectionResult;
  /** 技能名称（可选，默认使用 reflection.suggestedSkillName） */
  name?: string;
  /** 技能描述（可选，默认使用 reflection.suggestedSkillDescription） */
  description?: string;
  /** 标签（可选，默认使用 reflection.suggestedTags） */
  tags?: string[];
  /** 分类 */
  category?: string;
  /**
   * 治理元信息（用于 Top-K、去重与审计）
   *
   * score 建议由上游（learnSkillFromTrajectory）结合 trajectory+reflection 计算。
   */
  meta?: {
    score?: number;
    source?: SkillSource;
    taskDescription?: string;
    toolCallCount?: number;
    durationMs?: number;
  } | undefined;
}

/**
 * 创建技能的结果
 */
export interface SkillCreationResult {
  /** 是否成功 */
  success: boolean;
  /** 技能名称 */
  name?: string;
  /** 技能路径 */
  path?: string;
  /** 生成的 SKILL.md 内容 */
  content?: string;
  /** 错误信息 */
  error?: string;
}

// ============================================================================
// 技能创建器
// ============================================================================

/**
 * 技能创建器
 *
 * 基于反思结果生成知识型技能（skillType: 'knowledge'）
 */
export class SkillCreator {
  private readonly config: SkillCreationConfig;

  constructor(config: SkillCreationConfig) {
    this.config = {
      overwrite: false,
      autoUpdateSimilar: false,
      ...config,
    };
  }

  /**
   * 创建技能
   *
   * @param input - 创建输入
   * @returns 创建结果
   */
  async create(input: SkillCreationInput): Promise<SkillCreationResult> {
    const { reflection } = input;

    // 归一化 reflection 字段，防止上游缺字段导致崩溃
    const safeReflection = this.normalizeReflection(reflection);

    // 1. 确定技能名称（空串视为无效，使用 fallback）
    const rawName = this.getValidString(
      input.name,
      safeReflection.suggestedSkillName,
      'learned-skill',
    );
    let name = this.sanitizeName(rawName);

    // 2. 确定技能描述
    const description = this.getValidString(
      input.description,
      safeReflection.suggestedSkillDescription,
      safeReflection.reasoningSummary,
    );

    // 3. 确定标签（过滤空串）
    const tags = (input.tags ?? safeReflection.suggestedTags ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const incomingScore = input.meta?.score ?? this.estimateQualityScore(safeReflection);

    // 4. 治理：列出现有技能（用于去重/Top-K）
    const existing = await this.listExistingSkills();
    const existingNames = existing.map((s) => s.name);

    // 5. 去重：相似技能 -> 自动更新（C-auto / top-K）
    const similar = this.findSimilarSkillFromList(name, existingNames);
    let effectiveOverwrite = this.config.overwrite === true;
    if (similar && this.config.autoUpdateSimilar) {
      name = similar;
      effectiveOverwrite = true;
    } else if (similar && !effectiveOverwrite) {
      return {
        success: false,
        error: `Skill governance: Similar skill "${similar}" already exists. Consider updating it instead.`,
      };
    }

    const skillDir = join(this.config.skillsDir, name);
    const skillMdPath = join(skillDir, SKILL_MD_FILENAME);

    try {
      await access(skillDir);
      // 目录存在：如不允许覆盖则报错；如允许覆盖则执行质量回归保护
      if (!effectiveOverwrite) {
        return {
          success: false,
          error: `Skill "${name}" already exists. Set overwrite: true to replace.`,
        };
      }

      // 质量回归保护：不允许用更低分覆盖更高分技能
      const existingMeta = existing.find((s) => s.name === name);
      if (existingMeta && existingMeta.score !== undefined && incomingScore < existingMeta.score) {
        return {
          success: false,
          error: `Skill governance: Quality regression blocked. New score ${incomingScore.toFixed(3)} < existing ${existingMeta.score.toFixed(3)} for "${name}".`,
        };
      }
    } catch {
      // 目录不存在，可以创建
    }

    // 6. Top-K：如果要创建新技能且已达到上限，则按分数淘汰最低分
    const maxSkills = this.config.maxSkills;
    const existsAlready = existingNames.includes(name);
    if (!existsAlready && typeof maxSkills === 'number' && maxSkills > 0 && existing.length >= maxSkills) {
      const worst = [...existing].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
      const worstScore = worst?.score ?? 0;
      const worstName = worst?.name ?? 'unknown';
      if (incomingScore <= worstScore) {
        return {
          success: false,
          error: `Skill governance: maxSkills=${maxSkills} reached. New score ${incomingScore.toFixed(3)} <= worst ${worstScore.toFixed(3)} (${worstName}). Skipping.`,
        };
      }
      if (worst?.dir) {
        await rm(worst.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // 5. 生成 SKILL.md 内容
    const rawContent = this.generateSkillContent({
      name,
      description,
      tags,
      category: input.category?.trim() || undefined,
      reflection: safeReflection,
      userGuidance: this.config.userGuidance,
    });

    // P1 去敏：在保存前移除敏感信息
    const content = redactSensitive(rawContent);

    // 6. 创建目录和文件
    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillMdPath, content, 'utf-8');

      // 6.1 写入技能元信息（用于 Top-K 与审计）
      const now = Date.now();
      const prev = await this.readMetaFile(skillDir).catch(() => null);
      const meta: SkillMetaFile = {
        name,
        score: incomingScore,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        ...(input.meta?.source ? { source: input.meta.source } : {}),
        ...(input.meta?.taskDescription ? { taskDescription: input.meta.taskDescription } : {}),
        ...(input.meta?.toolCallCount !== undefined ? { toolCallCount: input.meta.toolCallCount } : {}),
        ...(input.meta?.durationMs !== undefined ? { durationMs: input.meta.durationMs } : {}),
      };
      await writeFile(join(skillDir, SKILL_META_FILENAME), JSON.stringify(meta, null, 2), 'utf-8').catch(() => undefined);

      // 7. 调用刷新回调
      if (this.config.onCreated) {
        await this.config.onCreated(skillDir);
      }

      return {
        success: true,
        name,
        path: skillMdPath,
        content,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create skill: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * P1 去重：查找相似命名的技能
   *
   * 使用编辑距离阈值防止产生同质技能目录堆积
   */
  private findSimilarSkillFromList(name: string, existingSkills: string[]): string | null {
    for (const existing of existingSkills) {
      if (
        existing.includes(name) ||
        name.includes(existing)
      ) {
        return existing;
      }
      const minLen = Math.min(name.length, existing.length);
      if (minLen >= 12) {
        const dist = this.levenshteinDistance(name, existing);
        const ratio = dist / minLen;
        if (ratio < 0.2) {
          return existing;
        }
      }
    }
    return null;
  }

  private async listExistingSkills(): Promise<{ name: string; dir: string; score?: number }[]> {
    try {
      const entries = await readdir(this.config.skillsDir, { withFileTypes: true });
      const candidates = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, dir: join(this.config.skillsDir, e.name) }));

      const resolved = await Promise.all(
        candidates.map(async (c) => {
          try {
            await access(join(c.dir, SKILL_MD_FILENAME));
          } catch {
            return null;
          }
          const meta = await this.readMetaFile(c.dir).catch(() => null);
          return {
            name: c.name,
            dir: c.dir,
            ...(meta?.score !== undefined ? { score: meta.score } : {}),
          };
        }),
      );

      return resolved.filter((x): x is { name: string; dir: string; score?: number } => x !== null);
    } catch {
      return [];
    }
  }

  private async readMetaFile(skillDir: string): Promise<SkillMetaFile | null> {
    try {
      const raw = await readFile(join(skillDir, SKILL_META_FILENAME), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SkillMetaFile>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.createdAt !== 'number' || typeof parsed.updatedAt !== 'number') return null;
      return {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        score: typeof parsed.score === 'number' ? parsed.score : 0,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.taskDescription ? { taskDescription: parsed.taskDescription } : {}),
        ...(typeof parsed.toolCallCount === 'number' ? { toolCallCount: parsed.toolCallCount } : {}),
        ...(typeof parsed.durationMs === 'number' ? { durationMs: parsed.durationMs } : {}),
      };
    } catch {
      return null;
    }
  }

  private estimateQualityScore(reflection: ReflectionResult): number {
    // 轻量启发式：有更多高置信 patterns / knowledge 时分更高
    const patternScore = (reflection.patterns ?? []).reduce((sum, p) => {
      const conf = typeof p.confidence === 'number' ? p.confidence : 0.6;
      return sum + Math.max(0, Math.min(1, conf));
    }, 0);
    const knowledgeScore = (reflection.abstractableKnowledge ?? []).length * 0.8;
    const failureScore = (reflection.failureModes ?? []).length * 0.2;
    return Number((patternScore + knowledgeScore + failureScore).toFixed(3));
  }

  /**
   * 计算两个字符串的编辑距离（Levenshtein distance）
   */
  private levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Create matrix with proper initialization
    const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) =>
      Array.from({ length: a.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1,      // deletion
          matrix[i]![j - 1]! + 1,      // insertion
          matrix[i - 1]![j - 1]! + cost // substitution
        );
      }
    }
    return matrix[b.length]![a.length]!;
  }

  /**
   * 获取有效字符串（跳过空串）
   */
  private getValidString(...candidates: (string | undefined)[]): string {
    for (const c of candidates) {
      const trimmed = c?.trim();
      if (trimmed && trimmed.length > 0) {
        return trimmed;
      }
    }
    return 'learned-skill'; // 最终 fallback
  }

  /**
   * 归一化 reflection 字段，确保所有数组字段存在
   */
  private normalizeReflection(reflection: ReflectionResult): ReflectionResult {
    return {
      success: reflection.success ?? false,
      reasoningValid: reflection.reasoningValid ?? false,
      reasoningSummary: reflection.reasoningSummary ?? 'No summary available.',
      patterns: Array.isArray(reflection.patterns) ? reflection.patterns : [],
      failureModes: Array.isArray(reflection.failureModes) ? reflection.failureModes : [],
      abstractableKnowledge: Array.isArray(reflection.abstractableKnowledge)
        ? reflection.abstractableKnowledge
        : [],
      suggestedSkillName: reflection.suggestedSkillName,
      suggestedSkillDescription: reflection.suggestedSkillDescription,
      suggestedTags: Array.isArray(reflection.suggestedTags) ? reflection.suggestedTags : [],
      rawResponse: reflection.rawResponse,
    };
  }

  /**
   * 清理技能名称为 kebab-case
   * 保证永不返回空字符串
   */
  private sanitizeName(name: string): string {
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 64);
    
    // 如果清洗后为空，使用带时间戳+随机后缀的默认名称
    // 随机后缀防止极端并发下的碰撞
    if (!sanitized || sanitized.length === 0) {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 6);
      return `learned-skill-${timestamp}-${random}`;
    }
    return sanitized;
  }

  /**
   * 生成 SKILL.md 内容
   */
  private generateSkillContent(params: {
    name: string;
    description: string;
    tags: string[];
    category?: string | undefined;
    reflection: ReflectionResult;
    userGuidance?: string | undefined;
  }): string {
    const { name, description, tags, category, reflection, userGuidance } = params;

    // YAML frontmatter
    const frontmatter = this.generateFrontmatter({
      name,
      description,
      tags,
      category,
    });

    // Body sections
    const sections: string[] = [];

    // Title
    sections.push(`# ${this.toTitleCase(name)}`);
    sections.push('');

    // Overview
    sections.push('## Overview');
    sections.push('');
    sections.push(reflection.reasoningSummary);
    sections.push('');

    // Recommended Approach (from patterns)
    const solutionPatterns = reflection.patterns.filter((p) => p.type === 'solution');
    if (solutionPatterns.length > 0) {
      sections.push('## Recommended Approach');
      sections.push('');
      for (const pattern of solutionPatterns) {
        sections.push(`### ${pattern.name}`);
        sections.push('');
        sections.push(pattern.description);
        if (pattern.confidence >= 0.8) {
          sections.push('');
          sections.push('> **High Confidence**: This approach has been validated.');
        }
        sections.push('');
      }
    }

    // Optimization Tips
    const optimizationPatterns = reflection.patterns.filter(
      (p) => p.type === 'optimization',
    );
    if (optimizationPatterns.length > 0) {
      sections.push('## Optimization Tips');
      sections.push('');
      for (const pattern of optimizationPatterns) {
        sections.push(`- **${pattern.name}**: ${pattern.description}`);
      }
      sections.push('');
    }

    // Common Pitfalls
    const pitfallPatterns = reflection.patterns.filter((p) => p.type === 'pitfall');
    if (pitfallPatterns.length > 0 || reflection.failureModes.length > 0) {
      sections.push('## Common Pitfalls');
      sections.push('');

      // From patterns
      for (const pattern of pitfallPatterns) {
        sections.push(`### ${pattern.name}`);
        sections.push('');
        sections.push(pattern.description);
        sections.push('');
      }

      // From failure modes
      for (const failure of reflection.failureModes) {
        sections.push(`### ${this.formatFailureType(failure.type)}`);
        sections.push('');
        sections.push(failure.description);
        if (failure.rootCause) {
          sections.push('');
          sections.push(`**Root Cause**: ${failure.rootCause}`);
        }
        if (failure.mitigation) {
          sections.push('');
          sections.push(`**Mitigation**: ${failure.mitigation}`);
        }
        sections.push('');
      }
    }

    // Edge Cases
    const edgeCasePatterns = reflection.patterns.filter((p) => p.type === 'edge_case');
    if (edgeCasePatterns.length > 0) {
      sections.push('## Edge Cases');
      sections.push('');
      for (const pattern of edgeCasePatterns) {
        sections.push(`- **${pattern.name}**: ${pattern.description}`);
      }
      sections.push('');
    }

    // Key Insights
    if (reflection.abstractableKnowledge.length > 0) {
      sections.push('## Key Insights');
      sections.push('');
      for (const insight of reflection.abstractableKnowledge) {
        sections.push(`- ${insight}`);
      }
      sections.push('');
    }

    // User Guidance
    if (userGuidance) {
      sections.push('## Additional Notes');
      sections.push('');
      sections.push(userGuidance);
      sections.push('');
    }

    return frontmatter + sections.join('\n');
  }

  /**
   * 生成 YAML frontmatter
   */
  private generateFrontmatter(params: {
    name: string;
    description: string;
    tags: string[];
    category?: string | undefined;
  }): string {
    const lines: string[] = ['---'];
    lines.push(`name: ${this.escapeYamlString(params.name)}`);
    lines.push(`description: ${this.escapeYamlString(params.description)}`);
    lines.push("skillType: knowledge");

    if (params.category) {
      lines.push(`category: ${this.escapeYamlString(params.category)}`);
    }

    if (params.tags.length > 0) {
      lines.push(`tags:`);
      for (const tag of params.tags) {
        lines.push(`  - ${this.escapeYamlString(tag)}`);
      }
    }

    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 转换为标题格式
   */
  private toTitleCase(kebabCase: string): string {
    return kebabCase
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * 格式化失败类型
   */
  private formatFailureType(type: FailureMode['type']): string {
    const typeMap: Record<FailureMode['type'], string> = {
      error: 'Error Handling',
      timeout: 'Timeout Issues',
      wrong_approach: 'Wrong Approach',
      missing_context: 'Missing Context',
      edge_case: 'Edge Case',
    };
    return typeMap[type] ?? type;
  }

  /**
   * 转义 YAML 字符串
   */
  private escapeYamlString(str: string): string {
    // 如果包含特殊字符，使用引号包裹
    if (/[:{}[\],&*#?|\-<>=!%@\\]/.test(str) || str.includes('\n')) {
      return `"${str.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
    }
    return str;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建技能创建器
 */
export function createSkillCreator(config: SkillCreationConfig): SkillCreator {
  return new SkillCreator(config);
}
