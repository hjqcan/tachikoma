/**
 * Specification Generator
 *
 * 使用 LLM 将自然语言需求转换为结构化功能规范
 */

import type { SpecificationInput, Specification, UserStory } from '../types';
import type { LLMClient } from '../../planner/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Specification Generator 配置
 */
export interface SpecificationGeneratorConfig {
  /** LLM 客户端 */
  llmClient: LLMClient;
}

// ============================================================================
// 常量
// ============================================================================

const SYSTEM_PROMPT = `You are a product specification expert. Your task is to convert natural language requirements into a structured functional specification.

Focus on the WHAT and WHY, NOT the HOW. Do not mention technology stack or implementation details.

Output your response in valid JSON format with this structure:
{
  "name": "Feature name",
  "description": "Brief description of the feature",
  "userStories": [
    {
      "id": "US-001",
      "description": "As a [user type], I want [goal] so that [benefit]",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "priority": "high"
    }
  ],
  "acceptanceCriteria": ["Global acceptance criterion 1", "..."],
  "outOfScope": ["Item that is explicitly not included"],
  "dataModel": {
    "entities": [
      {
        "name": "EntityName",
        "description": "What this entity represents",
        "fields": [
          {"name": "fieldName", "type": "string", "required": true, "description": "Field description"}
        ],
        "relationships": ["EntityName has many OtherEntity"]
      }
    ]
  }
}

Be comprehensive but concise. Focus on user-facing functionality.`;

// ============================================================================
// SpecificationGenerator
// ============================================================================

/**
 * Specification Generator
 *
 * 将自然语言需求转换为结构化的功能规范
 */
export class SpecificationGenerator {
  private readonly llmClient: LLMClient;

  constructor(config: SpecificationGeneratorConfig) {
    this.llmClient = config.llmClient;
  }

  /**
   * 生成功能规范
   */
  async generate(input: SpecificationInput): Promise<Specification> {
    const userPrompt = this.buildUserPrompt(input);

    const response = await this.llmClient.complete({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 3000,
    });

    const parsed = this.parseResponse(response.content);
    const specId = input.specId ?? this.generateSpecId(parsed.name ?? 'feature');
    const rawContent = this.renderSpecification(parsed, specId);

    return {
      id: specId,
      name: parsed.name || 'Untitled Feature',
      description: parsed.description || '',
      userStories: parsed.userStories || [],
      acceptanceCriteria: parsed.acceptanceCriteria || [],
      outOfScope: parsed.outOfScope || [],
      rawContent,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 澄清规范细节
   */
  async clarify(spec: Specification, questions: string[]): Promise<Specification> {
    const userPrompt = `Current specification:
${spec.rawContent}

Please clarify the following questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Update the specification to address these questions. Output the updated specification in the same JSON format.`;

    const response = await this.llmClient.complete({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 3000,
    });

    const parsed = this.parseResponse(response.content);
    const rawContent = this.renderSpecification(parsed, spec.id);

    return {
      ...spec,
      name: parsed.name || spec.name,
      description: parsed.description || spec.description,
      userStories: parsed.userStories || spec.userStories,
      acceptanceCriteria: parsed.acceptanceCriteria || spec.acceptanceCriteria,
      outOfScope: parsed.outOfScope || spec.outOfScope,
      rawContent,
      updatedAt: Date.now(),
    };
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  private buildUserPrompt(input: SpecificationInput): string {
    let prompt = `Please create a functional specification for the following requirements:\n\n`;
    prompt += input.prompt;

    if (input.constitution) {
      prompt += `\n\nProject Principles to follow:\n`;
      for (const principle of input.constitution.principles) {
        prompt += `- ${principle}\n`;
      }
    }

    return prompt;
  }

  private parseResponse(content: string): SpecificationData {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { name: 'Untitled', description: content };
    }

    try {
      return JSON.parse(jsonMatch[0]) as SpecificationData;
    } catch {
      return { name: 'Untitled', description: content };
    }
  }

  private generateSpecId(name: string): string {
    const slug = (name || 'feature')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30);
    const num = String(Date.now()).slice(-3).padStart(3, '0');
    return `${num}-${slug}`;
  }

  private renderSpecification(data: SpecificationData, specId: string): string {
    let md = `# ${data.name || specId}\n\n`;

    // Description
    if (data.description) {
      md += `## Overview\n\n${data.description}\n\n`;
    }

    // User Stories
    if (data.userStories?.length) {
      md += `## User Stories\n\n`;
      for (const story of data.userStories) {
        md += `### ${story.id}: ${this.extractStoryTitle(story.description)}\n\n`;
        md += `${story.description}\n\n`;
        if (story.priority) {
          md += `**Priority:** ${story.priority}\n\n`;
        }
        if (story.acceptanceCriteria?.length) {
          md += `**Acceptance Criteria:**\n`;
          for (const criterion of story.acceptanceCriteria) {
            md += `- ${criterion}\n`;
          }
          md += '\n';
        }
      }
    }

    // Global Acceptance Criteria
    if (data.acceptanceCriteria?.length) {
      md += `## Acceptance Criteria\n\n`;
      for (const criterion of data.acceptanceCriteria) {
        md += `- ${criterion}\n`;
      }
      md += '\n';
    }

    // Out of Scope
    if (data.outOfScope?.length) {
      md += `## Out of Scope\n\n`;
      for (const item of data.outOfScope) {
        md += `- ${item}\n`;
      }
      md += '\n';
    }

    // Data Model
    if (data.dataModel?.entities?.length) {
      md += `## Data Model\n\n`;
      for (const entity of data.dataModel.entities) {
        md += `### ${entity.name}\n\n`;
        if (entity.description) {
          md += `${entity.description}\n\n`;
        }
        if (entity.fields?.length) {
          md += `| Field | Type | Required | Description |\n`;
          md += `|-------|------|----------|-------------|\n`;
          for (const field of entity.fields) {
            md += `| ${field.name} | ${field.type} | ${field.required ? 'Yes' : 'No'} | ${field.description || ''} |\n`;
          }
          md += '\n';
        }
        if (entity.relationships?.length) {
          md += `**Relationships:**\n`;
          for (const rel of entity.relationships) {
            md += `- ${rel}\n`;
          }
          md += '\n';
        }
      }
    }

    return md;
  }

  private extractStoryTitle(description: string): string {
    // Extract the "I want [goal]" part as title
    const match = description.match(/I want\s+(.+?)(?:\s+so that|$)/i);
    if (match?.[1]) {
      return match[1].trim().substring(0, 50);
    }
    return description.substring(0, 50);
  }
}

// ============================================================================
// 内部类型
// ============================================================================

interface SpecificationData {
  name?: string;
  description?: string;
  userStories?: UserStory[];
  acceptanceCriteria?: string[];
  outOfScope?: string[];
  dataModel?: {
    entities: {
      name: string;
      description?: string;
      fields?: {
        name: string;
        type: string;
        required?: boolean;
        description?: string;
      }[];
      relationships?: string[];
    }[];
  };
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Specification Generator
 */
export function createSpecificationGenerator(
  config: SpecificationGeneratorConfig
): SpecificationGenerator {
  return new SpecificationGenerator(config);
}
