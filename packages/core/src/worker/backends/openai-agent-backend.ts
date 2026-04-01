/**
 * OpenAI Agents SDK 后端
 *
 * 封装 @openai/agents，将其适配为统一的 IWorkerBackend 接口
 * 获得 OpenAI 官方 Agent 运行时能力（工具调用循环、流式事件、审批机制等）
 *
 * @see https://github.com/openai/openai-agents-js
 *
 * SDK 核心用法：
 * - 入口函数: run(agent, input, { stream: true })
 * - 工具格式: tool({ name, description, parameters: z.object(), execute })
 * - 流事件: event.type === 'run_item_stream_event', event.name 分流
 * - 审批: needsApproval + result.interruptions + state.approve()/reject()
 */

import { z, type ZodTypeAny, type ZodObject, type ZodRawShape } from 'zod';
import type {
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
  OpenAIAgentsBackendConfig,
  WorkerApprovalRequestMessage,
  KeyDecisionPolicy,
  RiskPolicy,
} from '../types';
import { DEFAULT_RESOURCE_LIMITS } from '../types';
import type { RetryPolicy, Tool } from '../../types';
import { isKeyDecision, isKeyDecisionAsync } from '../key-decision';
import { buildWorkerSystemPromptAsync } from '../prompts/system-prompt';
import { buildTaskPrompt } from '../prompts/task-prompt';
import {
  createSkillsManager,
  resolveProjectContextConfig,
  checkToolInputSize,
  deriveConstraintPolicy,
  checkToolCallAgainstConstraints,
  type ConstraintPolicy,
} from '../engines';
import {
  ToolRuntimeKernel,
  createResolvedToolsetSnapshot,
  createToolRuntimeLogMiddleware,
  createSyntheticToolFailureOutput,
  resolveToolRuntimeFeatureFlags,
} from '../tool-runtime';

// 共享基础层
import {
  BaseWorkerBackend,
  SDKAvailabilityChecker,
  ToolCallBudgetExceededError,
  createStatusMessage,
  createThinkingMessage,
  createOutputMessage,
  createErrorMessage,
  createToolCallMessage,
  createToolResultMessage,
  isRetryableError,
} from './base-backend';

// 工具调用追踪器（防循环）
import { ToolCallTracker } from '../tool-call-tracker';

// 工具输入验证器（参数预检）
import { validateToolInput } from '../tool-input-validator';

// 失败记忆系统（上下文注入）
import { FailureMemory } from '../failure-memory';

// 工作区结构缓存（上下文注入）
import { WorkspaceStructureCache, parseFileListOutput } from '../workspace-cache';
import { resolve } from 'node:path';
import { IdentityUpdater, getAgentIdFromEnv } from '../../agent-identity';
import { getToolPromptText } from '../../tools/build-tool';
import { ReadFileStateCache } from '../../tools/read-file-state';

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,  // Codex-style: allow multiple reconnection attempts
  baseDelay: 1000,
  backoffFactor: 2,
  maxDelay: 10000,
};

const TOOL_ARGS_RETRY_HINT = `## Tool Call Formatting (Recovery)
The previous tool call failed because its arguments were not valid JSON.
- Re-issue tool calls with strict JSON only (double quotes, escape newlines).
- Split large edits into multiple tool calls; keep each call small.
- Avoid unescaped backticks or code fences inside JSON strings.`;

function isConnectionError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('econnreset') ||
    message.includes('socket connection was closed') ||
    message.includes('connection error') ||
    message.includes('econnrefused') ||
    message.includes('etimedout')
  );
}

function isToolArgsParseError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    error.name === 'ToolCallError' ||
    message.includes('failed to run function tools')
  ) && (
    message.includes('json parse') ||
    message.includes('unterminated string') ||
    message.includes('invalid json')
  );
}

