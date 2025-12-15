/**
 * Constitution Generator
 *
 * 使用 LLM 生成项目宪法（治理原则）
 */

import type { ConstitutionInput, Constitution } from '../types';
import type { LLMClient } from '../../planner/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Constitution Generator 配置
 */
export interface ConstitutionGeneratorConfig {
  /** LLM 客户端 */
  llmClient: LLMClient;
  /** 模板内容（可选） */
  template?: string;
}

// ============================================================================
// 常量
// ============================================================================

const SYSTEM_PROMPT = `You are a software architecture expert helping to establish project governance principles.

Your task is to generate a comprehensive project constitution based on the user's input.
The constitution should cover:
1. Core Principles - Fundamental values guiding the project
2. Code Quality Guidelines - Code style, naming, documentation, error handling
3. Testing Standards - Coverage, test types, TDD approach
4. UX Consistency - Design principles, accessibility, responsiveness
5. Performance Requirements - Load times, memory, optimization

Output your response in valid JSON format with this structure:
{
  "principles": ["principle 1", "principle 2", ...],
  "codeQuality": {
    "codeStyle": "description",
    "namingConventions": "description",
    "documentationRequirements": "description",
    "errorHandling": "description"
  },
  "testingStandards": {
    "coverageRequirements": "description",
    "testTypes": ["type1", "type2"],
    "tddApproach": "description"
  },
  "uxConsistency": {
    "designPrinciples": ["principle1", "principle2"],
    "accessibility": "description",
    "responsiveness": "description"
  },
  "performance": {
    "loadTimeTargets": "description",
    "memoryLimits": "description",
    "optimizationStrategies": ["strategy1", "strategy2"]
  }
}

Be concise but comprehensive. Focus on actionable guidelines.`;

// ============================================================================
// ConstitutionGenerator
// ============================================================================

/**
 * Constitution Generator
 *
 * 使用 LLM 从用户输入生成项目宪法
 */
export class ConstitutionGenerator {
  private readonly llmClient: LLMClient;

  constructor(config: ConstitutionGeneratorConfig) {
    this.llmClient = config.llmClient;
  }

  /**
   * 生成项目宪法
   */
  async generate(input: ConstitutionInput): Promise<Constitution> {
    const userPrompt = this.buildUserPrompt(input);

    const response = await this.llmClient.complete({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2000,
    });

    const parsed = this.parseResponse(response.content);
    const rawContent = this.renderConstitution(parsed, input.projectName);

    return {
      version: '1.0',
      principles: parsed.principles || [],
      rawContent,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 根据反馈细化现有宪法
   */
  async refine(existing: Constitution, feedback: string): Promise<Constitution> {
    const userPrompt = `Current constitution:
${existing.rawContent}

User feedback for refinement:
${feedback}

Please update the constitution based on the feedback. Output the updated constitution in the same JSON format.`;

    const response = await this.llmClient.complete({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2000,
    });

    const parsed = this.parseResponse(response.content);
    const rawContent = this.renderConstitution(parsed);

    return {
      ...existing,
      principles: parsed.principles || existing.principles,
      rawContent,
      updatedAt: Date.now(),
    };
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  private buildUserPrompt(input: ConstitutionInput): string {
    let prompt = `Please create a project constitution based on the following requirements:\n\n`;

    if (input.projectName) {
      prompt += `Project Name: ${input.projectName}\n\n`;
    }

    prompt += `User Requirements:\n${input.prompt}`;

    return prompt;
  }

  private parseResponse(content: string): ConstitutionData {
    // 尝试从响应中提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 如果没有找到 JSON，返回默认结构
      return {
        principles: ['Write clean, maintainable code', 'Test thoroughly', 'Document clearly'],
      };
    }

    try {
      return JSON.parse(jsonMatch[0]) as ConstitutionData;
    } catch {
      return {
        principles: ['Write clean, maintainable code', 'Test thoroughly', 'Document clearly'],
      };
    }
  }

  private renderConstitution(data: ConstitutionData, projectName?: string): string {
    let md = `# ${projectName ? `${projectName} ` : ''}Project Constitution\n\n`;

    // Core Principles
    md += `## Core Principles\n\n`;
    if (data.principles?.length) {
      for (const principle of data.principles) {
        md += `- ${principle}\n`;
      }
    }
    md += '\n';

    // Code Quality
    md += `## Code Quality Guidelines\n\n`;
    if (data.codeQuality) {
      if (data.codeQuality.codeStyle) {
        md += `### Code Style\n${data.codeQuality.codeStyle}\n\n`;
      }
      if (data.codeQuality.namingConventions) {
        md += `### Naming Conventions\n${data.codeQuality.namingConventions}\n\n`;
      }
      if (data.codeQuality.documentationRequirements) {
        md += `### Documentation Requirements\n${data.codeQuality.documentationRequirements}\n\n`;
      }
      if (data.codeQuality.errorHandling) {
        md += `### Error Handling\n${data.codeQuality.errorHandling}\n\n`;
      }
    }

    // Testing Standards
    md += `## Testing Standards\n\n`;
    if (data.testingStandards) {
      if (data.testingStandards.coverageRequirements) {
        md += `### Coverage Requirements\n${data.testingStandards.coverageRequirements}\n\n`;
      }
      if (data.testingStandards.testTypes?.length) {
        md += `### Test Types\n`;
        for (const type of data.testingStandards.testTypes) {
          md += `- ${type}\n`;
        }
        md += '\n';
      }
      if (data.testingStandards.tddApproach) {
        md += `### TDD Approach\n${data.testingStandards.tddApproach}\n\n`;
      }
    }

    // UX Consistency
    md += `## UX Consistency Guidelines\n\n`;
    if (data.uxConsistency) {
      if (data.uxConsistency.designPrinciples?.length) {
        md += `### Design Principles\n`;
        for (const principle of data.uxConsistency.designPrinciples) {
          md += `- ${principle}\n`;
        }
        md += '\n';
      }
      if (data.uxConsistency.accessibility) {
        md += `### Accessibility\n${data.uxConsistency.accessibility}\n\n`;
      }
      if (data.uxConsistency.responsiveness) {
        md += `### Responsiveness\n${data.uxConsistency.responsiveness}\n\n`;
      }
    }

    // Performance
    md += `## Performance Requirements\n\n`;
    if (data.performance) {
      if (data.performance.loadTimeTargets) {
        md += `### Load Time Targets\n${data.performance.loadTimeTargets}\n\n`;
      }
      if (data.performance.memoryLimits) {
        md += `### Memory Limits\n${data.performance.memoryLimits}\n\n`;
      }
      if (data.performance.optimizationStrategies?.length) {
        md += `### Optimization Strategies\n`;
        for (const strategy of data.performance.optimizationStrategies) {
          md += `- ${strategy}\n`;
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

interface ConstitutionData {
  principles?: string[];
  codeQuality?: {
    codeStyle?: string;
    namingConventions?: string;
    documentationRequirements?: string;
    errorHandling?: string;
  };
  testingStandards?: {
    coverageRequirements?: string;
    testTypes?: string[];
    tddApproach?: string;
  };
  uxConsistency?: {
    designPrinciples?: string[];
    accessibility?: string;
    responsiveness?: string;
  };
  performance?: {
    loadTimeTargets?: string;
    memoryLimits?: string;
    optimizationStrategies?: string[];
  };
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Constitution Generator
 */
export function createConstitutionGenerator(
  config: ConstitutionGeneratorConfig
): ConstitutionGenerator {
  return new ConstitutionGenerator(config);
}
