/**
 * MCP 工具调用客户端
 *
 * 提供 callMCPTool() 函数供工具包装器调用
 * 在沙盒环境中执行时，通过 IPC 与宿主通信
 *
 * @module servers/_client
 */

import type { MCPToolResult, MCPContentItem, ToolCallOptions } from './_types';
import { parseTextContent, successResult, errorResult } from './_types';

// ============================================================================
// 运行时环境检测
// ============================================================================

/**
 * 运行时环境类型
 */
export type RuntimeEnvironment = 'host' | 'sandbox';

/**
 * 检测当前运行时环境
 *
 * 在沙盒中运行时，会设置 TACHIKOMA_SANDBOX 环境变量
 */
export function detectEnvironment(): RuntimeEnvironment {
  return process.env.TACHIKOMA_SANDBOX === 'true' ? 'sandbox' : 'host';
}

// ============================================================================
// MCP 客户端接口
// ============================================================================

/**
 * MCP 客户端接口
 *
 * 用于解耦实际的 MCPClientManager 依赖
 */
export interface IMCPClient {
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      timeout?: number;
      skipCircuitBreaker?: boolean;
    }
  ): Promise<{
    isError?: boolean;
    content: MCPContentItem[];
  }>;
}

// ============================================================================
// 客户端实例管理
// ============================================================================

/** 当前客户端实例 */
let currentClient: IMCPClient | null = null;

/**
 * 设置 MCP 客户端实例
 *
 * 在宿主进程中调用，注入 MCPClientManager 实例
 *
 * @param client - MCP 客户端实例
 */
export function setMCPClient(client: IMCPClient): void {
  currentClient = client;
}

/**
 * 获取当前 MCP 客户端实例
 *
 * @returns 当前客户端实例，如果未设置则返回 null
 */
export function getMCPClient(): IMCPClient | null {
  return currentClient;
}

/**
 * 清除 MCP 客户端实例（用于测试）
 */
export function clearMCPClient(): void {
  currentClient = null;
}

// ============================================================================
// 核心调用函数
// ============================================================================

/**
 * 调用 MCP 工具
 *
 * 这是工具包装器使用的核心函数，根据运行时环境选择调用方式：
 * - 宿主环境：直接调用注入的 MCPClientManager
 * - 沙盒环境：通过 IPC 与宿主通信（TODO: 7.5 实现）
 *
 * @param serverName - 服务器名称
 * @param toolName - 工具名称
 * @param args - 调用参数
 * @param options - 调用选项
 * @returns 工具调用结果
 *
 * @example
 * ```ts
 * // 在工具包装器中使用
 * export async function readFile(input: { path: string }): Promise<MCPToolResult<string>> {
 *   return callMCPTool('filesystem', 'read_file', input);
 * }
 * ```
 */
export async function callMCPTool<T = unknown>(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  options: ToolCallOptions = {}
): Promise<MCPToolResult<T>> {
  const env = detectEnvironment();

  if (env === 'sandbox') {
    // 沙盒环境：通过 IPC 调用
    return callViaSandboxIPC<T>(serverName, toolName, args, options);
  }

  // 宿主环境：直接调用客户端
  return callViaClient<T>(serverName, toolName, args, options);
}

/**
 * 通过注入的客户端调用（宿主环境）
 */
async function callViaClient<T>(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  options: ToolCallOptions
): Promise<MCPToolResult<T>> {
  const client = getMCPClient();

  if (!client) {
    return errorResult<T>(
      'MCP client not initialized. Call setMCPClient() first.'
    );
  }

  try {
    // 构建选项对象，只包含有值的字段
    const callOptions: { timeout?: number; skipCircuitBreaker?: boolean } = {};
    if (options.timeout !== undefined) {
      callOptions.timeout = options.timeout;
    }
    if (options.skipCircuitBreaker !== undefined) {
      callOptions.skipCircuitBreaker = options.skipCircuitBreaker;
    }

    const result = await client.callTool(
      serverName,
      toolName,
      args,
      Object.keys(callOptions).length > 0 ? callOptions : undefined
    );

    if (result.isError) {
      const errorText = parseTextContent(result.content);
      return errorResult<T>(errorText || 'Tool call returned error');
    }

    // 如果请求包含原始内容，检查是否有非文本内容
    const hasNonTextContent = result.content.some(
      (item) => item.type !== 'text'
    );

    // 对于包含 resource/image 等非文本内容，直接返回 rawContent
    if (options.includeRawContent && hasNonTextContent) {
      return successResult(result.content as unknown as T, result.content);
    }

    // 解析文本内容
    const textContent = parseTextContent(result.content);

    // 尝试解析为 JSON，失败则返回原始文本
    let data: T;
    try {
      data = JSON.parse(textContent) as T;
    } catch {
      // 非 JSON 文本，作为字符串返回
      data = textContent as unknown as T;
    }

    if (options.includeRawContent) {
      return successResult(data, result.content);
    }

    return successResult(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult<T>(message);
  }
}

/**
 * 通过 IPC 调用（沙盒环境）
 *
 * TODO: 在 7.5 沙盒代码执行集成时实现
 */
async function callViaSandboxIPC<T>(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  _options: ToolCallOptions
): Promise<MCPToolResult<T>> {
  // 沙盒 IPC 实现将在 7.5 中添加
  // 当前返回错误提示
  return errorResult<T>(
    `Sandbox IPC not yet implemented. ` +
      `Attempted to call ${serverName}.${toolName} with args: ${JSON.stringify(args)}`
  );
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建工具调用函数（工厂方法）
 *
 * 用于生成工具包装器代码
 *
 * @param serverName - 服务器名称
 * @param toolName - 工具名称
 * @returns 绑定了服务器和工具名的调用函数
 *
 * @example
 * ```ts
 * // 生成的工具包装器
 * export const readFile = createToolCaller<ReadFileInput, string>(
 *   'filesystem',
 *   'read_file'
 * );
 * ```
 */
export function createToolCaller<TInput extends Record<string, unknown>, TOutput = unknown>(
  serverName: string,
  toolName: string
): (input: TInput, options?: ToolCallOptions) => Promise<MCPToolResult<TOutput>> {
  return (input: TInput, options?: ToolCallOptions) =>
    callMCPTool<TOutput>(serverName, toolName, input, options);
}