function resolveRetryPolicy(policy?: RetryPolicy): RetryPolicy {
  if (!policy) return DEFAULT_RETRY_POLICY;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- DEFAULT values are always defined
  const backoffFactor: number = policy.backoffFactor ?? DEFAULT_RETRY_POLICY.backoffFactor!;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- DEFAULT values are always defined
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

interface FunctionalToolFailure {
  failed: boolean;
  code: string;
  error: string;
}

function parseFunctionalToolFailure(output: unknown): FunctionalToolFailure {
  if (!output || typeof output !== 'object') {
    return {
      failed: false,
      code: '',
      error: '',
    };
  }

  const record = output as Record<string, unknown>;
  const hasFailureFlag =
    record.success === false ||
    record.isError === true ||
    record.is_error === true ||
    record.errorType === 'functional_error';

  if (!hasFailureFlag) {
    return {
      failed: false,
      code: '',
      error: '',
    };
  }

  const meta =
    record.meta && typeof record.meta === 'object'
      ? (record.meta as Record<string, unknown>)
      : null;
  const codeFromMeta = meta && typeof meta.code === 'string' ? meta.code.trim() : '';
  const code =
    typeof record.code === 'string' && record.code.trim().length > 0
      ? record.code
      : codeFromMeta.length > 0
        ? codeFromMeta
        : 'TOOL_FUNCTIONAL_ERROR';
  const error =
    typeof record.error === 'string' && record.error.trim().length > 0
      ? record.error
      : typeof record.message === 'string' && record.message.trim().length > 0
        ? record.message
        : 'Tool returned unsuccessful result.';

  return {
    failed: true,
    code,
    error,
  };
}

// ============================================================================
// JSON Schema to Zod 转换辅助
// ============================================================================

/**
 * 将 JSON Schema 转换为 Zod Schema
 *
 * 支持常见类型：string, number, boolean, array, object, enum
 * 不支持的类型回退到 z.unknown() 并记录警告
 */
function jsonSchemaToZod(schema: Record<string, unknown>): ZodTypeAny {
  const type = schema.type as string;

  // 处理 enum 类型（无论是否有 type）
  if (schema.enum && Array.isArray(schema.enum)) {
    const enumValues = schema.enum as [string, ...string[]];
    if (enumValues.length > 0 && enumValues.every(v => typeof v === 'string')) {
      return z.enum(enumValues as [string, ...string[]]).nullable().optional();
    }
    // 非字符串 enum 回退到 z.unknown
    console.warn('[jsonSchemaToZod] Non-string enum, falling back to z.unknown');
    return z.unknown().nullable().optional();
  }

  switch (type) {
    case 'string':
      return z.string().nullable().optional();
    case 'number':
    case 'integer':
      // Use preprocess to handle LLM sending numbers as strings (e.g. "10000")
      // Also handle empty strings → undefined, non-finite values → reject
      return z.preprocess(
        (val) => {
          if (val === null || val === undefined) return val;
          if (typeof val === 'number') return Number.isFinite(val) ? val : undefined;
          if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed === '') return undefined;
            const num = Number(trimmed);
            return Number.isFinite(num) ? num : undefined;
          }
          return undefined;
        },
        z.number().nullable().optional()
      );
    case 'boolean':
      // Use preprocess to handle LLM sending booleans as strings (e.g. "False", " true ", "0", "1")
      return z.preprocess(
        (val) => {
          if (val === null || val === undefined) return val;
          if (typeof val === 'boolean') return val;
          if (typeof val === 'number') return Number.isFinite(val) ? val !== 0 : undefined;
          if (typeof val === 'string') {
            const trimmed = val.trim().toLowerCase();
            if (['true', '1', 'yes'].includes(trimmed)) return true;
            if (['false', '0', 'no'].includes(trimmed)) return false;
          }
          return undefined;
        },
        z.boolean().nullable().optional()
      );
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      // Use preprocess to handle LLM sending arrays as JSON strings (e.g. "[\"a\",\"b\"]")
      return z.preprocess(
        (val) => {
          if (val === null || val === undefined) return val;
          if (Array.isArray(val)) return val;
          if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return parsed;
              } catch {
                // Not valid JSON, return undefined
              }
            }
          }
          return undefined;
        },
        items
          ? z.array(jsonSchemaToZod(items)).nullable().optional()
          : z.array(z.unknown()).nullable().optional()
      );
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const requiredFields = (schema.required as string[]) ?? [];

      if (!properties) {
        return z.record(z.string(), z.unknown());
      }

      // 构建 shape 对象（使用 as 断言绕过 readonly 限制）
      const shapeEntries: [string, ZodTypeAny][] = [];
      for (const [key, propSchema] of Object.entries(properties)) {
        // 根据是否 required 决定是否 optional
        const isRequired = requiredFields.includes(key);
        const basePropType = propSchema.type as string;
        
        let zodProp: ZodTypeAny;
        switch (basePropType) {
          case 'string':
            zodProp = isRequired ? z.string() : z.string().nullable().optional();
            break;
          case 'number':
          case 'integer': {
            // Use preprocess for robust number coercion with validation
            const numPreprocess = z.preprocess(
              (val) => {
                if (val === null || val === undefined) return val;
                if (typeof val === 'number') return Number.isFinite(val) ? val : undefined;
                if (typeof val === 'string') {
                  const trimmed = val.trim();
                  if (trimmed === '') return undefined;
                  const num = Number(trimmed);
                  return Number.isFinite(num) ? num : undefined;
                }
                return undefined;
              },
              z.number()
            );
            zodProp = isRequired ? numPreprocess : numPreprocess.nullable().optional();
            break;
          }
          case 'boolean': {
            // Use preprocess to handle LLM sending booleans as strings (e.g. "False", " True ", "0", "1")
            const boolPreprocess = z.preprocess(
              (val) => {
                if (val === null || val === undefined) return val;
                if (typeof val === 'boolean') return val;
                if (typeof val === 'number') return Number.isFinite(val) ? val !== 0 : undefined;
                if (typeof val === 'string') {
                  const trimmed = val.trim().toLowerCase();
                  if (['true', '1', 'yes'].includes(trimmed)) return true;
                  if (['false', '0', 'no'].includes(trimmed)) return false;
                }
                return undefined;
              },
              z.boolean()
            );
            zodProp = isRequired ? boolPreprocess : boolPreprocess.nullable().optional();
            break;
          }
          case 'array': {
            const items = propSchema.items as Record<string, unknown> | undefined;
            const arraySchema = items ? z.array(jsonSchemaToZod(items)) : z.array(z.unknown());
            const arrayPreprocess = z.preprocess(
              (val) => {
                if (val === null || val === undefined) return val;
                if (Array.isArray(val)) return val;
                if (typeof val === 'string') {
                  const trimmed = val.trim();
                  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    try {
                      const parsed = JSON.parse(trimmed);
                      if (Array.isArray(parsed)) return parsed;
                    } catch {
                      // Not valid JSON, return undefined
                    }
                  }
                }
                return undefined;
              },
              arraySchema
            );
            zodProp = isRequired ? arrayPreprocess : arrayPreprocess.nullable().optional();
            break;
          }
          default:
            zodProp = isRequired ? z.unknown() : z.unknown().nullable().optional();
        }
        shapeEntries.push([key, zodProp]);
      }

      return z.object(Object.fromEntries(shapeEntries)).strict();
    }
    default:
      return z.unknown();
  }
}

/**
 * 将 Tool.inputSchema 转换为 Zod object schema
 */
function toolInputSchemaToZod(inputSchema: Record<string, unknown>): ZodObject<ZodRawShape> {
  const zodSchema = jsonSchemaToZod(inputSchema);
  // 确保返回的是 object schema
  if (zodSchema instanceof z.ZodObject) {
    return zodSchema;
  }
  // 回退到空 object
  return z.object({});
}

// ============================================================================
// SDK 类型定义（延迟导入）
// ============================================================================

/**
 * SDK run() 函数类型
 */
type SDKRunFunction = (
  agent: unknown,
  input: string | unknown, // input 可以是 string 或 state
  options?: {
    stream?: boolean;
    signal?: AbortSignal;
    maxTurns?: number;
    modelProvider?: unknown; // OpenAIProvider
  }
) => Promise<SDKRunResult> | AsyncIterable<SDKStreamEvent>;

/**
 * SDK tool() 函数类型
 */
type SDKToolFunction = <T extends ZodRawShape>(config: {
  name: string;
  description: string;
  parameters: ZodObject<T>;
  execute: (params: z.infer<ZodObject<T>>, context?: unknown) => Promise<string> | string;
  needsApproval?: boolean | ((context: unknown, params: unknown) => Promise<boolean>);
}) => unknown;

/**
 * SDK Agent 类类型
 */
type SDKAgentClass = new (config: {
  name: string;
  instructions?: string;
  tools?: unknown[];
  model?: string;
}) => SDKAgent;

/**
 * SDK Agent 实例
 */
interface SDKAgent {
  name: string;
  instructions?: string;
  tools?: unknown[];
}

/**
 * SDK 运行结果
 */
interface SDKRunResult {
  finalOutput?: string;
  state?: SDKRunState;
  interruptions?: SDKInterruption[];
  /** Token 使用统计 (Phase 6) */
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
}

/**
 * SDK 运行状态（用于恢复）
 */
interface SDKRunState {
  approve: (interruption: SDKInterruption) => void;
  reject: (interruption: SDKInterruption) => void;
}

