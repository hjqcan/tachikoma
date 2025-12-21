/**
 * Worker Backend 共享基础层
 *
 * 提取各 Backend 实现的公共逻辑：
 * - AbortController 管理（ExecutionController）
 * - MemoryService 集成（MemoryManager）
 * - 审批等待机制（waitForApproval）
 * - 错误分类（isRetryableError）
 * - 执行上下文构建（buildExecutionContext）
 * - BaseWorkerBackend 抽象类（所有后端继承）
 */

import type {
  WorkerMessage,
  IWorkerBackend,
  WorkerBackendType,
  WorkerCapability,
  WorkerTask,
  WorkerExecutionOptions,
  WorkerApprovalRequestMessage,
  PendingApprovalInput,
} from '../types';
import type { Tool } from '../../types';
import type { MemoryConfig } from '../../memory';
import { MemoryService } from '../../memory';

// ============================================================================
// Memory 集成 Mixin
// ============================================================================

/**
 * Memory 管理器
 *
 * 封装 MemoryService 的检索/保存逻辑，可在多个后端复用
 */
export class MemoryManager {
  private memoryService?: MemoryService;
  private lastRetrievalAt = 0;
  private injectedIds = new Set<string>();
  private readonly backendName: string;

  constructor(
    config: MemoryConfig | undefined,
    backendName: string
  ) {
    this.backendName = backendName;
    if (config?.enabled) {
      this.memoryService = new MemoryService(config);
      console.debug(`[${backendName}] MemoryService initialized`);
    }
  }

  /**
   * 检索相关记忆
   *
   * @param query - 查询文本（通常是任务目标）
   * @param topK - 返回的最大条目数
   * @param cooldownMs - 检索冷却时间（毫秒）
   * @returns 格式化的记忆上下文字符串
   */
  async retrieve(
    query: string,
    topK = 5,
    cooldownMs = 10000
  ): Promise<string> {
    if (!this.memoryService) return '';

    const now = Date.now();
    if (now - this.lastRetrievalAt < cooldownMs) {
      return ''; // 在冷却期内
    }

    try {
      console.debug(`[${this.backendName}] Retrieving relevant memories...`);
      this.lastRetrievalAt = now;

      const result = await this.memoryService.retrieve(query, topK);

      // 去重：过滤掉已注入的记忆
      const newMemories = result.memories.filter(
        (m) => !this.injectedIds.has(m.id)
      );

      if (newMemories.length > 0) {
        console.debug(`[${this.backendName}] Injected ${newMemories.length} memories`);
        for (const m of newMemories) {
          this.injectedIds.add(m.id);
        }
        return (
          '\n\n[Relevant Memories]\n' +
          newMemories.map((m) => `- ${m.content}`).join('\n')
        );
      }
    } catch (error) {
      console.warn(`[${this.backendName}] Memory retrieval failed (continuing):`, error);
    }

    return '';
  }

  /**
   * 保存任务结果到记忆
   *
   * @param taskObjective - 任务目标
   * @param result - 任务结果
   * @param metadata - 额外元数据
   */
  async save(
    taskObjective: string,
    result: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (!this.memoryService || !result) return;

    try {
      console.debug(`[${this.backendName}] Saving task result to memory...`);
      await this.memoryService.save({
        content: `Task: ${taskObjective}\n\nResult: ${result}`,
        scope: 'procedural',
        metadata: {
          ...metadata,
          type: 'task_result',
          backend: this.backendName,
        },
      });
    } catch (error) {
      console.warn(`[${this.backendName}] Memory save failed (continuing):`, error);
    }
  }

  /**
   * 重置任务状态（避免跨任务污染）
   */
  reset(): void {
    this.lastRetrievalAt = 0;
    this.injectedIds.clear();
  }

  /**
   * 关闭 MemoryService 释放资源
   */
  async close(): Promise<void> {
    if (this.memoryService) {
      try {
        await this.memoryService.close();
      } catch {
        // Best-effort close
      }
    }
  }
}

// ============================================================================
// 执行控制器
// ============================================================================

/**
 * 执行控制器
 *
 * 管理 AbortController 和执行状态
 */
export class ExecutionController {
  private abortController: AbortController | null = null;
  private executing = false;

  /**
   * 开始执行
   */
  start(): AbortController {
    this.abortController = new AbortController();
    this.executing = true;
    return this.abortController;
  }

  /**
   * 结束执行
   */
  end(): void {
    this.executing = false;
    this.abortController = null;
  }

