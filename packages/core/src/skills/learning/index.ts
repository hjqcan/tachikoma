/**
 * Skill Learning Module
 *
 * 提供技能学习能力，包括轨迹反思和技能生成
 *
 * @module skills/learning
 */

import type { TrajectoryRecord, ExecutionFeedback, ReflectionResult } from './reflection';
import type { SkillCreationResult } from './creation';
import { TrajectoryReflector } from './reflection';
import { SkillCreator } from './creation';
import { createHash } from 'node:crypto';

// ============================================================================
// Reflection 导出
// ============================================================================

export {
  TrajectoryReflector,
  createTrajectoryReflector,
  thinkingRecordToTrajectory,
  actionRecordToTrajectory,
} from './reflection';

export type {
  TrajectoryRecord,
  ExecutionFeedback,
  IdentifiedPattern,
  FailureMode,
  ReflectionResult,
  ReflectionConfig,
} from './reflection';

// ============================================================================
// Creation 导出
// ============================================================================

export {
  SkillCreator,
  createSkillCreator,
} from './creation';

export type {
  SkillCreationConfig,
  SkillCreationInput,
  SkillCreationResult,
} from './creation';

// ============================================================================
// Orchestration: learnSkillFromTrajectory
// ============================================================================

/**
 * 学习后的技能信息
 */
export interface LearnedSkill {
  /** 技能名称 */
  name: string;
  /** 技能文件路径 */
  path: string;
  /** 技能摘要 */
  summary: string;
  /** 建议的标签 */
  tags: string[];
  /** 反思结果（供调试/审查） */
  reflection: ReflectionResult;
}

/**
 * 学习流程配置
 */
export interface LearnSkillConfig {
  /** LLM 调用函数（用于反思） */
  llmCall: (prompt: string) => Promise<string>;
  /** 技能存储目录 */
  skillsDir: string;
  /** 任务描述（反思时使用） */
  taskDescription: string;
  /** 目标技能名称（可选：用于稳定命名/治理；优先级高于 reflection.suggestedSkillName） */
  skillName?: string | undefined;
  /** 执行反馈（测试结果/用户反馈） */
  feedback?: ExecutionFeedback | undefined;
  /** 用户指导（追加到技能内容） */
  userGuidance?: string | undefined;
  /** 是否覆盖已存在的技能 */
  overwrite?: boolean | undefined;
  /** 自动更新相似技能（用于 C-auto/top-K） */
  autoUpdateSimilar?: boolean | undefined;
  /** 每个 skillsDir 最多保留的技能数量（用于每项目 Top-K） */
  maxSkills?: number | undefined;
  /** 相似技能去重阈值（透传到 SkillCreator） */
  similarity?: { minLen?: number; levenshteinRatio?: number } | undefined;
  /** 来源（用于审计） */
  source?: 'auto' | 'manual' | undefined;
  /** 刷新技能列表的回调 */
  onSkillsRefresh?: () => Promise<void>;
  /** 更新 Memory Block 的回调 */
  onBlockUpdate?: (name: string, content: string) => Promise<void>;
}

/**
 * 学习流程结果
 */
export interface LearnSkillResult {
  /** 是否成功 */
  success: boolean;
  /** 学习到的技能（成功时） */
  skill?: LearnedSkill | undefined;
  /** 错误信息（失败时） */
  error?: string | undefined;
  /** 失败阶段 */
  failedAt?: 'reflection' | 'creation' | 'reload' | undefined;
}

/**
 * 从执行轨迹学习技能
 *
 * 完整流程：
 * 1. reflect() - 分析轨迹，提取模式/教训
 * 2. create() - 生成 SKILL.md
 * 3. onSkillsRefresh() - 通过回调刷新技能列表（调用方提供）
 * 4. onBlockUpdate() - 通过回调更新 Memory Block（调用方提供）
 *
 * 注意：当反思没产出可学习模式时，返回 success: false。
 * 这不一定是“错误”，而是“没有新技能可沉淀”。
 * CLI 层可根据 failedAt === 'reflection' 且 error 包含 'learnable patterns'
 * 来展示成正常提示而非错误。
 *
 * @param trajectory - 执行轨迹记录
 * @param config - 学习配置
 * @returns 学习结果
 *
 * @example
 * ```typescript
 * const result = await learnSkillFromTrajectory(trajectory, {
 *   llmCall: (prompt) => myLlm.complete(prompt),
 *   skillsDir: '.tachikoma/skills',
 *   taskDescription: 'Implement user authentication',
 *   feedback: { success: true, userFeedback: 'Great work!' },
 *   onSkillsRefresh: async () => { blockManager.refreshSkillsBlock(loadSkills()); },
 *   onBlockUpdate: async (name, content) => { saveToBlock(name, content); },
 * });
 *
 * if (result.success) {
 *   console.log(`Learned skill: ${result.skill.name}`);
 * } else if (result.error?.includes('learnable patterns')) {
 *   console.log('No new skills to learn from this trajectory.');
 * }
 * ```
 */
