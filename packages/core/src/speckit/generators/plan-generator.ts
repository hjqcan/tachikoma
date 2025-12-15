/**
 * Plan Generator
 *
 * 使用 LLM 基于规范和技术栈生成实现计划
 */

import type {
  PlanInput,
  ImplementationPlan,
  Specification,
  TechStackConfig,
  ImplementationPhase,
  APIContract,
  ResearchNotes,
} from '../types';
import type { LLMClient } from '../../planner/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Plan Generator 配置
 */
export interface PlanGeneratorConfig {
  /** LLM 客户端 */
  llmClient: LLMClient;
}

// ============================================================================
// 常量
// ============================================================================

const SYSTEM_PROMPT = `You are a technical architect. Your task is to create an implementation plan based on a functional specification and technology stack.

Create a detailed, actionable plan that developers can follow. Output your response in valid JSON format:

{
  "techStack": {
    "runtime": "e.g., Node.js 20, Bun 1.0",
    "frontend": "e.g., React 18, Vue 3, Vanilla JS",
    "backend": "e.g., Express, Hono, FastAPI",
    "database": "e.g., PostgreSQL, SQLite, MongoDB",
    "dependencies": ["package1", "package2"],
    "description": "Brief tech stack summary"
  },
  "architecture": {
    "pattern": "e.g., MVC, Clean Architecture, Layered",
    "decisions": ["Key decision 1", "Key decision 2"],
    "constraints": ["Constraint 1"]
  },
  "phases": [
    {
      "id": "phase-1",
      "name": "Project Setup",
      "description": "Initialize project structure",
      "steps": ["Step 1", "Step 2"],
      "estimatedHours": 2
    }
  ],
  "contracts": [
    {
      "name": "API Contract",
      "baseUrl": "/api/v1",
      "endpoints": [
        {"method": "GET", "path": "/items", "description": "List all items"}
      ]
    }
  ],
  "research": {
    "techStackResearch": "Notes about chosen technologies",
    "bestPractices": ["Practice 1", "Practice 2"],
    "risks": ["Risk 1"]
  }
}

Be specific about file paths, package versions, and implementation order.`;

// ============================================================================
// PlanGenerator
// ============================================================================

/**
 * Plan Generator
 *
 * 基于规范和技术栈生成实现计划
 */
export class PlanGenerator {
  private readonly llmClient: LLMClient;

  constructor(config: PlanGeneratorConfig) {
    this.llmClient = config.llmClient;
  }

