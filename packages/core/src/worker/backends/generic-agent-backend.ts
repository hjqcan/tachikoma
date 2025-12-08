/**
 * 通用 Agent 后端
 *
 * 自研的通用后端实现，支持任意 LLM（OpenAI、Gemini 等）
 * 通过 LLMClient + Sandbox 实现工具调用循环
 */

import type {
  IWorkerBackend,
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
  GenericBackendConfig,
  WorkerApprovalRequestMessage,
  RiskPolicy,
} from '../types';
import { DEFAULT_RISK_POLICY, DEFAULT_RESOURCE_LIMITS } from '../types';
import type { Tool } from '../../types';
import type { LLMClient, LLMRequest } from '../../planner/types';
import type { Sandbox } from '../../sandbox';
import { createLLMClient } from '../../planner/llm-client';

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认系统提示
 */
const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant that can use tools to accomplish tasks.
When given a task, think step by step about how to accomplish it, then use the available tools.
Always provide clear explanations of what you're doing and why.`;

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 通用后端错误
 */
export class GenericBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'GenericBackendError';
  }
}

// ============================================================================
// 简单上下文管理器
// ============================================================================

/**
 * 消息角色
 */
type MessageRole = 'user' | 'assistant' | 'tool';

/**
 * 上下文消息
 */
interface ContextMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
}

/**
 * 简单上下文管理器
 *
 * 管理对话历史，支持可配置的上下文限制和 token 追踪
 */
class SimpleContextManager {
  private messages: ContextMessage[] = [];
  private readonly maxMessages: number;
  private totalTokensUsed = 0;
  private readonly maxTotalTokens: number;

  constructor(maxMessageWindow = 100, maxTotalTokens = 500_000) {
    this.maxMessages = maxMessageWindow;
    this.maxTotalTokens = maxTotalTokens;
  }

  addUserMessage(content: string): void {
    this.addMessage({ role: 'user', content });
  }

  addAssistantMessage(content: string): void {
    this.addMessage({ role: 'assistant', content });
  }

  addToolResult(toolCallId: string, result: string): void {
    this.addMessage({
      role: 'tool',
      content: result,
      toolCallId,
    });
  }

  /**
   * 记录 token 使用量
   */
  recordTokenUsage(inputTokens: number, outputTokens: number): void {
    this.totalTokensUsed += inputTokens + outputTokens;
  }

  /**
   * 获取已使用的 token 总量
   */
  getTotalTokensUsed(): number {
    return this.totalTokensUsed;
  }

  /**
   * 检查是否超过 token 预算
   */
  isOverBudget(): boolean {
    return this.totalTokensUsed >= this.maxTotalTokens;
  }

  /**
   * 获取剩余 token 预算
   */
  getRemainingBudget(): number {
    return Math.max(0, this.maxTotalTokens - this.totalTokensUsed);
  }

