/**
 * Skill Memory Blocks
 *
 * 定义 skills 和 loaded_skills 内存块，用于技能管理和上下文注入
 * 参考 Letta-Code 的 Memory Block 设计
 *
 * @module skills/blocks
 */

import { renderSkillsSection } from './renderer';
import type { SkillMetadata } from './types';

// ============================================================================
// Memory Block 常量
// ============================================================================

/**
 * Skill 相关的 Memory Block 标签
 */
export const SKILL_MEMORY_BLOCK_LABELS = ['skills', 'loaded_skills'] as const;

/**
 * Memory Block 标签类型
 */
export type SkillMemoryBlockLabel = (typeof SKILL_MEMORY_BLOCK_LABELS)[number];

/**
 * Skill Memory Blocks 是只读的（由 Skill Tool 管理，Agent 不能直接修改）
 */
export const SKILL_READ_ONLY_BLOCKS = ['skills', 'loaded_skills'] as const;

/**
 * 空 loaded_skills 块的占位符
 */
export const EMPTY_LOADED_SKILLS_PLACEHOLDER = '[CURRENTLY EMPTY]';

/**
 * 技能内容分隔符
 */
export const SKILL_CONTENT_SEPARATOR = '\n\n---\n\n';

// ============================================================================
// Memory Block 接口
// ============================================================================

/**
 * Memory Block 定义
 */
export interface MemoryBlock {
  /** 块标签/名称 */
  label: string;
  /** 块内容 */
  value: string;
  /** 块描述 */
  description?: string;
  /** 是否只读（由工具管理） */
  readOnly?: boolean;
  /** 内容字符限制 */
  limit?: number;
}

/**
 * Skill Memory Block 状态
 */
export interface SkillBlockState {
  /** skills 块：技能列表摘要 */
  skills: MemoryBlock;
  /** loaded_skills 块：已加载技能的完整内容 */
  loadedSkills: MemoryBlock;
}

// ============================================================================
// Memory Block 管理器
// ============================================================================

/**
 * Skill Memory Block 管理器
 *
 * 管理 skills 和 loaded_skills 两个内存块的生命周期
 */
export class SkillBlockManager {
  private state: SkillBlockState;

  constructor() {
    this.state = {
      skills: this.createSkillsBlock(''),
      loadedSkills: this.createLoadedSkillsBlock(EMPTY_LOADED_SKILLS_PLACEHOLDER),
    };
  }

  /**
   * 创建 skills 块
   */
  private createSkillsBlock(value: string): MemoryBlock {
    return {
      label: 'skills',
      value,
      description: 'Available skills that can be loaded for the current task',
      readOnly: true,
      limit: 20000, // 与 Letta-Code 一致
    };
  }

  /**
   * 创建 loaded_skills 块
   */
  private createLoadedSkillsBlock(value: string): MemoryBlock {
    return {
      label: 'loaded_skills',
      value,
      description: 'Currently loaded skills with their full content injected into context',
      readOnly: true,
      limit: 50000, // 较大限制以容纳多个技能内容
    };
  }

  /**
   * 刷新 skills 块内容
   *
   * @param skills - 已发现的技能元数据列表
   */
  refreshSkillsBlock(skills: SkillMetadata[]): void {
    const content = renderSkillsSection(skills) ?? '[NO SKILLS AVAILABLE]';
    this.state.skills = this.createSkillsBlock(content);
  }

  /**
   * 加载技能到 loaded_skills 块
   *
   * @param skillName - 技能名称
   * @param body - 技能内容（SKILL.md body）
   * @returns 是否成功加载（如果已存在返回 false）
   */
  loadSkill(skillName: string, body: string): boolean {
    const loadedIds = this.getLoadedSkillIds();
    if (loadedIds.includes(skillName)) {
      return false; // 已加载
    }

    let currentValue = this.state.loadedSkills.value;

    // 清除占位符
    if (currentValue === EMPTY_LOADED_SKILLS_PLACEHOLDER) {
      currentValue = '';
    }

    // 追加新技能
    const separator = currentValue ? SKILL_CONTENT_SEPARATOR : '';
    const newContent = `${currentValue}${separator}# Skill: ${skillName}\n${body}`;

    this.state.loadedSkills = this.createLoadedSkillsBlock(newContent);
    return true;
  }

