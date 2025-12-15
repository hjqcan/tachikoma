/**
 * Create Skill Tool
 *
 * 允许 Agent 动态创建新的 Skill (自进化能力)
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Tool, ExecutionContext } from '../../types';
import { ToolCategory, ToolLayer, ToolPermission } from '../types';

// NOTE: We use dynamic imports for SkillManager and ToolRegistry to avoid circular dependencies
// with tools/index.ts. This tool is a 'leaf' but connects two major systems.

const CreateSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'Name must be kebab-case (lowercase, numbers, hyphens)'),
  description: z.string().min(10, 'Description must be meaningful'),
  script_content: z.string().describe('The complete code for the script'),
  filename: z.string().regex(/^[^/\\]+$/, 'Filename must not contain path separators').describe('Filename with extension, e.g. main.py, index.ts'),
  dependencies: z.array(z.string()).optional().describe('List of dependencies (e.g. pip packages or npm packages)'),
  instructions: z.string().optional().describe('Usage instructions for the skill'),
});

export const createSkillTool: Tool = {
  name: 'create_skill',
  title: 'Create Skill',
  description: 'Dynamically create a new tool (Skill) that can be used immediately. Use this to expand your capabilities.',
  category: ToolCategory.Agent,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemWrite], // 需要写文件权限
  inputSchema: zodToJsonSchema(CreateSkillSchema as unknown as any) as Record<string, unknown>,
  
  execute: async (input: unknown, _context: ExecutionContext) => {
    const params = CreateSkillSchema.parse(input);
    
    // Dynamic import to break circular dependencies
    const { SkillManager } = await import('../../skills/manager');
    const { globalToolRegistry } = await import('../registry');
    
    const manager = new SkillManager(globalToolRegistry);

    try {
      await manager.createSkill(
        params.name,
        params.description,
        params.script_content,
        {
          filename: params.filename,
          ...(params.dependencies ? { dependencies: params.dependencies } : {}),
          ...(params.instructions ? { instructions: params.instructions } : {})
        }
      );

      // 获取新创建的工具定义以便返回给 LLM
      const newTool = globalToolRegistry.getByName(params.name);
      const schemaStr = newTool ? JSON.stringify(newTool.inputSchema, null, 2) : 'Check documentation';

      return {
        success: true,
        data: `Skill '${params.name}' created and registered successfully.\n\nUsage:\n${params.name}(args=[...])\n\nInput Schema:\n${schemaStr}\n\nYou can use this tool immediately.`,
        meta: {
          skillPath: params.name
        }
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to create skill: ${error.message}`
      };
    }
  },
};
