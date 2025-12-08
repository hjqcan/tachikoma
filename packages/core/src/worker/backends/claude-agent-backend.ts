/**
 * Claude Agent SDK 后端
 *
 * 封装 Claude Agent SDK，将其适配为统一的 IWorkerBackend 接口
 * 获得完整的 Claude Code 能力（代码编辑、命令执行、上下文管理等）
 */

import type {
  IWorkerBackend,
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
  ClaudeAgentSDKBackendConfig,
} from '../types';
import type { Tool } from '../../types';

// ============================================================================
// Claude Agent SDK 类型（延迟导入）
// ============================================================================

/**
 * SDK 消息类型（简化版）
 */
interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

// ============================================================================
// Claude Agent SDK 后端实现
// ============================================================================

/**
 * Claude Agent SDK 后端
 *
 * 使用 @anthropic-ai/claude-agent-sdk 实现，获得 Claude Code 的完整能力：
 * - 自动上下文压缩
 * - 丰富的工具生态
 * - 原生 MCP 支持
 * - 权限管理
 *
 * @example
 * ```ts
 * const backend = new ClaudeAgentSDKBackend({
 *   provider: 'anthropic',
 *   model: 'claude-3-5-sonnet-20241022',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * for await (const msg of backend.execute(task, tools, options)) {
 *   console.log(msg);
 * }
 * ```
 */
export class ClaudeAgentSDKBackend implements IWorkerBackend {
  readonly provider = 'anthropic';
  readonly backendType: WorkerBackendType = 'agent-sdk';

  private readonly config: ClaudeAgentSDKBackendConfig;
  private abortController: AbortController | null = null;
  private isExecuting = false;

  constructor(config: ClaudeAgentSDKBackendConfig) {
    this.config = config;
    // 预检查 SDK 是否可用
    this.checkSDKAvailability();
  }