export async function learnSkillFromTrajectory(
  trajectory: TrajectoryRecord[],
  config: LearnSkillConfig,
): Promise<LearnSkillResult> {
  // 1. 反思阶段
  const reflector = new TrajectoryReflector({
    llmCall: config.llmCall,
    detailed: true,
    suggestSkill: true,
  });

  let reflection: ReflectionResult;
  try {
    reflection = await reflector.reflect(
      trajectory,
      config.taskDescription,
      config.feedback,
    );
  } catch (error) {
    return {
      success: false,
      error: `Reflection failed: ${error instanceof Error ? error.message : String(error)}`,
      failedAt: 'reflection',
    };
  }

  // 检查反思结果是否值得创建技能
  if (!shouldCreateSkill(reflection)) {
    return {
      success: false,
      error: 'Reflection did not produce learnable patterns. Consider providing more detailed feedback.',
      failedAt: 'reflection',
    };
  }

  // ===== 质量与稳定命名（用于 C-auto / Top-K）=====
  const toolCallCount = trajectory.filter((r) => r.type === 'tool_call').length;
  const durationMs = (() => {
    if (trajectory.length === 0) return 0;
    const ts = trajectory.map((r) => r.timestamp);
    const min = Math.min(...ts);
    const max = Math.max(...ts);
    return Math.max(0, max - min);
  })();
  const qualityScore = computeQualityScore(reflection, { toolCallCount, durationMs, feedback: config.feedback });

  const derivedName =
    config.skillName ??
    reflection.suggestedSkillName ??
    deriveStableSkillName(config.taskDescription);

  // 2. 创建阶段
  const creator = new SkillCreator({
    skillsDir: config.skillsDir,
    overwrite: config.overwrite,
    autoUpdateSimilar: config.autoUpdateSimilar,
    maxSkills: config.maxSkills,
    similarity: config.similarity,
    userGuidance: config.userGuidance,
    onCreated: async (_path) => {
      // 刷新技能列表
      if (config.onSkillsRefresh) {
        await config.onSkillsRefresh();
      }
    },
  });

  let creationResult: SkillCreationResult;
  try {
    creationResult = await creator.create({
      reflection,
      name: derivedName,
      meta: {
        score: qualityScore,
        source: config.source ?? 'manual',
        taskDescription: config.taskDescription,
        toolCallCount,
        durationMs,
      },
    });
  } catch (error) {
    return {
      success: false,
      error: `Creation failed: ${error instanceof Error ? error.message : String(error)}`,
      failedAt: 'creation',
    };
  }

  if (!creationResult.success) {
    return {
      success: false,
      error: creationResult.error ?? 'Unknown creation error',
      failedAt: 'creation',
    };
  }

  // 3. 更新 Memory Block（如果提供了回调）
  const skillName = creationResult.name ?? 'unknown-skill';
  const skillPath = creationResult.path ?? '';
  
  if (config.onBlockUpdate && creationResult.content) {
    try {
      await config.onBlockUpdate(skillName, creationResult.content);
    } catch (error) {
      // Memory Block 更新失败不应导致整体失败，只记录警告
      console.warn(`Failed to update memory block: ${error}`);
    }
  }

  // 4. 构建返回结果
  const learnedSkill: LearnedSkill = {
    name: skillName,
    path: skillPath,
    summary: reflection.reasoningSummary,
    tags: reflection.suggestedTags ?? [],
    reflection,
  };

  return {
    success: true,
    skill: learnedSkill,
  };
}

/**
 * 判断反思结果是否值得创建技能
 */
function shouldCreateSkill(reflection: ReflectionResult): boolean {
  // 至少需要满足以下条件之一：
  // 1. 有识别的模式
  // 2. 有失败教训
  // 3. 有可抽象的知识
  const hasPatterns = reflection.patterns.length > 0;
  const hasFailures = reflection.failureModes.length > 0;
  const hasKnowledge = reflection.abstractableKnowledge.length > 0;

  return hasPatterns || hasFailures || hasKnowledge;
}

function deriveStableSkillName(taskDescription: string): string {
  const normalized = taskDescription.trim().toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  const hash = createHash('sha1').update(taskDescription).digest('hex').slice(0, 8);
  const base = slug.length > 0 ? slug : 'skill';
  return `auto-${base}-${hash}`;
}

function computeQualityScore(
  reflection: ReflectionResult,
  input: { toolCallCount: number; durationMs: number; feedback?: ExecutionFeedback | undefined },
): number {
  const patterns = Array.isArray(reflection.patterns) ? reflection.patterns : [];
  const patternScore = patterns.reduce((sum, p) => {
    const conf = typeof (p as any).confidence === 'number' ? (p as any).confidence : 0.6;
    return sum + Math.max(0, Math.min(1, conf)) * 2;
  }, 0);
  const knowledgeScore = (reflection.abstractableKnowledge?.length ?? 0) * 1.2;
  const failureScore = (reflection.failureModes?.length ?? 0) * 0.5;
  const toolScore = Math.log1p(Math.max(0, input.toolCallCount)) * 1.5;
  const durationScore = Math.log1p(Math.max(0, input.durationMs) / 60000) * 0.8;
  const feedbackBonus = input.feedback?.success === true ? 0.5 : 0;
  return Number((patternScore + knowledgeScore + failureScore + toolScore + durationScore + feedbackBonus).toFixed(3));
}

