/**
 * MCP Tool Bridge
 *
 * 将 Tachikoma Tool 接口转换为 Claude Agent SDK 可使用的 MCP Server 格式
 *
 * @module mcp/tool-bridge
 */

import type { Tool, ExecutionContext } from '../types';
import type { ToolResult } from '../tools/types';
import { DEFAULT_RESOURCE_LIMITS as DEFAULT_WORKER_LIMITS } from '../worker/types';
import {
  checkToolInputSize,
  checkToolCallAgainstConstraints,
  type ConstraintPolicy,
} from '../worker/engines';
import {
  ToolRuntimeKernel,
  createResolvedToolsetSnapshot,
  createToolRuntimeLogMiddleware,
  createSyntheticToolFailureOutput,
  resolveToolRuntimeFeatureFlags,
  type ResolvedToolset,
} from '../worker/tool-runtime';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * MCP Tool 定义（SDK 格式）
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * MCP Server 配置
 */
export interface MCPServerDefinition {
  name: string;
  tools: MCPToolDefinition[];
}

/**
 * Bridge 配置
 */
export interface ToolBridgeConfig {
  /** 服务器名称前缀 */
  serverName?: string;
  /** 是否包含工具元数据 */
  includeMetadata?: boolean;
  /** 工作目录 */
  workDir?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 最大工具输入大小（字节） */
  maxToolInputBytes?: number;
  /** 约束策略（用于工具调用约束） */
  constraintPolicy?: ConstraintPolicy | null;
  /** 工具执行前的自定义检查（例如 doom-loop） */
  beforeExecute?: (toolName: string, args: Record<string, unknown>) => Promise<{
    allowed: boolean;
    message?: string;
  }>;
  /** 任务 ID（用于工具运行时生命周期标识） */
  taskId?: string;
  /** 可选：外部注入的工具快照 */
  toolset?: ResolvedToolset;
  /** 可选：外部注入的工具运行时内核 */
  toolRuntime?: ToolRuntimeKernel;
}

interface ResolvedToolBridgeConfig extends Required<
  Omit<ToolBridgeConfig, 'beforeExecute' | 'toolset' | 'toolRuntime'>
> {
  beforeExecute?: ToolBridgeConfig['beforeExecute'];
  toolset?: ResolvedToolset;
  toolRuntime: ToolRuntimeKernel;
}

// ============================================================================
// ToolToMCPBridge
// ============================================================================

/**
 * Tachikoma Tool → MCP Server 桥接器
 *
 * 将 Tachikoma 的 Tool 接口转换为 Claude Agent SDK 可使用的 MCP Server 格式，
 * 使 ClaudeAgentSDKBackend 能够使用 Tachikoma 定义的工具。
 *
 * @example
 * ```ts
 * const bridge = new ToolToMCPBridge({ serverName: 'tachikoma' });
 * const mcpServers = bridge.convertToMCPServers(tools);
 *
 * // 在 Claude Agent SDK 中使用
 * query({
 *   prompt: task.objective,
 *   options: { mcpServers }
 * });
 * ```
 */
export class ToolToMCPBridge {
  private readonly config: ResolvedToolBridgeConfig;
  private sdkAvailable: boolean | null = null;

  constructor(config: ToolBridgeConfig = {}) {
    const resolved: ResolvedToolBridgeConfig = {
      serverName: config.serverName ?? 'tachikoma-tools',
      includeMetadata: config.includeMetadata ?? true,
      workDir: config.workDir ?? process.cwd(),
      env: config.env ?? {},
      maxToolInputBytes: config.maxToolInputBytes ?? DEFAULT_WORKER_LIMITS.maxToolInputBytes,
      constraintPolicy: config.constraintPolicy ?? null,
      taskId: config.taskId ?? 'mcp-bridge',
      toolRuntime:
        config.toolRuntime ??
        new ToolRuntimeKernel({
          middlewares: [
            createToolRuntimeLogMiddleware({
              backend: 'ToolToMCPBridge',
            }),
          ],
        }),
      ...(config.toolset !== undefined && { toolset: config.toolset }),
    };
    if (typeof config.beforeExecute === 'function') {
      resolved.beforeExecute = config.beforeExecute;
    }
    this.config = resolved;
  }

