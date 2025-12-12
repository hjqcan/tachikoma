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
// Context Engineering 模块（Task 8）
import {
  createContextManager,
  createDefaultContextConfig,
  type ContextMessage,
  type ContextManagerDependencies,
} from '../../context';
// Skills 模块
import {
  loadSkills,
  renderSkillsSection,
  type SkillMetadata,
  type SkillLoadOutcome,
} from '../../skills';
// Memory 模块
import { MemoryService } from '../../memory';

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认系统提示
 */
const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant that can use tools to accomplish tasks.
When given a task, think step by step about how to accomplish it, then use the available tools.
Always provide clear explanations of what you're doing and why.

## File Path Guidelines

⚠️ CRITICAL: Always use RELATIVE paths for all file operations.
- ✅ Correct: \`./src/index.js\`, \`package.json\`, \`src/utils/helper.ts\`
- ❌ Wrong: \`/absolute/path/project/src/index.js\`, \`project-name/src/index.js\`

DO NOT create directories that duplicate the project name. You are already in the project directory.

## File Modification Guidelines

IMPORTANT: When modifying existing files, prefer incremental edits over full rewrites to reduce output size and errors.

**Tool Selection Priority:**
1. \`apply_patch\` - For search/replace edits (PREFERRED for modifications)
2. \`replace_between_markers\` - For replacing content between markers/delimiters
3. \`file_write\` with \`append: true\` - For adding content to end of files
4. \`file_write\` (full content) - ONLY for new files or complete rewrites when necessary

**When to use apply_patch:**
- Changing function names, parameters, or return values
- Fixing bugs or typos in specific lines
- Adding/removing imports, exports, or dependencies
- Any targeted modification to existing code

**Example apply_patch usage:**
\`\`\`json
{
  "path": "config.js",
  "patches": [
    { "search": "debug: false", "replace": "debug: true" },
    { "search": "port: 3000", "replace": "port: 8080" }
  ]
}
\`\`\`

**When creating new files:**
- For large files (>50 lines), consider creating a skeleton first, then using apply_patch to fill in details
- This helps avoid output truncation issues

## Directory Listing Guidelines

⚠️ When using file_list tool:
- The tool automatically EXCLUDES node_modules, .git, dist, build, and other large directories when recursive=true
- Results are limited to 500 files by default to prevent context overflow
- If you need to see excluded directories, explicitly set excludes: [] to override defaults
- For large projects, prefer non-recursive listing first, then drill down into specific directories`;

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
// 上下文辅助函数（Task 8）
// ============================================================================

let messageIdCounter = 0;

/**
 * 创建用户消息
 */
function createUserMessage(content: string): ContextMessage {
  return {
    id: `user-${++messageIdCounter}`,
    role: 'user',
    content,
    timestamp: Date.now(),
    format: 'full',
  };
}

/**
 * 创建助手消息
 */