  /**
   * 中断执行
   */
  abort(): void {
    if (this.abortController && this.executing) {
      this.abortController.abort();
    }
  }

  /**
   * 检查是否已中断
   */
  get isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  /**
   * 获取 AbortSignal
   */
  get signal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /**
   * 检查是否正在执行
   */
  get isExecuting(): boolean {
    return this.executing;
  }
}

// ============================================================================
// 工具转换辅助
// ============================================================================

// OpenAIFunctionTool 已移除 - 未被使用

// ============================================================================
// 消息创建辅助
// ============================================================================

/**
 * 创建状态消息
 */
export function createStatusMessage(
  status: 'initializing' | 'thinking' | 'acting' | 'completed' | 'failed' | 'interrupted',
  tokensUsed?: number
): WorkerMessage {
  return {
    type: 'status',
    status,
    ...(tokensUsed !== undefined && { tokensUsed }),
    timestamp: Date.now(),
  };
}

/**
 * 创建思考消息
 */
export function createThinkingMessage(content: string): WorkerMessage {
  return {
    type: 'thinking',
    content,
    timestamp: Date.now(),
  };
}

/**
 * 创建输出消息
 */
export function createOutputMessage(content: string): WorkerMessage {
  return {
    type: 'output',
    content,
    timestamp: Date.now(),
  };
}

/**
 * 创建错误消息
 */
export function createErrorMessage(
  error: string,
  code: string,
  retryable: boolean
): WorkerMessage {
  return {
    type: 'error',
    error,
    code,
    retryable,
    timestamp: Date.now(),
  };
}

/**
 * 创建工具调用消息
 */
export function createToolCallMessage(
  tool: string,
  input: unknown,
  callId: string
): WorkerMessage {
  return {
    type: 'tool_call',
    tool,
    input,
    callId,
    timestamp: Date.now(),
  };
}

/**
 * 创建工具结果消息
 */
export function createToolResultMessage(
  tool: string,
  callId: string,
  result: unknown,
  success: boolean,
  duration: number
): WorkerMessage {
  return {
    type: 'tool_result',
    tool,
    callId,
    result,
    success,
    duration,
    timestamp: Date.now(),
  };
}

// ============================================================================
// 错误判断辅助
// ============================================================================

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('connection error') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('socket connection was closed') ||
    message.includes('503') ||
    message.includes('529') ||
    message.includes('overloaded') ||
    message.includes('temporarily unavailable')
  );
}

// ============================================================================
// SDK 可用性检查器
// ============================================================================

/**
 * Tool call loop error
 *
 * Emitted when a tool is called repeatedly with identical inputs.
 */
class ToolCallLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallLoopError';
  }
}

/**
 * SDK 可用性检查器
 *
 * 缓存动态 import 结果
 */
export class SDKAvailabilityChecker {
  private available: boolean | null = null;
  private readonly moduleName: string;

  constructor(moduleName: string) {
    this.moduleName = moduleName;
  }

