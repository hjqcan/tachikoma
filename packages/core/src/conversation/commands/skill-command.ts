/**
 * Skill Command Module
 *
 * /skill CLI 命令实现
 * - /skill：显示帮助
 * - /skill list：列出可用技能
 * - /skill load <name>：加载技能
 * - /skill unload <name>：卸载技能
 * - /skill learn [description]：从轨迹学习技能
 *
 * @module conversation/commands/skill-command
 */

import { join } from 'node:path';

import {
  loadSkills,
  getGlobalSkillBlockManager,
  learnSkillFromTrajectory,
  loadSkillContent,
  type SkillMetadata,
  type TrajectoryRecord,
  type LearnSkillResult,
} from '../../skills';
import type { StreamEvent, SessionState } from '../types';
import type { ThinkingRecord, ActionRecord } from '../../orchestrator/session/types';
import { thinkingRecordToTrajectory, actionRecordToTrajectory } from '../../skills/learning';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 技能命令上下文
 */
export interface SkillCommandContext {
  /** 当前会话 */
  session: SessionState;
  /** 工作目录 */
  workDir: string;
  /** LLM 调用函数（用于 /skill learn） */
  llmCall?: ((prompt: string) => Promise<string>) | undefined;
  /** 翻译函数 */
  t: (strings: { en: string; zh: string }) => string;
  /** 获取执行轨迹（用于 /skill learn） */
  getTrajectory?: (() => Promise<TrajectoryRecord[]>) | undefined;
}

/**
 * 技能命令结果
 */
export interface SkillCommandResult {
  /** 是否已处理 */
  handled: boolean;
}

// ============================================================================
// 命令处理器
// ============================================================================

/**
 * 处理 /skill 命令
 */
export async function* executeSkillCommand(
  args: string[],
  ctx: SkillCommandContext,
): AsyncGenerator<StreamEvent, SkillCommandResult> {
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case 'list':
      yield* executeSkillList(ctx);
      return { handled: true };

    case 'load':
      yield* executeSkillLoad(args.slice(1), ctx);
      return { handled: true };

    case 'unload':
      yield* executeSkillUnload(args.slice(1), ctx);
      return { handled: true };

    case 'learn':
      yield* executeSkillLearn(args.slice(1), ctx);
      return { handled: true };

    case 'help':
    case undefined:
      yield* executeSkillHelp(ctx);
      return { handled: true };

    default:
      // 未识别的子命令，显示帮助
      yield {
        type: 'complete',
        success: false,
        summary: ctx.t({
          en: `Unknown subcommand: ${subcommand}. Use /skill help for available commands.`,
          zh: `未知子命令: ${subcommand}。使用 /skill help 查看可用命令。`,
        }),
        timestamp: Date.now(),
      };
      return { handled: true };
  }
}

// ============================================================================
// 子命令实现
// ============================================================================

/**
 * /skill list - 列出可用技能
 */
async function* executeSkillList(ctx: SkillCommandContext): AsyncGenerator<StreamEvent> {
  yield {
    type: 'thinking',
    content: ctx.t({
      en: 'Loading skills...',
      zh: '正在加载技能列表...',
    }),
    timestamp: Date.now(),
  };

  try {
    const { skills } = loadSkills({ enabled: true }, ctx.workDir);
    const blockManager = getGlobalSkillBlockManager();
    const loadedSkillNames = blockManager.getLoadedSkillIds(); // 返回的是 name

    if (skills.length === 0) {
      yield {
        type: 'complete',
        success: true,
        summary: ctx.t({
          en: 'No skills found. Create skills in .tachikoma/skills/ directory.',
          zh: '未找到任何技能。请在 .tachikoma/skills/ 目录创建技能。',
        }),
        timestamp: Date.now(),
      };
      return;
    }

    const lines = skills.map((skill: SkillMetadata) => {
      const loaded = loadedSkillNames.includes(skill.name);
      const status = loaded ? '✓' : '○';
      const typeLabel = skill.skillType === 'knowledge' ? '[K]' : '[E]';
      return `${status} ${typeLabel} ${skill.name}: ${skill.description}`;
    });

    yield {
      type: 'complete',
      success: true,
      summary: ctx.t({
        en: `Available skills (${skills.length}):\n${lines.join('\n')}\n\n[K]=Knowledge [E]=Executable ✓=Loaded`,
        zh: `可用技能 (${skills.length}):\n${lines.join('\n')}\n\n[K]=知识型 [E]=可执行型 ✓=已加载`,
      }),
      timestamp: Date.now(),
    };
  } catch (error) {
    yield {
      type: 'error',
      error: ctx.t({
        en: `Failed to list skills: ${error instanceof Error ? error.message : String(error)}`,
        zh: `加载技能列表失败: ${error instanceof Error ? error.message : String(error)}`,
      }),
      retryable: false,
      timestamp: Date.now(),
    };
  }
}

/**
 * /skill load <name> - 加载技能
 */
