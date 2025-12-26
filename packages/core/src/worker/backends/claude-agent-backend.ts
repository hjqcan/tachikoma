/**
 * Claude Agent SDK 后端
 *
 * 封装 Claude Agent SDK，将其适配为统一的 IWorkerBackend 接口
 * 获得完整的 Claude Code 能力（代码编辑、命令执行、上下文管理等）
 */

import type {
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
  ClaudeAgentSDKBackendConfig,
} from '../types';
import { DEFAULT_DOOM_LOOP_POLICY, DEFAULT_RESOURCE_LIMITS } from '../types';
import type { Tool, RetryPolicy } from '../../types';
import { ToolToMCPBridge } from '../../mcp/tool-bridge';
import type { ToolBridgeConfig } from '../../mcp/tool-bridge';
import { MemoryService } from '../../memory';
import { BaseWorkerBackend, ToolCallBudgetExceededError, isRetryableError } from './base-backend';
import { buildWorkerSystemPrompt } from '../prompts/system-prompt';
import { buildTaskPrompt } from '../prompts/task-prompt';
import { createSkillsManager, type SkillsManager, deriveConstraintPolicy, type ConstraintPolicy, resolveProjectContextConfig } from '../engines';
import { IdentityUpdater, getAgentIdFromEnv } from '../../agent-identity';

// 工具调用追踪器（防循环）
import { ToolCallTracker } from '../tool-call-tracker';

// 失败记忆系统（上下文注入）
import { FailureMemory } from '../failure-memory';

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

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelay: 1000,
  backoffFactor: 2,
  maxDelay: 10000,
};

function isConnectionError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('econnreset') ||
    message.includes('socket connection was closed') ||
    message.includes('connection error') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('network')
  );
}

function resolveRetryPolicy(policy?: RetryPolicy): RetryPolicy {
  if (!policy) return DEFAULT_RETRY_POLICY;
  const backoffFactor: number = policy.backoffFactor ?? DEFAULT_RETRY_POLICY.backoffFactor!;
  const maxDelay: number = policy.maxDelay ?? DEFAULT_RETRY_POLICY.maxDelay!;
  return {
    maxRetries: policy.maxRetries,
    baseDelay: policy.baseDelay,
    backoffFactor,
    maxDelay,
  };
}

