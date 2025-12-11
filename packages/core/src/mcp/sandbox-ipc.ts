/**
 * MCP Sandbox IPC Bridge
 *
 * 提供沙盒内代码与宿主进程 MCPClientManager 之间的通信桥梁
 *
 * 架构：
 * - 沙盒侧：通过 stdin/stdout 发送 JSON-RPC 请求
 * - 宿主侧：监听子进程输出，处理请求并返回结果
 *
 * @module mcp/sandbox-ipc
 */

// ============================================================================
// IPC 消息类型
// ============================================================================

/**
 * IPC 请求消息
 */
export interface MCPIPCRequest {
  /** 消息类型 */
  type: 'mcp_call';
  /** 请求 ID（用于匹配响应）*/
  id: string;
  /** 服务器名称 */
  serverName: string;
  /** 工具名称 */
  toolName: string;
  /** 调用参数 */
  args: Record<string, unknown>;
  /** 选项 */
  options?: {
    timeout?: number;
    skipCircuitBreaker?: boolean;
    /** 是否返回原始 MCP 内容 */
    includeRawContent?: boolean;
    /** 最大内容长度（字节，防止 IPC 超限） */
    maxContentLength?: number;
  };
}

/**
 * IPC 响应消息
 */
export interface MCPIPCResponse {
  /** 消息类型 */
  type: 'mcp_result';
  /** 请求 ID（对应请求）*/
  id: string;
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
  /** 原始 MCP 内容 */
  rawContent?: MCPIPCContentItem[];
}

/**
 * MCP 内容项（IPC 传输用）
 */
export interface MCPIPCContentItem {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

/**
 * IPC 消息（请求或响应）
 */
export type MCPIPCMessage = MCPIPCRequest | MCPIPCResponse;

// ============================================================================
// IPC 消息标识
// ============================================================================

/**
 * IPC 消息前缀（用于区分普通输出和 IPC 消息）
 */
export const MCP_IPC_PREFIX = '___MCP_IPC___';

/**
 * 解码 IPC 消息
 */
export function decodeMCPIPCMessage(line: string): MCPIPCMessage | null {
  if (!line.startsWith(MCP_IPC_PREFIX)) {
    return null;
  }

  try {
    const json = line.slice(MCP_IPC_PREFIX.length);
    return JSON.parse(json) as MCPIPCMessage;
  } catch {
    return null;
  }
}

/**
 * 编码 IPC 消息
 */
export function encodeMCPIPCMessage(message: MCPIPCMessage): string {
  return MCP_IPC_PREFIX + JSON.stringify(message);
}

/**
 * 生成唯一请求 ID
 */
export function generateRequestId(): string {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ============================================================================
// 沙盒侧客户端
// ============================================================================

/**
 * 等待 IPC 响应的 Promise 映射
 */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: MCPIPCResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

/**
 * 发送 IPC 请求并等待响应（沙盒侧使用）
 *
 * @param request - IPC 请求
 * @param timeout - 超时时间（毫秒）
 * @returns IPC 响应
 */
export async function sendMCPIPCRequest(
  request: Omit<MCPIPCRequest, 'id'>,
  timeout = 60000
): Promise<MCPIPCResponse> {
  const id = generateRequestId();
  const fullRequest: MCPIPCRequest = { ...request, id };

  return new Promise<MCPIPCResponse>((resolve, reject) => {
    // 设置超时
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`MCP IPC request timeout after ${timeout}ms`));
    }, timeout);

    // 注册待处理请求
    pendingRequests.set(id, { resolve, reject, timeout: timeoutId });

    // 发送请求到 stdout
    const message = encodeMCPIPCMessage(fullRequest);
    console.log(message);
  });
}

/**
 * 处理 IPC 响应（沙盒侧使用）
 *
 * 在沙盒进程中设置 stdin 监听器调用此函数
 *
 * @param line - 从 stdin 读取的行
 */
export function handleMCPIPCResponse(line: string): boolean {
  const message = decodeMCPIPCMessage(line);

  if (!message || message.type !== 'mcp_result') {
    return false;
  }

  const pending = pendingRequests.get(message.id);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    pending.resolve(message);
    return true;
  }

  return false;
}

// ============================================================================
// 宿主侧处理器
// ============================================================================

/**
 * MCP IPC 请求处理器
 */
