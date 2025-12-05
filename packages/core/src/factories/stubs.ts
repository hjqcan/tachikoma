/**
 * Stub 实现
 *
 * 提供基础的占位实现，用于测试和开发阶段
 */

import type {
  Agent,
  AgentType,
  AgentConfig,
  Task,
  TaskResult,
  Sandbox,
  SandboxStatus,
  SandboxConfig,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  ContextManager,
  ContextThresholds,
  ConversationContext,
  ConversationSummary,
  Message,
  CompactionStrategy,
  SummarySchema,
  TraceData,
} from '../types';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成唯一 ID
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 创建默认追踪数据
 */
function createDefaultTraceData(operation: string): TraceData {
  return {
    traceId: generateId('trace'),
    spanId: generateId('span'),
    operation,
    attributes: {},
    events: [],
    duration: 0,
  };
}


// ============================================================================
// Stub Agent 实现
// ============================================================================

/**
 * Stub Agent 实现
 *
 * 提供基础的 Agent 接口实现，返回占位结果
 */
export class StubAgent implements Agent {
  readonly id: string;
  readonly type: AgentType;
  readonly config: AgentConfig;

  private running = false;

  constructor(id: string, type: AgentType, config: AgentConfig) {
    this.id = id;
    this.type = type;
    this.config = config;
  }

  async run(task: Task): Promise<TaskResult> {
    if (this.running) {
      throw new Error(`Agent ${this.id} is already running`);
    }

    this.running = true;
    const startTime = Date.now();

    try {
      // 模拟执行延迟
      await new Promise(resolve => setTimeout(resolve, 10));

      const endTime = Date.now();

      return {
        taskId: task.id,
        status: 'success',
        output: {
          message: `Stub agent ${this.id} completed task ${task.id}`,
          objective: task.objective,
        },
        artifacts: [],
        metrics: {
          startTime,
          endTime,
          duration: endTime - startTime,
          tokensUsed: 0,
          toolCallCount: 0,
          retryCount: 0,
        },
        trace: createDefaultTraceData(`agent.${this.type}.run`),
      };
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}

// ============================================================================
// Stub Sandbox 实现
// ============================================================================

/**
 * Stub Sandbox 实现
 *
 * 提供基础的 Sandbox 接口实现，模拟沙盒行为
 */
export class StubSandbox implements Sandbox {
  readonly id: string;
  private _status: SandboxStatus = 'running';
  private files = new Map<string, string>();

  constructor(id: string, _config: SandboxConfig) {
    this.id = id;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  async execute(code: string, _options?: ExecutionOptions): Promise<ExecutionResult> {
    if (this._status !== 'running') {
      return {
        success: false,
        stdout: '',
        stderr: `Sandbox ${this.id} is not running (status: ${this._status})`,
        exitCode: 1,
        duration: 0,
      };
    }

    const startTime = Date.now();

    // 模拟执行
    await new Promise(resolve => setTimeout(resolve, 5));

    const duration = Date.now() - startTime;

    return {
      success: true,
      stdout: `[Stub] Executed code (${code.length} chars)`,
      stderr: '',
      exitCode: 0,
      duration,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this._status !== 'running') {
      throw new Error(`Sandbox ${this.id} is not running`);
    }
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string> {
    if (this._status !== 'running') {
      throw new Error(`Sandbox ${this.id} is not running`);
    }
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async runCommand(command: string): Promise<CommandResult> {
    if (this._status !== 'running') {
      return {
        command,
        success: false,
        stdout: '',
        stderr: `Sandbox ${this.id} is not running (status: ${this._status})`,
        exitCode: 1,
        duration: 0,
      };
    }

    const startTime = Date.now();

    // 模拟命令执行
    await new Promise(resolve => setTimeout(resolve, 5));

    const duration = Date.now() - startTime;

    return {
      command,
      success: true,
      stdout: `[Stub] Executed command: ${command}`,
      stderr: '',
      exitCode: 0,
      duration,
    };
  }

  async destroy(): Promise<void> {
    this._status = 'stopped';
    this.files.clear();
  }
}

// ============================================================================
// Stub ContextManager 实现
// ============================================================================

/**
 * Stub ContextManager 实现
 *
 * 提供基础的上下文管理接口实现
 */
export class StubContextManager implements ContextManager {
  private readonly sessionId: string;
  private messages: Message[] = [];
  private tokenCount = 0;

  constructor(sessionId: string, _thresholds: ContextThresholds) {
    this.sessionId = sessionId;
  }

  getContext(): ConversationContext {
    return {
      sessionId: this.sessionId,
      messages: [...this.messages],
      toolCalls: [],
      tokenCount: this.tokenCount,
    };
  }

  addMessage(message: Message): void {
    this.messages.push(message);
    // 简单估算 token 数（实际应使用 tiktoken 等库）
    this.tokenCount += Math.ceil(message.content.length / 4);
  }

  compact(strategy: CompactionStrategy): void {
    // Stub 实现：仅保留最近的消息
    const keepCount = strategy === 'aggressive' ? 5 : strategy === 'balanced' ? 10 : 20;
    if (this.messages.length > keepCount) {
      this.messages = this.messages.slice(-keepCount);
      this.tokenCount = this.messages.reduce(
        (sum, msg) => sum + Math.ceil(msg.content.length / 4),
        0
      );
    }
  }

  summarize(schema: SummarySchema): ConversationSummary {
    // Stub 实现：返回基础摘要
    return {
      modifiedFiles: schema.includeModifiedFiles ? [] : [],
      userGoal: schema.includeUserGoal ? 'Unknown goal' : '',
      lastStopPoint: 'No stop point recorded',
      keyDecisions: schema.includeKeyDecisions ? [] : [],
      unresolvedIssues: schema.includeUnresolvedIssues ? [] : [],
      nextSteps: schema.includeNextSteps ? [] : [],
    };
  }

  getTokenCount(): number {
    return this.tokenCount;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Stub Agent
 */
export function createStubAgent(
  id: string,
  type: AgentType,
  config: AgentConfig
): StubAgent {
  return new StubAgent(id, type, config);
}

/**
 * 创建 Stub Sandbox
 */
export function createStubSandbox(id: string, config: SandboxConfig): StubSandbox {
  return new StubSandbox(id, config);
}

/**
 * 创建 Stub ContextManager
 */
export function createStubContextManager(
  sessionId: string,
  thresholds: ContextThresholds
): StubContextManager {
  return new StubContextManager(sessionId, thresholds);
}

