/**
 * 通用 Agent 后端
 *
 * 自研的通用后端实现，支持任意 LLM（OpenAI、Gemini 等）
 * 通过 LLMClient + Sandbox 实现工具调用循环
 */

import type {
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerStatus,
  WorkerTask,
  WorkerExecutionOptions,
  GenericBackendConfig,
  WorkerApprovalRequestMessage,
  WorkerErrorMessage,
} from '../types';
import { BaseWorkerBackend } from './base-backend';
import { 
  DEFAULT_RESOURCE_LIMITS, 
  DEFAULT_PARALLEL_EXECUTION_CONFIG,
} from '../types';
import type { Tool, ExecutionContext } from '../../types';
import type { LLMClient, LLMRequest } from '../../planner/types';
import type { Sandbox, SandboxConfig } from '../../sandbox';
import { createLLMClient } from '../../planner/llm-client';
import { createLocalSandbox } from '../../sandbox/drivers/local';
import { createSandboxConfig } from '../../sandbox/types';
import { globalToolRegistry } from '../../tools/registry';
import {
  createSandboxToolExecutor,
  type ISandboxToolExecutor,
} from '../../sandbox/tool-executor';
import { isKeyDecisionAsync } from '../key-decision';
import { buildWorkerSystemPrompt } from '../prompts/system-prompt';
import { buildTaskPrompt } from '../prompts/task-prompt';
// Prompt 上下文工程模块（内部）
import {
  createPromptContextEngine,
  createDefaultPromptConfig,
  type PromptContextEngineDependencies,
  type PromptContextEngine,
  DEFAULT_PROJECT_CONTEXT_CONFIG,
} from '../../prompt';

// Memory 模块
import { MemoryService } from '../../memory';
// Collaboration 模块
import { CollaborationManager, createPeerAssistTool } from '../../collaboration';
import type { Tool as CollaborationTool } from '../../types';
import {
  ProgressTracker,
  simpleHash,
  type ParsedToolCall,
  parseToolCalls,
  parseFunctionCalls,
  containsToolCall,
  classifyToolCalls,
  // Context Helpers
  createUserMessage,
  createAssistantMessage,
  createToolMessage,
  contextToLLMMessages,
  // Memory
  createMemoryRetriever,
  type MemoryRetriever,
  // Tool Executor
  executeParallel,
  executeSequentialGenerator,
  filterApprovalRequired,
  type ToolExecutorCallbacks,
  type ToolExecutionResult,
  type ToolExecutorEvent,
  checkToolInputSize,
  checkToolCallAgainstConstraints,
  deriveConstraintPolicy,
  type ConstraintPolicy,
  // Tool Schema
  convertToolsToAITools,
  // LLM Executor
  type LLMExecutor,
  createLLMExecutor,
  isRetryableError,
  type LLMExecutorConfig,
  // SkillsManager
  type SkillsManager,
  createSkillsManager,
  // Interaction Engine
  InteractionEngine,
} from '../engines';

// 工具调用追踪器（防循环）
import { ToolCallTracker } from '../tool-call-tracker';

// 失败记忆系统（上下文注入）
import { FailureMemory } from '../failure-memory';

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认系统提示
 */
const DEFAULT_SYSTEM_PROMPT = buildWorkerSystemPrompt();

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
// 上下文辅助函数现已从 ../engines/context-helpers.ts 模块导入
// 参见: src/worker/engines/context-helpers.ts
// ============================================================================

// ============================================================================
// 进度追踪器、工具调用解析、分类器现已从 ../engines 模块导入
// 参见: src/worker/engines/progress-tracker.ts
// 参见: src/worker/engines/tool-call-parser.ts
// ============================================================================






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
export class GenericAgentBackend extends BaseWorkerBackend {
  readonly provider: string;
  readonly backendType: WorkerBackendType = 'generic';

  private readonly config: GenericBackendConfig;
  private llmClient: LLMClient;
  private sandbox: Sandbox | null = null;
  private sandboxOwned = false; // 是否由本实例拥有（负责销毁）
  private memoryRetriever: MemoryRetriever;
  private llmExecutor: LLMExecutor;
  private skillsManager: SkillsManager;
  private interactionEngine: InteractionEngine;
  private abortController: AbortController | null = null;
  private isExecuting = false;
  private sandboxNeedsInit = false; // 是否需要初始化
  private constraintPolicy: ConstraintPolicy | null = null;
  
  // 失败后增量恢复支持
  private toolCallTracker: ToolCallTracker | null = null;
  private failureMemory: FailureMemory | null = null;
  
  // Collaboration 支持
  private collaborationManager?: CollaborationManager;
  private peerAssistTool?: CollaborationTool;
  private collaborationAgentId?: string;
  /** 协作请求处理器引用（用于取消注册） */
  private collaborationRequestHandlerRegistered = false;