export type MCPIPCRequestHandler = (
  request: MCPIPCRequest
) => Promise<MCPIPCResponse>;

/**
 * 创建宿主侧 IPC 处理器
 *
 * @param mcpClient - MCP 客户端接口（通常是 MCPClientManager）
 * @returns IPC 请求处理器
 */
export function createMCPIPCHandler(mcpClient: {
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeout?: number; skipCircuitBreaker?: boolean }
  ): Promise<{ isError?: boolean; content: MCPIPCContentItem[] }>;
}): MCPIPCRequestHandler {
  return async (request: MCPIPCRequest): Promise<MCPIPCResponse> => {
    try {
      const result = await mcpClient.callTool(
        request.serverName,
        request.toolName,
        request.args,
        request.options
      );

      const opts = request.options ?? {};
      const maxLen = opts.maxContentLength ?? 1024 * 1024; // 默认 1MB

      // 解析文本内容
      const textContent = result.content
        .filter((item): item is { type: 'text'; text: string } => 
          item.type === 'text' && typeof item.text === 'string'
        )
        .map((item) => item.text)
        .join('\n');

      // 检查是否有非文本内容
      const hasNonTextContent = result.content.some((item) => item.type !== 'text');

      // 根据 includeRawContent 决定返回数据
      let data: unknown;
      if (opts.includeRawContent && hasNonTextContent) {
        // 有非文本内容时，直接返回 rawContent
        data = result.content;
      } else {
        // 尝试解析为 JSON
        try {
          data = JSON.parse(textContent);
        } catch {
          data = textContent;
        }
      }

      // 准备 rawContent（如果需要）
      let rawContent: MCPIPCContentItem[] | undefined;
      if (opts.includeRawContent) {
        // 检查是否需要截断
        const contentStr = JSON.stringify(result.content);
        if (contentStr.length > maxLen) {
          // 对所有类型进行截断处理
          rawContent = result.content.map((item) => {
            // 文本类型：截断 text 字段
            if (item.type === 'text' && item.text && item.text.length > 10000) {
              return { type: 'text' as const, text: item.text.slice(0, 10000) + '...[truncated]' };
            }
            // 图片类型：截断 data/blob 字段
            if (item.type === 'image') {
              const imgItem = item as { type: 'image'; data?: string; mimeType?: string };
              if (imgItem.data && imgItem.data.length > 10000) {
                return {
                  type: 'image' as const,
                  mimeType: imgItem.mimeType ?? 'image/unknown',
                  data: '[base64 data truncated, length: ' + imgItem.data.length + ']',
                };
              }
            }
            // 资源类型：截断 text 字段
            if (item.type === 'resource') {
              const resItem = item as { type: 'resource'; text?: string; uri?: string; mimeType?: string };
              if (resItem.text && resItem.text.length > 10000) {
                const result: MCPIPCContentItem = {
                  type: 'resource' as const,
                  text: resItem.text.slice(0, 10000) + '...[truncated]',
                };
                if (resItem.uri) {
                  (result as { uri?: string }).uri = resItem.uri;
                }
                if (resItem.mimeType) {
                  (result as { mimeType?: string }).mimeType = resItem.mimeType;
                }
                return result;
              }
            }
            return item;
          });
        } else {
          rawContent = result.content;
        }
      }

      const response: MCPIPCResponse = {
        type: 'mcp_result',
        id: request.id,
        success: !result.isError,
        data,
      };
      if (rawContent) {
        response.rawContent = rawContent;
      }
      if (result.isError) {
        response.error = textContent;
      }
      return response;
    } catch (error) {
      return {
        type: 'mcp_result',
        id: request.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * 处理来自子进程的 IPC 请求行
 *
 * @param line - 子进程输出行
 * @param handler - IPC 请求处理器
 * @param writeFn - 写入响应的函数
 * @returns 是否是 IPC 消息（如果是则不应输出到常规日志）
 */
export async function processMCPIPCLine(
  line: string,
  handler: MCPIPCRequestHandler,
  writeFn: (response: string) => void
): Promise<boolean> {
  const message = decodeMCPIPCMessage(line);

  if (!message || message.type !== 'mcp_call') {
    return false;
  }

  const response = await handler(message);
  writeFn(encodeMCPIPCMessage(response));

  return true;
}