/**
 * SDK 中断项（审批请求）
 * 
 * SDK RunToolApprovalItem 结构:
 * - type: 'tool_approval_item'
 * - rawItem: { name, arguments (JSON string), call_id, ... }
 * - agent: Agent 实例
 */
interface SDKInterruption {
  type: string;
  /** rawItem 包含工具调用的原始数据 */
  rawItem?: {
    name?: string;
    arguments?: string;  // JSON string
    call_id?: string;
    [key: string]: unknown;
  };
  /** 备用字段（兼容性） */
  toolName?: string;
  callId?: string;
  arguments?: unknown;
  agent?: { name: string };
}

/**
 * SDK 流事件
 */
interface SDKStreamEvent {
  type: string;
  name?: string;
  item?: {
    type?: string;
    content?: string;
    text?: string;
    name?: string;
    callId?: string;
    arguments?: unknown;
    output?: unknown;
  };
  data?: unknown;
}

// ============================================================================
// OpenAI Agents SDK 后端实现
// ============================================================================

/**
 * OpenAI Agents SDK 后端
 *
 * 使用 @openai/agents 实现，获得 OpenAI 官方 Agent 运行时能力：
 * - SDK 标准 tool() 工具格式
 * - run(agent, input, { stream: true }) 流式执行
 * - RunItemStreamEvent 事件映射
 * - needsApproval + state.approve()/reject() 审批机制
 *
 * @example
 * ```ts
 * const backend = new OpenAIAgentsBackend({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   backend: 'openai-agents',
 * });
 *
 * for await (const msg of backend.execute(task, tools, options)) {
 *   console.log(msg);
 * }
 * ```
 */
export class OpenAIAgentsBackend extends BaseWorkerBackend {
  readonly provider = 'openai';
  readonly backendType: WorkerBackendType = 'agent-sdk';

  private readonly config: OpenAIAgentsBackendConfig;
  private readonly sdkChecker: SDKAvailabilityChecker;
  // memoryManager 和 executionController 继承自 BaseWorkerBackend

  // 工具映射（name -> Tool）用于执行
  private toolMap = new Map<string, Tool>();
  private readonly toolRuntime: ToolRuntimeKernel;

  constructor(config: OpenAIAgentsBackendConfig) {
    super(config.memoryConfig, 'OpenAIAgentsBackend');
    this.config = config;
    this.sdkChecker = new SDKAvailabilityChecker('@openai/agents');
    this.toolRuntime = new ToolRuntimeKernel({
      middlewares: [
        createToolRuntimeLogMiddleware({
          backend: 'OpenAIAgentsBackend',
        }),
      ],
    });

    // 不写入全局 env，避免多后端并行时污染
    // API Key 和 baseURL 在 run() 时通过 OpenAI 客户端传入

    // 预检查 SDK 是否可用
    this.sdkChecker.check();
  }