  /**
   * 生成实现计划
   */
  async generate(input: PlanInput): Promise<ImplementationPlan> {
    const userPrompt = this.buildUserPrompt(input);

    const response = await this.llmClient.complete({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 4000,
    });

    const parsed = this.parseResponse(response.content);
    const rawContent = this.renderPlan(parsed, input.specification);

    return {
      specId: input.specification.id,
      techStack: parsed.techStack || {},
      phases: parsed.phases || [],
      rawContent,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 针对特定技术进行深入研究
   */
  async research(plan: ImplementationPlan, topics: string[]): Promise<ResearchNotes> {
    const userPrompt = `Current implementation plan:
${plan.rawContent}

Please research the following topics in depth:
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Provide detailed research notes, best practices, potential issues, and recommendations.
Output in JSON format:
{
  "techStackResearch": "Detailed notes",
  "bestPractices": ["Practice 1", "Practice 2"],
  "risks": ["Risk 1", "Risk 2"]
}`;

    const response = await this.llmClient.complete({
      systemPrompt:
        'You are a technical researcher providing in-depth analysis of software technologies and practices.',
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 3000,
    });

    const parsed = this.parseResearch(response.content);
    const result: ResearchNotes = {
      rawContent: response.content,
    };
    if (parsed.techStackResearch) result.techStackResearch = parsed.techStackResearch;
    if (parsed.bestPractices) result.bestPractices = parsed.bestPractices;
    if (parsed.risks) result.risks = parsed.risks;
    return result;
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  private buildUserPrompt(input: PlanInput): string {
    let prompt = `Please create an implementation plan for the following specification:\n\n`;
    prompt += `# Specification: ${input.specification.name}\n\n`;
    prompt += input.specification.rawContent;
    prompt += `\n\n## Technology Stack Requirements:\n${input.techStackPrompt}`;

    if (input.constitution) {
      prompt += `\n\n## Project Principles to Follow:\n`;
      for (const principle of input.constitution.principles) {
        prompt += `- ${principle}\n`;
      }
    }

    return prompt;
  }

  private parseResponse(content: string): PlanData {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { phases: [] };
    }

    try {
      return JSON.parse(jsonMatch[0]) as PlanData;
    } catch {
      return { phases: [] };
    }
  }

  private parseResearch(content: string): ResearchData {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {};
    }

    try {
      return JSON.parse(jsonMatch[0]) as ResearchData;
    } catch {
      return {};
    }
  }

  private renderPlan(data: PlanData, spec: Specification): string {
    let md = `# Implementation Plan: ${spec.name}\n\n`;

    // Tech Stack
    if (data.techStack) {
      md += `## Technology Stack\n\n`;
      if (data.techStack.description) {
        md += `${data.techStack.description}\n\n`;
      }
      md += `| Component | Technology |\n`;
      md += `|-----------|------------|\n`;
      if (data.techStack.runtime) md += `| Runtime | ${data.techStack.runtime} |\n`;
      if (data.techStack.frontend) md += `| Frontend | ${data.techStack.frontend} |\n`;
      if (data.techStack.backend) md += `| Backend | ${data.techStack.backend} |\n`;
      if (data.techStack.database) md += `| Database | ${data.techStack.database} |\n`;
      md += '\n';

      if (data.techStack.dependencies?.length) {
        md += `### Dependencies\n`;
        for (const dep of data.techStack.dependencies) {
          md += `- ${dep}\n`;
        }
        md += '\n';
      }
    }

    // Architecture
    if (data.architecture) {
      md += `## Architecture\n\n`;
      if (data.architecture.pattern) {
        md += `**Pattern:** ${data.architecture.pattern}\n\n`;
      }
      if (data.architecture.decisions?.length) {
        md += `### Key Decisions\n`;
        for (const decision of data.architecture.decisions) {
          md += `- ${decision}\n`;
        }
        md += '\n';
      }
      if (data.architecture.constraints?.length) {
        md += `### Constraints\n`;
        for (const constraint of data.architecture.constraints) {
          md += `- ${constraint}\n`;
        }
        md += '\n';
      }
    }

    // Phases
    if (data.phases?.length) {
      md += `## Implementation Phases\n\n`;
      for (const phase of data.phases) {
        md += `### ${phase.id}: ${phase.name}\n\n`;
        if (phase.description) {
          md += `${phase.description}\n\n`;
        }
        if (phase.estimatedHours) {
          md += `**Estimated:** ${phase.estimatedHours} hours\n\n`;
        }
        if (phase.steps?.length) {
          md += `**Steps:**\n`;
          for (const step of phase.steps) {
            md += `1. ${step}\n`;
          }
          md += '\n';
        }
      }
    }

    // API Contracts
    if (data.contracts?.length) {
      md += `## API Contracts\n\n`;
      for (const contract of data.contracts) {
        md += `### ${contract.name}\n\n`;
        if (contract.baseUrl) {
          md += `**Base URL:** \`${contract.baseUrl}\`\n\n`;
        }
        if (contract.endpoints?.length) {
          md += `| Method | Path | Description |\n`;
          md += `|--------|------|-------------|\n`;
          for (const ep of contract.endpoints) {
            md += `| ${ep.method} | \`${ep.path}\` | ${ep.description ?? ''} |\n`;
          }
          md += '\n';
        }
      }
    }

    // Research
    if (data.research) {
      md += `## Research Notes\n\n`;
      if (data.research.techStackResearch) {
        md += `### Technology Research\n${data.research.techStackResearch}\n\n`;
      }
      if (data.research.bestPractices?.length) {
        md += `### Best Practices\n`;
        for (const practice of data.research.bestPractices) {
          md += `- ${practice}\n`;
        }
        md += '\n';
      }
      if (data.research.risks?.length) {
        md += `### Risks\n`;
        for (const risk of data.research.risks) {
          md += `- ⚠️ ${risk}\n`;
        }
        md += '\n';
      }
    }

    return md;
  }
}

// ============================================================================
// 内部类型
// ============================================================================

interface PlanData {
  techStack?: TechStackConfig;
  architecture?: {
    pattern?: string;
    decisions?: string[];
    constraints?: string[];
  };
  phases?: ImplementationPhase[];
  contracts?: APIContract[];
  research?: ResearchData;
}

interface ResearchData {
  techStackResearch?: string;
  bestPractices?: string[];
  risks?: string[];
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Plan Generator
 */
export function createPlanGenerator(config: PlanGeneratorConfig): PlanGenerator {
  return new PlanGenerator(config);
}
