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
} from '../types';
import { DEFAULT_RESOURCE_LIMITS, DEFAULT_KEY_DECISION_POLICY } from '../types';
import type { Tool } from '../../types';
import type { LLMClient, LLMRequest } from '../../planner/types';
import type { Sandbox, SandboxConfig } from '../../sandbox';
import { createLLMClient } from '../../planner/llm-client';
import { createLocalSandbox } from '../../sandbox/drivers/local';
import { createSandboxConfig } from '../../sandbox/types';
import {
  createSandboxToolExecutor,
  type ISandboxToolExecutor,
} from '../../sandbox/tool-executor';
import { isKeyDecision } from '../key-decision';

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
  private sandboxOwned = false; // 是否由本实例拥有（负责销毁）
  private sandboxNeedsInit = false; // 是否需要初始化
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

    // 使用提供的沙箱或自动创建
    if (config.sandbox) {
      this.sandbox = config.sandbox;
    } else if (config.sandboxConfig) {
      // 自动创建本地沙箱（延迟初始化，在 execute 时调用）
      this.sandbox = this.createSandboxFromConfig(config.sandboxConfig);
      this.sandboxOwned = true;
      this.sandboxNeedsInit = true;
    }
  }

  /**
   * 确保 Sandbox 已初始化
   *
   * 在首次执行前调用，处理初始化失败的情况
   */
  private async ensureSandboxInitialized(): Promise<void> {
    if (!this.sandboxNeedsInit || !this.sandbox) {
      return;
    }

    try {
      await this.sandbox.initialize();
      this.sandboxNeedsInit = false;
      console.debug('[GenericAgentBackend] Sandbox initialized successfully');
    } catch (error) {
      console.warn(
        `[GenericAgentBackend] ⚠️ Failed to initialize sandbox: ${error instanceof Error ? error.message : error}\n` +
        '  Falling back to non-isolated execution. High-risk tools may be rejected.'
      );
      this.sandbox = null;
      this.sandboxOwned = false;
      this.sandboxNeedsInit = false;
    }
  }

  /**
   * 从配置创建 Sandbox
   */
  private createSandboxFromConfig(partialConfig: Partial<SandboxConfig>): Sandbox {
    console.debug('[GenericAgentBackend] Auto-creating LocalSandbox from config');
    // 使用辅助函数创建完整配置
    const fullConfig = createSandboxConfig({
      ...partialConfig,
      runtime: 'local', // 强制使用本地沙盒
    });
    return createLocalSandbox(`worker-sandbox-${Date.now()}`, fullConfig);
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

    // 确保 Sandbox 已初始化（如果使用自动创建）
    await this.ensureSandboxInitialized();

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

        // 检查 intervention（每轮开始时）
        // eslint-disable-next-line no-await-in-loop -- Intervention check is intentionally sequential
        const interventionResult = await this.checkAndHandleIntervention(options);
        if (interventionResult === 'abort') {
          yield {
            type: 'status',
            status: 'interrupted',
            timestamp: Date.now(),
          };
          done = true;
          break;
        } else if (interventionResult === 'pause') {
          // pause 时暂时跳过本轮，等待下一轮重新检查
          // 实际实现中可能需要等待一段时间
          continue;
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
          maxTokens: Math.min(
            this.config.maxTokens ?? 4096,
            limits.maxTokensPerCall
          ),
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

            // 查找工具定义（用于元数据检查）
            const tool = tools.find((t) => t.name === call.name);

            // 检查关键决策（使用新的 isKeyDecision 函数）
            const keyDecisionResult = isKeyDecision(
              call.name,
              call.input,
              tool,
              options.keyDecisionPolicy,
              options.riskPolicy,
              options.unknownToolPolicy
            );

            if (keyDecisionResult.isKeyDecision) {
              const approvalRequest: WorkerApprovalRequestMessage = {
                type: 'approval_request',
                requestId: `approval-${call.callId}`,
                action: call.name,
                description: `${keyDecisionResult.reason}: ${call.name}`,
                details: { 
                  tool: call.name, 
                  input: call.input,
                  category: keyDecisionResult.category,
                  riskLevel: keyDecisionResult.riskLevel,
                },
                timestamp: Date.now(),
                category: keyDecisionResult.category,
                defaultDecision: options.keyDecisionPolicy?.defaultDecision ?? DEFAULT_KEY_DECISION_POLICY.defaultDecision,
                timeout: options.keyDecisionPolicy?.approvalTimeout ?? DEFAULT_KEY_DECISION_POLICY.approvalTimeout,
              };

              yield approvalRequest;

              // 等待审批（阻塞 + 超时）
              // eslint-disable-next-line no-await-in-loop -- Approval is intentionally sequential
              const approved = await this.waitForApproval(approvalRequest, options, task.id);
              if (!approved) {
                const rejectedResult = `Tool call ${call.name} was rejected by approval process (${keyDecisionResult.reason}).`;
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
          console.debug('[GenericAgentBackend] Loop stop: reason is stop and no tool call');
          done = true;
        } else {
          console.debug(`[GenericAgentBackend] Loop check: stopReason=${response.stopReason}, containsToolCall=${containsToolCall(response.content)}`);
        }
      }

      console.debug(`[GenericAgentBackend] Loop finished. done=${done}, round=${round}, maxRounds=${limits.maxThinkingRounds}`);

      // 发出完成状态
      yield {
        type: 'status',
        status: done ? 'completed' : 'failed',
        timestamp: Date.now(),
        tokensUsed: context.getTotalTokensUsed(),
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
      console.error('[GenericAgentBackend] Execution error:', err);
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
   * 隔离说明：
   * - 工具执行通过 SandboxToolExecutor 处理
   * - 高风险工具（delete, exec 等）如果没有设置 isCommandBased 将被拒绝
   * - 开启 strictSandbox 后所有非命令型工具将被拒绝
   * - 命令型工具 (isCommandBased: true) 通过 sandbox.runCommand() 执行
   * - 非命令型工具的 execute() 在宿主进程执行（无进程隔离）
   */
  getCapabilities(): WorkerCapability[] {
    const capabilities: WorkerCapability[] = ['code-execution'];

    // 有 sandbox 时声明这些能力
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
    // 仅销毁自己创建的 sandbox
    if (this.sandbox && this.sandboxOwned) {
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

    // 创建工具执行器（使用 sandbox 如果可用）
    const toolExecutor: ISandboxToolExecutor = createSandboxToolExecutor(this.sandbox);

    // 执行工具
    const result = await toolExecutor.execute(tool, call.input, {
      workDir: options.workDir || process.cwd(),
      timeout: 60000, // 1 分钟超时
      ...(options.env && { env: options.env }),
      ...(options.securityPolicy && { securityPolicy: options.securityPolicy }),
    });

    return {
      success: result.success,
      output: result.success ? result.result : result.error,
    };
  }

  /**
   * 等待审批（阻塞 + 超时）
   *
   * 审批流程优先级：
   * 1. 如果有 onApprovalRequest 回调，使用回调
   * 2. 如果有文件协议回调，使用文件协议（写入 pending_approval，轮询 approval_response）
   * 3. 都没有时，警告并使用默认决策
   *
   * @param request - 审批请求
   * @param options - 执行选项
   * @param subtaskId - 子任务 ID（用于文件协议）
   * @returns 是否批准
   */
  private async waitForApproval(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    subtaskId?: string
  ): Promise<boolean> {
    const timeout = request.timeout ?? DEFAULT_KEY_DECISION_POLICY.approvalTimeout;
    const defaultDecision = request.defaultDecision ?? DEFAULT_KEY_DECISION_POLICY.defaultDecision;
    const pollInterval = 1000; // 1 秒轮询间隔

    // 优先级 1: 使用回调
    if (options.onApprovalRequest) {
      return this.waitForApprovalViaCallback(request, options, timeout, defaultDecision);
    }

    // 优先级 2: 使用文件协议
    if (options.onWritePendingApproval && options.onReadApprovalResponse) {
      return this.waitForApprovalViaFileProtocol(
        request, options, subtaskId, timeout, defaultDecision, pollInterval
      );
    }

    // 都没有时，警告并使用默认决策
    console.warn(
      `[GenericAgentBackend] ⚠️ No approval mechanism available for request ${request.requestId}. ` +
      `Neither callback nor file protocol configured. Using default decision: ${defaultDecision}`
    );
    return defaultDecision === 'approve';
  }

  /**
   * 通过回调等待审批
   */
  private async waitForApprovalViaCallback(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    timeout: number,
    defaultDecision: 'approve' | 'reject'
  ): Promise<boolean> {
    try {
      // 创建超时 Promise
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          console.warn(
            `[GenericAgentBackend] Approval timeout for request ${request.requestId}, ` +
            `using default decision: ${defaultDecision}`
          );
          resolve(defaultDecision === 'approve');
        }, timeout);
      });

      // 竞争：审批回调 vs 超时
      const approved = await Promise.race([
        options.onApprovalRequest!(request),
        timeoutPromise,
      ]);

      return approved;
    } catch (error) {
      console.error(`[GenericAgentBackend] Approval callback error:`, error);
      return defaultDecision === 'approve';
    }
  }

  /**
   * 通过文件协议等待审批
   *
   * 流程：
   * 1. 写入 pending_approval.json
   * 2. 轮询 approval_response.json
   * 3. 超时后使用 defaultDecision
   * 4. 清理 pending_approval
   */
  private async waitForApprovalViaFileProtocol(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    subtaskId: string | undefined,
    timeout: number,
    defaultDecision: 'approve' | 'reject',
    pollInterval: number
  ): Promise<boolean> {
    try {
      // 1. 写入待审批请求文件
      const approvalInput = {
        requestId: request.requestId,
        subtaskId: subtaskId || 'unknown',
        type: this.mapCategoryToApprovalType(request.category),
        description: request.description,
        details: {
          metadata: request.details,
          impactScope: 'high' as const,
          reversible: false,
        },
        timeout,
        defaultDecision,
      };

      await options.onWritePendingApproval!(approvalInput);
      console.log(`[GenericAgentBackend] Wrote pending approval: ${request.requestId}`);

      // 2. 轮询等待响应
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        // 检查是否中断
        if (this.abortController?.signal.aborted) {
          console.log(`[GenericAgentBackend] Approval wait aborted`);
          return false;
        }

        // 读取审批响应
        const response = await options.onReadApprovalResponse!();
        if (response && response.requestId === request.requestId) {
          console.log(
            `[GenericAgentBackend] Approval response received: ${response.approved ? 'approved' : 'rejected'}`
          );

          // 3. 清理待审批文件
          if (options.onClearPendingApproval) {
            await options.onClearPendingApproval();
          }

          return response.approved;
        }

        // 等待轮询间隔
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      // 超时
      console.warn(
        `[GenericAgentBackend] Approval timeout for request ${request.requestId}, ` +
        `using default decision: ${defaultDecision}`
      );

      // 清理待审批文件
      if (options.onClearPendingApproval) {
        await options.onClearPendingApproval();
      }

      return defaultDecision === 'approve';
    } catch (error) {
      console.error(`[GenericAgentBackend] File protocol approval error:`, error);
      return defaultDecision === 'approve';
    }
  }

  /**
   * 将 ApprovalCategory 映射到 ApprovalRequestType
   */
  private mapCategoryToApprovalType(
    category?: string
  ): 'file_deletion' | 'multi_file_refactor' | 'external_api_call' | 'dangerous_operation' | 'resource_intensive' {
    switch (category) {
      case 'key_decision':
        return 'dangerous_operation';
      case 'high_risk_tool':
        return 'dangerous_operation';
      case 'dangerous_pattern':
        return 'dangerous_operation';
      default:
        return 'dangerous_operation';
    }
  }

  /**
   * 检查并处理干预指令
   *
   * @param options - 执行选项
   * @returns 'continue' | 'pause' | 'abort'
   */
  private async checkAndHandleIntervention(
    options: WorkerExecutionOptions
  ): Promise<'continue' | 'pause' | 'abort'> {
    // 如果没有 intervention 检查回调，直接继续
    if (!options.onCheckIntervention) {
      return 'continue';
    }

    try {
      const intervention = await options.onCheckIntervention();

      // 没有干预或已确认的干预，继续执行
      if (!intervention || intervention.acknowledged) {
        return 'continue';
      }

      console.log(
        `[GenericAgentBackend] Intervention detected: ${intervention.type} - ${intervention.reason}`
      );

      // 根据干预类型处理
      switch (intervention.type) {
        case 'abort':
          // 确认干预
          if (options.onAcknowledgeIntervention) {
            await options.onAcknowledgeIntervention(intervention.interventionId);
          }
          return 'abort';

        case 'pause':
          // 暂停时不确认，保持 pending 状态
          return 'pause';

        case 'resume':
          // 确认恢复指令并继续
          if (options.onAcknowledgeIntervention) {
            await options.onAcknowledgeIntervention(intervention.interventionId);
          }
          return 'continue';

        case 'redirect':
        case 'guidance':
          // 对于 redirect 和 guidance，记录指导但继续执行
          // 实际实现中可能需要将 instructions 注入到上下文
          console.log(
            `[GenericAgentBackend] Guidance: ${intervention.instructions}`
          );
          if (options.onAcknowledgeIntervention) {
            await options.onAcknowledgeIntervention(intervention.interventionId);
          }
          return 'continue';

        default:
          return 'continue';
      }
    } catch (error) {
      console.warn(`[GenericAgentBackend] Error checking intervention:`, error);
      return 'continue';
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
      message.includes('529') ||
      message.includes('overloaded')
    );
  }
}