  /**
   * 检查 Claude Agent SDK 是否可用
   */
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
   * 将 Tachikoma Tools 转换为 MCP Server 配置
   *
   * 使用 Claude Agent SDK 的 createSdkMcpServer() 创建内联 MCP 服务器
   *
   * @param tools - Tachikoma 工具列表
   * @param overrides - 覆盖工作目录/环境变量
   * @returns MCP Server 配置数组（用于 Claude Agent SDK 的 mcpServers 选项）
   */
  async convertToMCPServers(
    tools: Tool[],
    overrides?: Partial<
      Pick<
        ToolBridgeConfig,
        'workDir' | 'env' | 'maxToolInputBytes' | 'constraintPolicy' | 'beforeExecute' | 'taskId' | 'toolset'
      >
    >
  ): Promise<unknown[]> {
    if (!tools || tools.length === 0) {
      return [];
    }

    // 检查 SDK 是否可用
    const sdkAvailable = await this.checkSDKAvailability();
    if (!sdkAvailable) {
      console.warn(
        '[ToolToMCPBridge] Claude Agent SDK not available. ' +
          `${tools.length} Tachikoma tools will NOT be bridged.`
      );
      return [];
    }

    try {
      // 动态导入 SDK
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const { createSdkMcpServer, tool } = sdk;

      // 确保函数存在
      if (typeof createSdkMcpServer !== 'function' || typeof tool !== 'function') {
        console.warn(
          '[ToolToMCPBridge] createSdkMcpServer or tool function not found in SDK. ' +
            'SDK version may be incompatible.'
        );
        return [];
      }

      // 创建 MCP 工具定义
      const context = this.buildContext(overrides);

      const maxToolInputBytes =
        overrides?.maxToolInputBytes ?? this.config.maxToolInputBytes;
      const constraintPolicy =
        overrides?.constraintPolicy ?? this.config.constraintPolicy ?? null;
      const beforeExecute = overrides?.beforeExecute ?? this.config.beforeExecute;
      const toolset =
        overrides?.toolset ??
        this.config.toolset ??
        createResolvedToolsetSnapshot(tools);
      const mcpTools = tools.map((t) =>
        this.createMCPTool(
          t,
          tool,
          context,
          maxToolInputBytes,
          constraintPolicy,
          beforeExecute,
          toolset
        )
      );

      // 创建 MCP Server
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = createSdkMcpServer({
        name: this.config.serverName,
        tools: mcpTools as any,
      });

      console.debug(
        `[ToolToMCPBridge] Bridged ${tools.length} tools to MCP server '${this.config.serverName}'`
      );

      return [server];
    } catch (error) {
      console.error(
        '[ToolToMCPBridge] Failed to create MCP server:',
        error instanceof Error ? error.message : error
      );
      return [];
    }
  }