  constructor(config: GenericBackendConfig) {
    // 调用基类构造函数（不使用基类 Memory，保留本地实现）
    super(undefined, 'GenericAgentBackend');
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

    // 初始化 Memory Retriever
    // 实例化 MemoryService 用于传给 Retriever (config 中包含 connection options 等)
    // 注意: MemoryService 可能需要 config.memoryConfig
    const memoryService = config.memoryConfig?.enabled ? new MemoryService(config.memoryConfig) : undefined;
    this.memoryRetriever = createMemoryRetriever(memoryService, config.memoryConfig);
    
    // 初始化 LLM Executor
    const llmExecutorConfig: LLMExecutorConfig = {
      maxRetries: 3, // Default hardcoded in original
    };
    this.llmExecutor = createLLMExecutor(this.llmClient, llmExecutorConfig);

    // 初始化 Skills Manager
    this.skillsManager = createSkillsManager(
      config.skillsConfig, 
      config.workDir ?? process.cwd(),
      { ...DEFAULT_PROJECT_CONTEXT_CONFIG, enabled: true }
    );

    this.interactionEngine = new InteractionEngine();

    // 初始化协作管理器
    if (config.collaborationConfig?.enabled) {
      const collabConfig = config.collaborationConfig;
      // 使用 .tachikoma 作为默认 rootDir，与 Orchestrator 保持一致
      this.collaborationManager = new CollaborationManager({
        backend: collabConfig.backend ?? 'file',
        rootDir: collabConfig.rootDir ?? '.tachikoma',
        ...(collabConfig.redis && { redis: collabConfig.redis }),
      });
      // 固定 agentId：避免每次任务启动生成不同 ID（影响 peer 发现与路由）
      this.collaborationAgentId = this.sanitizeAgentId(
        collabConfig.agentId ?? `worker-${this.provider}-${Date.now()}`
      );
      console.debug('[GenericAgentBackend] CollaborationManager created');
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
   * 清理 agentId，防止路径逃逸攻击
   * 
   * 仅保留 [a-zA-Z0-9_-]，其他字符替换为 _
   */
  private sanitizeAgentId(agentId: string): string {
    return agentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }

  /**
   * 执行任务
   */
  async *execute(
    task: WorkerTask,
    providedTools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage> {
    // 创建 AbortController
    this.abortController = new AbortController();
    this.interactionEngine.setAbortController(this.abortController);
    this.isExecuting = true;

    // Reset memory state for new task (avoid cross-task dedup interference)
    this.memoryRetriever.reset();
    this.constraintPolicy = deriveConstraintPolicy(task.constraints);
    
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

    // 确保 Sandbox 已初始化（如果使用自动创建）
    await this.ensureSandboxInitialized();

    // 构建审批用执行上下文（每个任务只初始化一次）
    const approvalContext = this.buildExecutionContext(task, options);

    // 启动协作管理器并注入 peer-assist 工具（仅首次执行时启动）
    let tools = providedTools;
    if (this.collaborationManager && this.config.collaborationConfig?.enabled) {
      // 只在未启动时启动，避免 "already started" 错误
      if (!this.collaborationManager.isStarted()) {
        const collabConfig = this.config.collaborationConfig;
        const agentId = this.collaborationAgentId ?? this.sanitizeAgentId(
          collabConfig.agentId ?? `worker-${this.provider}-${Date.now()}`
        );
        
        try {
          await this.collaborationManager.start(agentId, {
            sessionId: collabConfig.sessionId ?? task.sessionId ?? 'default',
            type: 'worker',
            capabilities: collabConfig.capabilities ?? ['general'],
            status: 'online',
            priority: collabConfig.priority ?? 5,
          });
          console.debug('[GenericAgentBackend] Collaboration started');
        } catch (error) {
          console.warn('[GenericAgentBackend] Failed to start collaboration:', error);
        }
      }
      
      // 注入 peer-assist 工具（每次执行都注入，因为 tools 是参数）
      if (this.collaborationManager.isStarted()) {
        if (!this.peerAssistTool) {
          this.peerAssistTool = createPeerAssistTool(this.collaborationManager);
        }
        const hasPeerAssist = providedTools.some((t) => t.name === this.peerAssistTool!.name);
        tools = hasPeerAssist ? providedTools : [...providedTools, this.peerAssistTool];
        
        // 注册请求处理器（仅注册一次）
        if (!this.collaborationRequestHandlerRegistered) {
          this.registerCollaborationHandler();
          this.collaborationRequestHandlerRegistered = true;
        }

        // 更新协作注册状态为 busy（P1: 状态同步）
        try {
          await this.collaborationManager.updateStatus('busy');
        } catch {
          console.debug('[GenericAgentBackend] Failed to update collaboration status to busy');
        }
      }
    }


    // 发出初始化状态
    yield {
      type: 'status',
      status: 'initializing',
      timestamp: Date.now(),
    };

    // Ensure skills are refreshed per task (logs loaded skills)
    this.skillsManager.reload();

    // 构建资源限制
    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...options.resourceLimits,
    };

    // 统一工作目录：用于 Prompt 默认配置、项目上下文加载等
    const workDir = options.workDir ?? this.config.workDir ?? process.cwd();

    // 创建 PromptContextEngine（使用资源限制）
    // 将 maxMessageWindow 映射到 PromptConfig 阈值
    let contextConfig = this.config.promptConfig 
      ?? createDefaultPromptConfig(workDir);
    
    // 如果没有显式配置，根据 maxMessageWindow 估算阈值
    // 假设平均每条消息 ~2000 tokens
    if (!this.config.promptConfig && limits.maxMessageWindow) {
      const estimatedSoftLimit = limits.maxMessageWindow * 2000;
      contextConfig = {
        ...contextConfig,
        thresholds: {
          ...contextConfig.thresholds,
          softLimit: Math.min(estimatedSoftLimit, contextConfig.thresholds.softLimit),
          hardLimit: Math.min(estimatedSoftLimit * 1.2, contextConfig.thresholds.hardLimit),
        },
      };
    }
    
    const contextDeps: PromptContextEngineDependencies = {};
    const context = createPromptContextEngine(contextConfig, contextDeps);
    let totalTokensUsed = 0;
    const maxTotalTokens = limits.maxTotalTokens;
    const recordTokenUsage = (input: number, output: number) => { totalTokensUsed += input + output; };
    const isOverBudget = () => totalTokensUsed >= maxTotalTokens;
    
    // 日志记录 context 配置
    console.debug('[GenericAgentBackend] Context initialized', {
      softLimit: contextConfig.thresholds.softLimit,
      hardLimit: contextConfig.thresholds.hardLimit,
      hasCustomEstimator: !!contextConfig.tokenEstimator,
    });
    
    // 添加任务目标到 todo
    context.addTodo(task.objective);

    // 注入项目上下文（TACHIKOMA.md 等）
    // 注意：必须在 addMessage(user) 之前调用，确保 system 消息在前
    try {
      const injectedMessages = await this.skillsManager.injectProjectContext([], workDir);
      const projectMessage = injectedMessages.find((m) => m.id === 'project-context');
      if (projectMessage) {
        context.addMessage(projectMessage);
        console.debug('[GenericAgentBackend] Injected project context from:', workDir);
      }
    } catch (projectError) {
      console.debug('[GenericAgentBackend] No project context found (continuing):', projectError);
    }

    // 构建工具描述与原生工具集（Function Calling）
    const nativeToolSet = convertToolsToAITools(tools);
    const useNativeToolCalls = Object.keys(nativeToolSet).length > 0;

    // 初始用户消息
    const taskPrompt = buildTaskPrompt(task, tools, { useNativeToolCalls });
    context.addMessage(createUserMessage(taskPrompt));

    // 构建带 Skills 的 system prompt（缓存，避免每轮重建）
    // Pass task objective for skill recommendations with auto-activation
    const systemPromptWithSkills = await this.skillsManager.renderSystemPromptSection(
      DEFAULT_SYSTEM_PROMPT,
      task.objective,
      { autoActivate: true, ...(task.parentObjective !== undefined && { parentObjective: task.parentObjective }) }
    );

	    let finalStatus: WorkerStatus = 'failed';
	    try {
	      let round = 0;
	      let done = false;
	      let totalToolCalls = 0;
      
      // 创建进度追踪器
      const progressTracker = new ProgressTracker();
      
      // 追踪最后一轮未执行的工具调用（用于 grace round）
      let pendingToolCalls: ParsedToolCall[] = [];

	      while (!done && round < limits.maxThinkingRounds) {
	        round++;

	        // 检查是否已中断
	        if (this.abortController.signal.aborted) {
	          finalStatus = 'interrupted';
	          done = true;
	          break;
	        }

        // 检查 intervention（每轮开始时）
        // eslint-disable-next-line no-await-in-loop -- Intervention check is intentionally sequential
	        const interventionResult = await this.checkAndHandleIntervention(options);
	        if (interventionResult === 'abort') {
	          finalStatus = 'interrupted';
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

        // Task 8: Context Compaction
        const contextConfig = await this.manageContext(context);
        if (!contextConfig.success) {
           yield contextConfig.error!;
           finalStatus = 'failed';
           done = true;
           break;
        }

        // Memory: 自动检索相关记忆 (best-effort, 不中断主循环)
        try {
          // MemoryRetriever handles cooldown and autoRetrieve checks
          await this.memoryRetriever.retrieve({
            getContext: () => context.getContext(),
            getRetrievalContext: () => context.getRetrievalContext(),
            shouldRetrieveMemories: () => context.shouldRetrieveMemories(),
            injectRetrievedMemories: (memories) => {
              context.injectRetrievedMemories(memories);
              console.debug(`[GenericAgentBackend] Injected ${memories.length} memories`);
            }
          });
        } catch (memoryError) {
          console.warn('[GenericAgentBackend] Memory retrieval failed (continuing):', memoryError);
        }

        // 生成失败警告并注入 system prompt（如果有）
        let effectiveSystemPrompt = systemPromptWithSkills;
        if (this.failureMemory) {
          const failureWarnings = this.failureMemory.generateWarnings();
          if (failureWarnings) {
            effectiveSystemPrompt = `${systemPromptWithSkills}\n\n${failureWarnings}`;
            console.debug('[GenericAgentBackend] Injected failure warnings into system prompt');
          }
        }
        // 注入工具调用追踪器警告（如果有重复失败模式）
        if (this.toolCallTracker) {
          const trackerWarning = this.toolCallTracker.generateContextWarning();
          if (trackerWarning) {
            effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${trackerWarning}`;
          }
        }

        // 调用 LLM
        const request: LLMRequest = {
          systemPrompt: effectiveSystemPrompt,
          messages: contextToLLMMessages(context.getContext()),
          maxTokens: Math.min(
            this.config.maxTokens ?? 4096,
            limits.maxTokensPerCall
          ),
          temperature: this.config.temperature ?? 0.3,
          abortSignal: this.abortController.signal,
          ...(useNativeToolCalls ? { tools: nativeToolSet, toolChoice: 'auto' } : {}),
        };

        // LLM 调用（由 LLMExecutor 处理重试）
        // eslint-disable-next-line no-await-in-loop
        const response = await this.llmExecutor.executeWithRetry(request);

        // 记录 token 使用量
	        recordTokenUsage(
	          response.usage.inputTokens,
	          response.usage.outputTokens
	        );

	        // Budget check: if total token budget is exceeded, terminate.
	        // Context reduction cannot "refund" already spent tokens.
	        if (isOverBudget()) {
	          const msg = `Total token budget exceeded (${totalTokensUsed}/${maxTotalTokens}). Terminating execution.`;
	          console.warn(`[GenericAgentBackend] ${msg}`);
	          yield {
	            type: 'error',
	            error: msg,
	            code: 'TOKEN_BUDGET_EXCEEDED',
	            retryable: false,
	            timestamp: Date.now(),
	          };
	          finalStatus = 'failed';
	          done = true;
	          break;
	        }

	        const normalizedContent = response.content?.trim() ?? '';

	        // 发出思考消息（无文本则跳过）
	        if (normalizedContent) {
	          yield {
	            type: 'thinking',
	            content: response.content,
	            timestamp: Date.now(),
	          };
	          // 添加到上下文
	          context.addMessage(createAssistantMessage(response.content));
	        }

        // 追踪本轮进度
        const nativeToolCalls = response.toolCalls
          ? parseFunctionCalls(response.toolCalls)
          : [];
        const hasNativeToolCalls = nativeToolCalls.length > 0;
        const hasToolCallMarker = !hasNativeToolCalls && containsToolCall(response.content);
        const toolCalls = hasNativeToolCalls
          ? nativeToolCalls
          : hasToolCallMarker
            ? parseToolCalls(response.content)
            : [];
        const toolCallsParseFailed = !hasNativeToolCalls && hasToolCallMarker && toolCalls.length === 0;
        let toolCallsSucceeded = 0;
        
        // 更新待执行工具调用（用于检测 loop 提前终止时是否有未执行的调用）
        pendingToolCalls = toolCalls;

        // 检查是否有工具调用
        if (toolCalls.length > 0) {
          
          // 清空待执行队列（即将执行）
          pendingToolCalls = [];

          // 获取执行器回调
          const callbacks = this.createToolExecutorCallbacks(tools, options, approvalContext);

          // 获取并行执行配置
          const parallelConfig = options.parallelExecution ?? DEFAULT_PARALLEL_EXECUTION_CONFIG;
          
          // 分类工具调用
          const { parallel, sequential } = parallelConfig.enabled 
            ? classifyToolCalls(toolCalls, parallelConfig)
            : { parallel: [], sequential: toolCalls };

          console.debug(
            `[GenericAgentBackend] Tool call classification: ` +
            `${parallel.length} parallel, ${sequential.length} sequential ` +
            `(parallelEnabled=${parallelConfig.enabled})`
          );

          // =============================================
          // 阶段 1: 并行执行可并行工具
          // =============================================
          if (parallel.length > 0) {
            // 过滤需要审批的工具
            const { safe, needsApproval } = await filterApprovalRequired(parallel, callbacks);
            
            if (needsApproval.length > 0) {
              console.debug(
                `[GenericAgentBackend] ${needsApproval.length} calls moved to sequential queue (requires approval)`
              );
              sequential.push(...needsApproval);
            }

            if (safe.length > 0) {
              // 1. 发出所有 tool_call 消息
              for (const call of safe) {
                yield {
                  type: 'tool_call',
                  tool: call.name,
                  input: call.input,
                  callId: call.callId,
                  timestamp: Date.now(),
                };
              }

              yield {
                type: 'status',
                status: 'acting',
                timestamp: Date.now(),
              };

              // 2. 执行工具
              const parallelResults = await executeParallel(
                safe, 
                callbacks, 
                parallelConfig.maxConcurrency
              );

              // 3. 处理结果
              for (const { call, result, duration } of parallelResults) {
                totalToolCalls++;
                if (result.success) toolCallsSucceeded++;

                context.addMessage(createToolMessage(call.callId, JSON.stringify(result.output)));

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

              // 检查工具调用次数限制
              if (totalToolCalls >= limits.maxToolCalls) {
                yield {
                  type: 'error',
                  error: `Max tool calls (${limits.maxToolCalls}) exceeded`,
                  code: 'MAX_TOOL_CALLS_EXCEEDED',
                  retryable: false,
                  timestamp: Date.now(),
                };
                finalStatus = 'failed';
                done = true;
                continue; // 跳过后续顺序执行
              }
            }
          }

          // =============================================
          // 阶段 2: 顺序执行
          // =============================================
          if (sequential.length > 0) {
            const iterator = executeSequentialGenerator(sequential, callbacks, {
              maxToolCalls: limits.maxToolCalls,
              currentToolCount: totalToolCalls
            });

            // Delegate events handling to helper
            const eventHandler = this.handleToolExecutionEvents(
               iterator, 
               context, 
               options, 
               limits, 
               task.id, 
               totalToolCalls
            );

            const handlerResult = yield* eventHandler;
            
            // Update stats
            totalToolCalls += handlerResult.totalCalled; // Only add count of this batch
            if (handlerResult.succeeded > 0) {
               // Update local success count if needed, though mostly used for final logging?
               // GenericAgentBackend doesn't seem to use toolCallsSucceeded for logic, mostly logging/metrics.
               toolCallsSucceeded += handlerResult.succeeded;
            }

            if (handlerResult.done) {
               finalStatus = handlerResult.finalStatus!;
               done = true;
               // Wait, manual loop also handled `break`.
               break; 
            }
          }
        } else if (toolCallsParseFailed) {
          // 工具调用标记存在但解析失败 — 可能是 LLM 输出被截断
          console.warn(
            '[GenericAgentBackend] Tool call marker detected but parsing failed. ' +
            'This may indicate truncated LLM output. Adding feedback for retry.'
          );
          
          // Add error feedback to context prompting LLM to retry with complete output
          const truncationFeedback = 
            '[System] Your previous response contained a tool call, but the output was incomplete/truncated and could not be parsed. ' +
            'Please output the complete tool call again. If the tool parameters are too long (e.g., large CSS code), ' +
            'try splitting into multiple calls, modifying a small portion each time.';
          context.addMessage(createUserMessage(truncationFeedback));
          
          // 不标记为完成，让循环继续
          // done = false (保持默认)
        } else {
          // 没有工具调用，任务完成
          done = true;

          // Memory: 自动保存任务结果 (best-effort, 不中断主循环)
          // Memory: 自动保存任务结果 (best-effort, 不中断主循环)
          try {
            // eslint-disable-next-line no-await-in-loop
            await this.memoryRetriever.save(
              `Task: ${task.objective}\n\nResult: ${response.content}`, 
              {
                sessionId: task.sessionId,
                taskId: task.id,
                type: 'task_result',
              }
            );
          } catch (memorySaveError) {
            console.warn('[GenericAgentBackend] Memory save failed (continuing):', memorySaveError);
          }

          yield {
            type: 'output',
            content: response.content,
            timestamp: Date.now(),
          };
        }

        // 记录本轮进度
        // 计算工具调用 hash 用于检测重复调用
        const toolCallFingerprint = toolCalls.length > 0
          ? toolCalls.map(c => `${c.name}:${JSON.stringify(c.input)}`).join('|')
          : '';
        const toolCallHash = toolCallFingerprint ? simpleHash(toolCallFingerprint) : undefined;
        
        // 收集工具名称列表（用于增强检测）
        const toolNames = toolCalls.length > 0
          ? toolCalls.map(c => c.name)
          : undefined;
        
        const outputBasis = normalizedContent
          || (toolCallFingerprint || response.content);

        // 收集工具结果模式（基于响应内容或工具调用的前 200 字符 hash）
        // 注意：这里使用 outputBasis 作为粗略的模式指纹
        // 如果需要更精确，可以在工具执行时收集每个工具的输出
        const toolResultPatterns = toolCalls.length > 0
          ? [simpleHash(outputBasis.slice(0, 200))]
          : undefined;
        
        progressTracker.recordRound({
          round,
          stopReason: response.stopReason ?? 'unknown',
          toolCallsAttempted: toolCalls.length,
          toolCallsSucceeded,
          toolCallsParseFailed,
          outputHash: simpleHash(outputBasis),
          ...(toolCallHash && { toolCallHash }),
          ...(toolNames && { toolNames }),
          ...(toolResultPatterns && { toolResultPatterns }),
        });

        // 检查是否需要降级策略
        if (progressTracker.shouldDegradeStrategy()) {
          const degradationLevel = progressTracker.getDegradationLevel();
          const degradationMessage = progressTracker.getDegradationMessage();
          
          console.warn(
            `[GenericAgentBackend] Strategy degradation triggered. Level: ${degradationLevel}, ` +
            `noProgressCount: ${progressTracker.getNoProgressCount()}`
          );
          
          // Level 3: 强制终止
	          if (degradationLevel >= 3) {
	            yield {
	              type: 'error',
	              error: `Task stuck: no progress after ${progressTracker.getNoProgressCount()} rounds. ` +
	                     `Consider breaking down the task into smaller subtasks.`,
	              code: 'NO_PROGRESS_TERMINATION',
	              retryable: false,
	              timestamp: Date.now(),
	            };
	            finalStatus = 'failed';
	            done = true;
	            break;
	          }
          
          // Level 1-2: 注入降级提示
          if (degradationMessage) {
            context.addMessage(createUserMessage(degradationMessage));
          }
        }

	        // 检查停止原因
	        if (response.stopReason === 'stop' && toolCalls.length === 0) {
	          console.debug('[GenericAgentBackend] Loop stop: reason is stop and no tool call');
	          finalStatus = 'completed';
	          done = true;
	        } else {
          console.debug(
            `[GenericAgentBackend] Loop check: stopReason=${response.stopReason}, ` +
            `containsToolCall=${hasToolCallMarker}, toolCallsParsed=${toolCalls.length}, ` +
            `toolCallsSucceeded=${toolCallsSucceeded}`
          );
        }
      }

      console.debug(`[GenericAgentBackend] Loop finished. done=${done}, round=${round}, maxRounds=${limits.maxThinkingRounds}`);

      // =========================================================================
      // Grace Round: 执行最后一批未完成的工具调用
      // =========================================================================
      // 当 loop 因 maxThinkingRounds 终止但最后一轮 LLM 响应包含工具调用时，
      // 这些调用会被记录到 thinking.jsonl 但不会执行（因为循环已经退出）。
      // 这里添加一个 "grace round"，确保最后一批工具调用被执行。
      //
      // 安全策略：
      // - 保留关键决策审批流程（不绕过审批）
      // - 检查 token 预算和 maxToolCalls 限制
      // - 追踪成功/失败状态
      
	      if (pendingToolCalls.length > 0 && !done) {
	        // 检查 token 预算是否已超出
	        if (isOverBudget()) {
	          console.warn(
	            `[GenericAgentBackend] Grace round skipped: token budget exceeded ` +
	            `(${totalTokensUsed}/${maxTotalTokens}). ${pendingToolCalls.length} tool calls not executed.`
	          );
	          yield {
	            type: 'error',
	            error: `Grace round skipped: token budget exceeded. ${pendingToolCalls.length} pending tool calls not executed.`,
	            code: 'GRACE_ROUND_BUDGET_EXCEEDED',
	            retryable: false,
	            timestamp: Date.now(),
	          };
	          finalStatus = 'failed';
	        } else {
	          console.warn(
	            `[GenericAgentBackend] Grace round: executing ${pendingToolCalls.length} pending tool calls ` +
	            `that were parsed but not executed due to loop termination.`
	          );
	          
	          yield {
	            type: 'thinking',
	            content: `[Grace Round] Executing ${pendingToolCalls.length} pending tool call(s) before completing...`,
	            timestamp: Date.now(),
	          };

            const graceCallbacks = this.createToolExecutorCallbacks(tools, options, approvalContext);
            const iterator = executeSequentialGenerator(pendingToolCalls, graceCallbacks, {
              maxToolCalls: limits.maxToolCalls,
              currentToolCount: totalToolCalls
            });

            const eventHandler = this.handleToolExecutionEvents(
               iterator, 
               context, 
               options, 
               limits, 
               task.id, 
               totalToolCalls
            );

            const graceResult = yield* eventHandler;
            
            totalToolCalls += graceResult.totalCalled;
            
            if (graceResult.succeeded > 0) {
               const failures = graceResult.totalCalled - graceResult.succeeded;
               
               if (failures === 0) {
                 done = true;
                 finalStatus = 'completed';
                 console.debug(`[GenericAgentBackend] Grace round completed successfully. ${graceResult.succeeded} tools executed.`);
               } else {
                 done = true;
                 finalStatus = 'failed';
                 console.warn(
                    `[GenericAgentBackend] Grace round partially succeeded. ` +
                    `${graceResult.succeeded} succeeded, ${failures} failed.`
                 );
                 yield {
                    type: 'error',
                    error: `Grace round partially succeeded: ${graceResult.succeeded} succeeded, ${failures} failed.`,
                    code: 'GRACE_ROUND_PARTIAL_SUCCESS',
                    retryable: false,
                    timestamp: Date.now(),
                 };
               }
            } else {
               // 全部失败
               console.error(`[GenericAgentBackend] Grace round failed. All ${graceResult.totalCalled} tool calls failed.`);
               yield {
                  type: 'error',
                  error: `Grace round failed: all ${graceResult.totalCalled} tool calls failed.`,
                  code: 'GRACE_ROUND_FAILED',
                  retryable: false,
                  timestamp: Date.now(),
               };
               finalStatus = 'failed';
            }
	        }
	      }

	      // 如果达到最大轮次，发出警告（但如果 grace round 成功执行了，不算失败）
	      if (round >= limits.maxThinkingRounds && !done) {
	        yield {
	          type: 'error',
	          error: `Max thinking rounds (${limits.maxThinkingRounds}) exceeded`,
	          code: 'MAX_ROUNDS_EXCEEDED',
	          retryable: false,
	          timestamp: Date.now(),
	        };
	        finalStatus = 'failed';
	      }
	    } catch (error) {
	      const err = error as Error;
	      console.error('[GenericAgentBackend] Execution error:', err);
	      yield {
	        type: 'error',
	        error: err.message,
          // 使用 engines 的 isRetryableError 工具函数
          code: 'TOOL_EXECUTION_ERROR',
          retryable: isRetryableError(err),
          timestamp: Date.now(),
        };
	      finalStatus = 'failed';
	    } finally {
	      this.isExecuting = false;
	      this.abortController = null;
	      this.constraintPolicy = null;

	      // 更新协作注册状态回 online（P1: 状态同步）
	      if (this.collaborationManager?.isStarted()) {
	        try {
	          await this.collaborationManager.updateStatus('online');
	        } catch {
	          console.debug('[GenericAgentBackend] Failed to update collaboration status to online');
	        }
	      }
	    }

	    // Emit final status once, consistently.
	    yield {
	      type: 'status',
	      status: finalStatus,
	      timestamp: Date.now(),
	      tokensUsed: totalTokensUsed,
	    };
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
    // 停止协作管理器
    if (this.collaborationManager) {
      await this.collaborationManager.stop();
    }
    // 关闭 MemoryRetriever（释放底层连接/句柄）
    await this.memoryRetriever.close();
    // 仅销毁自己创建的 sandbox
    if (this.sandbox && this.sandboxOwned) {
      await this.sandbox.destroy();
      this.sandbox = null;
    }
    // 重置协作处理器注册状态
    this.collaborationRequestHandlerRegistered = false;
  }

  /**
   * 注册协作请求处理器
   * 
   * 当其他 Agent 发起协作请求时，此处理器会被调用。
   *
   * 当前协作能力定位为“路由/发现”（由 Orchestrator 返回 targetWorkerId 供调用方协调），
   * Worker 不直接处理协作请求，避免出现“接受但不执行”的假阳性响应。
   */
  private registerCollaborationHandler(): void {
    if (!this.collaborationManager) return;

    this.collaborationManager.onRequest(async (request) => {
      console.debug(`[GenericAgentBackend] Collaboration request rejected: ${request.id}`);
      return {
        success: false,
        error: 'Worker does not handle collaboration requests directly. Route via orchestrator and coordinate externally.',
        payload: {
          workerId: this.collaborationAgentId,
          requestId: request.id,
          type: request.type,
        },
      };
    });
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 执行工具
   */

  /**
   * Handle Tool Execution Events (Generator Loop)
   */
  private async *handleToolExecutionEvents(
    iterator: AsyncGenerator<ToolExecutorEvent, { results: ToolExecutionResult[]; terminated: boolean; terminateReason?: string }, boolean | undefined>,
    context: PromptContextEngine,
    options: WorkerExecutionOptions,
    limits: { maxToolCalls: number },
    taskId: string,
    initialToolCount = 0
  ): AsyncGenerator<WorkerMessage, { done: boolean; finalStatus?: WorkerStatus; totalCalled: number; succeeded: number }, void> {
    let nextValue: boolean | undefined = undefined;
    let toolCallsSucceeded = 0;
    let totalCalled = 0;
    // Use initialToolCount to offset any internal limits logic if we were checking inside loop, 
    // but here limits are passed to executeSequentialGenerator. Just for logging?
    // We suppress unused warning:
    void initialToolCount;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done: genDone } = await iterator.next(nextValue);
      
      if (genDone) {
         const { terminated, terminateReason, results } = value;
         
         for (const res of results) {
            if (res.result.success) toolCallsSucceeded++;
         }
         totalCalled = results.length;

         if (terminated) {
           if (terminateReason === 'max_tool_calls_exceeded') {
              yield {
                type: 'error',
                error: `Max tool calls (${limits.maxToolCalls}) exceeded`,
                code: 'MAX_TOOL_CALLS_EXCEEDED',
                retryable: false,
                timestamp: Date.now(),
              };
              return { done: true, finalStatus: 'failed', totalCalled, succeeded: toolCallsSucceeded };
           } else if (terminateReason === 'terminate_subtask') {
              console.debug('[GenericAgentBackend] Subtask terminated by tool');
              return { done: true, finalStatus: 'completed', totalCalled, succeeded: toolCallsSucceeded };
           } else if (terminateReason === 'aborted') {
              return { done: true, finalStatus: 'interrupted', totalCalled, succeeded: toolCallsSucceeded };
           }
         }
         return { done: false, totalCalled, succeeded: toolCallsSucceeded };
      }

      // Handle Events
      const event = value;
      nextValue = undefined; // Reset

      if (event.type === 'tool_start') {
        yield {
          type: 'tool_call',
          tool: event.call.name,
          input: event.call.input,
          callId: event.call.callId,
          timestamp: Date.now(),
        };
        yield { type: 'status', status: 'acting', timestamp: Date.now() };
      
      } else if (event.type === 'tool_result') {
         context.addMessage(createToolMessage(
           event.result.call.callId, 
           JSON.stringify(event.result.result.output)
         ));
         
         yield {
            type: 'tool_result',
            tool: event.result.call.name,
            callId: event.result.call.callId,
            result: event.result.result.output,
            success: event.result.result.success,
            duration: event.result.duration,
            timestamp: Date.now(),
         };

      } else if (event.type === 'approval_required') {
         const approvalRequest: WorkerApprovalRequestMessage = {
            type: 'approval_request',
            requestId: `approval-${event.call.callId}`,
            action: event.call.name,
            description: `${event.reason}: ${event.call.name}`,
            details: { tool: event.call.name, input: event.call.input },
            timestamp: Date.now(),
            category: 'key_decision', // Default to key_decision
         };
         // Fill defaults using option extraction logic if needed, simplify for now or duplicate logic?
         // Duplicate logic for defaults:
         const fullReq = {
            ...approvalRequest,
            category: 'key_decision',
            defaultDecision: options.keyDecisionPolicy?.defaultDecision ?? 'reject',
            timeout: options.keyDecisionPolicy?.approvalTimeout ?? 60000 
         } as any;

         yield fullReq;
         // eslint-disable-next-line no-await-in-loop
         const approved = await this.waitForApprovalWithSubtask(fullReq, options, taskId);
         nextValue = approved;
      }
    }
  }

  /**
   * Manage Context (Compaction & Limits)
   */
  private async manageContext(context: PromptContextEngine): Promise<{ success: boolean; error?: WorkerErrorMessage }> {
    if (context.needsReduction()) {
      console.debug('[GenericAgentBackend] Context needs reduction, running autoReduce');
      await context.autoReduce();
      
      if (context.needsReduction()) {
        console.warn('[GenericAgentBackend] Context still over limit after autoReduce, forcing compact');
        for (let i = 0; i < 3 && context.needsReduction(); i++) {
          // eslint-disable-next-line no-await-in-loop
          await context.compact();
        }
      }
      
      if (context.needsSummarization()) {
        console.error('[GenericAgentBackend] Context exceeds hard limit after all reduction attempts');
        return {
          success: false,
          error: {
            type: 'error',
            error: `Context size exceeds hard limit after reduction. Token count: ${context.getState().totalTokens}`,
            code: 'CONTEXT_OVERFLOW',
            retryable: false,
            timestamp: Date.now(),
          }
        };
      }
      
      context.injectStatusReminder();
    }
    return { success: true };
  }

  /**
   * Helper to create ToolExecutor Callbacks
   */
  private createToolExecutorCallbacks(
    tools: Tool[],
    options: WorkerExecutionOptions,
    executionContext: ExecutionContext
  ): ToolExecutorCallbacks {
    return {
      executeTool: async (call) => {
        const result = await this.executeTool(call, tools, options);
        return {
          success: result.success,
          output: result.output,
        };
      },
      requiresApproval: async (call) => {
        const tool = tools.find((t) => t.name === call.name);
        const decision = await isKeyDecisionAsync(
          call.name, 
          call.input, 
          tool, 
          executionContext,
          options.keyDecisionPolicy, 
          options.riskPolicy, 
          options.unknownToolPolicy
        );
        return {
          required: decision.isKeyDecision,
          reason: decision.reason,
          category: decision.category,
          riskLevel: decision.riskLevel
        };
      },
      waitForApproval: async (call, reason) => {
        // Construct WorkerApprovalRequestMessage from ParsedToolCall
        const approvalRequest: WorkerApprovalRequestMessage = {
          type: 'approval_request',
          requestId: call.callId,
          action: call.name,
          description: reason,
          details: { input: call.input },
          timestamp: Date.now(),
          category: 'key_decision',
          defaultDecision: options.keyDecisionPolicy?.defaultDecision ?? 'reject',
          timeout: options.keyDecisionPolicy?.approvalTimeout ?? 300_000,
        };
        // Delegate to InteractionEngine for consistent approval handling
        return this.interactionEngine.waitForApproval(approvalRequest, options);
      },
      isAborted: () => this.abortController?.signal.aborted ?? false,
    };
  }

  private async executeTool(
    call: ParsedToolCall,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): Promise<{ success: boolean; output: unknown }> {
    // 查找工具
    let tool = tools.find((t) => t.name === call.name);

    // Fallback: 尝试从全局注册表查找（用于动态创建的 Skill）
    if (!tool) {
      tool = globalToolRegistry.getByName(call.name);
      if (tool) {
        console.debug(`[GenericAgentBackend] Found dynamic tool in global registry: ${call.name}`);
      }
    }

    if (!tool) {
      return {
        success: false,
        output: `Tool not found: ${call.name}`,
      };
    }

    // 检查是否为重复调用（防循环）
    if (this.toolCallTracker) {
      const duplicateCheck = this.toolCallTracker.checkDuplicate(call.name, call.input);
      if (duplicateCheck.shouldBlock) {
        // 阻止执行并返回警告
        const warning = duplicateCheck.warning ?? 'Blocked: repeated failed call';
        console.warn(`[GenericAgentBackend] ToolCallTracker blocked call: ${call.name}`);
        return {
          success: false,
          output: warning,
        };
      }
      // 如果是重复调用但未被阻止，记录警告日志
      if (duplicateCheck.isDuplicate && duplicateCheck.failureCount > 0) {
        console.warn(`[GenericAgentBackend] Duplicate call detected: ${call.name} (${duplicateCheck.failureCount} previous failures)`);
      }
    }

    if (this.constraintPolicy) {
      const violation = checkToolCallAgainstConstraints(call.name, call.input, this.constraintPolicy);
      if (violation) {
        // 记录约束违反到失败记忆
        this.failureMemory?.recordFailure(call.name, call.input, violation.message);
        this.toolCallTracker?.record(call.name, call.input, false, violation.message);
        return {
          success: false,
          output: violation.message,
        };
      }
    }

    const maxToolInputBytes =
      options.resourceLimits?.maxToolInputBytes ?? DEFAULT_RESOURCE_LIMITS.maxToolInputBytes;
    const sizeCheck = checkToolInputSize(call.name, call.input, maxToolInputBytes);
    if (!sizeCheck.ok) {
      const errorMsg = sizeCheck.message ?? 'Tool input too large.';
      // 记录大小超限到失败记忆
      this.failureMemory?.recordFailure(call.name, call.input, errorMsg);
      this.toolCallTracker?.record(call.name, call.input, false, errorMsg);
      return {
        success: false,
        output: errorMsg,
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

    // 记录工具调用结果到追踪器
    if (!result.success) {
      const errorMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      this.failureMemory?.recordFailure(call.name, call.input, errorMsg);
      this.toolCallTracker?.record(call.name, call.input, false, errorMsg);
    } else {
      this.toolCallTracker?.record(call.name, call.input, true);
    }

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
  /**
   * 等待审批（阻塞 + 超时）
   */
  private async waitForApprovalWithSubtask(
    request: WorkerApprovalRequestMessage,
    options: WorkerExecutionOptions,
    subtaskId?: string
  ): Promise<boolean> {
    return this.interactionEngine.waitForApproval(request, options, subtaskId);
  }

  /**
   * 检查并处理干预指令
   */
  private async checkAndHandleIntervention(
    options: WorkerExecutionOptions
  ): Promise<'continue' | 'pause' | 'abort'> {
    return this.interactionEngine.checkAndHandleIntervention(options);
  }


}