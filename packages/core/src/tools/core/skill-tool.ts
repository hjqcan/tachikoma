/**
 * Skill Tool
 *
 * 管理 Skill 的生命周期：load/unload/refresh
 * 参考 Letta-Code 的 Skill Tool 设计
 *
 * @module tools/core/skill-tool
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Tool, ExecutionContext } from '../../types';
import { ToolCategory, ToolLayer, ToolPermission, type ToolResult } from '../types';

// ============================================================================
// Schema 定义
// ============================================================================

const SkillToolSchema = z.object({
  command: z
    .enum(['load', 'unload', 'refresh', 'list'])
    .describe('The command to execute: load (activate skill), unload (deactivate skill), refresh (rescan skills directory), list (show loaded skills)'),
  skills: z
    .array(z.string())
    .optional()
    .describe('Skill names to load/unload. Required for load/unload commands.'),
});

type SkillToolInput = z.infer<typeof SkillToolSchema>;

// ============================================================================
// Skill Tool 实现
// ============================================================================

/**
 * 获取全局 SkillBlockManager 实例
 * 延迟导入以避免循环依赖
 */
async function getBlockManager() {
  const { getGlobalSkillBlockManager } = await import('../../skills');
  return getGlobalSkillBlockManager();
}

/**
 * Skill Tool 执行函数
 *
 * 关键设计：
 * - 所有状态由 SkillBlockManager 管理（单一数据源）
 * - 返回值包含已加载技能内容的摘要，供 LLM 参考
 */
async function executeSkillTool(
  input: SkillToolInput,
  context: ExecutionContext,
): Promise<ToolResult> {
  const { command, skills: skillNames } = input;

  // load/unload 需要技能名称
  if ((command === 'load' || command === 'unload') && (!skillNames || skillNames.length === 0)) {
    return {
      success: false,
      error: `Skill tool requires 'skills' array for "${command}" command`,
    };
  }

  try {
    // 动态导入以避免循环依赖
    const { loadSkills, loadSkillContent } = await import('../../skills');

    const workDir = context.workDir || process.cwd();
    const blockManager = await getBlockManager();

    switch (command) {
      case 'refresh': {
        // 重新扫描并发现技能
        const outcome = loadSkills({ enabled: true }, workDir);

        // 更新技能列表缓存
        blockManager.refreshSkillsBlock(outcome.skills);

        const errorCount = outcome.errors.length;
        const errorMsg = errorCount > 0 ? `, ${errorCount} error(s)` : '';

        return {
          success: true,
          data: `Refreshed skills list: found ${outcome.skills.length} skill(s)${errorMsg}\n\nAvailable skills:\n${outcome.skills.map((s) => `  - ${s.name}: ${s.description}`).join('\n') || '  (none)'}`,
          meta: {
            skillCount: outcome.skills.length,
            errorCount,
            skillNames: outcome.skills.map((s) => s.name),
          },
        };
      }

      case 'list': {
        // 列出当前已加载的技能
        const loadedIds = blockManager.getLoadedSkillIds();
        
        if (loadedIds.length === 0) {
          return {
            success: true,
            data: 'No skills currently loaded. Use `skill load <name>` to load a skill.',
            meta: { loadedCount: 0 },
          };
        }

        // 返回已加载技能的内容摘要（前200字符）
        const loadedBlock = blockManager.getLoadedSkillsBlock();
        const preview = loadedBlock.value.length > 500 
          ? loadedBlock.value.substring(0, 500) + '...(truncated)'
          : loadedBlock.value;

        return {
          success: true,
          data: `Currently loaded skills (${loadedIds.length}):\n${loadedIds.map((id) => `  - ${id}`).join('\n')}\n\nLoaded content preview:\n${preview}`,
          meta: { loadedCount: loadedIds.length, loadedSkills: loadedIds },
        };
      }

      case 'load': {
        // 加载技能
        const outcome = loadSkills({ enabled: true }, workDir);
        const results: string[] = [];
        const skillsToLoad = skillNames ?? [];

        // 并行加载所有技能
        const loadPromises = skillsToLoad.map(async (skillName) => {
          // 检查是否已加载
          if (blockManager.getLoadedSkillIds().includes(skillName)) {
            return `"${skillName}" already loaded`;
          }

          // 查找技能元数据
          const skillMeta = outcome.skills.find((s) => s.name === skillName);
          if (!skillMeta) {
            return `"${skillName}" not found`;
          }

          try {
            // 加载技能完整内容
            const skillContent = await loadSkillContent(skillMeta);
            return { skillName, body: skillContent.body, success: true };
          } catch (error) {
            return `"${skillName}" failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        });

        const loadResults = await Promise.all(loadPromises);

        // 处理结果
        for (const result of loadResults) {
          if (typeof result === 'string') {
            results.push(result);
          } else {
            // 使用 BlockManager 加载技能
            blockManager.loadSkill(result.skillName, result.body);
            results.push(`"${result.skillName}" loaded`);
          }
        }

        // 返回已加载的技能内容
        const loadedContent = blockManager.renderLoadedSkillsForPrompt();

        return {
          success: true,
          data: `${results.join(', ')}\n\n${loadedContent ?? ''}`,
          meta: { loadedSkills: blockManager.getLoadedSkillIds() },
        };
      }

      case 'unload': {
        const results: string[] = [];
        const skillsToUnload = skillNames ?? [];
        const currentLoadedIds = blockManager.getLoadedSkillIds();

        for (const skillName of skillsToUnload) {
          if (!currentLoadedIds.includes(skillName)) {
            results.push(`"${skillName}" not loaded`);
            continue;
          }
          
          // 使用 BlockManager 卸载技能
          blockManager.unloadSkill(skillName);
          results.push(`"${skillName}" unloaded`);
        }

        return {
          success: true,
          data: results.join(', '),
          meta: { loadedSkills: blockManager.getLoadedSkillIds() },
        };
      }

      default:
        return {
          success: false,
          error: `Unknown command: ${command}. Must be "load", "unload", "refresh", or "list".`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to ${command} skill(s): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// Tool 导出
// ============================================================================

export const skillTool: Tool = {
  name: 'skill',
  title: 'Skill Manager',
  description:
    'Manage skills: load (activate a skill into context), unload (deactivate a skill), ' +
    'refresh (rescan skills directory), or list (show loaded skills). ' +
    'Use "refresh" to discover new skills, then "load" to activate them. ' +
    'Loaded skills will be injected into your context automatically.',
  category: ToolCategory.Agent,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemRead],
  inputSchema: zodToJsonSchema(SkillToolSchema as unknown as any) as Record<string, unknown>,

  execute: async (input: unknown, context: ExecutionContext): Promise<ToolResult> => {
    const validatedInput = SkillToolSchema.parse(input);
    return executeSkillTool(validatedInput, context);
  },
};
