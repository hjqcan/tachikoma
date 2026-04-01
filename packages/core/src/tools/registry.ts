/**
 * 工具注册表
 * 
 * 管理工具的注册、查询和执行，提供权限校验和多维度查询
 */

import type { Tool, ExecutionContext } from '../types';
import type { ToolResult, ToolLayer, ToolCategory } from './types';
import { PermissionValidator } from './permission-validator';
import { ToolExecutor } from './tool-executor';
import type { PermissionValidationResult } from './permission-validator';
import { ToolNotFoundError } from './errors';
import { getToolPromptText } from './build-tool';
import { getModelFacingToolName } from './model-facing-names';

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

export { PermissionDeniedError, ToolNotFoundError } from './errors';

/**
 * 工具注册表类
 * 
 * 提供工具的注册、查询、权限校验和执行功能
 */
export class ToolRegistry {
  /** 工具存储（按名称索引） */
  private tools: Map<string, Tool> = new Map();
  /** 工具别名映射（alias -> primary name） */
  private aliases: Map<string, string> = new Map();
  /** 权限校验器 */
  private validator: PermissionValidator;
  /** 工具执行器 */
  private executor: ToolExecutor;

  constructor() {
    this.validator = new PermissionValidator();
    this.executor = new ToolExecutor();
  }

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
    for (const alias of tool.aliases ?? []) {
      if (this.tools.has(alias) || this.aliases.has(alias)) {
        throw new Error(`工具别名已存在: ${alias}`);
      }
    }
    
    // 基本校验：检查必要字段
    if (!tool.name || !tool.description) {
      throw new Error('工具必须提供 name 和 description');
    }
    
    this.tools.set(tool.name, tool);
    for (const alias of tool.aliases ?? []) {
      this.aliases.set(alias, tool.name);
    }
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
    const primaryName = this.aliases.get(name) ?? name;
    const tool = this.tools.get(primaryName);
    if (!tool) {
      return false;
    }

    for (const alias of tool.aliases ?? []) {
      this.aliases.delete(alias);
    }

    return this.tools.delete(primaryName);
  }

  /**
   * 按名称查询工具
   * 
   * @param name - 工具名称
   * @returns 工具实例，如果不存在返回 undefined
   */
  getByName(name: string): Tool | undefined {
    const primaryName = this.aliases.get(name) ?? name;
    return this.tools.get(primaryName);
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
        name: getModelFacingToolName(tool),
        description: getToolPromptText(tool),
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
   * 执行工具（自动权限校验）
   * 
   * @param toolName - 工具名称
   * @param input - 输入参数
   * @param context - 执行上下文
   * @param skipPermissionCheck - 是否跳过权限检查
   * @returns 执行结果
   */
  async execute(
    toolName: string,
    input: unknown,
    context: ExecutionContext,
    skipPermissionCheck = false
  ): Promise<ToolResult> {
    const tool = this.getByName(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }

    // 使用ToolExecutor执行，自动集成权限校验
    return this.executor.execute(tool, input, context, {
      skipPermissionCheck,
      throwOnError: false, // 返回ToolResult而不抛异常
    });
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