function createAssistantMessage(content: string): ContextMessage {
  return {
    id: `assistant-${++messageIdCounter}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    format: 'full',
  };
}

/**
 * 创建工具结果消息
 */
function createToolMessage(toolCallId: string, result: string): ContextMessage {
  return {
    id: `tool-${++messageIdCounter}`,
    role: 'tool',
    content: result,
    timestamp: Date.now(),
    format: 'full',
    toolResult: {
      callId: toolCallId,
      output: result,
      success: true,
    },
  };
}

/**
 * 将上下文消息转换为 LLM 可接受的格式
 * 
 * 注意：system 消息（如摘要、状态提醒）转换为 user 消息注入，
 * 以保留压缩后的上下文信息
 */
function contextToLLMMessages(
  context: ContextMessage[]
): { role: 'user' | 'assistant'; content: string }[] {
  const result: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const msg of context) {
    if (msg.role === 'tool') {
      result.push({
        role: 'user',
        content: `Tool result: ${msg.content}`,
      });
    } else if (msg.role === 'system') {
      // System 消息（摘要、状态提醒等）转换为 user 消息注入
      result.push({
        role: 'user',
        content: `[System Context]\n${msg.content}`,
      });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return result;
}

// ============================================================================
// 进度追踪器
// ============================================================================

/**
 * 单轮执行进度
 */
interface RoundProgress {
  round: number;
  stopReason: string;
  toolCallsAttempted: number;     // 解析出的工具调用数
  toolCallsSucceeded: number;     // 成功执行的工具调用数
  toolCallsParseFailed: boolean;  // 工具调用 XML 被截断
  outputHash: string;             // 输出内容 hash（检测重复）
  toolCallHash?: string;          // 工具调用内容 hash（检测重复调用）
}

/**
 * 降级策略级别
 */
type DegradationLevel = 0 | 1 | 2 | 3;

/**
 * 进度追踪器
 * 
 * 追踪执行进度，检测死循环和无进展状态。
 * 当连续多轮没有实质进展时，触发策略降级。
 */
class ProgressTracker {
  private history: RoundProgress[] = [];
  private noProgressCount = 0;
  private lastOutputHash = '';
  private lastInjectedLevel: DegradationLevel = 0;
  private toolCallHashHistory: string[] = [];  // 追踪最近的工具调用 hash
  private repeatToolCallCount = 0;             // 连续重复工具调用计数
  
  /**
   * 记录一轮执行的进度
   */
  recordRound(progress: RoundProgress): void {
    this.history.push(progress);
    
    if (this.hasProgress(progress)) {
      this.noProgressCount = 0;
      this.lastInjectedLevel = 0; // Reset on progress
    } else {
      this.noProgressCount++;
      console.warn(
        `[ProgressTracker] No progress detected. Count: ${this.noProgressCount}. ` +
        `stopReason=${progress.stopReason}, toolCallsSucceeded=${progress.toolCallsSucceeded}, ` +
        `toolCallsParseFailed=${progress.toolCallsParseFailed}`
      );
    }
    
    this.lastOutputHash = progress.outputHash;
  }
  
  /**
   * 判断本轮是否有实质进展
   */
  private hasProgress(progress: RoundProgress): boolean {
    // 正常完成（没有工具调用请求且 stop reason 是 stop）
    if (progress.stopReason === 'stop' && progress.toolCallsAttempted === 0) {
      return true;
    }
    
    // 检测重复的工具调用
    if (progress.toolCallHash) {
      const lastHash = this.toolCallHashHistory[this.toolCallHashHistory.length - 1];
      if (lastHash === progress.toolCallHash) {
        this.repeatToolCallCount++;
        console.warn(
          `[ProgressTracker] Repeated tool call detected. RepeatCount: ${this.repeatToolCallCount}`
        );
        // 连续 3 次相同的工具调用 = 卡死
        if (this.repeatToolCallCount >= 3) {
          return false;
        }
      } else {
        this.repeatToolCallCount = 0;
      }
      // 保留最近 10 个 hash
      this.toolCallHashHistory.push(progress.toolCallHash);
      if (this.toolCallHashHistory.length > 10) {
        this.toolCallHashHistory.shift();
      }
    }
    
    // 有成功的工具调用
    if (progress.toolCallsSucceeded > 0) {
      return true;
    }
    
    // 被截断且无工具调用成功 = 无进展
    if (progress.stopReason === 'length' || progress.toolCallsParseFailed) {
      return false;
    }
    
    // 输出与上轮相同 = 无进展
    if (progress.outputHash === this.lastOutputHash && this.lastOutputHash !== '') {
      return false;
    }
    
    return true;
  }
  
  getNoProgressCount(): number {
    return this.noProgressCount;
  }
  
  shouldDegradeStrategy(): boolean {
    return this.noProgressCount >= 3;
  }
  
  /**
   * 获取降级级别
   * 0 = 正常, 1 = 第一次降级（约束输出）, 2 = 第二次降级（终止任务）, 3+ = 强制终止
   */
  getDegradationLevel(): DegradationLevel {
    if (this.noProgressCount < 3) return 0;
    if (this.noProgressCount < 6) return 1;
    if (this.noProgressCount < 9) return 2;
    return 3;
  }
  
  /**
   * 获取降级提示消息（仅当级别提升时返回消息）
   */
  getDegradationMessage(): string | null {
    const level = this.getDegradationLevel();
    
    // 只有当级别提升时才返回消息，避免重复注入
    if (level === 0 || level <= this.lastInjectedLevel) return null;
    
    // 更新已注入的级别
    this.lastInjectedLevel = level;
    
    if (level === 1) {
      return `⚠️ 检测到你的输出被截断了（已连续 ${this.noProgressCount} 次无进展）。

请调整你的策略：
1. 不要一次性生成完整文件
2. 每次只生成一个函数或一个代码块（最多 100 行）
3. 使用 <!-- CONTINUE_FROM: 上次结束的位置 --> 标记
4. 优先使用 apply_patch 工具进行增量修改

如果文件很长，请分多次写入。`;
    }
    
    if (level === 2) {
      return `⚠️ 连续 ${this.noProgressCount} 次无进展。请立即完成当前步骤或报告问题。

建议：
- 简化你的输出，只完成最小可行版本
- 如果任务太复杂，请说明并建议如何拆分`;
    }
    
    return null; // level 3 会直接终止，不需要消息
  }
  
  getHistory(): RoundProgress[] {
    return [...this.history];
  }
  
  reset(): void {
    this.history = [];
    this.noProgressCount = 0;
    this.lastOutputHash = '';
  }
}

/**
 * 简单 hash 函数（用于检测重复输出）
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
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
 * 解析文本中的工具调用
 *
 * 支持多种格式：
 * - JSON 格式：{"tool": "name", "input": {...}}
 * - 函数调用格式：tool_name(arg1, arg2)
 * - XML 格式：<tool_use><name>...</name><input>...</input></tool_use>
 * 
 * 注意：单次响应最多解析 MAX_CALLS_PER_RESPONSE 个工具调用，
 * 防止 LLM 幻觉生成大量重复调用。
 */
const MAX_CALLS_PER_RESPONSE = 20;

function parseToolCalls(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 尝试解析 JSON 格式
  try {
    const jsonMatch = content.match(/\{[\s\S]*"tool"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        // 检查是否达到单次响应最大调用数限制
        if (calls.length >= MAX_CALLS_PER_RESPONSE) {
          console.warn(
            `[parseToolCalls] Truncated tool calls: reached max ${MAX_CALLS_PER_RESPONSE} calls per response. ` +
            `This may indicate LLM generating excessive duplicate tool calls.`
          );
          return calls; // 直接返回，不再解析其他格式
        }
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
    // 检查是否达到单次响应最大调用数限制
    if (calls.length >= MAX_CALLS_PER_RESPONSE) {
      console.warn(
        `[parseToolCalls] Truncated tool calls: reached max ${MAX_CALLS_PER_RESPONSE} calls per response. ` +
        `This may indicate LLM generating excessive duplicate tool calls.`
      );
      break;
    }

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
  
  // Skills 支持
  private skills: SkillMetadata[] = [];
  private skillLoadErrors: SkillLoadOutcome['errors'] = [];

  // Memory 支持
  private memoryService?: MemoryService;

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

    // 加载 Skills
    if (config.skillsConfig?.enabled !== false) {
      const outcome = loadSkills(
        config.skillsConfig ?? {},
        config.workDir ?? process.cwd()
      );
      this.skills = outcome.skills;
      this.skillLoadErrors = outcome.errors;
      
      if (this.skills.length > 0) {
        console.debug(`[GenericAgentBackend] Loaded ${this.skills.length} skills`);
      }
      if (this.skillLoadErrors.length > 0) {
        console.warn('[GenericAgentBackend] Skill loading errors:', this.skillLoadErrors);
      }
    }

    // 初始化 MemoryService
    if (config.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(config.memoryConfig);
      console.debug('[GenericAgentBackend] MemoryService initialized');
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
    // Task 8: 直接使用 ContextManager，将 maxMessageWindow 映射到阈值
    let contextConfig = this.config.contextManagerConfig 
      ?? createDefaultContextConfig(this.config.workDir ?? '/tmp');
    
    // 如果没有显式配置，根据 maxMessageWindow 估算阈值
    // 假设平均每条消息 ~2000 tokens
    if (!this.config.contextManagerConfig && limits.maxMessageWindow) {
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
    
    const contextDeps: ContextManagerDependencies = {};
    if (this.memoryService) {
      contextDeps.memoryProvider = this.memoryService;
    }
    const context = createContextManager(contextConfig, contextDeps);
    
    // Token 使用追踪（独立于 ContextManager）
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

    // 构建工具描述
    const toolDescriptions = this.buildToolDescriptions(tools);

    // 初始用户消息
    context.addMessage(createUserMessage(`Task: ${task.objective}

Constraints:
${task.constraints?.map((c) => `- ${c}`).join('\n') || 'None'}

Available tools:
${toolDescriptions}

Please accomplish this task step by step. When you need to use a tool, output it in this format:
<tool_use>
<name>tool_name</name>
<input>{"param": "value"}</input>
</tool_use>

When the task is complete, provide a final summary of what was accomplished.`));

    // 构建带 Skills 的 system prompt（缓存，避免每轮重建）
    let systemPromptWithSkills = DEFAULT_SYSTEM_PROMPT;
    const skillsSection = renderSkillsSection(
      this.skills,
      this.config.skillsConfig?.maxSkillTokens
    );
    if (skillsSection) {
      systemPromptWithSkills += '\n\n' + skillsSection;
    }

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

        // Task 8: 在 LLM 调用前检查并执行上下文压缩
        if (context.needsReduction()) {
          console.debug('[GenericAgentBackend] Context needs reduction, running autoReduce');
          // eslint-disable-next-line no-await-in-loop -- Auto-reduce is intentionally sequential
          await context.autoReduce();
          
          // 如果 autoReduce 后仍然需要压缩（可能 deps 不完整导致失败）
          // 强制执行压缩操作以避免超出模型上下文窗口
          if (context.needsReduction()) {
            console.warn('[GenericAgentBackend] Context still over limit after autoReduce, forcing compact');
            // 尝试最多 3 轮压缩
            for (let i = 0; i < 3 && context.needsReduction(); i++) {
              // eslint-disable-next-line no-await-in-loop -- Sequential compaction attempts
              await context.compact();
            }
          }
          
          // 硬限制兜底：如果仍然超过限制，需要处理
          if (context.needsSummarization()) {
            // 超过硬限制，中止本轮执行并报告错误
            console.error('[GenericAgentBackend] Context exceeds hard limit after all reduction attempts');
            yield {
              type: 'error',
              error: `Context size exceeds hard limit after reduction. Token count: ${context.getState().totalTokens}`,
              code: 'CONTEXT_OVERFLOW',
              retryable: false,
              timestamp: Date.now(),
            };
            done = true;
            break;
          }
          
          // 压缩成功后注入状态提醒帮助 agent 理解上下文变化
          context.injectStatusReminder();
        }

        // Memory: 自动检索相关记忆 (best-effort, 不中断主循环)
        const autoRetrieve = this.config.memoryConfig?.autoRetrieve !== false;
        if (this.memoryService && autoRetrieve && context.shouldRetrieveMemories()) {
          try {
            console.debug('[GenericAgentBackend] Retrieving relevant memories...');
            // eslint-disable-next-line no-await-in-loop
            const memoryResult = await this.memoryService.search(context.getContext());
            if (memoryResult.memories.length > 0) {
              console.debug(`[GenericAgentBackend] Injected ${memoryResult.memories.length} memories`);
              context.injectRetrievedMemories(memoryResult.memories);
            }
          } catch (memoryError) {
            console.warn('[GenericAgentBackend] Memory retrieval failed (continuing):', memoryError);
          }
        }

        // 调用 LLM
        const request: LLMRequest = {
          systemPrompt: systemPromptWithSkills,
          messages: contextToLLMMessages(context.getContext()),
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
        recordTokenUsage(
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        // 检查 token 预算 - 超过预算时尝试压缩上下文而不是直接失败
        if (isOverBudget()) {
          console.warn(
            `[GenericAgentBackend] Token budget warning: ${totalTokensUsed}/${maxTotalTokens}. ` +
            `Attempting context reduction before continuing...`
          );
          
          // 触发上下文压缩/摘要
          // eslint-disable-next-line no-await-in-loop -- Context reduction is intentionally sequential
          await context.autoReduce();
          
          // 如果 autoReduce 后仍然需要压缩，尝试多轮压缩
          if (context.needsReduction()) {
            console.debug('[GenericAgentBackend] Context still large after autoReduce, forcing compact');
            for (let i = 0; i < 3 && context.needsReduction(); i++) {
              // eslint-disable-next-line no-await-in-loop -- Sequential compaction attempts
              await context.compact();
            }
          }
          
          // 注入状态提醒帮助 agent 理解上下文变化
          context.injectStatusReminder();
          
          // 报告压缩结果
          const contextState = context.getState();
          console.debug(
            `[GenericAgentBackend] Context reduced. New token count: ${contextState.totalTokens}. ` +
            `Messages: ${contextState.messages.length}. Continuing execution...`
          );
          
          yield {
            type: 'thinking',
            content: `[Context Management] Token budget reached (${totalTokensUsed}/${maxTotalTokens}). ` +
                     `Context has been summarized/compressed (now ${contextState.totalTokens} tokens). Continuing...`,
            timestamp: Date.now(),
          };
          
          // 注意：我们不再直接失败，而是继续执行
          // 如果上下文压缩成功，下一轮 LLM 调用将使用更少的 input tokens
          // 真正的硬限制检查在 context.needsSummarization() -> hardLimit
        }

        // 发出思考消息
        yield {
          type: 'thinking',
          content: response.content,
          timestamp: Date.now(),
        };

        // 添加到上下文
        context.addMessage(createAssistantMessage(response.content));

        // 追踪本轮进度
        const hasToolCallMarker = containsToolCall(response.content);
        const toolCalls = hasToolCallMarker ? parseToolCalls(response.content) : [];
        const toolCallsParseFailed = hasToolCallMarker && toolCalls.length === 0;
        let toolCallsSucceeded = 0;
        
        // 更新待执行工具调用（用于检测 loop 提前终止时是否有未执行的调用）
        pendingToolCalls = toolCalls;

        // 检查是否有工具调用
        if (hasToolCallMarker && toolCalls.length > 0) {
          
          // 清空待执行队列（即将执行）
          pendingToolCalls = [];

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
                context.addMessage(createToolMessage(call.callId, rejectedResult));

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
            
            // 记录成功的工具调用
            if (result.success) {
              toolCallsSucceeded++;
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
              done = true;
              break;
            }

            // 添加结果到上下文
            context.addMessage(createToolMessage(call.callId, JSON.stringify(result.output)));

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

          // Memory: 自动保存任务结果 (best-effort, 不中断主循环)
          const autoSave = this.config.memoryConfig?.autoSave !== false;
          if (this.memoryService && autoSave) {
            try {
              console.debug('[GenericAgentBackend] Saving task result to memory...');
              // eslint-disable-next-line no-await-in-loop
              await this.memoryService.save({
                content: `Task: ${task.objective}\n\nResult: ${response.content}`,
                scope: 'procedural',
                metadata: {
                  sessionId: task.sessionId,
                  taskId: task.id,
                  type: 'task_result',
                },
              });
            } catch (memorySaveError) {
              console.warn('[GenericAgentBackend] Memory save failed (continuing):', memorySaveError);
            }
          }

          yield {
            type: 'output',
            content: response.content,
            timestamp: Date.now(),
          };
        }

        // 记录本轮进度
        // 计算工具调用 hash 用于检测重复调用
        const toolCallHash = toolCalls.length > 0
          ? simpleHash(toolCalls.map(c => `${c.name}:${JSON.stringify(c.input)}`).join('|'))
          : undefined;
        
        progressTracker.recordRound({
          round,
          stopReason: response.stopReason ?? 'unknown',
          toolCallsAttempted: toolCalls.length,
          toolCallsSucceeded,
          toolCallsParseFailed,
          outputHash: simpleHash(response.content),
          ...(toolCallHash && { toolCallHash }),
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
            done = true;
            break;
          }
          
          // Level 1-2: 注入降级提示
          if (degradationMessage) {
            context.addMessage(createUserMessage(degradationMessage));
          }
        }

        // 检查停止原因
        if (response.stopReason === 'stop' && !hasToolCallMarker) {
          console.debug('[GenericAgentBackend] Loop stop: reason is stop and no tool call');
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
          
          let graceRoundSucceeded = 0;
          let graceRoundFailed = 0;
          
          for (const call of pendingToolCalls) {
            // 检查 maxToolCalls 限制
            if (totalToolCalls >= limits.maxToolCalls) {
              console.warn(
                `[GenericAgentBackend] Grace round: max tool calls (${limits.maxToolCalls}) reached. ` +
                `Remaining ${pendingToolCalls.length - graceRoundSucceeded - graceRoundFailed} calls skipped.`
              );
              yield {
                type: 'error',
                error: `Grace round: max tool calls limit reached. Some pending calls were not executed.`,
                code: 'GRACE_ROUND_MAX_TOOLS_EXCEEDED',
                retryable: false,
                timestamp: Date.now(),
              };
              break;
            }
            
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
            
            // 保留关键决策审批流程（不绕过安全策略）
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
                requestId: `approval-grace-${call.callId}`,
                action: call.name,
                description: `[Grace Round] ${keyDecisionResult.reason}: ${call.name}`,
                details: { 
                  tool: call.name, 
                  input: call.input,
                  category: keyDecisionResult.category,
                  riskLevel: keyDecisionResult.riskLevel,
                  graceRound: true,
                },
                timestamp: Date.now(),
                category: keyDecisionResult.category,
                defaultDecision: options.keyDecisionPolicy?.defaultDecision ?? DEFAULT_KEY_DECISION_POLICY.defaultDecision,
                timeout: options.keyDecisionPolicy?.approvalTimeout ?? DEFAULT_KEY_DECISION_POLICY.approvalTimeout,
              };

              yield approvalRequest;

              // eslint-disable-next-line no-await-in-loop -- Approval is intentionally sequential
              const approved = await this.waitForApproval(approvalRequest, options, task.id);
              if (!approved) {
                const rejectedResult = `[Grace Round] Tool call ${call.name} was rejected by approval process.`;
                context.addMessage(createToolMessage(call.callId, rejectedResult));
                graceRoundFailed++;

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
            // eslint-disable-next-line no-await-in-loop -- Grace round tool execution is intentionally sequential
            const result = await this.executeTool(call, tools, options);
            const duration = Date.now() - startTime;
            totalToolCalls++;
            
            if (result.success) {
              graceRoundSucceeded++;
            } else {
              graceRoundFailed++;
            }

            // 添加结果到上下文
            context.addMessage(createToolMessage(call.callId, JSON.stringify(result.output)));

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
          
          // 清空待执行队列
          pendingToolCalls = [];
          
          // 根据执行结果决定最终状态
          // 只有所有工具调用都成功时才标记为完成
          if (graceRoundFailed === 0 && graceRoundSucceeded > 0) {
            done = true;
            console.debug(`[GenericAgentBackend] Grace round completed successfully. ${graceRoundSucceeded} tools executed.`);
          } else if (graceRoundSucceeded > 0) {
            // 部分成功：仍标记为完成，但发出警告
            done = true;
            console.warn(
              `[GenericAgentBackend] Grace round partially succeeded. ` +
              `${graceRoundSucceeded} succeeded, ${graceRoundFailed} failed.`
            );
            yield {
              type: 'error',
              error: `Grace round partially succeeded: ${graceRoundSucceeded} succeeded, ${graceRoundFailed} failed.`,
              code: 'GRACE_ROUND_PARTIAL_SUCCESS',
              retryable: false,
              timestamp: Date.now(),
            };
          } else {
            // 全部失败
            console.error(`[GenericAgentBackend] Grace round failed. All ${graceRoundFailed} tool calls failed.`);
            yield {
              type: 'error',
              error: `Grace round failed: all ${graceRoundFailed} tool calls failed.`,
              code: 'GRACE_ROUND_FAILED',
              retryable: false,
              timestamp: Date.now(),
            };
          }
        }
      }

      // 发出完成状态
      yield {
        type: 'status',
        status: done ? 'completed' : 'failed',
        timestamp: Date.now(),
        tokensUsed: totalTokensUsed,
      };

      // 如果达到最大轮次，发出警告（但如果 grace round 成功执行了，不算失败）
      if (round >= limits.maxThinkingRounds && !done) {
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
