/**
 * 工具注册表
 * 
 * 管理工具的注册、查询和执行，提供权限校验和多维度查询
 */

import type { Tool, ExecutionContext } from '../types';
import type { ToolLayer, ToolCategory } from './types';
import { PermissionValidator } from './permission-validator';
import type { PermissionValidationResult } from './permission-validator';

/**
 * 工具定义（用于渐进披露）
 */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  layer?: ToolLayer;
  category?: ToolCategory;
  permissions?: string[];
  annotations?: unknown;
}

/**
 * 权限拒绝错误
 */
export class PermissionDeniedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason: string
  ) {
    super(`工具 "${toolName}" 权限被拒绝: ${reason}`);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * 工具未找到错误
 */
export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`工具未找到: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

/**
 * 工具注册表类
 * 
 * 提供工具的注册、查询、权限校验和执行功能
 */
export class ToolRegistry {
  /** 工具存储（按名称索引） */
  private readonly tools = new Map<string, Tool>();
  
  /** 权限校验器 */
  private readonly validator = new PermissionValidator();

  /**
   * 注册工具
   * 
   * @param tool - 要注册的工具
   * @throws 如果工具名称已存在
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具名称已存在: ${tool.name}`);
    }
    
    // 基本校验：检查必要字段
    if (!tool.name || !tool.description) {
      throw new Error('工具必须提供 name 和 description');
    }
    
    this.tools.set(tool.name, tool);
  }

  /**
   * 批量注册工具
   * 
   * @param tools - 工具数组
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 注销工具
   * 
   * @param name - 工具名称
   * @returns 是否成功注销
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 按名称查询工具
   * 
   * @param name - 工具名称
   * @returns 工具实例，如果不存在返回 undefined
   */
  getByName(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 按层级查询工具
   * 
   * @param layer - 工具层级
   * @returns 该层级的所有工具
   */
  getByLayer(layer: ToolLayer): Tool[] {
    return Array.from(this.tools.values()).filter((tool) => tool.layer === layer);
  }

  /**
   * 按分类查询工具
   * 
   * @param category - 工具分类
   * @returns 该分类的所有工具
   */
  getByCategory(category: ToolCategory): Tool[] {
    return Array.from(this.tools.values()).filter((tool) => tool.category === category);
  }

  /**
   * 按权限查询工具
   * 
   * 返回上下文权限允许的所有工具
   * 
   * @param context - 执行上下文
   * @returns 允许的工具列表
   */
  getByPermissions(context: ExecutionContext): Tool[] {
    return Array.from(this.tools.values()).filter((tool) => {
      const validation = this.validator.validate(tool, context);
      return validation.allowed;
    });
  }

  /**
   * 获取所有工具
   * 
   * @returns 所有已注册的工具
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取所有工具名称
   * 
   * @returns 工具名称数组
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 获取工具定义（用于LLM调用）
   * 
   * 支持渐进披露：可以选择性返回字段以减少Token消耗
   * 
   * @param options - 查询选项
   * @returns 工具定义数组
   */
  getDefinitions(options?: {
    /** 只返回指定层级的工具 */
    layer?: ToolLayer;
    /** 是否包含 annotations */
    includeAnnotations?: boolean;
    /** 是否包含完整的 schema */
    includeFullSchema?: boolean;
    /** 最大返回数量 */
    maxCount?: number;
  }): ToolDefinition[] {
    let tools = Array.from(this.tools.values());

    // 按层级过滤
    if (options?.layer) {
      tools = tools.filter((tool) => tool.layer === options.layer);
    }

    // 限制数量
    if (options?.maxCount) {
      tools = tools.slice(0, options.maxCount);
    }

    // 构建定义
    return tools.map((tool) => {
      const definition: ToolDefinition = {
        name: tool.name,
        description: tool.description,
      };

      // 只在值存在时才添加可选字段
      if (tool.title !== undefined) {
        definition.title = tool.title;
      }
      if (tool.layer !== undefined) {
        definition.layer = tool.layer;
      }
      if (tool.category !== undefined) {
        definition.category = tool.category;
      }
      if (tool.permissions !== undefined) {
        definition.permissions = tool.permissions;
      }

      // 根据选项包含或排除字段
      if (options?.includeFullSchema) {
        definition.inputSchema = tool.inputSchema;
        if (tool.outputSchema !== undefined) {
          definition.outputSchema = tool.outputSchema;
        }
      }

      if (options?.includeAnnotations && tool.annotations !== undefined) {
        definition.annotations = tool.annotations;
      }

      return definition;
    });
  }

  /**
   * 执行工具（带权限检查）
   * 
   * @param toolName - 工具名称
   * @param input - 工具输入
   * @param context - 执行上下文
   * @returns 工具执行结果
   * @throws ToolNotFoundError 如果工具不存在
   * @throws PermissionDeniedError 如果权限不足
   */
  async execute(
    toolName: string,
    input: unknown,
    context: ExecutionContext
  ): Promise<unknown> {
    // 1. 查找工具
    const tool = this.getByName(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }

    // 2. 权限校验
    const validation = this.validator.validate(tool, context);
    if (!validation.allowed) {
      throw new PermissionDeniedError(toolName, validation.reason || '未知原因');
    }

    // 3. 执行工具
    try {
      return await tool.execute(input, context);
    } catch (error) {
      // 包装错误以提供更好的上下文
      if (error instanceof Error) {
        error.message = `工具 "${toolName}" 执行失败: ${error.message}`;
      }
      throw error;
    }
  }

  /**
   * 验证工具权限（不执行）
   * 
   * @param toolName - 工具名称
   * @param context - 执行上下文
   * @returns 权限验证结果
   * @throws ToolNotFoundError 如果工具不存在
   */
  validatePermissions(
    toolName: string,
    context: ExecutionContext
  ): PermissionValidationResult {
    const tool = this.getByName(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }

    return this.validator.validate(tool, context);
  }

  /**
   * 获取注册器大小
   * 
   * @returns 已注册的工具数量
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 清空所有工具
   */
  clear(): void {
    this.tools.clear();
  }
}

/**
 * 全局工具注册表实例
 */
export const globalToolRegistry = new ToolRegistry();