  getMessages(): { role: 'user' | 'assistant'; content: string }[] {
    // 转换为 LLM 可接受的格式
    // Tool 消息合并到上一条或转换为 user 消息
    const result: { role: 'user' | 'assistant'; content: string }[] = [];

    for (const msg of this.messages) {
      if (msg.role === 'tool') {
        // 工具结果作为 user 消息
        result.push({
          role: 'user',
          content: `Tool result: ${msg.content}`,
        });
      } else {
        result.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return result;
  }

  clear(): void {
    this.messages = [];
    this.totalTokensUsed = 0;
  }

  private addMessage(message: ContextMessage): void {
    this.messages.push(message);
    // 保持消息数量在限制内
    if (this.messages.length > this.maxMessages) {
      // 保留第一条（用户初始请求）和最近的消息
      const firstMessage = this.messages[0];
      if (firstMessage) {
        this.messages = [firstMessage, ...this.messages.slice(-this.maxMessages + 1)];
      }
    }
  }
}

// ============================================================================
// 工具调用解析
// ============================================================================

/**
 * 工具调用
 */
interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
  callId: string;
}

/**
 * 从 LLM 响应中解析工具调用
 *
 * 支持多种格式：
 * - JSON 格式：{"tool": "name", "input": {...}}
 * - 函数调用格式：tool_name(arg1, arg2)
 * - XML 格式：<tool_use><name>...</name><input>...</input></tool_use>
 */
function parseToolCalls(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 尝试解析 JSON 格式
  try {
    const jsonMatch = content.match(/\{[\s\S]*"tool"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          name: parsed.tool,
          input: parsed.input || parsed.arguments || {},
          callId: `call-${Date.now()}`,
        });
      }
    }
  } catch {
    // 继续尝试其他格式
  }

  // 尝试解析 XML 格式（Claude 风格）
  const xmlRegex = /<tool_use>([\s\S]*?)<\/tool_use>/g;
  let xmlMatch;
  while ((xmlMatch = xmlRegex.exec(content)) !== null) {
    const toolBlock = xmlMatch[1];
    const nameMatch = toolBlock?.match(/<name>(.*?)<\/name>/);
    const inputMatch = toolBlock?.match(/<input>([\s\S]*?)<\/input>/);

    if (nameMatch && nameMatch[1]) {
      let input = {};
      if (inputMatch && inputMatch[1]) {
        try {
          input = JSON.parse(inputMatch[1]);
        } catch {
          input = { raw: inputMatch[1] };
        }
      }

      calls.push({
        name: nameMatch[1],
        input,
        callId: `call-${Date.now()}-${calls.length}`,
      });
    }
  }

  return calls;
}

/**
 * 判断响应是否包含工具调用
 */
function containsToolCall(content: string): boolean {
  return (
    content.includes('"tool"') ||
    content.includes('<tool_use>') ||
    content.includes('tool_call')
  );
}

// ============================================================================
// 通用后端实现
// ============================================================================

/**
 * 通用 Agent 后端
 *
 * 自研实现，支持任意 LLM 提供商
 *
 * @example
 * ```ts
 * const backend = new GenericAgentBackend({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * for await (const msg of backend.execute(task, tools, options)) {
 *   console.log(msg);
 * }
 * ```
 */
export class GenericAgentBackend implements IWorkerBackend {
  readonly provider: string;
  readonly backendType: WorkerBackendType = 'generic';

  private readonly config: GenericBackendConfig;
  private llmClient: LLMClient;
  private sandbox: Sandbox | null = null;
  private abortController: AbortController | null = null;
  private isExecuting = false;

  constructor(config: GenericBackendConfig) {
    this.config = config;
    this.provider = config.provider;

    // 使用提供的 LLM 客户端或创建新的
    if (config.llmClient) {
      this.llmClient = config.llmClient;
    } else {
      this.llmClient = createLLMClient({
        provider: config.provider,
        model: config.model,
        maxTokens: config.maxTokens ?? 4096,
        ...(config.apiKey && { apiKey: config.apiKey }),
        ...(config.baseUrl && { baseUrl: config.baseUrl }),
        ...(config.temperature !== undefined && { temperature: config.temperature }),
      });
    }

    // 使用提供的沙盒
    if (config.sandbox) {
      this.sandbox = config.sandbox;
    }
  }