  /**
   * 从 loaded_skills 块卸载技能
   *
   * @param skillName - 技能名称
   * @returns 是否成功卸载（如果不存在返回 false）
   */
  unloadSkill(skillName: string): boolean {
    const loadedIds = this.getLoadedSkillIds();
    if (!loadedIds.includes(skillName)) {
      return false; // 未加载
    }

    const boundaries = this.parseLoadedSkillBoundaries();
    const boundary = boundaries.get(skillName);
    if (!boundary) {
      return false;
    }

    let currentValue = this.state.loadedSkills.value;

    // 计算实际要移除的范围
    let removeStart = boundary.start;
    let removeEnd = boundary.end;

    // 检查前面是否有分隔符（非第一个技能的情况）
    if (boundary.start >= SKILL_CONTENT_SEPARATOR.length) {
      const potentialSep = currentValue.substring(
        boundary.start - SKILL_CONTENT_SEPARATOR.length,
        boundary.start,
      );
      if (potentialSep === SKILL_CONTENT_SEPARATOR) {
        removeStart = boundary.start - SKILL_CONTENT_SEPARATOR.length;
      }
    }

    // 如果是第一个技能且后面还有其他技能，需要移除后面的分隔符
    if (removeStart === boundary.start && boundary.end < currentValue.length) {
      const potentialSepAfter = currentValue.substring(
        boundary.end,
        boundary.end + SKILL_CONTENT_SEPARATOR.length,
      );
      if (potentialSepAfter === SKILL_CONTENT_SEPARATOR) {
        removeEnd = boundary.end + SKILL_CONTENT_SEPARATOR.length;
      }
    }

    // 移除技能内容
    currentValue =
      currentValue.substring(0, removeStart) +
      currentValue.substring(removeEnd);

    // 清理内容
    currentValue = currentValue.trim();
    if (currentValue === '') {
      currentValue = EMPTY_LOADED_SKILLS_PLACEHOLDER;
    }

    this.state.loadedSkills = this.createLoadedSkillsBlock(currentValue);
    return true;
  }

  /**
   * 获取已加载技能的 ID 列表
   */
  getLoadedSkillIds(): string[] {
    const skillRegex = /# Skill: ([^\n]+)/g;
    const skills: string[] = [];
    const value = this.state.loadedSkills.value;

    let match = skillRegex.exec(value);
    while (match !== null) {
      const skillId = match[1]?.trim();
      if (skillId) {
        skills.push(skillId);
      }
      match = skillRegex.exec(value);
    }

    return skills;
  }

  /**
   * 解析 loaded_skills 块内容的边界
   */
  private parseLoadedSkillBoundaries(): Map<string, { start: number; end: number }> {
    const skillMap = new Map<string, { start: number; end: number }>();
    const value = this.state.loadedSkills.value;
    const skillHeaderRegex = /# Skill: ([^\n]+)/g;

    const headers: { id: string; start: number }[] = [];

    let match = skillHeaderRegex.exec(value);
    while (match !== null) {
      const skillId = match[1]?.trim();
      if (skillId) {
        headers.push({ id: skillId, start: match.index });
      }
      match = skillHeaderRegex.exec(value);
    }

    for (let i = 0; i < headers.length; i++) {
      const current = headers[i];
      const next = headers[i + 1];

      if (!current) continue;

      let end: number;
      if (next) {
        const searchStart = current.start;
        const searchEnd = next.start;
        const substring = value.substring(searchStart, searchEnd);
        const sepMatch = substring.lastIndexOf(SKILL_CONTENT_SEPARATOR);
        if (sepMatch !== -1) {
          end = searchStart + sepMatch;
        } else {
          end = searchEnd;
        }
      } else {
        end = value.length;
      }

      skillMap.set(current.id, { start: current.start, end });
    }

    return skillMap;
  }

  /**
   * 获取 skills 块
   */
  getSkillsBlock(): MemoryBlock {
    return this.state.skills;
  }

  /**
   * 获取 loaded_skills 块
   */
  getLoadedSkillsBlock(): MemoryBlock {
    return this.state.loadedSkills;
  }

  /**
   * 获取所有 Memory Blocks
   */
  getAllBlocks(): MemoryBlock[] {
    return [this.state.skills, this.state.loadedSkills];
  }

  /**
   * 检查标签是否为 Skill Memory Block
   */
  static isSkillBlock(label: string): boolean {
    return (SKILL_MEMORY_BLOCK_LABELS as readonly string[]).includes(label);
  }

  /**
   * 检查标签是否为只读块
   */
  static isReadOnlyBlock(label: string): boolean {
    return (SKILL_READ_ONLY_BLOCKS as readonly string[]).includes(label);
  }

  /**
   * 渲染 loaded_skills 块为 System Prompt 片段
   */
  renderLoadedSkillsForPrompt(): string | null {
    const value = this.state.loadedSkills.value;
    if (!value || value === EMPTY_LOADED_SKILLS_PLACEHOLDER) {
      return null;
    }

    return `## Loaded Skills\n\nThe following skills are currently loaded and available for reference:\n\n${value}`;
  }

  /**
   * 重置所有块到初始状态
   */
  reset(): void {
    this.state = {
      skills: this.createSkillsBlock(''),
      loadedSkills: this.createLoadedSkillsBlock(EMPTY_LOADED_SKILLS_PLACEHOLDER),
    };
  }
}

// ============================================================================
// 全局单例（可选）
// ============================================================================

let globalBlockManager: SkillBlockManager | null = null;

/**
 * 获取全局 Skill Block Manager 单例
 */
export function getGlobalSkillBlockManager(): SkillBlockManager {
  if (!globalBlockManager) {
    globalBlockManager = new SkillBlockManager();
  }
  return globalBlockManager;
}

/**
 * 重置全局 Skill Block Manager（用于测试）
 */
export function resetGlobalSkillBlockManager(): void {
  globalBlockManager = null;
}
