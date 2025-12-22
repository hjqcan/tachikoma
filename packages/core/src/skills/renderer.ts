/**
 * Skill 渲染器
 *
 * 生成注入 system prompt 的 Skills section
 *
 * @module skills/renderer
 */

import type { SkillMetadata } from './types';
import { DEFAULT_MAX_SKILL_TOKENS } from './types';
import { matchSkillsToTask, getHighlyRelevantSkills, type SkillRecommendation } from './skill-matcher';

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

  // 说明（更清晰的引导）
  lines.push(
    'The following skills contain expert-curated best practices that can help improve your work quality. ' +
    'When a skill appears relevant to the current task, consider reading its SKILL.md for detailed guidance.'
  );
  lines.push('');
  lines.push('**How to use a skill:**');
  lines.push('1. Review the skill descriptions below');
  lines.push('2. For relevant skills, use `file_read` to read the full SKILL.md');
  lines.push('3. Follow the instructions in the skill when implementing');
  lines.push('');

  // 估算 token 用量，超过预算时截断
  // 基础开销: 标题(10) + 说明(60) + 使用指南(50) = ~120 tokens
  let currentTokens = 120;
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
    
    lines.push(`- **${skill.name}**: ${skill.description}`);
    currentTokens += skillTokens;
    includedCount++;
  }

  return lines.join('\n');
}

/**
 * 渲染带推荐的 Skills section
 *
 * 根据任务描述高亮显示最相关的技能
 *
 * @param skills - Skill 元数据列表
 * @param taskDescription - 任务描述（用于匹配推荐）
 * @param maxTokens - 最大 token 预算
 * @returns 渲染后的 section
 */
export function renderSkillsSectionWithRecommendations(
  skills: SkillMetadata[],
  taskDescription: string,
  maxTokens: number = DEFAULT_MAX_SKILL_TOKENS
): string | null {
  if (skills.length === 0) {
    return null;
  }

  const recommendations = matchSkillsToTask(taskDescription, skills);
  const highlyRelevant = getHighlyRelevantSkills(recommendations);

  const lines: string[] = [];

  // 标题
  lines.push('## Skills');
  lines.push('');

  // 说明
  lines.push(
    'The following skills contain expert-curated best practices. ' +
    'Consider reading the SKILL.md of relevant skills for detailed guidance.'
  );
  lines.push('');

  // 动态计算已用 tokens: 标题(10) + 说明(40) = ~50 base
  let currentTokens = 50;

  // 如果有高相关度技能，优先展示（但受预算控制）
  if (highlyRelevant.length > 0) {
    const headerTokens = 15; // "### Recommended for This Task"
    currentTokens += headerTokens;
    
    lines.push('### [Recommended] For This Task');
    lines.push('');
    
    for (const rec of highlyRelevant) {
      const recTokens = Math.ceil((rec.skill.name.length + rec.skill.description.length + rec.reason.length + 20) / 4);
      if (currentTokens + recTokens > maxTokens) {
        break; // 预算不足，不再添加推荐
      }
      lines.push(`- **${rec.skill.name}** [*]: ${rec.skill.description}`);
      lines.push(`  -> _${rec.reason}_`);
      currentTokens += recTokens;
    }
    lines.push('');
  }

  // 其他技能
  const recommendedNames = new Set(highlyRelevant.map((r: SkillRecommendation) => r.skill.name));
  const otherSkills = skills.filter(s => !recommendedNames.has(s.name));

  if (otherSkills.length > 0) {
    if (highlyRelevant.length > 0) {
      lines.push('### Other Available Skills');
      lines.push('');
      currentTokens += 10; // header overhead
    }
    
    let includedCount = 0;
    
    for (const skill of otherSkills) {
      const skillTokens = Math.ceil((skill.name.length + skill.description.length + 10) / 4);
      
      if (currentTokens + skillTokens > maxTokens && includedCount > 0) {
        lines.push(`- ... and ${otherSkills.length - includedCount} more skills`);
        break;
      }
      
      lines.push(`- **${skill.name}**: ${skill.description}`);
      currentTokens += skillTokens;
      includedCount++;
    }
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

  // 基础开销（标题 + 说明 + 使用指南）
  let tokens = 120;

  // 每个 skill 的开销（name + description，不含 path）
  for (const skill of skills) {
    const skillTokens = Math.ceil(
      (skill.name.length + skill.description.length + 10) / 4
    );
    tokens += skillTokens;
  }

  return tokens;
}