  /**
   * 执行任务
   */
  async *execute(
    task: WorkerTask,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage> {
    // 创建 AbortController
    this.abortController = new AbortController();
    this.isExecuting = true;

    // 发出初始化状态
    yield {
      type: 'status',
      status: 'initializing',
      timestamp: Date.now(),
    };

    // 构建资源限制
    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...options.resourceLimits,
    };

    // 创建上下文管理器（使用资源限制）
    const context = new SimpleContextManager(
      limits.maxMessageWindow,
      limits.maxTotalTokens
    );

    // 构建工具描述
    const toolDescriptions = this.buildToolDescriptions(tools);

    // 初始用户消息
    context.addUserMessage(`Task: ${task.objective}

Constraints:
${task.constraints?.map((c) => `- ${c}`).join('\n') || 'None'}

Available tools:
${toolDescriptions}

Please accomplish this task step by step. When you need to use a tool, output it in this format:
<tool_use>
<name>tool_name</name>
<input>{"param": "value"}</input>
</tool_use>

When the task is complete, provide a final summary of what was accomplished.`);

    try {
      let round = 0;
      let done = false;
      let totalToolCalls = 0;

      while (!done && round < limits.maxThinkingRounds) {
        round++;

        // 检查是否已中断
        if (this.abortController.signal.aborted) {
          yield {
            type: 'status',
            status: 'interrupted',
            timestamp: Date.now(),
          };
          break;
        }

        // 发出思考状态
        yield {
          type: 'status',
          status: 'thinking',
          progress: Math.min(95, (round / limits.maxThinkingRounds) * 100),
          timestamp: Date.now(),
        };

        // 调用 LLM
        const request: LLMRequest = {
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          messages: context.getMessages(),
          maxTokens: this.config.maxTokens ?? 4096,
          temperature: this.config.temperature ?? 0.3,
          abortSignal: this.abortController.signal,
        };

        // eslint-disable-next-line no-await-in-loop -- LLM call is intentionally sequential in agent loop
        const response = await this.llmClient.complete(request);

        // 记录 token 使用量
        context.recordTokenUsage(
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        // 检查 token 预算
        if (context.isOverBudget()) {
          yield {
            type: 'error',
            error: `Token budget exceeded: ${context.getTotalTokensUsed()} tokens used (limit: ${limits.maxTotalTokens})`,
            code: 'TOKEN_BUDGET_EXCEEDED',
            retryable: false,
            timestamp: Date.now(),
          };
          done = true;
          break;
        }

        // 发出思考消息
        yield {
          type: 'thinking',
          content: response.content,
          timestamp: Date.now(),
        };

        // 添加到上下文
        context.addAssistantMessage(response.content);

        // 检查是否有工具调用
        if (containsToolCall(response.content)) {
          const toolCalls = parseToolCalls(response.content);

          for (const call of toolCalls) {
            // 发出工具调用消息
            yield {
              type: 'tool_call',
              tool: call.name,
              input: call.input,
              callId: call.callId,
              timestamp: Date.now(),
            };

            // 发出执行状态
            yield {
              type: 'status',
              status: 'acting',
              timestamp: Date.now(),
            };

            // 检查是否需要审批
            if (options.requireApproval && this.isHighRiskOperation(call.name, call.input, options.riskPolicy)) {
              const approvalRequest: WorkerApprovalRequestMessage = {
                type: 'approval_request',
                requestId: `approval-${call.callId}`,
                action: call.name,
                description: `Execute ${call.name} with input: ${JSON.stringify(call.input)}`,
                details: { tool: call.name, input: call.input },
                timestamp: Date.now(),
              };

              yield approvalRequest;

              // 等待审批
              if (options.onApprovalRequest) {
                yield {
                  type: 'status',
                  status: 'waiting-approval',
                  timestamp: Date.now(),
                };

                // eslint-disable-next-line no-await-in-loop -- Approval callback is intentionally sequential
                const approved = await options.onApprovalRequest(approvalRequest);
                if (!approved) {
                  const rejectedResult = `Tool call ${call.name} was rejected by approval process.`;
                  context.addToolResult(call.callId, rejectedResult);

                  yield {
                    type: 'tool_result',
                    tool: call.name,
                    callId: call.callId,
                    result: rejectedResult,
                    success: false,
                    duration: 0,
                    timestamp: Date.now(),
                  };

                  continue;
                }
              }
            }

            // 执行工具
            const startTime = Date.now();
            // eslint-disable-next-line no-await-in-loop -- Tool execution is intentionally sequential in agent loop
            const result = await this.executeTool(call, tools, options);
            const duration = Date.now() - startTime;
            totalToolCalls++;

            // 检查工具调用次数限制
            if (totalToolCalls >= limits.maxToolCalls) {
              yield {
                type: 'error',
                error: `Max tool calls (${limits.maxToolCalls}) exceeded`,
                code: 'MAX_TOOL_CALLS_EXCEEDED',
                retryable: false,
                timestamp: Date.now(),
              };
              done = true;
              break;
            }

            // 添加结果到上下文
            context.addToolResult(call.callId, JSON.stringify(result.output));

            // 发出工具结果消息
            yield {
              type: 'tool_result',
              tool: call.name,
              callId: call.callId,
              result: result.output,
              success: result.success,
              duration,
              timestamp: Date.now(),
            };
          }
        } else {
          // 没有工具调用，任务完成
          done = true;

          yield {
            type: 'output',
            content: response.content,
            timestamp: Date.now(),
          };
        }

        // 检查停止原因
        if (response.stopReason === 'stop' && !containsToolCall(response.content)) {
          done = true;
        }
      }

      // 发出完成状态
      yield {
        type: 'status',
        status: done ? 'completed' : 'failed',
        timestamp: Date.now(),
      };

      // 如果达到最大轮次，发出警告
      if (round >= limits.maxThinkingRounds) {
        yield {
          type: 'error',
          error: `Max thinking rounds (${limits.maxThinkingRounds}) exceeded`,
          code: 'MAX_ROUNDS_EXCEEDED',
          retryable: false,
          timestamp: Date.now(),
        };
      }
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
   * ⚠️ 注意：当前 sandbox 未连接到 executeTool
   * 即使声明了 file-operations/shell-commands，实际工具执行仍未隔离
   * TODO: 实现真正的 sandbox 隔离执行
   */
  getCapabilities(): WorkerCapability[] {
    const capabilities: WorkerCapability[] = ['code-execution'];

    // 仅在有 sandbox 时声明这些能力（但实际未完全隔离）
    if (this.sandbox) {
      capabilities.push('file-operations', 'shell-commands');
    }

    return capabilities;
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.llmClient.isAvailable();
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
    if (this.sandbox) {
      await this.sandbox.destroy();
      this.sandbox = null;
    }
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 构建工具描述
   */
  private buildToolDescriptions(tools: Tool[]): string {
    if (!tools || tools.length === 0) {
      return 'No tools available.';
    }

    return tools
      .map((tool) => {
        const schemaStr = JSON.stringify(tool.inputSchema, null, 2);
        return `- ${tool.name}: ${tool.description}
  Input schema: ${schemaStr}`;
      })
      .join('\n\n');
  }

  /**
   * 执行工具
   */
  private async executeTool(
    call: ParsedToolCall,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): Promise<{ success: boolean; output: unknown }> {
    // 查找工具
    const tool = tools.find((t) => t.name === call.name);

    if (!tool) {
      return {
        success: false,
        output: `Tool not found: ${call.name}`,
      };
    }

    try {
      // 执行工具
      const context = {
        taskId: 'worker-task',
        agentId: 'worker',
        traceId: `trace-${Date.now()}`,
        workDir: options.workDir || process.cwd(),
        env: options.env || {},
      };

      const result = await tool.execute(call.input, context);

      return {
        success: true,
        output: result,
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        output: `Tool execution failed: ${err.message}`,
      };
    }
  }

  /**
   * 判断是否为高风险操作
   *
   * 使用可配置的风险策略
   */
  private isHighRiskOperation(
    toolName: string,
    input: Record<string, unknown>,
    riskPolicy?: RiskPolicy
  ): boolean {
    const policy = {
      highRiskTools: riskPolicy?.highRiskTools ?? DEFAULT_RISK_POLICY.highRiskTools,
      dangerousPatterns: riskPolicy?.dangerousPatterns ?? DEFAULT_RISK_POLICY.dangerousPatterns,
    };

    // 自定义评估函数优先
    if (riskPolicy?.customEvaluator) {
      return riskPolicy.customEvaluator(toolName, input);
    }

    // 检查高风险工具名称
    if (policy.highRiskTools.some((t) => toolName.toLowerCase().includes(t.toLowerCase()))) {
      return true;
    }

    // 检查输入中的危险模式
    const inputStr = JSON.stringify(input).toLowerCase();
    return policy.dangerousPatterns.some((pattern) => inputStr.includes(pattern.toLowerCase()));
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
      message.includes('529') ||
      message.includes('overloaded')
    );
  }
}