async function* executeSkillLoad(
  args: string[],
  ctx: SkillCommandContext,
): AsyncGenerator<StreamEvent> {
  const skillName = args[0];

  if (!skillName) {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: 'Usage: /skill load <name>. Use /skill list to see available skills.',
        zh: '用法: /skill load <名称>。使用 /skill list 查看可用技能。',
      }),
      timestamp: Date.now(),
    };
    return;
  }

  yield {
    type: 'thinking',
    content: ctx.t({
      en: `Loading skill: ${skillName}...`,
      zh: `正在加载技能: ${skillName}...`,
    }),
    timestamp: Date.now(),
  };

  try {
    // 1. 查找技能
    const { skills } = loadSkills({ enabled: true }, ctx.workDir);
    const skill = skills.find((s: SkillMetadata) => s.name === skillName);

    if (!skill) {
      yield {
        type: 'complete',
        success: false,
        summary: ctx.t({
          en: `Skill not found: ${skillName}. Use /skill list to see available skills.`,
          zh: `未找到技能: ${skillName}。使用 /skill list 查看可用技能。`,
        }),
        timestamp: Date.now(),
      };
      return;
    }

    // 2. 加载内容
    const content = await loadSkillContent(skill);

    // 3. 更新 Memory Block
    const blockManager = getGlobalSkillBlockManager();
    const wasLoaded = blockManager.loadSkill(skill.name, content.body);

    const preview = content.body.substring(0, 500);
    const truncated = content.body.length > 500 ? '...' : '';

    if (wasLoaded) {
      yield {
        type: 'complete',
        success: true,
        summary: ctx.t({
          en: `Skill loaded: ${skill.name}\n\n${preview}${truncated}`,
          zh: `已加载技能: ${skill.name}\n\n${preview}${truncated}`,
        }),
        timestamp: Date.now(),
      };
    } else {
      yield {
        type: 'complete',
        success: true,
        summary: ctx.t({
          en: `Skill already loaded: ${skill.name}`,
          zh: `技能已加载: ${skill.name}`,
        }),
        timestamp: Date.now(),
      };
    }
  } catch (error) {
    yield {
      type: 'error',
      error: ctx.t({
        en: `Failed to load skill: ${error instanceof Error ? error.message : String(error)}`,
        zh: `加载技能失败: ${error instanceof Error ? error.message : String(error)}`,
      }),
      retryable: false,
      timestamp: Date.now(),
    };
  }
}

/**
 * /skill unload <name> - 卸载技能
 */
async function* executeSkillUnload(
  args: string[],
  ctx: SkillCommandContext,
): AsyncGenerator<StreamEvent> {
  const skillName = args[0];

  if (!skillName) {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: 'Usage: /skill unload <name>. Use /skill list to see loaded skills.',
        zh: '用法: /skill unload <名称>。使用 /skill list 查看已加载技能。',
      }),
      timestamp: Date.now(),
    };
    return;
  }

  try {
    const blockManager = getGlobalSkillBlockManager();
    const loadedSkillNames = blockManager.getLoadedSkillIds();

    // 检查是否已加载
    if (!loadedSkillNames.includes(skillName)) {
      yield {
        type: 'complete',
        success: false,
        summary: ctx.t({
          en: `Skill not loaded: ${skillName}`,
          zh: `技能未加载: ${skillName}`,
        }),
        timestamp: Date.now(),
      };
      return;
    }

    // 卸载
    blockManager.unloadSkill(skillName);

    yield {
      type: 'complete',
      success: true,
      summary: ctx.t({
        en: `Skill unloaded: ${skillName}`,
        zh: `已卸载技能: ${skillName}`,
      }),
      timestamp: Date.now(),
    };
  } catch (error) {
    yield {
      type: 'error',
      error: ctx.t({
        en: `Failed to unload skill: ${error instanceof Error ? error.message : String(error)}`,
        zh: `卸载技能失败: ${error instanceof Error ? error.message : String(error)}`,
      }),
      retryable: false,
      timestamp: Date.now(),
    };
  }
}

/**
 * /skill learn [description] - 从轨迹学习技能
 */
