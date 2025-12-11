/**
 * MCP 代码生成器
 *
 * 从 MCP 工具 Schema 生成类型安全的 TypeScript 包装器
 *
 * @module mcp/generator
 */

import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { MCPToolInfo } from './types';
import { DEFAULT_SERVERS_DIR } from './types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 生成选项
 */
export interface GeneratorOptions {
  /** 输出目录（默认 './servers'） */
  outputDir?: string;
  /** 是否覆盖已存在的文件（默认 true） */
  overwrite?: boolean;
  /** 是否生成 JSDoc 注释 */
  generateDocs?: boolean;
  /** 服务器过滤（只生成指定服务器） */
  serverFilter?: string[];
  /** servers 模块相对导入路径（默认 '../'） */
  serversImportPath?: string;
}

/**
 * 生成结果
 */
export interface GeneratorResult {
  /** 生成的文件列表 */
  files: GeneratedFile[];
  /** 错误列表 */
  errors: GeneratorError[];
  /** 总共生成的工具数 */
  totalTools: number;
}

/**
 * 生成的文件
 */
export interface GeneratedFile {
  /** 文件路径 */
  path: string;
  /** 服务器名称 */
  serverName: string;
  /** 工具名称（如果是工具文件） */
  toolName?: string;
  /** 文件类型 */
  type: 'tool' | 'index';
}

/**
 * 生成错误
 */
export interface GeneratorError {
  /** 服务器名称 */
  serverName: string;
  /** 工具名称（如果适用） */
  toolName?: string;
  /** 错误信息 */
  message: string;
}

// ============================================================================
// MCPCodeGenerator
// ============================================================================

/**
 * MCP 代码生成器
 *
 * @example
 * ```ts
 * const generator = new MCPCodeGenerator();
 *
 * // 从工具列表生成
 * const result = await generator.generateFromTools(
 *   'filesystem',
 *   tools,
 *   { outputDir: './servers' }
 * );
 *
 * // 从 MCPClientManager 生成所有服务器的包装器
 * const result = await generator.generateAll(manager, config);
 * ```
 */
export class MCPCodeGenerator {
  private options: GeneratorOptions;

  constructor(options: GeneratorOptions = {}) {
    this.options = {
      outputDir: DEFAULT_SERVERS_DIR,
      overwrite: true,
      generateDocs: true,
      serversImportPath: '../',
      ...options,
    };
  }

