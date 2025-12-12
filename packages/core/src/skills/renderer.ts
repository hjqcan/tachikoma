/**
 * Skill 渲染器
 *
 * 生成注入 system prompt 的 Skills section
 *
 * @module skills/renderer
 */

import type { SkillMetadata } from './types';
import { DEFAULT_MAX_SKILL_TOKENS } from './types';

// ============================================================================
// 渲染函数
// ============================================================================

/**
 * 渲染 Skills section
 *
 * 生成用于注入 system prompt 的 Skills 摘要
 * 
 * 注意：不暴露绝对路径，只显示 skill 名称和描述
 *
 * @param skills - Skill 元数据列表
 * @param maxTokens - 最大 token 预算（超过则截断）
 * @returns 渲染后的 section，或 null（如果没有 skills）
 *
 * @example
 * ```typescript
 * const section = renderSkillsSection(skills);
 * if (section) {
 *   systemPrompt += '\n\n' + section;
 * }
 * ```
 */
export function renderSkillsSection(
  skills: SkillMetadata[],
  maxTokens: number = DEFAULT_MAX_SKILL_TOKENS
): string | null {
  if (skills.length === 0) {
    return null;
  }

  const lines: string[] = [];

  // 标题
  lines.push('## Skills');
  lines.push('');

  // 说明（不提及文件路径，保持安全）
  lines.push(
    'These skills are available. When a skill is relevant to the task, ' +
    'use the file_read tool to read the SKILL.md from the skill directory for detailed instructions.'
  );
  lines.push('');

  // 估算 token 用量，超过预算时截断
  let currentTokens = 50; // 标题 + 说明的基础开销
  let includedCount = 0;
  const maxSkills = skills.length;

  // 列表（只显示名称和描述，不暴露绝对路径）
  for (const skill of skills) {
    // 估算这个 skill 的 token 开销
    const skillTokens = Math.ceil((skill.name.length + skill.description.length + 10) / 4);
    
    if (currentTokens + skillTokens > maxTokens && includedCount > 0) {
      // 超过预算，添加提示并停止
      lines.push(`- ... and ${maxSkills - includedCount} more skills (use file_list to discover)`);
      break;
    }
    
    lines.push(`- ${skill.name}: ${skill.description}`);
    currentTokens += skillTokens;
    includedCount++;
  }

  return lines.join('\n');
}

/**
 * 渲染 Skill 内容提示
 *
 * 用于 Level 2 动态加载时，告知 LLM 如何使用 Skill
 *
 * @param skillName - Skill 名称
 * @param body - SKILL.md 正文
 * @returns 渲染后的提示
 */
export function renderSkillContentPrompt(skillName: string, body: string): string {
  const lines: string[] = [];

  lines.push(`## Skill: ${skillName}`);
  lines.push('');
  lines.push('The following are detailed instructions for this skill:');
  lines.push('');
  lines.push(body);

  return lines.join('\n');
}

/**
 * 估算 Skills section 的 token 数
 *
 * 粗略估算，用于上下文管理
 * 注意：渲染器不输出 path，故估算时不含 path
 *
 * @param skills - Skill 元数据列表
 * @returns 估算的 token 数
 */
export function estimateSkillsSectionTokens(skills: SkillMetadata[]): number {
  if (skills.length === 0) {
    return 0;
  }

  // 基础开销（标题 + 说明）
  let tokens = 50;

  // 每个 skill 的开销（name + description，不含 path）
  for (const skill of skills) {
    const skillTokens = Math.ceil(
      (skill.name.length + skill.description.length + 10) / 4
    );
    tokens += skillTokens;
  }

  return tokens;
}