function calculateRetryDelay(retryPolicy: RetryPolicy, attemptNumber: number): number {
  const { baseDelay, backoffFactor = 1, maxDelay } = retryPolicy;
  const delay = baseDelay * Math.pow(backoffFactor, attemptNumber - 1);
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  const finalDelay = Math.round(delay + jitter);
  return maxDelay ? Math.min(finalDelay, maxDelay) : finalDelay;
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
 * - 记忆检索与保存
 *
 * @example
 * ```ts
 * const backend = new ClaudeAgentSDKBackend({
 *   provider: 'anthropic',
 *   model: 'claude-3-5-sonnet-20241022',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   memoryConfig: { enabled: true, providerType: 'in-memory' },
 * });
 *
 * for await (const msg of backend.execute(task, tools, options)) {
 *   console.log(msg);
 * }
 * ```
 */
export class ClaudeAgentSDKBackend extends BaseWorkerBackend {
  readonly provider = 'anthropic';
  readonly backendType: WorkerBackendType = 'agent-sdk';

  private readonly config: ClaudeAgentSDKBackendConfig;
  private abortController: AbortController | null = null;
  private isExecuting = false;
  private readonly toolBridge: ToolToMCPBridge;
  private toolCallsThisRun = 0;
  private toolCallsInAttempt = 0;
  private maxToolCallsThisRun = DEFAULT_RESOURCE_LIMITS.maxToolCalls;
  private maxTurnsThisRun = DEFAULT_RESOURCE_LIMITS.maxThinkingRounds;
  
  // Memory support (local implementation, not using base class)
  private memoryService?: MemoryService;
  private lastMemoryRetrievalAt?: number;
  private injectedMemoryIds = new Set<string>();
  
  // 失败后增量恢复支持
  private toolCallTracker: ToolCallTracker | null = null;
  private failureMemory: FailureMemory | null = null;
  // Track tool_use id -> input for accurate tool_result success/failure attribution
  private readonly toolCallInputs = new Map<string, { toolName: string; input: unknown }>();

  constructor(config: ClaudeAgentSDKBackendConfig) {
    // 调用基类构造函数（不使用基类 Memory，保留本地实现）
    super(undefined, 'ClaudeAgentSDKBackend');
    this.config = config;
    this.toolBridge = new ToolToMCPBridge({
      serverName: 'tachikoma-tools',
      workDir: process.cwd(),
    });
    
    // 初始化 MemoryService
    if (config.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(config.memoryConfig);
      console.debug('[ClaudeAgentSDKBackend] MemoryService initialized');
    }
    
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

    // 创建 AbortController（使用基类执行控制器）
    this.abortController = this.executionController.start();
    this.isExecuting = true;
    const retryPolicy = resolveRetryPolicy(options.retryPolicy);
    const maxRetries = Math.max(0, retryPolicy.maxRetries);
    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...options.resourceLimits,
    };
    this.toolCallsThisRun = 0;
    this.toolCallsInAttempt = 0;
    this.maxToolCallsThisRun = limits.maxToolCalls;
    this.maxTurnsThisRun =
      Number.isFinite(limits.maxThinkingRounds) && limits.maxThinkingRounds > 0
        ? limits.maxThinkingRounds
        : DEFAULT_RESOURCE_LIMITS.maxThinkingRounds;

    // Reset per-task state to avoid cross-task pollution
    // (reset per sessionId or new task)
    this.injectedMemoryIds.clear();
    delete this.lastMemoryRetrievalAt;
    this.resetToolCallGuard();
    this.toolCallInputs.clear();
    
    // Initialize failure tracking systems for incremental recovery
    this.toolCallTracker = new ToolCallTracker({
      maxHistory: 100,
      duplicateWindowMs: 5 * 60 * 1000, // 5 minutes
      blockAfterFailures: 3,
      enableBlocking: true,
    });
    this.failureMemory = new FailureMemory({
      maxPatterns: 50,
      patternWindowMs: 10 * 60 * 1000, // 10 minutes
      minOccurrences: 2,
    });

    // Memory: 自动检索相关记忆 (best-effort)
    const memoryConfig = this.config.memoryConfig;
    const autoRetrieve = memoryConfig?.autoRetrieve !== false;
    const cooldownMs = memoryConfig?.retrievalCooldownMs ?? 10000;
    const now = Date.now();
    const cooldownOk = !this.lastMemoryRetrievalAt || (now - this.lastMemoryRetrievalAt) >= cooldownMs;
    
    let memoryContext = '';
    if (this.memoryService && autoRetrieve && cooldownOk) {
      try {
        console.debug('[ClaudeAgentSDKBackend] Retrieving relevant memories...');
        this.lastMemoryRetrievalAt = now;
        
        const topK = memoryConfig?.topK ?? 5;
        const memoryResult = await this.memoryService.retrieve(task.objective, topK);
        
        // Dedup: filter out already-injected memories
        const newMemories = memoryResult.memories.filter(
          m => !this.injectedMemoryIds.has(m.id)
        );
        
        if (newMemories.length > 0) {
          console.debug(`[ClaudeAgentSDKBackend] Injected ${newMemories.length} memories`);
          for (const m of newMemories) {
            this.injectedMemoryIds.add(m.id);
          }
          // Format memories as context for the prompt
          memoryContext = '\n\n[Relevant Memories]\n' + newMemories
            .map(m => `- ${m.content}`)
            .join('\n');
        }
      } catch (memoryError) {
        console.warn('[ClaudeAgentSDKBackend] Memory retrieval failed (continuing):', memoryError);
      }
    }

    let attempt = 0;
    const projectContextConfig = resolveProjectContextConfig(
      this.config.projectContextConfig
    );
    const skillsManager = createSkillsManager(
      this.config.skillsConfig,
      options.workDir ?? process.cwd(),
      projectContextConfig
    );

    try {
      while (true) {
        this.toolCallsInAttempt = 0;
        this.resetToolCallGuard();

        // Track final result for memory save (output preferred, assistant as fallback)
        let finalResult = '';
        let lastAssistantContent = '';

        try {
          // 发出初始化状态
          yield {
            type: 'status',
            status: 'initializing',
            timestamp: Date.now(),
          };

          // 构建 SDK 配置 (inject memories into systemPrompt, not user prompt)
          const constraintPolicy = deriveConstraintPolicy(task.constraints);
          const sdkOptions = await this.buildSDKOptions(
            tools,
            options,
            task,
            memoryContext,
            skillsManager,
            task.objective,
            task.parentObjective,
            constraintPolicy
          );
            
          const taskPrompt = buildTaskPrompt(task, tools, {
            useNativeToolCalls: true,
            toolDescriptionMode: 'names-only',
          });
          const result = query({
            prompt: taskPrompt,
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
              return;
            }

            // 转换 SDK 消息为统一格式
            const workerMessage = this.transformSDKMessage(sdkMessage);
            if (workerMessage) {
              // Track final result for memory save
              if (workerMessage.type === 'output') {
                finalResult = workerMessage.content;
              } else if (workerMessage.type === 'thinking') {
                // Fallback: track last assistant/thinking content
                lastAssistantContent = workerMessage.content;
              }
              yield workerMessage;
            }
          }

          if (this.abortController.signal.aborted) {
            yield {
              type: 'status',
              status: 'interrupted',
              timestamp: Date.now(),
            };
            return;
          }

          // Use finalResult if available, otherwise fallback to last assistant content
          const resultToSave = finalResult || lastAssistantContent;

          // Memory: 自动保存任务结果 (best-effort)
          const autoSave = memoryConfig?.autoSave !== false;
          if (this.memoryService && autoSave && resultToSave) {
            try {
              console.debug('[ClaudeAgentSDKBackend] Saving task result to memory...');
              await this.memoryService.save({
                content: `Task: ${task.objective}\n\nResult: ${resultToSave}`,
                scope: 'procedural',
                metadata: {
                  sessionId: task.sessionId,
                  taskId: task.id,
                  type: 'task_result',
                  backend: 'claude-agent-sdk',
                },
              });
            } catch (memorySaveError) {
              console.warn('[ClaudeAgentSDKBackend] Memory save failed (continuing):', memorySaveError);
            }
          }

          // 发出完成状态
          yield {
            type: 'status',
            status: 'completed',
            timestamp: Date.now(),
          };
          return;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const isToolLoopError = err.name === 'ToolCallLoopError';
          const isToolBudgetError = err.name === 'ToolCallBudgetExceededError';
          const retryable = isRetryableError(err) && !isToolLoopError && !isToolBudgetError;
          const connectionError = isConnectionError(err);

          const shouldRetry =
            retryable &&
            attempt < maxRetries &&
            this.toolCallsInAttempt === 0 &&
            !this.executionController.isAborted;

          if (!shouldRetry) {
            throw err;
          }

          attempt += 1;
          const delay = calculateRetryDelay(retryPolicy, attempt);
          const actionLabel = connectionError ? 'reconnecting' : 'retrying';
          const retryMessage = `${actionLabel} ${attempt}/${maxRetries}...`;
          console.log(`[ClaudeAgentSDKBackend] ${retryMessage}`);
          yield {
            type: 'status',
            status: 'initializing',
            timestamp: Date.now(),
          };
          yield {
            type: 'thinking',
            content: retryMessage,
            timestamp: Date.now(),
          };

          await new Promise(resolve => setTimeout(resolve, delay));

          if (this.executionController.isAborted) {
            yield {
              type: 'status',
              status: 'interrupted',
              timestamp: Date.now(),
            };
            return;
          }
        }
      }
    } catch (error) {
      const err = error as Error;
      const isToolLoopError = err.name === 'ToolCallLoopError';
      const isToolBudgetError = err.name === 'ToolCallBudgetExceededError';
      const retryable = isRetryableError(err) && !isToolLoopError && !isToolBudgetError;
      const connectionError = isConnectionError(err);
      let errorCode = 'EXECUTION_ERROR';
      if (isToolBudgetError) {
        errorCode = 'MAX_TOOL_CALLS_EXCEEDED';
      } else if (isToolLoopError) {
        errorCode = 'TOOL_CALL_LOOP';
      } else if (connectionError) {
        errorCode = 'CONNECTION_ERROR';
      }
      yield {
        type: 'error',
        error: err.message,
        code: errorCode,
        retryable,
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
      this.executionController.end();
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

    // MCP 工具桥接已实现
    if (this.sdkAvailable === true) {
      implemented.push('mcp-tools');
    }

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
    // Close memory service to release connections (Redis/LevelDB/Vector)
    if (this.memoryService) {
      try {
        await this.memoryService.close();
      } catch {
        // Best-effort close
      }
    }
  }

  /**
   * Abort current execution (sync base controller + SDK controller).
   */
  protected override abortExecution(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    super.abortExecution();
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 构建 SDK 配置选项
   */
  private async buildSDKOptions(
    tools: Tool[],
    options: WorkerExecutionOptions,
    task: WorkerTask,
    memoryContext?: string,
    skillsManager?: SkillsManager,
    taskObjective?: string,
    taskParentObjective?: string,
    constraintPolicy?: ConstraintPolicy
  ): Promise<Record<string, unknown>> {
    const sdkConfig = this.config.sdkOptions || {};

    // 构造 overrides 对象（过滤 undefined 以满足 exactOptionalPropertyTypes）
    const overrides: Partial<Pick<ToolBridgeConfig, 'workDir' | 'env' | 'maxToolInputBytes' | 'constraintPolicy' | 'beforeExecute'>> = {};
    if (options.workDir !== undefined) {
      overrides.workDir = options.workDir;
    }
    if (options.env !== undefined) {
      overrides.env = options.env;
    }
    overrides.maxToolInputBytes =
      options.resourceLimits?.maxToolInputBytes ?? DEFAULT_RESOURCE_LIMITS.maxToolInputBytes;
    if (constraintPolicy) {
      overrides.constraintPolicy = constraintPolicy;
    }
    const doomLoopGuard = this.buildDoomLoopGuard(options, task);
    if (doomLoopGuard) {
      overrides.beforeExecute = doomLoopGuard;
    }

    // 将 Tachikoma 工具转换为 MCP Server（同步等待，保证首轮可用）
    const mcpServers = await this.toolBridge.convertToMCPServers(tools, overrides);

    // Build unified system prompt with memory context (if available)
    // Filter undefined values for exactOptionalPropertyTypes
    const promptOptions: {
      memoryContext?: string;
      extraSystemPrompt?: string;
      identityContext?: string;
      provider?: string;
      model?: string;
    } = {
      provider: this.config.provider,
      model: this.config.model,
    };
    if (memoryContext) promptOptions.memoryContext = memoryContext;
    if (sdkConfig.systemPrompt) promptOptions.extraSystemPrompt = sdkConfig.systemPrompt;

    // Letta-code style: inject identity context right after base prompt (best-effort)
    if (this.config.identityConfig?.enabled !== false) {
      try {
        const agentId = this.config.identityConfig?.agentId ?? getAgentIdFromEnv();
        const updater = new IdentityUpdater(
          this.config.identityConfig?.agentsDir || this.config.identityConfig?.maxFileSize
            ? {
                ...(this.config.identityConfig?.agentsDir && { agentsDir: this.config.identityConfig.agentsDir }),
                ...(this.config.identityConfig?.maxFileSize && { maxFileSize: this.config.identityConfig.maxFileSize }),
              }
            : undefined
        );
        const identityContext = await updater.getCoreMemoryForPrompt(agentId);
        if (identityContext) {
          promptOptions.identityContext = identityContext;
          console.debug('[ClaudeAgentSDKBackend] Injected Identity coreMemory for agent:', agentId);
        }
      } catch (identityError) {
        console.debug('[ClaudeAgentSDKBackend] Identity loading skipped:', identityError);
      }
    }
    
    let systemPrompt = buildWorkerSystemPrompt(promptOptions);
    if (skillsManager) {
      // Pass task objective for skill recommendations with auto-activation
      systemPrompt = await skillsManager.renderSystemPromptSection(
        systemPrompt, 
        taskObjective,
        { 
          autoActivate: true,
          includeProjectContext: true,
          ...(taskParentObjective !== undefined && { parentObjective: taskParentObjective }),
        }
      );
    }
    
    // 注入失败警告到 system prompt（如果有）
    if (this.failureMemory) {
      const failureWarnings = this.failureMemory.generateWarnings();
      if (failureWarnings) {
        systemPrompt = `${systemPrompt}\n\n${failureWarnings}`;
        console.debug('[ClaudeAgentSDKBackend] Injected failure warnings into system prompt');
      }
    }
    // 注入工具调用追踪器警告（如果有重复失败模式）
    if (this.toolCallTracker) {
      const trackerWarning = this.toolCallTracker.generateContextWarning();
      if (trackerWarning) {
        systemPrompt = `${systemPrompt}\n\n${trackerWarning}`;
      }
    }

    return {
      // 工作目录
      cwd: options.workDir,
      // 环境变量
      env: options.env,
      // 权限模式
      permissionMode: sdkConfig.permissionMode || 'bypassPermissions',
      // 额外目录
      additionalDirectories: sdkConfig.additionalDirectories,
      // 系统提示 (with memory context if available)
      systemPrompt: systemPrompt || undefined,
      // 最大回合数（对应 resourceLimits.maxThinkingRounds）
      maxTurns: this.maxTurnsThisRun,
      // AbortController
      abortController: this.abortController,
      // MCP 服务器配置（将工具转换为 MCP 格式）
      mcpServers,
    };
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

      case 'tool_use': {
        const toolName = String(sdkMessage.name || 'unknown');
        const input = sdkMessage.input;
        const callId = String(sdkMessage.id || `call-${timestamp}`);
        this.toolCallInputs.set(callId, { toolName, input });
        
        // 检查是否为重复调用（防循环）
        if (this.toolCallTracker) {
          const duplicateCheck = this.toolCallTracker.checkDuplicate(toolName, input);
          if (duplicateCheck.shouldBlock) {
            console.warn(`[ClaudeAgentSDKBackend] ToolCallTracker would block: ${toolName} (cannot intercept SDK call)`);
          }
        }
        
        this.recordToolCall(toolName, input);
        // 工具调用
        return {
          type: 'tool_call',
          tool: toolName,
          input,
          callId,
          timestamp,
        };
      }

      case 'tool_result': {
        const callId = String(sdkMessage.tool_use_id || sdkMessage.id || `call-${timestamp}`);
        const tracked = this.toolCallInputs.get(callId);
        const toolName = tracked?.toolName ?? String(sdkMessage.name || 'unknown');
        const input = tracked?.input ?? {};
        this.toolCallInputs.delete(callId);

        const resultContent = sdkMessage.content || sdkMessage.output;
        const isErrorFlag = Boolean((sdkMessage as any).is_error);

        // SDK-level is_error only reflects transport/runtime errors, not ToolResult.success=false.
        // Our MCP bridge encodes failures as JSON with { success:false, error: ... }.
        let isSuccess = !isErrorFlag;
        let errorMsg: string | undefined;
        if (typeof resultContent === 'string') {
          try {
            const parsed = JSON.parse(resultContent) as unknown;
            if (
              parsed &&
              typeof parsed === 'object' &&
              (parsed as any).success === false
            ) {
              isSuccess = false;
              const maybeError = (parsed as any).error;
              errorMsg = typeof maybeError === 'string' ? maybeError : 'Tool returned success=false';
            }
          } catch {
            // Non-JSON output (e.g., plain text) -> treat as success unless SDK flagged error.
          }
        }
        if (!isSuccess && !errorMsg) {
          errorMsg =
            typeof resultContent === 'string'
              ? resultContent
              : JSON.stringify(resultContent);
        }
        
        // 记录工具调用结果到追踪器
        if (!isSuccess) {
          this.failureMemory?.recordFailure(toolName, input, errorMsg ?? 'Tool failed');
          this.toolCallTracker?.record(toolName, input, false, errorMsg);
        } else {
          this.toolCallTracker?.record(toolName, input, true);
        }
        
        // 工具结果
        return {
          type: 'tool_result',
          tool: toolName,
          callId,
          result: resultContent,
          success: isSuccess,
          duration: 0, // SDK 不提供持续时间
          timestamp,
        };
      }

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
   * 记录工具调用并应用预算/去重守卫
   */
  private recordToolCall(toolName: string, input: unknown): void {
    if (this.toolCallsThisRun >= this.maxToolCallsThisRun) {
      const message = `Max tool calls (${this.maxToolCallsThisRun}) exceeded before executing "${toolName}".`;
      this.abortExecution();
      throw new ToolCallBudgetExceededError(message);
    }
    this.toolCallsThisRun += 1;
    this.toolCallsInAttempt += 1;
    this.guardAgainstRepeatedToolCall(toolName, input);
  }

  private buildDoomLoopGuard(
    options: WorkerExecutionOptions,
    task: WorkerTask
  ): ToolBridgeConfig['beforeExecute'] | undefined {
    if (!this.toolCallTracker) return undefined;
    const policy = {
      ...DEFAULT_DOOM_LOOP_POLICY,
      ...(options.doomLoopPolicy ?? {}),
    };
    if (!policy.enabled) return undefined;

    return async (toolName, args) => {
      if (!this.toolCallTracker) return { allowed: true };
      const decision = await this.checkDoomLoopAndApprove({
        tracker: this.toolCallTracker,
        toolName,
        args,
        options,
        taskId: task.id,
      });
      if (decision.allowed) return { allowed: true };
      return { allowed: false, message: decision.message };
    };
  }
}