async function* executeSkillLearn(
  args: string[],
  ctx: SkillCommandContext,
): AsyncGenerator<StreamEvent> {
  const description = args.join(' ').trim() || 'Learn from recent execution';

  if (!ctx.llmCall) {
    yield {
      type: 'complete',
      success: false,
      summary: ctx.t({
        en: 'LLM not configured. Cannot learn skills without LLM access.',
        zh: 'LLM 未配置。无法在没有 LLM 的情况下学习技能。',
      }),
      timestamp: Date.now(),
    };
    return;
  }

  yield {
    type: 'thinking',
    content: ctx.t({
      en: `Learning skill from trajectory: ${description}`,
      zh: `从轨迹学习技能: ${description}`,
    }),
    timestamp: Date.now(),
  };

  try {
    // 1. 获取轨迹
    let trajectory: TrajectoryRecord[];
    if (ctx.getTrajectory) {
      trajectory = await ctx.getTrajectory();
    } else {
      // 从 session 提取轨迹
      trajectory = extractTrajectoryFromSession(ctx.session);
    }

    if (trajectory.length === 0) {
      yield {
        type: 'complete',
        success: false,
        summary: ctx.t({
          en: 'No execution trajectory found. Complete some tasks first, then try /skill learn.',
          zh: '未找到执行轨迹。请先完成一些任务，然后使用 /skill learn。',
        }),
        timestamp: Date.now(),
      };
      return;
    }

    yield {
      type: 'thinking',
      content: ctx.t({
        en: `Found ${trajectory.length} trajectory records. Analyzing...`,
        zh: `找到 ${trajectory.length} 条轨迹记录。正在分析...`,
      }),
      timestamp: Date.now(),
    };

    // 2. 学习技能
    const skillsDir = join(ctx.workDir, '.tachikoma', 'skills');
    const result: LearnSkillResult = await learnSkillFromTrajectory(trajectory, {
      llmCall: ctx.llmCall,
      skillsDir,
      taskDescription: description,
      overwrite: true,
      autoUpdateSimilar: true,
      maxSkills: 5,
      similarity: { minLen: 12, levenshteinRatio: 0.2 },
      source: 'manual',
      userGuidance: args.length > 0 ? args.join(' ') : undefined,
      onSkillsRefresh: async () => {
        // 刷新技能列表到 Memory Block
        const { skills } = loadSkills({ enabled: true }, ctx.workDir);
        const blockManager = getGlobalSkillBlockManager();
        blockManager.refreshSkillsBlock(skills);
      },
    });

    // 3. 返回结果
    if (result.success && result.skill) {
      yield {
        type: 'complete',
        success: true,
        summary: ctx.t({
          en: `Skill learned successfully!\n\nName: ${result.skill.name}\nPath: ${result.skill.path}\nTags: ${result.skill.tags.join(', ')}\n\nUse /skill load ${result.skill.name} to activate.`,
          zh: `技能学习成功！\n\n名称: ${result.skill.name}\n路径: ${result.skill.path}\n标签: ${result.skill.tags.join(', ')}\n\n使用 /skill load ${result.skill.name} 激活。`,
        }),
        timestamp: Date.now(),
      };
    } else if (result.error?.includes('learnable patterns')) {
      // 没有可学习的模式，不算错误
      yield {
        type: 'complete',
        success: true,
        summary: ctx.t({
          en: 'No new skills to learn from this trajectory. The execution was routine or did not contain extractable patterns.',
          zh: '本次轨迹没有可沉淀的新技能。执行过程较为常规，未发现可提取的模式。',
        }),
        timestamp: Date.now(),
      };
    } else {
      yield {
        type: 'complete',
        success: false,
        summary: ctx.t({
          en: `Failed to learn skill: ${result.error ?? 'Unknown error'}`,
          zh: `技能学习失败: ${result.error ?? '未知错误'}`,
        }),
        timestamp: Date.now(),
      };
    }
  } catch (error) {
    yield {
      type: 'error',
      error: ctx.t({
        en: `Failed to learn skill: ${error instanceof Error ? error.message : String(error)}`,
        zh: `技能学习失败: ${error instanceof Error ? error.message : String(error)}`,
      }),
      retryable: false,
      timestamp: Date.now(),
    };
  }
}

/**
 * /skill help - 显示帮助
 */
async function* executeSkillHelp(ctx: SkillCommandContext): AsyncGenerator<StreamEvent> {
  yield {
    type: 'complete',
    success: true,
    summary: ctx.t({
      en: `Skill Commands:
/skill list              - List all available skills
/skill load <name>       - Load a skill into context
/skill unload <name>     - Unload a skill from context
/skill learn [desc]      - Learn a skill from recent execution
/skill help              - Show this help

Examples:
  /skill list
  /skill load git-workflow
  /skill learn "API implementation patterns"`,
      zh: `技能命令:
/skill list              - 列出所有可用技能
/skill load <名称>       - 加载技能到上下文
/skill unload <名称>     - 从上下文卸载技能
/skill learn [描述]      - 从最近执行中学习技能
/skill help              - 显示此帮助

示例:
  /skill list
  /skill load git-workflow
  /skill learn "API 实现模式"`,
    }),
    timestamp: Date.now(),
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从会话中提取轨迹
 */
function extractTrajectoryFromSession(session: SessionState): TrajectoryRecord[] {
  const trajectory: TrajectoryRecord[] = [];

  // 从 session.variables 中提取最近的轨迹（如果存在）
  const recentThinking = session.variables.recentThinking as ThinkingRecord[] | undefined;
  const recentActions = session.variables.recentActions as ActionRecord[] | undefined;

  if (Array.isArray(recentThinking)) {
    for (const record of recentThinking) {
      trajectory.push(thinkingRecordToTrajectory(record));
    }
  }

  if (Array.isArray(recentActions)) {
    for (const record of recentActions) {
      trajectory.push(actionRecordToTrajectory(record));
    }
  }

  // 按时间排序
  trajectory.sort((a, b) => a.timestamp - b.timestamp);

  return trajectory;
}
