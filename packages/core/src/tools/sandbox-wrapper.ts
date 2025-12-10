/**
 * Sandbox Tool Wrapper
 * 
 * 为Layer 2工具提供沙盒隔离执行能力
 */

import type { Tool, ExecutionContext } from '../types';
import { ToolLayer } from './types';

/**
 * 沙盒执行脚本生成选项
 */
export interface ScriptGenerationOptions {
  /** 工具名称 */
  toolName: string;
  /** 工具输入（JSON） */
  input: unknown;
  /** 执行上下文 */
  context: ExecutionContext;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 沙盒工具包装器
 * 
 * 提供Layer 2工具的沙盒隔离执行能力
 */
export class SandboxToolWrapper {
  /**
   * 包装工具为沙盒版本
   * 
   * @param tool - 原始工具
   * @returns 包装后的沙盒工具
   */
  wrap(tool: Tool): Tool {
    // 只包装需要沙盒的工具
    if (tool.layer !== ToolLayer.Sandbox && !tool.isCommandBased) {
      return tool;
    }

    return {
      ...tool,
      layer: ToolLayer.Sandbox,
      
      async execute(input: unknown, context: ExecutionContext): Promise<unknown> {
        // 应用资源限制
        const limitedContext = applyResourceLimits(context);
        
        // 在限制的上下文中执行原始工具
        try {
          const result = await tool.execute(input, limitedContext);
          return result;
        } catch (error) {
          // 包装错误以提供更好的上下文
          if (error instanceof Error) {
            error.message = `[Sandbox] ${error.message}`;
          }
          throw error;
        }
      },
    };
  }

  /**
   * 批量包装多个工具
   * 
   * @param tools - 工具数组
   * @returns 包装后的工具数组
   */
  wrapAll(tools: Tool[]): Tool[] {
    return tools.map((tool) => this.wrap(tool));
  }

  /**
   * 生成沙盒执行脚本
   * 
   * 为工具生成独立的执行脚本，可在隔离环境中运行
   * 
   * @param options - 脚本生成选项
   * @returns 可执行的shell脚本
   */
  generateExecutionScript(options: ScriptGenerationOptions): string {
    const { toolName, input, context, timeout = 30000 } = options;
    
    // 序列化输入
    const inputJson = JSON.stringify(input);
    const contextJson = JSON.stringify({
      taskId: context.taskId,
      agentId: context.agentId,
      workDir: context.workDir,
      env: context.env,
    });

    // 生成隔离执行脚本
    const script = `#!/usr/bin/env node
// Auto-generated sandbox execution script
// Tool: ${toolName}
// Timeout: ${timeout}ms

const input = ${inputJson};
const context = ${contextJson};

// TODO: Import and execute tool
// This is a placeholder for sandbox execution
console.log('Executing tool: ${toolName}');
console.log('Input:', JSON.stringify(input, null, 2));
process.exit(0);
`;

    return script;
  }
}

/**
 * 应用资源限制到执行上下文
 * 
 * @param context - 原始执行上下文
 * @returns 应用了默认资源限制的上下文
 */
function applyResourceLimits(context: ExecutionContext): ExecutionContext {
  const defaultLimits = {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxOutputSize: 1 * 1024 * 1024, // 1MB
    maxExecutionTime: 30000, // 30秒
  };

  return {
    ...context,
    resourceLimits: context.resourceLimits || defaultLimits,
    permissions: context.permissions || {
      allowed: [],
      denied: [],
      requireSandbox: true,
    },
  };
}

/**
 * 全局沙盒工具包装器实例
 */
export const sandboxToolWrapper = new SandboxToolWrapper();
