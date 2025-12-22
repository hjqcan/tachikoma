/**
 * Skill 匹配器
 *
 * 根据任务描述推荐最相关的技能
 *
 * @module skills/skill-matcher
 */

import type { SkillMetadata } from './types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 技能相关度等级
 */
export type SkillRelevance = 'highly-relevant' | 'relevant' | 'loosely-relevant';

/**
 * 技能推荐结果
 */
export interface SkillRecommendation {
  /** 技能元数据 */
  skill: SkillMetadata;
  /** 推荐原因 */
  reason: string;
  /** 相关度等级 */
  relevance: SkillRelevance;
  /** 匹配分数 (0-100) */
  score: number;
}

/**
 * 关键字匹配规则
 */
interface KeywordRule {
  /** 技能名称 */
  skillName: string;
  /** 匹配关键字（支持中英文） */
  keywords: string[];
  /** 推荐原因模板 */
  reasonTemplate: string;
  /** 基础分数 */
  baseScore: number;
}

// ============================================================================
// 关键字规则配置
// ============================================================================

const KEYWORD_RULES: KeywordRule[] = [
  {
    skillName: 'frontend-design',
    keywords: [
      // 中文
      '网站', '网页', '前端', '界面', '页面', '组件', '样式', '布局',
      '美化', '设计', '美观', '交互', '响应式', '音乐', '播放器', '听歌',
      // 英文 (all lowercase for case-insensitive matching)
      'website', 'web', 'frontend', 'front-end', 'interface', 'ui', 'ux',
      'page', 'component', 'style', 'layout', 'design', 'css', 'html',
      'tailwind', 'react', 'vue', 'landing', 'music', 'player',
    ],
    reasonTemplate: 'This skill provides expert design guidance for high-quality frontend interfaces',
    baseScore: 80,
  },
  {
    skillName: 'webapp-testing',
    keywords: [
      // 中文
      '测试', '验证', '自动化', '浏览器', '截图', '调试',
      // 英文
      'test', 'testing', 'verify', 'automation', 'browser', 'screenshot',
      'debug', 'playwright', 'puppeteer', 'e2e', 'end-to-end',
    ],
    reasonTemplate: '任务需要测试或验证 Web 应用功能',
    baseScore: 75,
  },
  {
    skillName: 'web-artifacts-builder',
    keywords: [
      // 中文
      '组件', '打包', '构建',
      // 英文 (all lowercase)
      'react', 'component', 'tailwind', 'shadcn', 'bundle', 'build',
      'artifact', 'typescript', 'vite',
    ],
    reasonTemplate: '任务涉及 React 组件或复杂前端应用构建',
    baseScore: 70,
  },
  {
    skillName: 'speckit',
    keywords: [
      // 中文
      '规划', '需求', '规格', '设计文档', '架构', '任务分解',
      // 英文
      'spec', 'specification', 'requirement', 'planning', 'architecture',
      'design doc', 'task breakdown',
    ],
    reasonTemplate: '任务需要结构化的需求规划和设计',
    baseScore: 65,
  },
  {
    skillName: 'deep-research',
    keywords: [
      // 中文
      '调研', '研究', '分析', '对比', '报告', '最佳实践',
      // 英文
      'research', 'investigate', 'analyze', 'compare', 'report',
      'best practice', 'survey',
    ],
    reasonTemplate: '任务需要深度网络调研和信息综合',
    baseScore: 60,
  },
  {
    skillName: 'skill-creator',
    keywords: [
      // 中文
      '创建技能', '新技能', 'skill',
      // 英文
      'create skill', 'new skill', 'skill creation',
    ],
    reasonTemplate: '任务涉及创建新的 Agent 技能',
    baseScore: 50,
  },
];

// ============================================================================
// 核心匹配函数
// ============================================================================

/**
 * 根据任务描述匹配推荐技能
 *
 * @param taskDescription - 任务描述
 * @param skills - 可用技能列表
 * @returns 推荐结果列表（按分数降序）
 */
export function matchSkillsToTask(
  taskDescription: string,
  skills: SkillMetadata[]
): SkillRecommendation[] {
  if (!taskDescription || skills.length === 0) {
    return [];
  }

  const recommendations: SkillRecommendation[] = [];
  const taskLower = taskDescription.toLowerCase();
  const skillMap = new Map(skills.map(s => [s.name, s]));

  for (const rule of KEYWORD_RULES) {
    const skill = skillMap.get(rule.skillName);
    if (!skill) continue;

    // 计算匹配分数 (use word boundary matching to avoid false positives)
    const matchedLower = new Set<string>();

    for (const keyword of rule.keywords) {
      const kLower = keyword.toLowerCase();
      if (matchedLower.has(kLower)) continue;
      
      // Only use word boundary for short ASCII-only keywords to avoid false positives
      // e.g., 'ui' should not match 'build'
      // \b doesn't work for CJK characters, so always use substring for non-ASCII
      const isAsciiOnly = /^[a-z0-9-]+$/i.test(kLower);
      const needsWordBoundary = isAsciiOnly && kLower.length <= 3;
      let matches: boolean;
      
      if (needsWordBoundary) {
        // Word boundary regex: matches whole word only (ASCII)
        const regex = new RegExp(`\\b${kLower}\\b`, 'i');
        matches = regex.test(taskLower);
      } else {
        // For CJK or longer keywords, use substring matching
        matches = taskLower.includes(kLower);
      }
      
      if (matches) {
        matchedLower.add(kLower);
      }
    }

    const matchCount = matchedLower.size;

    if (matchCount > 0) {
      // 分数 = 基础分 + 匹配关键字数量加成（每个+5，最多+20）
      const score = Math.min(100, rule.baseScore + Math.min(matchCount * 5, 20));
      
      // 确定相关度等级
      let relevance: SkillRelevance;
      if (score >= 80) {
        relevance = 'highly-relevant';
      } else if (score >= 60) {
        relevance = 'relevant';
      } else {
        relevance = 'loosely-relevant';
      }

      recommendations.push({
        skill,
        reason: rule.reasonTemplate,
        relevance,
        score,
      });
    }
  }

  // 按分数降序排序
  recommendations.sort((a, b) => b.score - a.score);

  return recommendations;
}

/**
 * 获取高相关度的技能
 */
export function getHighlyRelevantSkills(
  recommendations: SkillRecommendation[]
): SkillRecommendation[] {
  return recommendations.filter(r => r.relevance === 'highly-relevant');
}

/**
 * 获取相关的技能（包括高相关度）
 */
export function getRelevantSkills(
  recommendations: SkillRecommendation[]
): SkillRecommendation[] {
  return recommendations.filter(r => r.relevance !== 'loosely-relevant');
}