  /**
   * 检查 SDK 是否可用
   */
  async check(): Promise<boolean> {
    if (this.available !== null) return this.available;

    try {
      await import(this.moduleName);
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  /**
   * 获取缓存的可用性状态
   */
  get isAvailable(): boolean | null {
    return this.available;
  }
}

// ============================================================================
// BaseWorkerBackend 抽象类
// ============================================================================

import type { ExecutionContext } from '../../types';

/**
 * Worker 后端抽象基类
 *
 * 提供所有后端（OpenAI/Claude/Generic/Gemini）共享的核心功能：
 * - ExecutionController 管理（start/end/abort）
 * - MemoryManager 集成（可选）
 * - 审批等待逻辑（回调 + 文件协议）
 * - 执行上下文构建
 * - 错误分类
 *
 * 子类需实现 execute、getCapabilities、isAvailable 等方法
 */
export abstract class BaseWorkerBackend implements IWorkerBackend {
  abstract readonly provider: string;
  abstract readonly backendType: WorkerBackendType;

  protected readonly memoryManager: MemoryManager;
  protected readonly executionController: ExecutionController;
  protected readonly backendName: string;
  private lastToolCallKey: string | null = null;
  private repeatedToolCallCount = 0;

  // Detect repeated calls to identical tool+input combinations.
  private static readonly TOOL_CALL_REPEAT_LIMIT = 3;
  private static readonly TOOL_CALL_REPEAT_LIMIT_RELAXED = 6;
  private static readonly TOOL_CALL_REPEAT_LIMIT_OVERRIDES = new Set(['file_list', 'file_read']);
  private static readonly TOOL_INPUT_PREVIEW_LIMIT = 200;

  constructor(
    memoryConfig: MemoryConfig | undefined,
    backendName: string
  ) {
    this.backendName = backendName;
    this.memoryManager = new MemoryManager(memoryConfig, backendName);
    this.executionController = new ExecutionController();
  }

  // 抽象方法
  abstract execute(
    task: WorkerTask,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage>;

  abstract getCapabilities(): WorkerCapability[];
  abstract isAvailable(): boolean;

  // 默认实现：中断执行
  async interrupt(): Promise<void> {
    this.executionController.abort();
  }

  // 默认实现：释放资源
  async dispose(): Promise<void> {
    await this.memoryManager.close();
  }

  // ============================================================================
  // Tool call de-duplication guard
  // ============================================================================

  /**
   * Reset tool call guard state.
   *
   * Call this at the beginning of each execute() to avoid cross-task contamination.
   */
  protected resetToolCallGuard(): void {
    this.lastToolCallKey = null;
    this.repeatedToolCallCount = 0;
  }

  /**
   * Guard against repeated identical tool calls in SDK-backed loops.
   *
   * Throws ToolCallLoopError when repetition exceeds the limit.
   */
  protected guardAgainstRepeatedToolCall(toolName: string, input: unknown): void {
    const key = this.buildToolCallKey(toolName, input);

    if (this.lastToolCallKey === key) {
      this.repeatedToolCallCount += 1;
    } else {
      this.lastToolCallKey = key;
      this.repeatedToolCallCount = 1;
    }

    const limit = this.getToolCallRepeatLimit(toolName);
    if (this.repeatedToolCallCount > limit) {
      const preview = this.formatToolInputPreview(input);
      const message =
        `Repeated tool call detected: "${toolName}" with identical input ` +
        `(${this.repeatedToolCallCount} times). ` +
        `Aborting to prevent infinite loop. Input preview: ${preview}`;
      this.abortExecution();
      throw new ToolCallLoopError(message);
    }
  }

  private getToolCallRepeatLimit(toolName: string): number {
    const normalized = toolName.trim().toLowerCase();
    if (BaseWorkerBackend.TOOL_CALL_REPEAT_LIMIT_OVERRIDES.has(normalized)) {
      return BaseWorkerBackend.TOOL_CALL_REPEAT_LIMIT_RELAXED;
    }
    return BaseWorkerBackend.TOOL_CALL_REPEAT_LIMIT;
  }

  /**
   * Abort current execution (override if backend uses a different abort controller).
   */
  protected abortExecution(): void {
    this.executionController.abort();
  }

  private buildToolCallKey(toolName: string, input: unknown): string {
    const payload = `${toolName}:${this.stableStringify(input)}`;
    return this.hashString(payload);
  }

  private formatToolInputPreview(input: unknown): string {
    const text = this.stableStringify(input);
    if (text.length <= BaseWorkerBackend.TOOL_INPUT_PREVIEW_LIMIT) return text;
    return `${text.slice(0, BaseWorkerBackend.TOOL_INPUT_PREVIEW_LIMIT)}...`;
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`)
      .join(',')}}`;
  }

  private hashString(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // ============================================================================
  // 执行上下文构建
  // ============================================================================

  /**
   * 构建 ExecutionContext
   *
   * 填充 taskId/agentId/traceId/workDir/env/permissions/resourceLimits
   */
  protected buildExecutionContext(
    task: WorkerTask,
    options: WorkerExecutionOptions
  ): ExecutionContext {
    return {
      taskId: task.id,
      agentId: `worker-${task.id}`,
      traceId: `trace-${task.id}-${Date.now()}`,
      workDir: options.workDir ?? process.cwd(),
      env: options.env ?? {},
      permissions: {
        allowed: [],
        denied: [],
        requireSandbox: false,
      },
      resourceLimits: {
        maxFileSize: 10 * 1024 * 1024,
        maxOutputSize: 1 * 1024 * 1024,
        maxExecutionTime: options.timeout ?? 300000,
      },
    };
  }

  // ============================================================================
  // 共享审批等待逻辑
  // ============================================================================

  /**
   * 等待审批
   *
   * 优先级: 回调 > 文件协议 > 默认批准
   *
   * @param request - 审批请求消息
   * @param options - 执行选项
   * @param timeout - 超时时间（毫秒，默认 300000）
   * @param defaultDecision - 超时后默认决策（默认 'reject'）
   * @param taskId - 任务 ID，用于审计追踪
   * @returns true = 批准, false = 拒绝
   */
  protected async waitForApproval(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    timeout = 300000,
    defaultDecision: 'approve' | 'reject' = 'reject',
    taskId?: string
  ): Promise<boolean> {
    // 优先级 1: 使用回调
    if (options.onApprovalRequest) {
      return this.waitForApprovalViaCallback(request, options, timeout, defaultDecision);
    }

    // 优先级 2: 使用文件协议
    if (options.onWritePendingApproval && options.onReadApprovalResponse) {
      return this.waitForApprovalViaFileProtocol(request, options, timeout, defaultDecision, 1000, taskId);
    }

    // 无审批机制，警告并使用默认决策
    console.warn(
      `[${this.backendName}] ⚠️ No approval mechanism for request ${request.requestId}. ` +
      `Using default: ${defaultDecision}`
    );
    return defaultDecision === 'approve';
  }

  /**
   * 通过回调等待审批
   */
  protected async waitForApprovalViaCallback(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    timeout: number,
    defaultDecision: 'approve' | 'reject'
  ): Promise<boolean> {
    try {
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          console.warn(
            `[${this.backendName}] Approval timeout for ${request.requestId}, ` +
            `using default: ${defaultDecision}`
          );
          resolve(defaultDecision === 'approve');
        }, timeout);
      });

      const approved = await Promise.race([
        options.onApprovalRequest!(request),
        timeoutPromise,
      ]);

      return approved;
    } catch (error) {
      console.error(`[${this.backendName}] Approval callback error:`, error);
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
   * @param taskId - 任务 ID，用于审计追踪
   */
  protected async waitForApprovalViaFileProtocol(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    timeout: number,
    defaultDecision: 'approve' | 'reject',
    pollInterval = 1000,
    taskId?: string
  ): Promise<boolean> {
    try {
      // 1. 写入待审批请求
      const approvalInput: PendingApprovalInput = {
        requestId: request.requestId,
        subtaskId: taskId || 'unknown-task',
        type: this.mapCategoryToApprovalType(request.category),
        description: request.description,
        details: {
          metadata: request.details,
          impactScope: 'high',
          reversible: false,
        },
        timeout,
        defaultDecision,
      };

      await options.onWritePendingApproval!(approvalInput);
      console.log(`[${this.backendName}] Wrote pending approval: ${request.requestId}`);

      // 2. 轮询等待响应
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        // 检查中断
        if (this.executionController.isAborted) {
          return false;
        }

        const response = await options.onReadApprovalResponse!();
        if (response && response.requestId === request.requestId) {
          console.log(
            `[${this.backendName}] Approval response: ${response.approved ? 'approved' : 'rejected'}`
          );
          // 清理
          if (options.onClearPendingApproval) {
            await options.onClearPendingApproval();
          }
          return response.approved;
        }

        // 等待
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      // 超时 - 清理 pending 文件
      console.warn(`[${this.backendName}] Approval timeout, using default: ${defaultDecision}`);
      if (options.onClearPendingApproval) {
        try {
          await options.onClearPendingApproval();
        } catch (cleanupError) {
          console.warn(`[${this.backendName}] Failed to cleanup pending approval:`, cleanupError);
        }
      }
      return defaultDecision === 'approve';
    } catch (error) {
      console.error(`[${this.backendName}] File protocol error:`, error);
      return defaultDecision === 'approve';
    }
  }

  /**
   * 映射审批类别到 PendingApprovalInput.type
   */
  protected mapCategoryToApprovalType(
    category: string | undefined
  ): 'file_deletion' | 'multi_file_refactor' | 'external_api_call' | 'dangerous_operation' | 'resource_intensive' {
    switch (category) {
      case 'file_deletion':
      case 'file_delete':
        return 'file_deletion';
      case 'multi_file_refactor':
      case 'file_modify':
      case 'file_create':
        return 'multi_file_refactor';
      case 'external_api_call':
      case 'external_api':
        return 'external_api_call';
      case 'dangerous_operation':
      case 'shell_command':
        return 'dangerous_operation';
      case 'resource_intensive':
        return 'resource_intensive';
      default:
        return 'dangerous_operation';
    }
  }
}