  /**
   * 检查 SDK 是否可用（异步，结果缓存）
   */
  private sdkAvailable: boolean | null = null;
  private async checkSDKAvailability(): Promise<boolean> {
    if (this.sdkAvailable !== null) return this.sdkAvailable;
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      this.sdkAvailable = true;
    } catch {
      this.sdkAvailable = false;
    }
    return this.sdkAvailable;
  }

  /**
   * 执行任务
   */
  async *execute(
    task: WorkerTask,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage> {
    // 动态导入 Claude Agent SDK
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: (args: { prompt: string; options?: unknown }) => AsyncIterable<any>;
    try {
      // @anthropic-ai/claude-agent-sdk is an optional dependency
      // Dynamic import will fail if not installed
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      query = sdk.query as typeof query;
    } catch (_error) {
      yield {
        type: 'error',
        error: 'Claude Agent SDK is not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
        code: 'SDK_NOT_INSTALLED',
        retryable: false,
        timestamp: Date.now(),
      };
      return;
    }

    // 创建 AbortController
    this.abortController = new AbortController();
    this.isExecuting = true;

    // 发出初始化状态
    yield {
      type: 'status',
      status: 'initializing',
      timestamp: Date.now(),
    };

    try {
      // 构建 SDK 配置
      const sdkOptions = this.buildSDKOptions(tools, options);

      // 调用 Claude Agent SDK
      const result = query({
        prompt: task.objective,
        options: sdkOptions,
      });

      // 转换并输出消息
      for await (const sdkMessage of result) {
        // 检查是否已中断
        if (this.abortController.signal.aborted) {
          yield {
            type: 'status',
            status: 'interrupted',
            timestamp: Date.now(),
          };
          break;
        }

        // 转换 SDK 消息为统一格式
        const workerMessage = this.transformSDKMessage(sdkMessage);
        if (workerMessage) {
          yield workerMessage;
        }
      }

      // 发出完成状态
      yield {
        type: 'status',
        status: 'completed',
        timestamp: Date.now(),
      };
    } catch (error) {
      const err = error as Error;
      yield {
        type: 'error',
        error: err.message,
        code: 'EXECUTION_ERROR',
        retryable: this.isRetryableError(err),
        timestamp: Date.now(),
      };

      yield {
        type: 'status',
        status: 'failed',
        timestamp: Date.now(),
      };
    } finally {
      this.isExecuting = false;
      this.abortController = null;
    }
  }

  /**
   * 获取后端能力
   *
   * 注意：部分能力依赖 Claude Agent SDK 实际功能，当前 MCP 工具桥接尚未完成
   */
  getCapabilities(): WorkerCapability[] {
    // 实际已实现的能力
    const implemented: WorkerCapability[] = [
      'code-execution',
      'file-operations',
      'shell-commands',
    ];

    // TODO: 以下能力需要 SDK 完整集成后启用
    // 'web-search',
    // 'browser-automation',
    // 'mcp-tools',

    return implemented;
  }

  /**
   * 检查是否可用
   *
   * 除了检查 API Key，还会检查 SDK 是否已安装
   */
  isAvailable(): boolean {
    // API Key 必须存在
    if (!this.config.apiKey) return false;
    // SDK 可用性（初次调用后缓存）
    if (this.sdkAvailable === false) return false;
    return true;
  }

  /**
   * 中断执行
   */
  async interrupt(): Promise<void> {
    if (this.abortController && this.isExecuting) {
      this.abortController.abort();
    }
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    await this.interrupt();
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 构建 SDK 配置选项
   */
  private buildSDKOptions(tools: Tool[], options: WorkerExecutionOptions): Record<string, unknown> {
    const sdkConfig = this.config.sdkOptions || {};

    return {
      // 工作目录
      cwd: options.workDir,
      // 环境变量
      env: options.env,
      // 权限模式
      permissionMode: sdkConfig.permissionMode || 'bypassPermissions',
      // 额外目录
      additionalDirectories: sdkConfig.additionalDirectories,
      // 系统提示
      systemPrompt: sdkConfig.systemPrompt,
      // AbortController
      abortController: this.abortController,
      // MCP 服务器配置（将工具转换为 MCP 格式）
      mcpServers: this.convertToolsToMCPServers(tools),
    };
  }

  /**
   * 将 Tachikoma 工具转换为 MCP 服务器格式
   *
   * ⚠️ 当前实现为占位 - MCP 工具桥接尚未完成
   * TODO: 实现真正的 MCP Server 桥接，可选方案：
   *   1. 使用 createSdkMcpServer() 创建内联 MCP Server
   *   2. 将 Tachikoma Tools 封装为独立的 stdio MCP Server
   */
  private convertToolsToMCPServers(tools: Tool[]): Record<string, unknown>[] {
    // 如果没有工具，返回空数组
    if (!tools || tools.length === 0) {
      return [];
    }

    // ⚠️ 占位实现 - 工具元数据记录，实际不可用
    // Claude Agent SDK 将使用其原生工具，Tachikoma 工具暂不注入
    console.warn(
      '[ClaudeAgentSDKBackend] MCP tool bridge not implemented. ' +
      `${tools.length} Tachikoma tools will NOT be available. ` +
      'Using Claude Agent SDK native tools only.'
    );

    // 返回空数组，不注入损坏的配置
    return [];
  }

  /**
   * 转换 SDK 消息为统一格式
   */
  private transformSDKMessage(sdkMessage: SDKMessage): WorkerMessage | null {
    const timestamp = Date.now();

    // 根据 SDK 消息类型转换
    switch (sdkMessage.type) {
      case 'assistant':
        // Claude 的思考/响应
        return {
          type: 'thinking',
          content: String(sdkMessage.content || sdkMessage.text || ''),
          timestamp,
        };

      case 'tool_use':
        // 工具调用
        return {
          type: 'tool_call',
          tool: String(sdkMessage.name || 'unknown'),
          input: sdkMessage.input,
          callId: String(sdkMessage.id || `call-${timestamp}`),
          timestamp,
        };

      case 'tool_result':
        // 工具结果
        return {
          type: 'tool_result',
          tool: String(sdkMessage.name || 'unknown'),
          callId: String(sdkMessage.tool_use_id || `call-${timestamp}`),
          result: sdkMessage.content || sdkMessage.output,
          success: !sdkMessage.is_error,
          duration: 0, // SDK 不提供持续时间
          timestamp,
        };

      case 'result':
        // 最终结果
        return {
          type: 'output',
          content: String(sdkMessage.content || sdkMessage.text || ''),
          timestamp,
        };

      case 'error':
        // 错误
        return {
          type: 'error',
          error: String(sdkMessage.message || sdkMessage.error || 'Unknown error'),
          code: String(sdkMessage.code || 'SDK_ERROR'),
          retryable: false,
          timestamp,
        };

      default:
        // 忽略未知类型
        return null;
    }
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('503') ||
      message.includes('529')
    );
  }
}
