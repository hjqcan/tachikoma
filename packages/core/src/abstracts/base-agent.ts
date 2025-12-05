/**
 * Agent 抽象基类
 *
 * 提供 Agent 接口的基础实现，处理通用字段、生命周期钩子与日志上下文
 */

import type {
  Agent,
  AgentType,
  AgentConfig,
  Task,
  TaskResult,
  TraceData,
} from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Agent 状态
 */
export type AgentState = 'idle' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * Agent 生命周期钩子
 */
export interface AgentLifecycleHooks {
  /** 任务开始前调用 */
  onBeforeRun?(task: Task): Promise<void>;
  /** 任务完成后调用 */
  onAfterRun?(task: Task, result: TaskResult): Promise<void>;
  /** 发生错误时调用 */
  onError?(task: Task, error: Error): Promise<void>;
  /** Agent 停止时调用 */
  onStop?(): Promise<void>;
}

/**
 * Agent 日志上下文
 */
export interface AgentLogContext {
  agentId: string;
  agentType: AgentType;
  taskId: string | undefined;
  traceId: string | undefined;
  spanId?: string;
  [key: string]: unknown;
}

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
function createTraceData(operation: string, agentId: string): TraceData {
  return {
    traceId: generateId('trace'),
    spanId: generateId('span'),
    operation,
    attributes: { agentId },
    events: [],
    duration: 0,
  };
}

// ============================================================================
// 抽象基类
// ============================================================================

/**
 * Agent 抽象基类
 *
 * 提供通用的生命周期管理、状态跟踪和日志上下文
 *
 * @example
 * ```ts
 * class OrchestratorAgent extends BaseAgent {
 *   constructor(id: string, config: AgentConfig) {
 *     super(id, 'orchestrator', config);
 *   }
 *
 *   protected async executeTask(task: Task): Promise<TaskResult> {
 *     // 实现具体的任务执行逻辑
 *   }
 * }
 * ```
 */
export abstract class BaseAgent implements Agent {
  readonly id: string;
  readonly type: AgentType;
  readonly config: AgentConfig;

  /** 当前状态 */
  protected state: AgentState = 'idle';

  /** 当前执行的任务 */
  protected currentTask: Task | null = null;

  /** 生命周期钩子 */
  protected hooks: AgentLifecycleHooks = {};

  constructor(id: string, type: AgentType, config: AgentConfig) {
    this.id = id;
    this.type = type;
    this.config = config;
  }

  // ==========================================================================
  // 公共方法
  // ==========================================================================

  /**
   * 执行任务
   */
  async run(task: Task): Promise<TaskResult> {
    // 检查状态
    if (this.state === 'running') {
      throw new Error(`Agent ${this.id} is already running a task`);
    }
    if (this.state === 'stopped') {
      throw new Error(`Agent ${this.id} has been stopped`);
    }

    // 更新状态
    this.state = 'running';
    this.currentTask = task;

    const startTime = Date.now();
    const trace = createTraceData(`agent.${this.type}.run`, this.id);

    try {
      // 调用前置钩子
      await this.hooks.onBeforeRun?.(task);

      // 执行任务（由子类实现）
      const result = await this.executeTask(task);

      // 更新追踪数据
      const endTime = Date.now();
      result.trace = {
        ...trace,
        duration: endTime - startTime,
      };
      result.metrics = {
        ...result.metrics,
        startTime,
        endTime,
        duration: endTime - startTime,
      };

      // 调用后置钩子
      await this.hooks.onAfterRun?.(task, result);

      return result;
    } catch (error) {
      // 处理错误
      const err = error instanceof Error ? error : new Error(String(error));
      await this.hooks.onError?.(task, err);

      // 返回失败结果
      const endTime = Date.now();
      return {
        taskId: task.id,
        status: 'failure',
        output: { error: err.message },
        artifacts: [],
        metrics: {
          startTime,
          endTime,
          duration: endTime - startTime,
          tokensUsed: 0,
          toolCallCount: 0,
          retryCount: 0,
        },
        trace: {
          ...trace,
          duration: endTime - startTime,
          attributes: {
            ...trace.attributes,
            error: err.message,
          },
        },
      };
    } finally {
      // 重置状态
      this.state = 'idle';
      this.currentTask = null;
    }
  }

  /**
   * 停止 Agent
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }

    this.state = 'stopping';

    try {
      // 调用停止钩子
      await this.hooks.onStop?.();

      // 执行子类的清理逻辑
      await this.cleanup();
    } finally {
      this.state = 'stopped';
      this.currentTask = null;
    }
  }

  // ==========================================================================
  // 状态和上下文方法
  // ==========================================================================

  /**
   * 获取当前状态
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * 获取日志上下文
   */
  getLogContext(): AgentLogContext {
    return {
      agentId: this.id,
      agentType: this.type,
      taskId: this.currentTask?.id,
      traceId: this.currentTask?.context?.traceId,
    };
  }

  /**
   * 设置生命周期钩子
   */
  setHooks(hooks: AgentLifecycleHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  // ==========================================================================
  // 抽象方法（子类必须实现）
  // ==========================================================================

  /**
   * 执行任务的具体逻辑
   * @param task - 要执行的任务
   * @returns 任务结果
   */
  protected abstract executeTask(task: Task): Promise<TaskResult>;

  // ==========================================================================
  // 可选的生命周期方法（子类可以覆盖）
  // ==========================================================================

  /**
   * 清理资源
   * 子类可以覆盖此方法来执行自定义清理逻辑
   */
  protected async cleanup(): Promise<void> {
    // 默认不做任何事情
  }
}