  /**
   * 从工具列表生成服务器包装器
   */
  async generateFromTools(
    serverName: string,
    tools: MCPToolInfo[],
    options?: Partial<GeneratorOptions>
  ): Promise<GeneratorResult> {
    const opts = { ...this.options, ...options };
    const result: GeneratorResult = {
      files: [],
      errors: [],
      totalTools: 0,
    };

    const outputDir = opts.outputDir ?? DEFAULT_SERVERS_DIR;
    const serverDir = join(outputDir, serverName);

    // 创建目录
    await mkdir(serverDir, { recursive: true });

    // 检测文件名冲突
    const fileNameSet = new Set<string>();
    const funcNameSet = new Set<string>();

    // 生成每个工具的包装器
    for (const tool of tools) {
      try {
        const fileName = this.sanitizeFileName(tool.name);
        const funcName = this.toCamelCase(tool.name);

        // 检测冲突
        if (fileNameSet.has(fileName)) {
          result.errors.push({
            serverName,
            toolName: tool.name,
            message: `Duplicate file name: ${fileName}.ts (skipped)`,
          });
          continue;
        }
        if (funcNameSet.has(funcName)) {
          result.errors.push({
            serverName,
            toolName: tool.name,
            message: `Duplicate function name: ${funcName} (skipped)`,
          });
          continue;
        }

        const filePath = join(serverDir, fileName + '.ts');

        // 检查 overwrite 选项
        if (!opts.overwrite && existsSync(filePath)) {
          continue; // 跳过已存在的文件
        }

        const content = this.generateToolWrapper(serverName, tool, opts);
        await writeFile(filePath, content, 'utf-8');

        fileNameSet.add(fileName);
        funcNameSet.add(funcName);

        result.files.push({
          path: filePath,
          serverName,
          toolName: tool.name,
          type: 'tool',
        });
        result.totalTools++;
      } catch (error) {
        result.errors.push({
          serverName,
          toolName: tool.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 生成 index.ts
    try {
      const indexContent = this.generateServerIndex(serverName, tools, opts);
      const indexPath = join(serverDir, 'index.ts');

      await writeFile(indexPath, indexContent, 'utf-8');

      result.files.push({
        path: indexPath,
        serverName,
        type: 'index',
      });
    } catch (error) {
      result.errors.push({
        serverName,
        message: `Failed to generate index: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return result;
  }

  /**
   * 生成单个工具的 TypeScript 包装器
   */
  generateToolWrapper(
    serverName: string,
    tool: MCPToolInfo,
    options?: Partial<GeneratorOptions>
  ): string {
    const opts = { ...this.options, ...options };
    const funcName = this.toCamelCase(tool.name);
    const inputTypeName = this.toPascalCase(tool.name) + 'Input';

    const lines: string[] = [];

    // Header
    if (opts.generateDocs) {
      lines.push('/**');
      lines.push(` * ${tool.description || tool.name}`);
      lines.push(' *');
      lines.push(` * @server ${serverName}`);
      lines.push(` * @tool ${tool.name}`);
      lines.push(' * @generated This file was automatically generated by MCPCodeGenerator');
      lines.push(' */');
      lines.push('');
    }

    // Imports
    const importPath = opts.serversImportPath ?? '../';
    lines.push(`import { createToolCaller, type MCPToolResult, type ToolCallOptions } from '${importPath}';`);
    lines.push('');

    // Input interface
    lines.push('/**');
    lines.push(` * Input parameters for ${tool.name}`);
    lines.push(' */');
    lines.push(`export interface ${inputTypeName} {`);

    const schema = tool.inputSchema;
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);

    for (const [propName, propSchema] of Object.entries(properties)) {
      const prop = propSchema as {
        type?: string;
        description?: string;
        enum?: unknown[];
        items?: { type?: string };
      };

      // JSDoc for property
      if (opts.generateDocs && prop.description) {
        lines.push(`  /** ${prop.description} */`);
      }

      const tsType = this.jsonSchemaToTs(prop);
      const optional = required.has(propName) ? '' : '?';
      lines.push(`  ${propName}${optional}: ${tsType};`);
    }

    lines.push('}');
    lines.push('');

    // Tool function
    if (opts.generateDocs) {
      lines.push('/**');
      lines.push(` * ${tool.description || tool.name}`);
      if (schema.properties) {
        lines.push(' *');
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          const prop = propSchema as { description?: string };
          lines.push(` * @param input.${propName} ${prop.description || ''}`);
        }
      }
      lines.push(' * @param options Call options');
      lines.push(' * @returns Tool result');
      lines.push(' */');
    }

    lines.push(`export const ${funcName} = createToolCaller<${inputTypeName}, unknown>(`);
    lines.push(`  '${serverName}',`);
    lines.push(`  '${tool.name}'`);
    lines.push(');');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 生成服务器的 index.ts
   */
  generateServerIndex(
    serverName: string,
    tools: MCPToolInfo[],
    options?: Partial<GeneratorOptions>
  ): string {
    const opts = { ...this.options, ...options };
    const lines: string[] = [];

    // Header
    if (opts.generateDocs) {
      lines.push('/**');
      lines.push(` * ${serverName} MCP Server Tools`);
      lines.push(' *');
      lines.push(' * @generated This file was automatically generated by MCPCodeGenerator');
      lines.push(' */');
      lines.push('');
    }

    // Re-export all tools
    for (const tool of tools) {
      const fileName = this.sanitizeFileName(tool.name);
      const funcName = this.toCamelCase(tool.name);
      const inputTypeName = this.toPascalCase(tool.name) + 'Input';

      lines.push(`export { ${funcName}, type ${inputTypeName} } from './${fileName}';`);
    }

    lines.push('');

    return lines.join('\n');
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  /**
   * JSON Schema 类型转 TypeScript 类型
   * 
   * @param schema - JSON Schema
   * @param depth - 嵌套深度（防止无限递归）
   */
  private jsonSchemaToTs(
    schema: {
      type?: string;
      enum?: unknown[];
      items?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean | { type?: string };
    },
    depth = 0
  ): string {
    // 防止无限递归
    if (depth > 3) {
      return 'unknown';
    }

    if (schema.enum && Array.isArray(schema.enum)) {
      return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
    }

    switch (schema.type) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        if (schema.items) {
          const itemType = this.jsonSchemaToTs(
            schema.items as { type?: string; properties?: Record<string, unknown> },
            depth + 1
          );
          return `${itemType}[]`;
        }
        return 'unknown[]';
      case 'object':
        // 如果有明确的 properties 定义，生成内联对象类型
        if (schema.properties && Object.keys(schema.properties).length > 0) {
          const requiredSet = new Set(schema.required ?? []);
          const fields: string[] = [];
          for (const [key, value] of Object.entries(schema.properties)) {
            const propSchema = value as { type?: string; properties?: Record<string, unknown> };
            const propType = this.jsonSchemaToTs(propSchema, depth + 1);
            const optional = requiredSet.has(key) ? '' : '?';
            fields.push(`${key}${optional}: ${propType}`);
          }
          return `{ ${fields.join('; ')} }`;
        }
        if (schema.additionalProperties) {
          const valueType =
            typeof schema.additionalProperties === 'object'
              ? this.jsonSchemaToTs(
                  schema.additionalProperties as { type?: string },
                  depth + 1
                )
              : 'unknown';
          return `Record<string, ${valueType}>`;
        }
        return 'Record<string, unknown>';
      case 'null':
        return 'null';
      default:
        return 'unknown';
    }
  }

  /**
   * 转换为 camelCase
   */
  private toCamelCase(str: string): string {
    return str
      .split(/[-_\s]+/)
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');
  }

  /**
   * 转换为 PascalCase
   */
  private toPascalCase(str: string): string {
    return str
      .split(/[-_\s]+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }

  /**
   * 清理文件名
   */
  private sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 生成服务器包装器（便捷函数）
 */
export async function generateServerWrappers(
  serverName: string,
  tools: MCPToolInfo[],
  options?: GeneratorOptions
): Promise<GeneratorResult> {
  const generator = new MCPCodeGenerator(options);
  return generator.generateFromTools(serverName, tools, options);
}

/**
 * 默认生成器实例
 */
export const defaultGenerator = new MCPCodeGenerator();