  /**
   * 将单个 Tachikoma Tool 转换为 MCP Tool
   */
  private createMCPTool(
    tachikoma: Tool,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolFactory: any,
    context: ExecutionContext,
    maxToolInputBytes: number,
    constraintPolicy: ConstraintPolicy | null,
    beforeExecute?: (toolName: string, args: Record<string, unknown>) => Promise<{
      allowed: boolean;
      message?: string;
    }>,
    toolset?: ResolvedToolset
  ): unknown {
    const runtimeFlags = resolveToolRuntimeFeatureFlags(context.env);
    // 使用 SDK 的 tool() 函数创建 MCP Tool
    return toolFactory(
      tachikoma.name,
      tachikoma.description,
      tachikoma.inputSchema ?? { type: 'object', properties: {} },
      async (args: Record<string, unknown>): Promise<string> => {
        const runtimeResult = await this.config.toolRuntime.execute({
          taskId: context.taskId,
          toolName: tachikoma.name,
          input: args,
          toolset: toolset ?? createResolvedToolsetSnapshot([tachikoma]),
          metadata: {
            backend: 'claude-agent-sdk',
            bridgeServer: this.config.serverName,
            toolRuntimeV2Enabled: runtimeFlags.toolRuntimeV2Enabled,
            toolRuntimeV2ShadowMode: runtimeFlags.toolRuntimeV2ShadowMode,
          },
          errorCode: 'TOOL_EXECUTION_ERROR',
          recoverUnhandledErrors:
            runtimeFlags.toolRuntimeV2Enabled &&
            runtimeFlags.syntheticToolResultEnabled,
          execute: async (runtimeCall) => {
            const runtimeArgs =
              runtimeCall.input && typeof runtimeCall.input === 'object'
                ? (runtimeCall.input as Record<string, unknown>)
                : {};

            if (beforeExecute) {
              const guard = await beforeExecute(tachikoma.name, runtimeArgs);
              if (!guard.allowed) {
                return {
                  success: false,
                  isError: true,
                  output: createSyntheticToolFailureOutput({
                    toolName: tachikoma.name,
                    code: 'TOOL_EXECUTION_BLOCKED',
                    error: guard.message ?? 'Tool execution blocked by guard.',
                    kind: 'functional',
                  }),
                };
              }
            }

            if (constraintPolicy) {
              const violation = checkToolCallAgainstConstraints(
                tachikoma.name,
                runtimeArgs,
                constraintPolicy
              );
              if (violation) {
                return {
                  success: false,
                  isError: true,
                  output: createSyntheticToolFailureOutput({
                    toolName: tachikoma.name,
                    code: 'CONSTRAINT_VIOLATION',
                    error: violation.message,
                    kind: 'functional',
                    details: {
                      category: violation.category,
                      detected: violation.detected,
                      allowed: violation.allowed,
                    },
                  }),
                };
              }
            }

            const sizeCheck = checkToolInputSize(tachikoma.name, runtimeArgs, maxToolInputBytes);
            if (!sizeCheck.ok) {
              return {
                success: false,
                isError: true,
                output: createSyntheticToolFailureOutput({
                  toolName: tachikoma.name,
                  code: 'TOOL_INPUT_TOO_LARGE',
                  error: sizeCheck.message ?? 'Tool input too large.',
                  kind: 'functional',
                  details: {
                    size: sizeCheck.size,
                    limit: maxToolInputBytes,
                  },
                }),
              };
            }

            const result = await tachikoma.execute(runtimeArgs, context) as ToolResult;

            if (result.success) {
              return {
                success: true,
                isError: false,
                output:
                  typeof result.data === 'string'
                    ? result.data
                    : JSON.stringify(result.data, null, 2),
              };
            }

            const meta =
              result.meta && typeof result.meta === 'object'
                ? (result.meta as Record<string, unknown>)
                : null;
            const codeFromMeta =
              meta && typeof meta.code === 'string' && meta.code.trim().length > 0
                ? meta.code
                : null;

            return {
              success: false,
              isError: true,
              output: createSyntheticToolFailureOutput({
                toolName: tachikoma.name,
                code: codeFromMeta ?? 'TOOL_FUNCTIONAL_ERROR',
                error: result.error ?? 'Unknown error',
                kind: 'functional',
              }),
            };
          },
        });

        return typeof runtimeResult.output === 'string'
          ? runtimeResult.output
          : JSON.stringify(runtimeResult.output, null, 2);
      }
    );
  }

  /**
   * 构建执行上下文
   */
  private buildContext(
    overrides?: Partial<Pick<ToolBridgeConfig, 'workDir' | 'env' | 'taskId'>>
  ): ExecutionContext {
    const workDir = overrides?.workDir ?? this.config.workDir;
    const env = { ...this.config.env, ...(overrides?.env ?? {}) };
    const taskId = overrides?.taskId ?? this.config.taskId;
    // Preserve effectiveCwd across tool calls for this bridged session (P1-A).
    const cwdState = { current: workDir };

    return {
      taskId,
      agentId: 'mcp-bridge',
      traceId: `bridge-${Date.now()}`,
      workDir,
      get effectiveCwd() {
        return cwdState.current;
      },
      updateCwd: (newCwd: string) => {
        cwdState.current = newCwd;
      },
      env,
    };
  }

  /**
   * 获取工具定义（不创建 MCP Server，仅返回定义）
   *
   * 用于调试或日志记录
   */
  getToolDefinitions(tools: Tool[]): MCPServerDefinition {
    return {
      name: this.config.serverName,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        handler: async () => {
          /* placeholder */
        },
      })),
    };
  }
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 创建 MCP Tool Bridge
 */
export function createToolBridge(config?: ToolBridgeConfig): ToolToMCPBridge {
  return new ToolToMCPBridge(config);
}

/**
 * 快速转换工具为 MCP Servers
 *
 * @param tools - Tachikoma 工具列表
 * @param config - 可选配置
 * @returns MCP Server 配置数组
 */
export async function bridgeToolsToMCP(
  tools: Tool[],
  config?: ToolBridgeConfig
): Promise<unknown[]> {
  const bridge = new ToolToMCPBridge(config);
  return bridge.convertToMCPServers(tools);
}
