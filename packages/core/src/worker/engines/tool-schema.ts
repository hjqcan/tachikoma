/**
 * Tool Schema Converter
 *
 * 将 Tachikoma Tool 的 JSON Schema 转换为 AI SDK 的 Zod Tool 格式
 * 支持 AI SDK v6 原生 Function Calling（仅生成 schema，不自动执行工具）
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Tool } from '../../types';
import { getToolPromptText } from '../../tools/build-tool';
import { getModelFacingToolName } from '../../tools/model-facing-names';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * AI SDK Tool 类型
 * Note: Using any due to AI SDK v6's complex generic types
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AITool = any;

/**
 * JSON Schema 类型（简化版）
 */
interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
}

// ============================================================================
// JSON Schema → Zod 转换
// ============================================================================

/**
 * 将 JSON Schema 转换为 Zod Schema
 * 
 * 支持常见类型：string, number, boolean, array, object
 */
export function jsonSchemaToZod(schema: JSONSchema | undefined): z.ZodTypeAny {
  if (!schema) {
    return z.object({}).passthrough();
  }

  const type = schema.type;

  switch (type) {
    case 'string':
      return buildStringSchema(schema);
    case 'number':
    case 'integer':
      return buildNumberSchema(schema);
    case 'boolean':
      return z.boolean().describe(schema.description ?? '');
    case 'array':
      return buildArraySchema(schema);
    case 'object':
    default:
      return buildObjectSchema(schema);
  }
}

function buildStringSchema(schema: JSONSchema): z.ZodTypeAny {
  let zodSchema: z.ZodTypeAny = z.string();
  
  if (schema.enum && Array.isArray(schema.enum)) {
    const enumValues = schema.enum.filter((v): v is string => typeof v === 'string');
    if (enumValues.length > 0) {
      zodSchema = z.enum(enumValues as [string, ...string[]]);
    }
  }
  
  if (schema.description) {
    zodSchema = zodSchema.describe(schema.description);
  }
  
  return zodSchema;
}

function buildNumberSchema(schema: JSONSchema): z.ZodTypeAny {
  let zodSchema: z.ZodTypeAny = z.number();
  
  if (schema.description) {
    zodSchema = zodSchema.describe(schema.description);
  }
  
  return zodSchema;
}

function buildArraySchema(schema: JSONSchema): z.ZodTypeAny {
  const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.unknown();
  let zodSchema: z.ZodTypeAny = z.array(itemSchema);
  
  if (schema.description) {
    zodSchema = zodSchema.describe(schema.description);
  }
  
  return zodSchema;
}

function buildObjectSchema(schema: JSONSchema): z.ZodTypeAny {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  
  const shape: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, propSchema] of Object.entries(properties)) {
    let propZod = jsonSchemaToZod(propSchema as JSONSchema);
    
    // 添加描述
    const desc = (propSchema as JSONSchema).description;
    if (desc) {
      propZod = propZod.describe(desc);
    }
    
    // 非必需字段设为 optional
    if (!required.has(key)) {
      propZod = propZod.optional();
    }
    
    shape[key] = propZod;
  }
  
  let zodSchema: z.ZodTypeAny = z.object(shape);
  
  // 允许额外属性
  zodSchema = (zodSchema as z.ZodObject<z.ZodRawShape>).passthrough();
  
  if (schema.description) {
    zodSchema = zodSchema.describe(schema.description);
  }
  
  return zodSchema;
}

// ============================================================================
// Tool 转换
// ============================================================================

/**
 * 将 Tachikoma Tool 转换为 AI SDK Tool
 * 
 * @param tachikoma - Tachikoma 工具定义
 * @returns AI SDK Tool
 */
export function convertToolToAITool(
  tachikoma: Tool
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const inputSchema = jsonSchemaToZod(tachikoma.inputSchema as JSONSchema);
  const outputSchema = tachikoma.outputSchema
    ? jsonSchemaToZod(tachikoma.outputSchema as JSONSchema)
    : z.unknown();
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolConfig: any = {
    description: getToolPromptText(tachikoma),
    ...(tachikoma.title ? { title: tachikoma.title } : {}),
    inputSchema,
    outputSchema,
  };
  
  return tool(toolConfig);
}

/**
 * 批量转换工具
 * 
 * @param tools - Tachikoma 工具列表
 * @returns AI SDK Tools 对象
 */
export function convertToolsToAITools(
  tools: Tool[]
): Record<string, AITool> {
  const aiTools: Record<string, AITool> = {};
  
  for (const t of tools) {
    aiTools[getModelFacingToolName(t)] = convertToolToAITool(t);
  }
  
  return aiTools;
}

/**
 * 获取工具的 Zod schema（用于调试）
 */
export function getToolZodSchema(tool: Tool): z.ZodTypeAny {
  return jsonSchemaToZod(tool.inputSchema as JSONSchema);
}
