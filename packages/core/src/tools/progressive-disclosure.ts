/**
 * Progressive Disclosure - 工具渐进披露机制
 * 
 * 按需加载工具定义，减少Token消耗
 */

import type { Tool } from '../types';
import type { ToolLayer, ToolCategory } from './types';

/**
 * 工具元数据（Level 1）
 * 最小化信息，用于初始展示
 */
export interface ToolMetadata {
  name: string;
  title: string;
  category?: ToolCategory;
  layer?: ToolLayer;
}

/**
 * 基础工具定义（Level 2）
 * 包含描述和简化的Schema
 */
export interface BasicToolDefinition extends ToolMetadata {
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  permissions?: string[];
}

/**
 * JSON Schema（简化版）
 */
interface JSONSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  examples?: unknown[];
  [key: string]: unknown;
}

/**
 * 渐进披露类
 * 
 * 提供三级工具信息披露机制
 */
export class ProgressiveDisclosure {
  /**
   * Level 1: 获取元数据
   * 
   * 最小化信息（~50 tokens/tool）
   * 用于初始工具列表展示
   */
  getMetadata(tools: Tool[]): ToolMetadata[] {
    return tools.map((t) => {
      const metadata: ToolMetadata = {
        name: t.name,
        title: t.title || t.name,
      };
      if (t.category !== undefined) {
        metadata.category = t.category;
      }
      if (t.layer !== undefined) {
        metadata.layer = t.layer;
      }
      return metadata;
    });
  }

  /**
   * Level 2: 获取基础定义
   * 
   * 包含描述和简化Schema（~200 tokens/tool）
   * 用于工具选择和参数理解
   */
  getBasicDefinition(tool: Tool): BasicToolDefinition {
    const metadata = this.getMetadata([tool])[0];
    if (!metadata) {
      throw new Error(`Failed to get metadata for tool: ${tool.name}`);
    }

    const result: BasicToolDefinition = {
      ...metadata,
      description: tool.description,
      inputSchema: this.simplifySchema(tool.inputSchema as JSONSchema),
    };
    
    if (tool.permissions !== undefined) {
      result.permissions = tool.permissions;
    }

    return result;
  }

  /**
   * Level 3: 获取完整定义
   * 
   * 完整的工具定义（~500+ tokens/tool）
   * 用于实际执行
   */
  getFullDefinition(tool: Tool): Tool {
    return tool;
  }

  /**
   * 批量获取基础定义
   * 
   * @param tools - 工具列表
   * @param maxCount - 最大返回数量（用于Token控制）
   */
  getBasicDefinitions(tools: Tool[], maxCount?: number): BasicToolDefinition[] {
    const targetTools = maxCount ? tools.slice(0, maxCount) : tools;
    return targetTools.map((t) => this.getBasicDefinition(t));
  }

  /**
   * 智能推荐工具
   * 
   * 根据上下文关键词推荐最相关的工具
   * 
   * @param context - 上下文描述（用户意图、任务描述等）
   * @param tools - 候选工具列表
   * @param maxCount - 最大推荐数量
   * @returns 推荐的工具列表
   */
  recommend(context: string, tools: Tool[], maxCount: number = 5): Tool[] {
    // 简单的关键词匹配推荐算法
    const contextLower = context.toLowerCase();
    const scored = tools.map((tool) => {
      let score = 0;

      // 基于工具名称匹配
      if (contextLower.includes(tool.name.toLowerCase())) {
        score += 10;
      }

      // 基于描述匹配
      const descWords = tool.description.toLowerCase().split(/\s+/);
      const contextWords = contextLower.split(/\s+/);
      for (const word of contextWords) {
        if (word.length > 3 && descWords.includes(word)) {
          score += 2;
        }
      }

      // 基于分类匹配
      if (tool.category && contextLower.includes(tool.category)) {
        score += 5;
      }

      // 优先级加权
      if (tool.annotations?.priority) {
        score += tool.annotations.priority * 3;
      }

      return { tool, score };
    });

    // 排序并返回top N
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCount)
      .map((s) => s.tool);
  }

  /**
   * 简化JSON Schema
   * 
   * 移除非必需字段，保留核心结构
   */
  private simplifySchema(schema: JSONSchema): BasicToolDefinition['inputSchema'] {
    const simplified: BasicToolDefinition['inputSchema'] = {
      type: schema.type,
    };

    if (schema.properties) {
      simplified.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        const prop = value as JSONSchema;
        const propDef: { type: string; description?: string } = {
          type: prop.type || 'string',
        };
        if (prop.description !== undefined) {
          propDef.description = prop.description;
        }
        simplified.properties[key] = propDef;
      }
    }

    if (schema.required) {
      simplified.required = schema.required;
    }

    return simplified;
  }

  /**
   * 估算Token消耗
   * 
   * 粗略估算不同级别的Token消耗
   * 
   * @param level - 披露级别（1/2/3）
   * @param toolCount - 工具数量
   * @returns 估算的Token数量
   */
  estimateTokens(level: 1 | 2 | 3, toolCount: number): number {
    const tokensPerTool = {
      1: 50,   // Metadata only
      2: 200,  // Basic definition
      3: 500,  // Full definition
    };

    return tokensPerTool[level] * toolCount;
  }
}

/**
 * 全局渐进披露实例
 */
export const progressiveDisclosure = new ProgressiveDisclosure();
