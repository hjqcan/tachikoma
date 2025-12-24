/**
 * Skill Creation Module
 *
 * 基于反思结果生成 SKILL.md（知识型技能）
 * 参考 Letta 的 Skill Learning 两阶段设计（Reflection + Creation）
 *
 * @module skills/learning/creation
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReflectionResult, FailureMode } from './reflection';

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
    const name = this.sanitizeName(rawName);

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

    // 4. 检查是否已存在
    const skillDir = join(this.config.skillsDir, name);
    const skillMdPath = join(skillDir, 'SKILL.md');

    try {
      await access(skillDir);
      if (!this.config.overwrite) {
        return {
          success: false,
          error: `Skill "${name}" already exists. Set overwrite: true to replace.`,
        };
      }
    } catch {
      // 目录不存在，可以创建
    }

    // 5. 生成 SKILL.md 内容
    const content = this.generateSkillContent({
      name,
      description,
      tags,
      category: input.category?.trim() || undefined,
      reflection: safeReflection,
      userGuidance: this.config.userGuidance,
    });

    // 6. 创建目录和文件
    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillMdPath, content, 'utf-8');

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
