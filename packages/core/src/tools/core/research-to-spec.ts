/**
 * Research to Spec Tool
 *
 * 将研究报告转换为可执行的项目规范 (PRD, 架构, 任务列表)
 * 依赖 LLM 能力
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';
import { validatePath, ensureWorkDir } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

export interface ResearchToSpecInput {
  /** 研究报告内容或文件路径 */
  report: string;
  /** 项目名称 */
  projectName: string;
  /** 输出目录 (默认为 specs/) */
  outputDir?: string;
  /** 语言 (默认 zh-CN) */
  language?: string;
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

export interface ResearchToSpecOutput {
  specFile: string;
  archFile: string;
  taskFile: string;
  summary: string;
}

// =============================================================================
// Prompts
// =============================================================================

const SPEC_PROMPT = `
You are an expert Product Manager. Based on the following research report, create a detailed Product Requirements Document (PRD) in Markdown.

Format requirements:
1. **Title**: Project Name & Version
2. **Background**: Context and Problem Statement
3. **Goals**: Core Objectives
4. **User Stories**: Detailed user scenarios
5. **Functional Requirements**: List of features (P0/P1/P2)
6. **Non-Functional Requirements**: Performance, Security, etc.
7. **Success Metrics**: KPI
`;

const ARCH_PROMPT = `
You are an expert System Architect. Based on the Research Report and PRD, design a technical architecture.

Format requirements:
1. **System Overview**: High-level design
2. **Tech Stack**: Recommended technologies (Frontend, Backend, Database, AI Models, etc.) with reasoning.
3. **Component Diagram**: Mermaid diagram of components.
4. **Data Flow**: How data moves through the system.
5. **API Design**: Key API endpoints (REST/GraphQL).
6. **Database Schema**: Key entities and relationships.
7. **Infrastructure**: Deployment strategy (Docker, Cloud, etc.).
`;

const TASK_PROMPT = `
You are an expert Technical Project Manager. Based on the PRD and Architecture, create a phased Implementation Plan.

Format requirements:
1. **Phase 1: MVP**: Core features (Weeks 1-2)
2. **Phase 2: Enhancement**: Secondary features
3. **Phase 3: Optimization**: Polish and non-functional requirements

For each phase, list specific actionable tasks in checklist format:
- [ ] Task Name: Description
`;

// =============================================================================
// 工具定义
// =============================================================================

export const researchToSpecTool: Tool = {
  name: 'research_to_spec',
  title: 'Research to Spec',
  description: 'Convert a research report into actionable project specifications (PRD, Architecture, Tasks) using LLM.',
  
  category: ToolCategory.Agent, // 使用 Agent 能力
  layer: ToolLayer.CodeExecution, // 需要较高权限
  permissions: [ToolPermission.FileSystemWrite],
  
  inputSchema: {
    type: 'object',
    properties: {
      report: {
        type: 'string',
        description: 'Research report content or file path',
      },
      projectName: {
        type: 'string',
        description: 'Name of the project',
      },
      outputDir: {
        type: 'string',
        description: 'Directory to save output files (default: specs/)',
      },
      language: {
        type: 'string',
        description: 'Output language (default: zh-CN)',
        default: 'zh-CN',
      },
    },
    required: ['report', 'projectName'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          specFile: { type: 'string' },
          archFile: { type: 'string' },
          taskFile: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.9,
    estimatedDuration: 60000, // 生成过程较慢
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<ResearchToSpecOutput>> {
    const {
      report,
      projectName,
      outputDir = 'specs',
      language = 'zh-CN',
      llm: llmOverride,
    } = input as ResearchToSpecInput;

    try {
      // 1. 验证工作目录
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };
      }

      // 2. 获取报告内容
      let reportContent = report;
      if (report.startsWith('/') || report.match(/\.(md|txt)$/)) {
        const reportPath = validatePath(report, context.workDir);
        if (existsSync(reportPath)) {
          reportContent = await readFile(reportPath, 'utf-8');
        }
      }

      if (!reportContent || reportContent.length < 50) {
        return { success: false, error: 'Report content is too short or file not found.' };
      }

      // 3. 动态导入 LLM Client (避免循环依赖)
      // NOTE: 这里的路径需要根据实际构建结构调整，假设相对路径是正确的
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
        maxTokens: llmOverride?.maxTokens ?? 4000,
      });

      // 4. 定义生成函数
      const generate = async (prompt: string, type: string) => {
        const systemPrompt = `You are a professional software architect assistance.
Output Language: ${language}
Project: ${projectName}
`;
        const userPrompt = `${prompt}\n\n=== RESEARCH REPORT ===\n${reportContent}`;
        
        try {
          const response = await llm.complete({
            systemPrompt,
            messages: [
              { role: 'user', content: userPrompt },
            ],
          });
          return response.content;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to generate ${type}: ${msg}`);
        }
      };

      // 5. 并行生成 (为了速度) 或 串行 (为了上下文)?
      // 为了更好的一致性，应该串行，并把前一步的输出作为上下文
      // 但为了简单 MVP，先并行生成，或者 Spec -> Arch -> Task
      
      // Step 1: Generate PRD
      const specContent = await generate(SPEC_PROMPT, 'PRD');
      
      // Step 2: Generate Architecture (with PRD context)
      // 组合 prompt
      const archInput = `${ARCH_PROMPT}\n\n=== PRD ===\n${specContent.slice(0, 2000)}...`; 
      const archContent = await generate(archInput, 'Architecture');

      // Step 3: Generate Tasks (with PRD & Arch context)
      const taskInput = `${TASK_PROMPT}\n\n=== PRD ===\n${specContent.slice(0, 1000)}...\n\n=== ARCHITECTURE ===\n${archContent.slice(0, 1000)}...`;
      const taskContent = await generate(taskInput, 'Tasks');

      // 6. 写入文件
      const outPath = validatePath(outputDir, context.workDir);
      await mkdir(outPath, { recursive: true });

      const specFile = join(outPath, 'spec.md');
      const archFile = join(outPath, 'architecture.md');
      const taskFile = join(outPath, 'tasks.md');

      await writeFile(specFile, specContent, 'utf-8');
      await writeFile(archFile, archContent, 'utf-8');
      await writeFile(taskFile, taskContent, 'utf-8');

      return {
        success: true,
        data: {
          specFile,
          archFile,
          taskFile,
          summary: `Successfully generated specifications in ${outPath}`,
        },
      };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Research to Spec failed: ${msg}`,
      };
    }
  },
};