  /**
   * 执行任务
   */
  async *execute(
    task: WorkerTask,
    tools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage> {
    // 动态导入 OpenAI Agents SDK
    let Agent: SDKAgentClass;
    let run: SDKRunFunction;
    let sdkTool: SDKToolFunction;

    try {
      const sdk = await import('@openai/agents');
      Agent = sdk.Agent as unknown as SDKAgentClass;
      run = sdk.run as unknown as SDKRunFunction;
      sdkTool = sdk.tool as unknown as SDKToolFunction;
    } catch (_error) {
      yield createErrorMessage(
        'OpenAI Agents SDK is not installed. Run: bun add @openai/agents',
        'SDK_NOT_INSTALLED',
        false
      );
      return;
    }

    // 开始执行
    this.executionController.start();
    let abortHandler: (() => void) | undefined;
    const retryPolicy = resolveRetryPolicy(options.retryPolicy);
    const maxRetries = Math.max(0, retryPolicy.maxRetries);
    let attempt = 0;
    const toolResultCache = new Map<string, string>();
    // 工具调用追踪器：防止重复失败调用导致的循环
    const toolCallTracker = new ToolCallTracker({
      maxHistory: 100,
      duplicateWindowMs: 5 * 60 * 1000, // 5 minutes
      blockAfterFailures: 3,
      enableBlocking: true,
    });
    // 失败记忆：跨轮次跟踪失败模式并注入上下文警告
    const failureMemory = new FailureMemory({
      maxPatterns: 50,
      patternWindowMs: 10 * 60 * 1000, // 10 minutes
      minOccurrences: 2,
    });
    // 工作区结构缓存：从 file_list 输出中提取和注入上下文
    const workspaceCache = new WorkspaceStructureCache({
      maxEntries: 100,
      ttlMs: 10 * 60 * 1000, // 10 minutes
    });
    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...options.resourceLimits,
    };
    let totalToolCalls = 0;
    let toolArgsRetryHint: string | null = null;
    const projectContextConfig = resolveProjectContextConfig(
      this.config.projectContextConfig
    );
    const skillsManager = createSkillsManager(
      this.config.skillsConfig,
      options.workDir ?? process.cwd(),
      projectContextConfig
    );
    const constraintPolicy = deriveConstraintPolicy(task.constraints);

    try {
      // 集成外部 abortSignal（如果提供）
      // 当外部信号触发时，同步中断 ExecutionController
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          // 已经中断
          yield createStatusMessage('interrupted');
          return;
        }
        abortHandler = () => {
          this.executionController.abort();
        };
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      while (true) {
        let toolCallsInAttempt = 0;
        const useToolResultCache = attempt > 0;

        try {
          // 发出初始化状态
          yield createStatusMessage('initializing');

          // 重置任务状态
          this.memoryManager.reset();
          this.toolMap.clear();
          this.resetToolCallGuard();

          // 构建工具映射和 SDK 工具
          for (const tool of tools) {
            this.toolMap.set(tool.name, tool);
          }

          // 跟踪最终结果（用于记忆保存）
          let finalResult = '';
          let lastAssistantContent = '';
          // Memory: 自动检索相关记忆
          const memoryContext = await this.memoryManager.retrieve(
            task.objective,
            this.config.memoryConfig?.topK ?? 5,
            this.config.memoryConfig?.retrievalCooldownMs ?? 10000
          );

          // 构建系统提示（注入 skills 元数据）
          // Pass task objective for skill recommendations with auto-activation
          // 注入失败记忆警告（如果有）
          const failureWarnings = failureMemory.generateWarnings();
          // 注入工作区结构上下文（如果有）
          const workspaceContext = workspaceCache.generateContext();
          
          const baseSystemPrompt = await this.buildSystemPrompt(
            memoryContext,
            toolArgsRetryHint,
            options.workDir ?? process.cwd(),
          );
          const contextParts = [baseSystemPrompt];
          if (failureWarnings) {
            contextParts.push(failureWarnings);
          }
          if (workspaceContext) {
            contextParts.push(workspaceContext);
          }
          const systemPromptWithContext = contextParts.join('\n\n');
          
          const systemPrompt = await skillsManager.renderSystemPromptSection(
            systemPromptWithContext,
            task.objective,
            { 
              autoActivate: true,
              includeProjectContext: true,
              availableToolNames: options.toolPreflight?.availableSkillToolNames ?? tools.map(tool => tool.name),
              ...(task.parentObjective !== undefined && { parentObjective: task.parentObjective }),
            }
          );

          // 转换工具为 SDK tool() 格式
          const sdkTools = this.convertToolsToSDKFormat(
            tools,
            sdkTool,
            options,
            task,
            (toolName) => {
              if (totalToolCalls >= limits.maxToolCalls) {
                const message = `Max tool calls (${limits.maxToolCalls}) exceeded before executing "${toolName}".`;
                this.abortExecution();
                throw new ToolCallBudgetExceededError(message);
              }
              toolCallsInAttempt += 1;
              totalToolCalls += 1;
            },
            toolResultCache,
            useToolResultCache,
            limits.maxToolInputBytes,
            constraintPolicy,
            toolCallTracker,
            failureMemory,
            workspaceCache
          );

          // 创建 Agent 实例
          const agent = new Agent({
            name: 'TachikomaWorker',
            instructions: systemPrompt,
            tools: sdkTools,
            model: this.config.model,
          });

          // 配置 OpenAI 客户端
          // SDK 使用 setDefaultOpenAIClient() 而非 OpenAIProvider constructor
          const openRouterApiKey = options.env?.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
          const openAiApiKey = options.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
          const apiKey = this.config.apiKey || openRouterApiKey || openAiApiKey;

          const openRouterBaseUrl = options.env?.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL;
          const openAiBaseUrl = options.env?.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
          const baseUrl = this.config.baseUrl || (apiKey === openRouterApiKey ? openRouterBaseUrl : openAiBaseUrl);

          if (apiKey) {
            try {
              // @ts-ignore - openai is an optional peer dependency
              const openaiSdk = await import('openai');
              const OpenAIClass = openaiSdk.default || openaiSdk.OpenAI;
              const client = new OpenAIClass({
                apiKey: apiKey,
                baseURL: baseUrl,
              });
              
              // 使用 SDK 的 setDefaultOpenAIClient
              const agentsSdk = await import('@openai/agents');
              if (agentsSdk.setDefaultOpenAIClient) {
                // @ts-expect-error - version mismatch between dynamic import and agents sdk
                agentsSdk.setDefaultOpenAIClient(client);
                console.debug('[OpenAIAgentsBackend] Custom OpenAI client configured');
              } else if (agentsSdk.setDefaultOpenAIKey) {
                // 备选: setDefaultOpenAIKey
                agentsSdk.setDefaultOpenAIKey(apiKey);
                console.debug('[OpenAIAgentsBackend] Custom API key configured');
              }

              // 修复: 如果没有设置 OPENAI_API_KEY (例如使用 OpenRouter)，SDK 默认的 Tracing Exporter 会报警告
              // 手动禁用 Tracing (清空 processors)
              if (!process.env.OPENAI_API_KEY && agentsSdk.setTraceProcessors) {
                agentsSdk.setTraceProcessors([]);
              }
            } catch (err) {
              console.warn('[OpenAIAgentsBackend] Could not configure custom OpenAI client:', err);
            }
          }

          // 运行 Agent（流式模式）
          // Use maxThinkingRounds from resourceLimits if available
          const configuredMaxTurns =
            Number.isFinite(limits.maxThinkingRounds) && limits.maxThinkingRounds > 0
              ? limits.maxThinkingRounds
              : DEFAULT_RESOURCE_LIMITS.maxThinkingRounds;
          interface RunOptionsType { 
            stream: true; 
            signal?: AbortSignal; 
            maxTurns: number;
          }
          const runOptions: RunOptionsType = {
            stream: true,
            maxTurns: configuredMaxTurns,
          };
          // 只有当 signal 存在时才添加
          if (this.executionController.signal) {
            runOptions.signal = this.executionController.signal;
          }
          const taskPrompt = buildTaskPrompt(task, tools, {
            useNativeToolCalls: true,
            toolDescriptionMode: 'names-only',
          });
          const streamResult = await run(agent, taskPrompt, runOptions);

          // 处理流式事件
          // streamResult 在 stream: true 时是 AsyncIterable
          const eventStream = streamResult as AsyncIterable<SDKStreamEvent>;

          for await (const event of eventStream) {
            // 检查是否已中断
            if (this.executionController.isAborted) {
              yield createStatusMessage('interrupted');
              break;
            }

            // 转换 SDK 事件为 WorkerMessage
            const messages = this.mapSDKEvent(event);
            for (const msg of messages) {
              // 跟踪内容
              if (msg.type === 'output') {
                finalResult = msg.content;
              } else if (msg.type === 'thinking') {
                lastAssistantContent = msg.content;
              }
              yield msg;
            }
          }

          // ========================================
          // Phase 4: SDK 审批中断 Resume 流程
          // ========================================
          // 将 streamResult 转为 SDKRunResult 以访问 interruptions
          const runResult = streamResult as unknown as SDKRunResult;
          let hasInterruptions = (runResult.interruptions?.length ?? 0) > 0;
          let currentState = runResult.state;
          let currentResult = runResult;

          while (hasInterruptions && !this.executionController.isAborted) {
            yield createThinkingMessage('Processing tool approval requests...');

            for (const interruption of currentResult.interruptions ?? []) {
              // 创建审批请求消息（带 policy 参数）
              const approvalRequest = this.createApprovalRequestFromInterruption(
                interruption, 
                task, 
                options.keyDecisionPolicy, 
                options.riskPolicy
              );
              yield approvalRequest;

              // 等待审批（传入 taskId 用于审计追踪）
              // eslint-disable-next-line no-await-in-loop -- Approval is intentionally sequential
              const approved = await this.waitForApproval(approvalRequest, options, 300000, 'reject', task.id);

              // 在 state 上标记批准/拒绝
              if (currentState) {
                if (approved) {
                  currentState.approve(interruption);
                } else {
                  currentState.reject(interruption);
                }
              }
            }

            // 恢复执行：run(agent, state) 需要带 signal 保持中断能力
            if (currentState) {
              yield createThinkingMessage('Resuming agent execution after approval...');
              const resumeOptions: RunOptionsType = {
                stream: true,
                maxTurns: configuredMaxTurns, // Use same configured limit for resume
              };
              if (this.executionController.signal) {
                resumeOptions.signal = this.executionController.signal;
              }
              const resumeResult = await run(agent, currentState as unknown, resumeOptions);
              
              // Resume result is also a stream if stream: true
              const resumeEventStream = resumeResult as unknown as AsyncIterable<SDKStreamEvent>;
              for await (const event of resumeEventStream) {
                 if (this.executionController.isAborted) {
                   yield createStatusMessage('interrupted');
                   break;
                 }
                 const messages = this.mapSDKEvent(event);
                 for (const msg of messages) {
                   // Track content from resumed stream
                   if (msg.type === 'output') {
                     finalResult = msg.content;
                   } else if (msg.type === 'thinking') {
                     lastAssistantContent = msg.content;
                   }
                   yield msg;
                 }
              }

              // After stream finishes, get latest result/state
              currentResult = resumeResult as unknown as SDKRunResult;
              currentState = currentResult.state;
              hasInterruptions = (currentResult.interruptions?.length ?? 0) > 0;

              // 如果有最终输出，更新
              if (currentResult.finalOutput) {
                finalResult = currentResult.finalOutput;
                // mapSDKEvent already emitted output, so we don't need to emit again strictly, 
                // but finalOutput might update. Duplicate output is better than missing.
                // Actually mapSDKEvent handles message_output_created. 
                // If finalOutput is just the accumulated text, we might skip emitting here if already emitted.
                // But let's keep it safe.
                // yield createOutputMessage(finalResult); 
                // Better to rely on stream events.
              }
            } else {
              break;
            }
          }

          // 检查是否在审批循环中被中断
          if (this.executionController.isAborted) {
            yield createStatusMessage('interrupted');
            return;
          }

          // 使用最终结果，否则回退到最后的助手内容
          const resultToSave = finalResult || lastAssistantContent;

          // Memory: 自动保存任务结果（仅在未中断时）
          if (resultToSave) {
            await this.memoryManager.save(task.objective, resultToSave, {
              sessionId: task.sessionId,
              taskId: task.id,
            });
          }

          // Phase 6: 提取 token 指标
          const totalTokens = currentResult.usage?.totalTokens;

          // 发出完成状态（带 token 指标）
          const statusMsg: WorkerMessage = {
            type: 'status' as const,
            status: 'completed' as const,
            timestamp: Date.now(),
            ...(totalTokens !== undefined && { tokensUsed: totalTokens }),
          };
          yield statusMsg;
          return;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const isToolLoopError = err.name === 'ToolCallLoopError';
          const isToolBudgetError = err.name === 'ToolCallBudgetExceededError';
          const toolArgsParseError = isToolArgsParseError(err);
          const retryable =
            (isRetryableError(err) || toolArgsParseError) &&
            !isToolLoopError &&
            !isToolBudgetError;
          const connectionError = isConnectionError(err);
          
          const shouldRetry =
            retryable &&
            attempt < maxRetries &&
            toolCallsInAttempt === 0 &&
            !this.executionController.isAborted &&
            options.abortSignal?.aborted !== true;

          if (!shouldRetry) {
            throw err;
          }

          if (toolArgsParseError) {
            toolArgsRetryHint = TOOL_ARGS_RETRY_HINT;
          }

          attempt += 1;
          const delay = calculateRetryDelay(retryPolicy, attempt);
          
          // Codex-style retrying/reconnecting message
          const actionLabel = connectionError ? 'reconnecting' : 'retrying';
          const reasonLabel = connectionError
            ? 'connection error'
            : toolArgsParseError
              ? 'tool args parse error'
              : 'retryable error';
          const reconnectMsg = `${actionLabel} ${attempt}/${maxRetries} (${reasonLabel})...`;
          console.log(`[OpenAIAgentsBackend] ${reconnectMsg}`);
          yield createStatusMessage('initializing');
          yield createThinkingMessage(reconnectMsg);
          
          await new Promise(resolve => setTimeout(resolve, delay));

          if (this.executionController.isAborted) {
            yield createStatusMessage('interrupted');
            return;
          }
        }
      }
    } catch (error) {
      const err = error as Error;
      // 不再直接 console.error，而是通过消息系统传递
      const isToolLoopError = err.name === 'ToolCallLoopError';
      const isToolBudgetError = err.name === 'ToolCallBudgetExceededError';
      const toolArgsParseError = isToolArgsParseError(err);
      const retryable =
        (isRetryableError(err) || toolArgsParseError) &&
        !isToolLoopError &&
        !isToolBudgetError;
      const connectionError = isConnectionError(err);
      let errorCode = 'EXECUTION_ERROR';
      if (isToolBudgetError) {
        errorCode = 'MAX_TOOL_CALLS_EXCEEDED';
      } else if (isToolLoopError) {
        errorCode = 'TOOL_CALL_LOOP';
      } else if (connectionError) {
        errorCode = 'CONNECTION_ERROR';
      } else if (toolArgsParseError) {
        errorCode = 'TOOL_ARGS_PARSE_ERROR';
      }
      if (connectionError) {
        console.warn(`[OpenAIAgentsBackend] Connection failed after retries: ${err.message}`);
      } else if (isToolBudgetError || isToolLoopError) {
        console.warn(`[OpenAIAgentsBackend] ${err.name}: ${err.message}`);
      } else {
        console.error('[OpenAIAgentsBackend] Execution error:', err);
      }
      yield createErrorMessage(
        err.message,
        errorCode,
        retryable
      );
      yield createStatusMessage('failed');
    } finally {
      if (options.abortSignal && abortHandler) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
      this.executionController.end();
    }
  }

  /**
   * 获取后端能力
   */
  getCapabilities(): WorkerCapability[] {
    return ['code-execution', 'file-operations', 'shell-commands'];
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    if (!this.config.apiKey && !process.env.OPENAI_API_KEY) return false;
    if (this.sdkChecker.isAvailable === false) return false;
    return true;
  }

  /**
   * 中断执行
   */
  async interrupt(): Promise<void> {
    this.executionController.abort();
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    await this.interrupt();
    await this.memoryManager.close();
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 构建系统提示
   */
  private async buildSystemPrompt(
    memoryContext: string,
    extraSystemPrompt?: string | null,
    cwd = process.cwd()
  ): Promise<string> {
    // Letta-code style: inject identity context right after base prompt
    let identityContext: string | null = null;
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
        identityContext = await updater.getCoreMemoryForPrompt(agentId);
        if (identityContext) {
          console.debug('[OpenAIAgentsBackend] Injected Identity coreMemory for agent:', agentId);
        }
      } catch (identityError) {
        console.debug('[OpenAIAgentsBackend] Identity loading skipped:', identityError);
      }
    }

    return buildWorkerSystemPromptAsync({
      cwd,
      memoryContext,
      provider: this.config.provider,
      model: this.config.model,
      ...(identityContext ? { identityContext } : {}),
      ...(typeof extraSystemPrompt === 'string' ? { extraSystemPrompt } : {}),
    });
  }

  /**
   * 检查是否需要审批
   *
   * 默认策略：如果未显式禁用，则使用默认策略
   */
  protected needsApproval(
    options: WorkerExecutionOptions,
    _toolName?: string,
    _args?: Record<string, unknown>
  ): boolean {
    if (options.requireApproval === false) {
      return false;
    }
    // 如果 keyDecisionPolicy.enabled 未定义，默认为 true (BaseWorkerBackend 行为)
    // 这里我们保持一致，除非 policy 显式 disable
    return options.keyDecisionPolicy?.enabled !== false;
  }

  /**
   * 转换 Tachikoma 工具为 SDK tool() 格式
   *
   * SDK 要求使用 tool({ parameters: z.object(), execute }) 格式
   */
  private convertToolsToSDKFormat(
    tools: Tool[],
    sdkTool: SDKToolFunction,
    options: WorkerExecutionOptions,
    task: WorkerTask,
    onToolExecute?: (toolName: string, input: unknown) => void,
    toolResultCache?: Map<string, string>,
    useToolResultCache = false,
    maxToolInputBytes = DEFAULT_RESOURCE_LIMITS.maxToolInputBytes,
    constraintPolicy?: ConstraintPolicy,
    toolCallTracker?: ToolCallTracker,
    failureMemory?: FailureMemory,
    workspaceCache?: WorkspaceStructureCache
  ): unknown[] {
    // Build one shared execution context per run so effectiveCwd updates persist across tools.
    const executionContext = this.buildExecutionContext(task, options) as unknown as {
      taskId: string;
      agentId: string;
      traceId: string;
      workDir: string;
      effectiveCwd?: string;
      updateCwd?: (newCwd: string) => void;
      registerModifiedFile?: (filePath: string) => void;
      env: Record<string, string>;
      readFileState: ReadFileStateCache;
    };
    executionContext.readFileState = new ReadFileStateCache();
    const resolvedToolset = options.toolPreflight?.resolvedToolset ?? createResolvedToolsetSnapshot(tools);
    const runtimeFlags = resolveToolRuntimeFeatureFlags(options.env);

    return tools.map((tachikomaTool) => {
      // 转换 inputSchema 为 Zod schema
      const zodParameters = toolInputSchemaToZod(
        tachikomaTool.inputSchema as Record<string, unknown>
      );

      // 创建 SDK tool
      return sdkTool({
        name: tachikomaTool.name,
        description: getToolPromptText(tachikomaTool),
        parameters: zodParameters,
        execute: async (params: unknown) => {
          const runtimeResult = await this.toolRuntime.execute({
            taskId: task.id,
            toolName: tachikomaTool.name,
            input: params,
            toolset: resolvedToolset,
            metadata: {
              backend: this.backendType,
              provider: this.provider,
              toolRuntimeV2Enabled: runtimeFlags.toolRuntimeV2Enabled,
              toolRuntimeV2ShadowMode: runtimeFlags.toolRuntimeV2ShadowMode,
            },
            errorCode: 'TOOL_EXECUTION_ERROR',
            recoverUnhandledErrors:
              runtimeFlags.toolRuntimeV2Enabled &&
              runtimeFlags.syntheticToolResultEnabled,
            execute: async (runtimeCall) => {
              const runtimeInput = runtimeCall.input;
              let cacheKey: string | null = null;

              // 检查是否为重复调用（防循环）
              if (toolCallTracker) {
                const duplicateCheck = toolCallTracker.checkDuplicate(tachikomaTool.name, runtimeInput);
                if (duplicateCheck.shouldBlock) {
                  // 阻止执行并返回警告
                  const output = JSON.stringify(
                    createSyntheticToolFailureOutput({
                      toolName: tachikomaTool.name,
                      code: 'DUPLICATE_CALL_BLOCKED',
                      error: duplicateCheck.warning ?? 'Blocked: repeated failed call',
                      kind: 'functional',
                      details: {
                        duplicateCount: duplicateCheck.count,
                        failureCount: duplicateCheck.failureCount,
                      },
                    })
                  );
                  return {
                    success: false,
                    isError: true,
                    output,
                  };
                } else if (duplicateCheck.warning) {
                  // 仅记录警告，不阻止执行
                  console.warn(`[ToolCallTracker] ${duplicateCheck.warning}`);
                }
              }

              if (toolCallTracker) {
                const doomDecision = await this.checkDoomLoopAndApprove({
                  tracker: toolCallTracker,
                  toolName: tachikomaTool.name,
                  args: runtimeInput,
                  options,
                  taskId: task.id,
                });
                if (!doomDecision.allowed) {
                  return {
                    success: false,
                    isError: true,
                    output: JSON.stringify(
                      createSyntheticToolFailureOutput({
                        toolName: tachikomaTool.name,
                        code: 'DOOM_LOOP_BLOCKED',
                        error: doomDecision.message,
                        kind: 'functional',
                        details: { duplicateCount: doomDecision.count },
                      })
                    ),
                  };
                }
              }

              // 参数预验证：检查必需参数是否存在
              const inputSchema = tachikomaTool.inputSchema as Record<string, unknown>;
              const validation = validateToolInput(inputSchema, runtimeInput);
              if (!validation.valid) {
                // 记录验证失败
                const errorMsg = validation.hint ?? 'Missing required parameters';
                toolCallTracker?.record(tachikomaTool.name, runtimeInput, false, errorMsg);
                const validationFailure = createSyntheticToolFailureOutput({
                  toolName: tachikomaTool.name,
                  code: 'TOOL_VALIDATION_ERROR',
                  error: errorMsg,
                  kind: 'functional',
                  hint:
                    validation.hint ??
                    'Fix required fields and schema mismatches before retrying this tool call.',
                  details: {
                    missingRequired: validation.missingRequired,
                    invalidFields: validation.invalidFields,
                  },
                });
                return {
                  success: false,
                  isError: true,
                  output: JSON.stringify(validationFailure),
                };
              }

              try {
                cacheKey = toolResultCache
                  ? this.buildToolCallKey(tachikomaTool.name, runtimeInput)
                  : null;
                if (useToolResultCache && cacheKey && toolResultCache?.has(cacheKey)) {
                  // 记录缓存命中（成功）
                  toolCallTracker?.record(tachikomaTool.name, runtimeInput, true);
                  return {
                    success: true,
                    isError: false,
                    output: toolResultCache.get(cacheKey) as string,
                  };
                }

                onToolExecute?.(tachikomaTool.name, runtimeInput);
                if (constraintPolicy) {
                  const violation = checkToolCallAgainstConstraints(
                    tachikomaTool.name,
                    runtimeInput,
                    constraintPolicy
                  );
                  if (violation) {
                    const output = JSON.stringify(
                      createSyntheticToolFailureOutput({
                        toolName: tachikomaTool.name,
                        code: 'CONSTRAINT_VIOLATION',
                        error: violation.message,
                        kind: 'functional',
                        details: {
                          category: violation.category,
                          detected: violation.detected,
                          allowed: violation.allowed,
                        },
                      })
                    );
                    if (cacheKey) {
                      toolResultCache?.set(cacheKey, output);
                    }
                    // 记录约束违规（失败）
                    toolCallTracker?.record(tachikomaTool.name, runtimeInput, false, violation.message);
                    return {
                      success: false,
                      isError: true,
                      output,
                    };
                  }
                }
                const sizeCheck = checkToolInputSize(tachikomaTool.name, runtimeInput, maxToolInputBytes);
                if (!sizeCheck.ok) {
                  const errorMsg = sizeCheck.message ?? 'Tool input too large.';
                  const output = JSON.stringify(
                    createSyntheticToolFailureOutput({
                      toolName: tachikomaTool.name,
                      code: 'TOOL_INPUT_TOO_LARGE',
                      error: errorMsg,
                      kind: 'functional',
                      details: {
                        size: sizeCheck.size,
                        limit: maxToolInputBytes,
                      },
                    })
                  );
                  if (cacheKey) {
                    toolResultCache?.set(cacheKey, output);
                  }
                  // 记录大小超限（失败）
                  toolCallTracker?.record(tachikomaTool.name, runtimeInput, false, errorMsg);
                  return {
                    success: false,
                    isError: true,
                    output,
                  };
                }
                if (tachikomaTool.validateInput) {
                  const toolValidation = await tachikomaTool.validateInput(
                    runtimeInput,
                    executionContext,
                  );
                  if (!toolValidation.result) {
                    const output = JSON.stringify(
                      createSyntheticToolFailureOutput({
                        toolName: tachikomaTool.name,
                        code: 'TOOL_VALIDATION_ERROR',
                        error: toolValidation.message,
                        kind: 'functional',
                      })
                    );
                    if (cacheKey) {
                      toolResultCache?.set(cacheKey, output);
                    }
                    toolCallTracker?.record(
                      tachikomaTool.name,
                      runtimeInput,
                      false,
                      toolValidation.message,
                    );
                    return {
                      success: false,
                      isError: true,
                      output,
                    };
                  }
                }
                const result = await tachikomaTool.execute(
                  runtimeInput,
                  executionContext
                );

                // Workspace cache wiring: capture file_list results for next-round context injection.
                if (workspaceCache && tachikomaTool.name === 'file_list') {
                  const paramsObj =
                    (runtimeInput && typeof runtimeInput === 'object')
                      ? (runtimeInput as Record<string, unknown>)
                      : {};
                  const rawPath = typeof paramsObj.path === 'string' ? paramsObj.path : '.';
                  const baseDir =
                    typeof executionContext.effectiveCwd === 'string'
                      ? executionContext.effectiveCwd
                      : (executionContext.workDir ?? process.cwd());
                  const resolvedPath = resolve(baseDir, rawPath);

                  const parsed = parseFileListOutput(result);
                  if (parsed) {
                    workspaceCache.recordDirectoryListing(
                      resolvedPath,
                      parsed.subdirectories,
                      parsed.files
                    );
                  } else if (typeof result === 'object' && result !== null) {
                    const resultObj = result as Record<string, unknown>;
                    const success = typeof resultObj.success === 'boolean' ? resultObj.success : undefined;
                    const error = typeof resultObj.error === 'string' ? resultObj.error : '';
                    if (
                      success === false &&
                      /directory not found|does not exist|enoent/i.test(error)
                    ) {
                      workspaceCache.recordNonExistent(resolvedPath);
                    }
                  }
                }

                // SDK 要求返回 string
                let output = typeof result === 'string' ? result : JSON.stringify(result);
                let isSuccess = true;
                let errorMsg: string | undefined;

                const functionalFailure = parseFunctionalToolFailure(result);
                if (functionalFailure.failed) {
                  isSuccess = false;
                  errorMsg = functionalFailure.error;
                  output = JSON.stringify(
                    createSyntheticToolFailureOutput({
                      toolName: tachikomaTool.name,
                      code: functionalFailure.code,
                      error: functionalFailure.error,
                      kind: 'functional',
                    })
                  );
                  failureMemory?.recordFailure(tachikomaTool.name, runtimeInput, functionalFailure.error);
                }

                if (cacheKey) {
                  toolResultCache?.set(cacheKey, output);
                }

                toolCallTracker?.record(tachikomaTool.name, runtimeInput, isSuccess, errorMsg);

                return {
                  success: isSuccess,
                  isError: !isSuccess,
                  output,
                };
              } catch (error) {
                const err = error as Error;
                if (err.name === 'ToolCallBudgetExceededError') {
                  this.abortExecution();
                  throw err;
                }
                // 返回结构化错误
                console.error(`[OpenAIAgentsBackend] Tool ${tachikomaTool.name} error:`, err);
                const output = JSON.stringify(
                  createSyntheticToolFailureOutput({
                    toolName: tachikomaTool.name,
                    code: 'TOOL_EXECUTION_ERROR',
                    error: err.message,
                    kind: 'execution',
                  })
                );
                if (cacheKey) {
                  toolResultCache?.set(cacheKey, output);
                }
                // 记录异常（失败）
                toolCallTracker?.record(tachikomaTool.name, runtimeInput, false, err.message);
                // 记录到失败记忆系统进行模式分析
                failureMemory?.recordFailure(tachikomaTool.name, runtimeInput, err.message);
                return {
                  success: false,
                  isError: true,
                  output,
                };
              }
            },
          });
          return typeof runtimeResult.output === 'string'
            ? runtimeResult.output
            : JSON.stringify(runtimeResult.output);
        },
        // 设置审批标记
        // 仅当 requireApproval=true 或 keyDecisionPolicy.enabled=true 时才设置 needsApproval
        needsApproval: this.needsApproval(options, tachikomaTool.name)
          ? async (_context: unknown, params: unknown) => {
              // 用实际输入判断
              const inputDecision = await isKeyDecisionAsync(
                tachikomaTool.name,
                params as Record<string, unknown>,
                tachikomaTool,
                executionContext,
                options.keyDecisionPolicy,
                options.riskPolicy,
                options.unknownToolPolicy
              );
              return inputDecision.isKeyDecision;
            }
          : false, // requireApproval=false 且 keyDecisionPolicy.enabled=false 时不设置审批
      });
    });
  }

  /**
   * 从 SDK 中断创建审批请求消息
   * 
   * SDK ToolApprovalItem / function_call 结构:
   * - rawItem.name / name: 工具名
   * - rawItem.arguments / arguments: JSON 字符串 或 对象
   * - rawItem.callId / callId / id: 调用 ID
   */
  private createApprovalRequestFromInterruption(
    interruption: SDKInterruption,
    _task: WorkerTask,
    keyDecisionPolicy?: KeyDecisionPolicy,
    riskPolicy?: RiskPolicy
  ): WorkerApprovalRequestMessage {
    // 从 rawItem 或备用字段获取工具信息
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (interruption.rawItem || {}) as any;
    
    // 优先使用 rawItem 的字段 (camelCase or snake_case)
    const toolName = (raw.name || raw.tool_name || interruption.toolName || 'unknown') as string;
    const callId = (raw.callId || raw.call_id || raw.id || interruption.callId || `approval-${Date.now()}`) as string;
    
    // 解析 arguments JSON 字符串 or Object
    let parsedArgs: Record<string, unknown> = {};
    const argsSource = raw.arguments || interruption.arguments;
    
    if (typeof argsSource === 'string') {
      try {
        parsedArgs = JSON.parse(argsSource);
      } catch {
        parsedArgs = { raw: argsSource };
      }
    } else if (argsSource && typeof argsSource === 'object') {
      parsedArgs = argsSource as Record<string, unknown>;
    }

    const tool = this.toolMap.get(toolName);
    const decision = isKeyDecision(
      toolName,
      parsedArgs,
      tool,
      keyDecisionPolicy,
      riskPolicy
    );

    return {
      type: 'approval_request',
      requestId: callId,
      action: toolName,
      description: decision.reason || `Tool ${toolName} requires approval`,
      details: { 
        toolInput: parsedArgs,
        riskLevel: decision.riskLevel,
      },
      timestamp: Date.now(),
      category: decision.category,
      timeout: 300000,
      defaultDecision: 'reject',
    };
  }

  // handleApprovalRequest 已移除 - 使用 createApprovalRequestFromInterruption + waitForApproval

  /**
   * 映射审批类别到 PendingApprovalInput.type
   */
  protected override mapCategoryToApprovalType(
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
      case 'doom_loop':
        return 'resource_intensive';
      default:
        return 'dangerous_operation';
    }
  }

  /**
   * 映射 SDK 流事件为 WorkerMessage
   *
   * SDK 事件:
   * - message_output_created: 消息输出 -> rawItem.content (output_text)
   * - reasoning_item_created: 思考 -> rawItem.content (reasoning_text)
   * - tool_called: 工具调用 -> rawItem (function_call)
   * - tool_output: 工具结果 -> rawItem (function_call_result)
   */
  private mapSDKEvent(event: SDKStreamEvent): WorkerMessage[] {
    const messages: WorkerMessage[] = [];

    // 只处理 run_item_stream_event
    if (event.type !== 'run_item_stream_event') {
      return messages;
    }

    const item = event.item;
    if (!item) return messages;

    // 获取 rawItem
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItem = (item as any).rawItem || item;

    switch (event.name) {
      // 消息输出
      case 'message_output_created': {
        const content = rawItem.content || [];
        if (Array.isArray(content)) {
          // 提取 output_text 类型的文本
          const text = content
            .filter((c: any) => c.type === 'output_text')
            .map((c: any) => c.text || '')
            .join('');
          if (text) {
            messages.push(createOutputMessage(text));
          }
        } else if (typeof content === 'string') {
          // 兼容可能为 string 的情况
          messages.push(createOutputMessage(content));
        }
        break;
      }

      // 思考/推理
      case 'reasoning_item_created': {
        // reasoning item rawContent structure check
        const rawContent = rawItem.rawContent || rawItem.content || [];
        if (Array.isArray(rawContent)) {
           const text = rawContent
            .filter((c: any) => c.type === 'reasoning_text' || c.type === 'text')
            .map((c: any) => c.text || '')
            .join('');
           if (text) {
             messages.push(createThinkingMessage(text));
           }
        }
        break;
      }

      // 工具调用
      case 'tool_called': {
        // rawItem matches ToolCallItem (function_call, hosted_tool_call, etc)
        const callId = rawItem.callId || rawItem.id || `call-${Date.now()}`;
        
        let toolName = 'unknown';
        let args: Record<string, unknown> = {};

        if (rawItem.type === 'function_call') {
          toolName = rawItem.name;
          try {
            args = JSON.parse(rawItem.arguments || '{}');
          } catch {
            args = { raw: rawItem.arguments };
          }
        } else if (rawItem.type === 'hosted_tool_call') {
          toolName = rawItem.name;
          // hosted tool args might be object or string
          const rawArgs = rawItem.arguments;
          if (typeof rawArgs === 'string') {
             try { args = JSON.parse(rawArgs); } catch { args = { raw: rawArgs }; }
          } else {
             args = rawArgs || {};
          }
        }

        // Guard against repeated tool calls (prevents infinite loops)
        this.guardAgainstRepeatedToolCall(toolName, args);

        messages.push(createToolCallMessage(toolName, args, callId));
        break;
      }

      // 工具结果
      case 'tool_output': {
         // rawItem matches ToolCallOutputItem (function_call_result, etc)
         const callId = rawItem.callId || rawItem.id || `call-${Date.now()}`;
         const toolName = rawItem.name || 'unknown';
         
         let output = '';
         if (rawItem.type === 'function_call_result') {
            output = typeof rawItem.output === 'string' ? rawItem.output : JSON.stringify(rawItem.output);
         } else if (rawItem.output) {
            output = typeof rawItem.output === 'string' ? rawItem.output : JSON.stringify(rawItem.output);
         }

         // Best-effort: parse structured ToolResult JSON to set success accurately.
         let success = true;
         try {
           const parsed = JSON.parse(output) as unknown;
           if (parsed && typeof parsed === 'object' && 'success' in (parsed as any)) {
             success = Boolean((parsed as any).success);
           }
         } catch {
           // Non-JSON output -> assume success (transport succeeded).
         }
         messages.push(createToolResultMessage(toolName, callId, output, success, 0));
         break;
      }

      // 忽略其他事件
      default:
        break;
    }

    return messages;
  }
}
