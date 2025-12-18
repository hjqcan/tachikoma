/**
 * Code Planner Tool
 *
 * 针对特定任务生成代码实现计划
 * 分析依赖、确定涉及文件、生成测试策略
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';
import { validatePath, ensureWorkDir } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

export interface CodePlannerInput {
  /** 任务描述 */
  task: string;
  /** 上下文目录 (默认 specs/) */
  contextDir?: string;
  /** 现有文件列表 (可选，帮助分析) */
  fileList?: string[];
  /**
   * 可选：LLM 配置覆盖（用于 CLI/脚本直接调用，避免依赖 process.env）
   *
   * 优先级：input.llm > context.env > process.env
   */
  llm?: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
  };
}

export interface CodePlan {
  /** 需要创建的文件 */
  filesToCreate: { path: string; description: string }[];
  /** 需要修改的文件 */
  filesToModify: { path: string; description: string }[];
  /** 测试策略 */
  testStrategy: string;
  /** 实现步骤 */
  steps: string[];
  /** 依赖变更 (npm/pip) */
  dependencies?: string[];
}

export interface CodePlannerOutput {
  plan: CodePlan;
  reasoning: string;
}

// =============================================================================
// Prompts
// =============================================================================

const SYSTEM_PROMPT = `
You are a Senior Software Engineer acting as a Code Planner.
Your goal is to analyze a specific implementation task and create a precise, actionable plan for a Junior Developer (AI Agent).

Input Context:
1. Architecture & Specs (from markdown files)
2. Current Task Description
3. Existing File Structure

Output Constraints:
- Return a JSON object with the execution plan.
- Focus on incremental changes.
- Identify dependencies clearly.
`;

// =============================================================================
// 工具定义
// =============================================================================

export const codePlannerTool: Tool = {
  name: 'code_planner',
  title: 'Code Planner',
  description: 'Analyze a task and generate a detailed implementation plan (files to touch, steps to take).',
  
  category: ToolCategory.Agent,
  layer: ToolLayer.CodeExecution,
  permissions: [ToolPermission.FileSystemRead],
  
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Description of the task to implement',
      },
      contextDir: {
        type: 'string',
        description: 'Directory containing spec.md/architecture.md (default: specs/)',
      },
      fileList: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of existing files to consider',
      },
    },
    required: ['task'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: {
              filesToCreate: { type: 'array' },
              filesToModify: { type: 'array' },
              steps: { type: 'array' },
            },
          },
          reasoning: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.8,
    estimatedDuration: 30000,
  },

  execute: async (input: unknown, context: ExecutionContext): Promise<ToolResult<CodePlannerOutput>> => {
    const {
      task,
      contextDir = 'specs',
      fileList = [],
      llm: llmOverride,
    } = input as CodePlannerInput;

    try {
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };

      // 1. 读取上下文文件
      const specsPath = validatePath(join(contextDir, 'spec.md'), context.workDir);
      const archPath = validatePath(join(contextDir, 'architecture.md'), context.workDir);

      let contextContent = '';
      
      if (existsSync(archPath)) {
        contextContent += `\n=== ARCHITECTURE (architecture.md) ===\n${await readFile(archPath, 'utf-8')}\n`;
      }
      if (existsSync(specsPath)) {
        // 截取部分 PRD 以节省 Token
        const spec = await readFile(specsPath, 'utf-8');
        contextContent += `\n=== SPECS (spec.md) ===\n${spec.slice(0, 5000)}\n`;
      }

      if (!contextContent) {
        contextContent = 'No spec/architecture files found. Relying on task description only.';
      }

      // 2. 动态导入 LLM
      const { createLLMClient } = await import('../../planner/llm-client');

      const env = (context.env ?? process.env) as Record<string, string | undefined>;
      const apiKey =
        llmOverride?.apiKey ||
        env.OPENROUTER_API_KEY ||
        env.OPENAI_API_KEY ||
        '';
      if (!apiKey) {
        return { success: false, error: 'Missing API key. Provide input.llm.apiKey or set OPENROUTER_API_KEY/OPENAI_API_KEY.' };
      }

      const baseUrl =
        llmOverride?.baseUrl ||
        env.OPENROUTER_BASE_URL ||
        (env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined);
      const model = llmOverride?.model || env.OPENROUTER_MODEL || 'gpt-4o';
      const provider = llmOverride?.provider || 'openai';

      const llm = createLLMClient({
        provider,
        apiKey,
        ...(baseUrl && { baseUrl }),
        model,
        maxTokens: llmOverride?.maxTokens ?? 2000,
      });

      // 3. 构建 Prompt
      const userPrompt = `
Task: ${task}

Existing Files:
${fileList.slice(0, 500).join('\n')}

${contextContent}

Please generate a JSON execution plan in the following format:
{
  "filesToCreate": [{"path": "string", "description": "string"}],
  "filesToModify": [{"path": "string", "description": "string"}],
  "dependencies": ["npm install x", "pip install y"],
  "testStrategy": "string",
  "steps": ["step 1", "step 2"]
}
`;

      // 4. 调用 LLM
      const response = await llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userPrompt },
        ],
      });

      // 5. 解析 JSON
      let content = response.content;
      // 尝试提取 JSON 块
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        const extracted = jsonMatch[1];
        if (extracted === undefined) {
          throw new Error('Matched a fenced code block, but failed to extract the JSON content.');
        }
        content = extracted;
      }

      let plan: CodePlan;
      try {
        plan = JSON.parse(content);
      } catch {
         // 简单的 fallback 或者重试逻辑
         // 这里简单返回原始内容放在 reasoning
         throw new Error('Failed to parse LLM JSON response');
         // 或者可以使用 LLM 修复 JSON，但这里为了 MVP 省略
      }

      return {
        success: true,
        data: {
          plan,
          reasoning: (response.content || '').substring(0, 200) + '...', // 保留部分原始思考
        },
      };

    } catch (error) {
       const msg = error instanceof Error ? error.message : String(error);
       return {
         success: false,
         error: `Code Planning failed: ${msg}`,
       };
    }
  },
};
