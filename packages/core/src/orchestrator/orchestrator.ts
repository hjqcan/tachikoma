/**
 * Orchestrator 实现
 *
 * 统筹者智能体，负责任务规划、分配、聚合和监控
 * 实现 plan → assign → aggregate 主流程
 */

import type { Task, TaskResult, Artifact, TaskMetrics, TraceData, RetryPolicy } from '../types';
import { BaseAgent } from '../abstracts/base-agent';
import type {
  OrchestratorTask,
  SubTask,
  PlannerInput,
  PlannerOutput,
  OrchestratorConfig,
  AggregatedResult,
  OrchestratorEventType,
  OrchestratorEvent,
  OrchestratorEventHandler,
  ExecutionStep,
  ExecutionPlan,
} from './types';
import {
  calculateRetryDelay,
  shouldRetry,
  createOrchestratorConfig,
} from './config';
import { Planner, type PlanResult, createLLMClient } from '../planner';
import {
  DefaultWorkerPool,
  type IWorkerPool,
  type AssignmentResult,
} from './worker-pool';
import {
  createAndInitializeSessionFileManager,
  generateTimestampId,
  type ISessionFileManager,
  type ProgressFile,
  type PendingApprovalFile,
  type ApprovalResponseFile,
  type SessionFileEvent,
  type ThinkingRecord,
  type InterventionFile,
} from './session';
import { MemoryService } from '../memory';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Orchestrator 选项
 */
export interface OrchestratorOptions {
  /** 配置 */
  config?: Partial<OrchestratorConfig>;
  /** Planner 实例（可选，用于注入测试） */
  planner?: Planner;
  /** WorkerPool 实例（可选，用于注入测试） */
  workerPool?: IWorkerPool;
  /** SessionFileManager 实例（可选，用于注入测试） */
  sessionManager?: ISessionFileManager;
}

/**
 * 子任务执行结果
 */
interface SubTaskExecutionResult {
  /** 子任务 ID */
  subtaskId: string;
  /** 是否成功 */
  success: boolean;
  /** 执行结果 */
  result?: TaskResult | undefined;
  /** 错误信息 */
  error?: string | undefined;
  /** 重试次数 */
  retryCount: number;
}

/**
 * 执行状态
 */
interface ExecutionState {
  /** 当前步骤 */
  currentStep: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 已完成子任务 */
  completedSubtasks: Map<string, TaskResult>;
  /** 失败子任务 */
  failedSubtasks: Map<string, string>;
  /** 进行中子任务 */
  runningSubtasks: Set<string>;
  /** 开始时间 */
  startTime: number;
  /** 总 Token 使用量 */
  totalTokens: number;
  /** 总重试次数 */
  totalRetries: number;
}

// ============================================================================
// Orchestrator 实现
// ============================================================================

/**
 * Orchestrator 类
 *
 * 统筹者智能体，负责：
 * 1. 任务规划（通过 Planner）
 * 2. 任务分配（通过 WorkerPool）
 * 3. 结果聚合
 * 4. 重试与降级
 *
 * @example
 * ```ts
 * const orchestrator = new Orchestrator('orch-001', {
 *   config: {
 *     workerPool: { maxWorkers: 5 }
 *   }
 * });
 *
 * const result = await orchestrator.run({
 *   id: 'task-001',
 *   type: 'composite',
 *   objective: '实现用户认证系统',
 *   constraints: ['使用 JWT', '支持 OAuth'],
 * });
 * ```
 */
export class Orchestrator extends BaseAgent {
  /** 配置 */
  private readonly orchestratorConfig: OrchestratorConfig;

  /** 规划器 */
  private readonly planner: Planner;

  /** Worker 池 */
  private readonly workerPool: IWorkerPool;

  /** Session 文件管理器 */
  private sessionManager: ISessionFileManager | null = null;

  /** 外部注入的 Session 管理器（用于测试） */
  private readonly injectedSessionManager: ISessionFileManager | null = null;

  /** 当前会话 ID */
  private currentSessionId: string | null = null;

  /** 事件监听器 */
  private readonly eventListeners = new Map<
    OrchestratorEventType,
    Set<OrchestratorEventHandler>
  >();

  /** 当前执行状态 */
  private executionState: ExecutionState | null = null;

  /** 审批处理器（绑定的方法引用，用于事件订阅/取消） */
  private readonly boundApprovalHandler: (event: SessionFileEvent<PendingApprovalFile>) => Promise<void>;

  /** 偏离检测定时器 */
  private deviationDetectionTimer: ReturnType<typeof setInterval> | null = null;

  /** 各 Worker 的最后干预时间（用于冷却控制） */
  private readonly workerInterventionCooldowns = new Map<string, number>();

  /** 已处理的审批请求缓存（requestId -> 处理时间戳，用于 TTL 清理） */
  private readonly processedApprovalRequests = new Map<string, number>();

  /** 审批请求缓存 TTL（5 分钟） */
  private static readonly REQUEST_CACHE_TTL = 5 * 60 * 1000;

  /** Memory 服务（跨会话记忆） */
  private memoryService?: MemoryService;

  constructor(id: string, options: OrchestratorOptions = {}) {
    const config = createOrchestratorConfig(options.config);

    super(id, 'orchestrator', config.agent);

    this.orchestratorConfig = config;

    // 创建或使用注入的 Planner
    this.planner = options.planner || new Planner({
      config: config.planner,
    });

    // 创建或使用注入的 WorkerPool
    this.workerPool = options.workerPool || new DefaultWorkerPool(config.workerPool);

    // 保存注入的 SessionManager（用于测试）
    this.injectedSessionManager = options.sessionManager ?? null;

    // 绑定审批处理器方法
    this.boundApprovalHandler = this.handlePendingApproval.bind(this);
    
    // 初始化 MemoryService（如果配置启用）
    if (config.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(config.memoryConfig);
      console.debug('[Orchestrator] MemoryService initialized');
    }
  }

  // ============================================================================
  // 公共方法
  // ============================================================================

  /**
   * 获取配置
   */
  getOrchestratorConfig(): OrchestratorConfig {
    return { ...this.orchestratorConfig };
  }

  /**
   * 获取当前会话 ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * 获取 Planner 实例
   */
  getPlanner(): Planner {
    return this.planner;
  }

  /**
   * 获取 WorkerPool 实例
   */
  getWorkerPool(): IWorkerPool {
    return this.workerPool;
  }

  /**
   * 获取当前执行状态
   */
  getExecutionState(): ExecutionState | null {
    if (!this.executionState) return null;
    return {
      ...this.executionState,
      completedSubtasks: new Map(this.executionState.completedSubtasks),
      failedSubtasks: new Map(this.executionState.failedSubtasks),
      runningSubtasks: new Set(this.executionState.runningSubtasks),
    };
  }

  // ============================================================================
  // 事件系统
  // ============================================================================

  /**
   * 添加事件监听器
   */
  on<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void {
    let handlers = this.eventListeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.eventListeners.set(type, handlers);
    }
    handlers.add(handler as OrchestratorEventHandler);
  }

  /**
   * 移除事件监听器
   */
  off<T = unknown>(
    type: OrchestratorEventType,
    handler: OrchestratorEventHandler<T>
  ): void {
    const handlers = this.eventListeners.get(type);
    if (handlers) {
      handlers.delete(handler as OrchestratorEventHandler);
    }
  }

  /**
   * 发出事件（带上下文信息）
   */
  private emit<T>(
    type: OrchestratorEventType,
    taskId: string,
    data: T,
    subtaskId?: string
  ): void {
    const event: OrchestratorEvent<T> = {
      type,
      taskId,
      // 添加会话和追踪上下文，便于调试和观测
      ...(this.currentSessionId && { sessionId: this.currentSessionId }),
      ...(this.id && { traceId: `orch-${this.id}` }),
      ...(subtaskId !== undefined && { subtaskId }),
      data,
      timestamp: Date.now(),
    };

    const handlers = this.eventListeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result instanceof Promise) {
            result.catch((error) => {
              console.error(`Error in orchestrator event handler [${type}]:`, error);
            });
          }
        } catch (error) {
          console.error(`Error in orchestrator event handler [${type}]:`, error);
        }
      }
    }
  }

  // ============================================================================
  // 核心执行逻辑
  // ============================================================================

  /**
   * 执行任务（实现 BaseAgent 的抽象方法）
   */
  protected async executeTask(task: Task, signal: AbortSignal): Promise<TaskResult> {
    const startTime = Date.now();
    const orchestratorTask = this.convertToOrchestratorTask(task);

    // 初始化会话
    await this.initializeSession(task.id);

    // 初始化执行状态
    this.executionState = {
      currentStep: 0,
      totalSteps: 0,
      completedSubtasks: new Map(),
      failedSubtasks: new Map(),
      runningSubtasks: new Set(),
      startTime,
      totalTokens: 0,
      totalRetries: 0,
    };

    try {
      // 阶段 1: 规划
      this.emit('plan:start', task.id, { task: orchestratorTask });
      const planResult = await this.executePlanPhase(orchestratorTask, signal);

      if (!planResult.success || !planResult.output) {
        this.emit('plan:failed', task.id, { error: planResult.error });
        return this.createFailureResult(
          task.id,
          `Planning failed: ${planResult.error}`,
          startTime,
          planResult.tokensUsed
        );
      }

      this.executionState.totalSteps = planResult.output.executionPlan.steps.length;
      this.executionState.totalTokens += planResult.tokensUsed.input + planResult.tokensUsed.output;

      this.emit('plan:complete', task.id, { plan: planResult.output });

      // 保存计划到会话文件
      await this.savePlanToSession(task.id, planResult.output);

      // 阶段 2: 执行（分配与聚合）
      const aggregatedResult = await this.executeAssignPhase(
        task.id,
        planResult.output,
        signal
      );

      // 阶段 3: 创建最终结果
      const finalResult = this.createFinalResult(task.id, aggregatedResult, startTime);

      // Memory: 保存任务结果到记忆 (best-effort)
      if (this.memoryService && this.orchestratorConfig.memoryConfig?.autoSave !== false) {
        try {
          const outputSummary = typeof aggregatedResult.output === 'string'
            ? aggregatedResult.output.slice(0, 500)
            : JSON.stringify(aggregatedResult.output).slice(0, 500);
          const memoryContent = `Task: ${orchestratorTask.objective}\nStatus: ${finalResult.status}\nResult: ${outputSummary}`;
          
          await this.memoryService.save({
            content: memoryContent,
            scope: 'procedural',
            metadata: {
              source: `orchestrator:${this.id}`,
              taskId: task.id,
              status: finalResult.status,
            }
          });
          console.debug('[Orchestrator] Task result saved to memory');
        } catch (error) {
          console.warn('[Orchestrator] Memory save failed (continuing):', error);
        }
      }

      return finalResult;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return this.createFailureResult(
        task.id,
        err.message,
        startTime,
        { input: this.executionState?.totalTokens || 0, output: 0 }
      );
    } finally {
      // 清理
      this.executionState = null;
      await this.closeSession();
      
      // 清除 session scope 记忆（防止跨任务污染）
      if (this.memoryService) {
        try {
          await this.memoryService.clear('session');
        } catch {
          // 忽略清理错误
        }
      }
    }
  }

  /**
   * 转换为 OrchestratorTask
   *
   * 优先使用原始任务的 priority/complexity，否则使用默认值
   */
  private convertToOrchestratorTask(task: Task): OrchestratorTask {
    // 使用 unknown 作为中间类型以安全访问可能存在的属性
    const taskAny = task as unknown as Record<string, unknown>;
    return {
      ...task,
      priority: (taskAny.priority as OrchestratorTask['priority']) ?? 'medium',
      complexity: (taskAny.complexity as OrchestratorTask['complexity']) ?? 'moderate',
    };
  }

  /**
   * 初始化会话
   *
   * 使用配置中的 session.rootDir，避免路径字符串替换
   * 初始化后启动文件监控（如果启用）并注册审批事件处理器
   */
  private async initializeSession(_taskId: string): Promise<void> {
    this.currentSessionId = generateTimestampId('session');

    // 使用注入的 SessionManager 或创建新的
    if (this.injectedSessionManager) {
      this.sessionManager = this.injectedSessionManager;
    } else {
      this.sessionManager = await createAndInitializeSessionFileManager(
        this.currentSessionId,
        {
          rootDir: this.orchestratorConfig.session.rootDir,
          enableWatch: this.orchestratorConfig.session.enableWatch ?? true,
          watchPollInterval: this.orchestratorConfig.session.watchPollInterval ?? 500,
        }
      );
    }

    // 注册审批请求事件处理器
    this.sessionManager.on<PendingApprovalFile>(
      'pending_approval_created',
      this.boundApprovalHandler
    );

    // 启动文件监控（如果配置启用且 SessionManager 支持）
    // 对于注入的 SessionManager，由调用者负责管理监控生命周期
    if (!this.injectedSessionManager && this.sessionManager) {
      await this.sessionManager.startWatching();
    }

    // 启动偏离检测定时器（如果配置启用）
    this.startDeviationDetection();
  }

  /**
   * 关闭会话
   *
   * 先取消事件监听、停止文件监控，再关闭 SessionManager
   */
  private async closeSession(): Promise<void> {
    // 停止偏离检测定时器
    this.stopDeviationDetection();

    // 取消审批事件监听
    if (this.sessionManager) {
      this.sessionManager.off<PendingApprovalFile>(
        'pending_approval_created',
        this.boundApprovalHandler
      );
    }

    // 只有当 sessionManager 不是注入的时候才关闭
    if (this.sessionManager && !this.injectedSessionManager) {
      // 显式停止文件监控（虽然 close() 内部也会调用，但显式调用更清晰）
      this.sessionManager.stopWatching();
      await this.sessionManager.close();
    }

    // 清理缓存
    this.processedApprovalRequests.clear();

    this.sessionManager = null;
    this.currentSessionId = null;
  }

  /**
   * 处理 Worker 审批请求
   *
   * 根据审批策略配置，对 Worker 发起的审批请求做出决策：
   * 1. 检查请求类型是否在自动批准/拒绝列表中
   * 2. 检查是否为低影响或可逆操作（可自动批准）
   * 3. 否则使用默认决策
   *
   * @param event - 审批请求事件
   */
  private async handlePendingApproval(
    event: SessionFileEvent<PendingApprovalFile>
  ): Promise<void> {
    if (!this.sessionManager) return;

    const approval = event.data;
    const workerId = event.workerId || approval.workerId;
    const policy = this.orchestratorConfig.approval;
    const now = Date.now();

    // 检查是否已处理过此请求（避免重复处理）
    if (this.processedApprovalRequests.has(approval.requestId)) {
      return; // 跳过已处理的请求
    }

    // 清理过期的请求缓存（TTL 清理）
    for (const [requestId, timestamp] of this.processedApprovalRequests) {
      if (now - timestamp > Orchestrator.REQUEST_CACHE_TTL) {
        this.processedApprovalRequests.delete(requestId);
      }
    }

    // 标记为已处理（记录时间戳用于 TTL）
    this.processedApprovalRequests.set(approval.requestId, now);

    // 检查是否已超时（使用 approval.timeout 或 policy.timeout）
    const requestTimeout = approval.timeout || policy.timeout;
    const isTimedOut = now - approval.requestedAt > requestTimeout;

    // 发送收到审批请求事件
    this.emit('approval:received', approval.subtaskId, {
      requestId: approval.requestId,
      workerId,
      type: approval.type,
      description: approval.description,
      isTimedOut,
    });

    // 根据策略决定是否批准
    let approved: boolean;
    let reason: string;

    // 0. 检查是否已超时（优先处理超时情况）
    if (isTimedOut) {
      const timeoutDecision = approval.defaultDecision || policy.defaultDecision;
      approved = timeoutDecision === 'approve';
      reason = `Request timed out after ${Math.round(requestTimeout / 1000)}s, using default decision: ${timeoutDecision}`;
    }
    // 1. 检查是否在自动拒绝列表中
    else if (policy.autoRejectTypes.includes(approval.type)) {
      approved = false;
      reason = `Request type "${approval.type}" is in auto-reject list`;
    }
    // 2. 检查是否在自动批准列表中
    else if (policy.autoApproveTypes.includes(approval.type)) {
      approved = true;
      reason = `Request type "${approval.type}" is in auto-approve list`;
    }
    // 3. 检查低影响操作
    else if (policy.lowImpactAutoApprove && approval.details.impactScope === 'low') {
      approved = true;
      reason = 'Low impact operation auto-approved';
    }
    // 4. 检查可逆操作
    else if (policy.reversibleAutoApprove && approval.details.reversible) {
      approved = true;
      reason = 'Reversible operation auto-approved';
    }
    // 5. 使用默认决策
    else {
      approved = policy.defaultDecision === 'approve';
      reason = `Default decision: ${policy.defaultDecision}`;
    }

    // 构建审批响应
    const response: ApprovalResponseFile = {
      requestId: approval.requestId,
      respondedAt: Date.now(),
      approved,
      respondedBy: 'orchestrator',
      reason,
    };

    // 写入审批响应（SessionFileManager.writeApprovalResponse 会自动清理 pending_approval.json 并记录决策）
    await this.sessionManager.writeApprovalResponse(workerId, response);

    // 发送审批完成事件
    this.emit('approval:complete', approval.subtaskId, {
      requestId: approval.requestId,
      workerId,
      approved,
      reason,
    });
  }

  // ============================================================================
  // 偏离检测方法
  // ============================================================================

  /**
   * 启动偏离检测定时器
   */
  private startDeviationDetection(): void {
    const config = this.orchestratorConfig.deviationDetection;
    
    if (!config.enabled) {
      return;
    }

    // 清除已有定时器
    this.stopDeviationDetection();

    // 启动周期性检测
    this.deviationDetectionTimer = setInterval(() => {
      this.checkWorkersForDeviation().catch((error) => {
        console.error('[Orchestrator] Deviation detection error:', error);
      });
    }, config.checkInterval);
  }

  /**
   * 停止偏离检测定时器
   */
  private stopDeviationDetection(): void {
    if (this.deviationDetectionTimer) {
      clearInterval(this.deviationDetectionTimer);
      this.deviationDetectionTimer = null;
    }
    // 清除冷却缓存
    this.workerInterventionCooldowns.clear();
  }

  /**
   * 检查所有 Worker 的偏离情况
   *
   * 遍历 WorkerPool 中所有活跃的 Worker，读取其思考日志并进行偏离检测
   */
  private async checkWorkersForDeviation(): Promise<void> {
    if (!this.sessionManager) return;

    const config = this.orchestratorConfig.deviationDetection;
    const workers = this.workerPool.getAllWorkers();

    for (const worker of workers) {
      // 跳过空闲状态的 Worker
      if (worker.status === 'idle') continue;

      // 检查冷却时间
      const lastIntervention = this.workerInterventionCooldowns.get(worker.id);
      if (lastIntervention && Date.now() - lastIntervention < config.interventionCooldown) {
        continue; // 仍在冷却中，跳过此 Worker
      }

      try {
        // 读取最新思考日志
        const thinkingLogs = await this.sessionManager.readThinkingLogs(
          worker.id,
          config.thinkingLogLimit
        );

        if (thinkingLogs.length === 0) continue;

        // 使用规则检测评估偏离
        if (config.enableRuleBasedDetection) {
          const deviationResult = this.evaluateThinkingLogs(thinkingLogs, worker.currentTaskId);
          
          if (deviationResult && deviationResult.score >= config.deviationThreshold) {
            // 如果启用模型评估，用 LLM 二次确认规则检测结果
            let confirmedDeviation = true;
            if (config.enableModelEvaluation && config.evaluationLLMConfig) {
              confirmedDeviation = await this.evaluateDeviationWithModel(
                thinkingLogs,
                deviationResult,
                config.evaluationLLMConfig
              );
            }

            if (confirmedDeviation) {
              // 检测到偏离，发出事件
              this.emit('deviation:detected', worker.currentTaskId || '', {
                workerId: worker.id,
                deviationType: deviationResult.type,
                score: deviationResult.score,
                description: deviationResult.description,
                modelConfirmed: config.enableModelEvaluation ? confirmedDeviation : undefined,
              });

              // 判断是否需要自动干预
              if (this.shouldAutoIntervene(deviationResult.severity, config.autoInterventionSeverity)) {
                await this.issueIntervention(
                  worker.id,
                  deviationResult.type,
                  deviationResult.description,
                  deviationResult.severity,
                  deviationResult.suggestedSteps
                );
              }
            }
          }
        }
      } catch (error) {
        console.error(`[Orchestrator] Error checking deviation for worker ${worker.id}:`, error);
      }
    }
  }

  /**
   * 使用 LLM 模型评估偏离
   *
   * 当规则检测认为有偏离时，调用 LLM 进行二次确认
   * 减少误报，提高干预准确性
   *
   * @param logs - 思考日志
   * @param ruleResult - 规则检测结果
   * @param llmConfig - LLM 配置
   * @returns 是否确认偏离
   */
  private async evaluateDeviationWithModel(
    logs: ThinkingRecord[],
    ruleResult: { type: string; description: string; score: number },
    llmConfig: NonNullable<typeof this.orchestratorConfig.deviationDetection.evaluationLLMConfig>
  ): Promise<boolean> {
    try {
      const llmClient = createLLMClient({
        provider: llmConfig.provider,
        apiKey: llmConfig.apiKey || '',
        model: llmConfig.model,
        maxTokens: llmConfig.maxTokens || 500,
      });

      const logsText = logs.slice(-5).map(l => 
        `[${l.stage}] ${l.content}${l.confidence !== undefined ? ` (confidence: ${l.confidence})` : ''}`
      ).join('\n');

      const response = await llmClient.complete({
        systemPrompt: `You are an AI assistant evaluating whether a worker agent is deviating from its assigned task.
Analyze the thinking logs and determine if the detected deviation is genuine.
Respond with only "YES" if you confirm the deviation, or "NO" if the detection seems to be a false positive.`,
        messages: [{
          role: 'user',
          content: `Rule-based detection found: ${ruleResult.type}
Description: ${ruleResult.description}
Confidence: ${ruleResult.score}

Recent thinking logs:
${logsText}

Is this a genuine deviation? Answer YES or NO only.`,
        }],
        maxTokens: 10,
        temperature: 0.1,
      });

      return response.content.trim().toUpperCase().includes('YES');
    } catch (error) {
      console.error('[Orchestrator] Model evaluation failed, using rule-based result:', error);
      return true; // 失败时默认信任规则检测结果
    }
  }

  /**
   * 评估思考日志，检测偏离
   *
   * 使用规则进行轻量检测：
   * - 检查是否长时间无进展（stuck）
   * - 检查是否重复相同操作（repetitive）
   * - 检查置信度是否持续走低
   *
   * @param logs - 思考日志记录
   * @param currentTaskId - 当前任务 ID
   * @returns 偏离检测结果，如果未检测到偏离则返回 null
   */
  private evaluateThinkingLogs(
    logs: ThinkingRecord[],
    currentTaskId?: string
  ): {
    type: 'off_task' | 'inefficient' | 'stuck' | 'repetitive' | 'resource_abuse';
    score: number;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    suggestedSteps: string[];
  } | null {
    if (logs.length < 3) return null; // 日志太少，无法判断

    const config = this.orchestratorConfig.deviationDetection;

    // 规则1: 检测是否卡住（最近日志时间间隔异常短或内容高度相似）
    const recentLogs = logs.slice(-5);
    const contents = recentLogs.map(l => l.content.toLowerCase().trim());
    const uniqueContents = new Set(contents);
    
    if (uniqueContents.size <= 2 && recentLogs.length >= 5) {
      return {
        type: 'repetitive',
        score: config.repetitiveThreshold,
        description: 'Worker is producing repetitive thinking patterns, possibly stuck in a loop',
        severity: 'medium',
        suggestedSteps: [
          'Consider a different approach to the current problem',
          'Review the original task requirements',
          'If stuck, break down the problem into smaller steps',
        ],
      };
    }

    // 规则2: 检测置信度持续走低
    const confidences = logs.filter(l => l.confidence !== undefined).map(l => l.confidence!);
    if (confidences.length >= 5) {
      const recentConfidences = confidences.slice(-5);
      const avgRecent = recentConfidences.reduce((a, b) => a + b, 0) / recentConfidences.length;
      const olderConfidences = confidences.slice(0, -5);
      const avgOlder = olderConfidences.length > 0 
        ? olderConfidences.reduce((a, b) => a + b, 0) / olderConfidences.length 
        : 0.7;
      
      if (avgRecent < 0.3 && avgOlder - avgRecent > 0.3) {
        return {
          type: 'stuck',
          score: config.stuckThreshold,
          description: 'Worker confidence has dropped significantly, may be struggling with the current task',
          severity: 'low',
          suggestedSteps: [
            'Take a step back and reassess the problem',
            'Consider asking for additional context or clarification',
            'Try a simpler approach first',
          ],
        };
      }
    }

    // 规则3: 检测是否偏离任务（如果有任务 ID 但日志中的 subtaskId 不匹配）
    if (currentTaskId) {
      const mismatchedLogs = recentLogs.filter(l => l.subtaskId !== currentTaskId);
      if (mismatchedLogs.length >= 3) {
        return {
          type: 'off_task',
          score: config.offTaskThreshold,
          description: 'Worker thinking logs suggest deviation from the assigned task',
          severity: 'medium',
          suggestedSteps: [
            'Refocus on the current assigned task',
            'Check if the current work is aligned with task objectives',
          ],
        };
      }
    }

    // 规则4: 检测效率低下（reflection 阶段过多）
    const reflectionLogs = recentLogs.filter(l => l.stage === 'reflection');
    if (reflectionLogs.length >= 4 && recentLogs.length >= 5) {
      return {
        type: 'inefficient',
        score: config.inefficientThreshold,
        description: 'Worker is spending too much time in reflection without making progress',
        severity: 'low',
        suggestedSteps: [
          'Move from reflection to action',
          'Make a decision and proceed with implementation',
        ],
      };
    }

    return null;
  }

  /**
   * 判断是否应该自动干预
   */
  private shouldAutoIntervene(
    detectedSeverity: 'low' | 'medium' | 'high' | 'critical',
    thresholdSeverity: 'low' | 'medium' | 'high' | 'critical'
  ): boolean {
    const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    return severityOrder[detectedSeverity] >= severityOrder[thresholdSeverity];
  }

  /**
   * 向 Worker 发送干预指令
   *
   * @param workerId - Worker ID
   * @param deviationType - 偏离类型
   * @param description - 问题描述
   * @param severity - 严重程度
   * @param suggestedSteps - 建议的下一步
   */
  private async issueIntervention(
    workerId: string,
    deviationType: 'off_task' | 'inefficient' | 'stuck' | 'repetitive' | 'resource_abuse',
    description: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    suggestedSteps: string[]
  ): Promise<void> {
    if (!this.sessionManager) return;

    // 记录冷却时间
    this.workerInterventionCooldowns.set(workerId, Date.now());

    // 根据偏离类型决定干预类型
    const interventionType: InterventionFile['type'] = 
      deviationType === 'off_task' ? 'redirect' :
      severity === 'critical' ? 'pause' :
      'guidance';

    // 构建干预指令
    const intervention: Omit<InterventionFile, 'interventionId' | 'createdAt' | 'acknowledged'> = {
      type: interventionType,
      reason: `Deviation detected: ${deviationType}`,
      detectedIssue: {
        type: deviationType === 'off_task' ? 'deviation' :
              deviationType === 'inefficient' ? 'inefficiency' :
              deviationType === 'stuck' || deviationType === 'repetitive' ? 'stuck' :
              'error',
        description,
        severity,
      },
      instructions: this.generateInterventionInstructions(deviationType, description),
      suggestedNextSteps: suggestedSteps,
    };

    // 写入干预指令
    await this.sessionManager.writeIntervention(workerId, intervention);

    // 发送干预事件
    this.emit('deviation:intervention', '', {
      workerId,
      deviationType,
      interventionType,
      severity,
    });
  }

  /**
   * 生成干预指令内容
   */
  private generateInterventionInstructions(
    deviationType: string,
    description: string
  ): string {
    const instructions: Record<string, string> = {
      off_task: 'Please refocus on your assigned task. The detected behavior suggests you may have strayed from the main objective. Review your task requirements and realign your approach.',
      inefficient: 'Your current approach appears to be inefficient. Consider simplifying your strategy and making more direct progress toward the goal.',
      stuck: 'You appear to be stuck. Try a different approach or break down the problem into smaller, more manageable steps.',
      repetitive: 'You are repeating similar actions without progress. Step back, analyze what is not working, and try an alternative method.',
      resource_abuse: 'Resource usage patterns are concerning. Please optimize your approach to use resources more efficiently.',
    };

    return instructions[deviationType] || `Attention required: ${description}`;
  }

  /**
   * 保存计划到会话文件
   */
  private async savePlanToSession(
    taskId: string,
    planOutput: PlannerOutput
  ): Promise<void> {
    if (!this.sessionManager) return;

    await this.sessionManager.writePlan({
      taskId,
      createdAt: Date.now(),
      plannerOutput: planOutput,
      version: 1,
    });
  }

  /**
   * 更新进度到会话文件
   */
  private async updateProgressToSession(taskId: string): Promise<void> {
    if (!this.sessionManager || !this.executionState) return;

    const progress: Omit<ProgressFile, 'sessionId' | 'updatedAt'> = {
      taskId,
      status: 'executing',
      currentStep: this.executionState.currentStep,
      totalSteps: this.executionState.totalSteps,
      completedSubtasks: Array.from(this.executionState.completedSubtasks.keys()),
      failedSubtasks: Array.from(this.executionState.failedSubtasks.keys()),
      runningSubtasks: Array.from(this.executionState.runningSubtasks),
      startedAt: this.executionState.startTime,
    };

    await this.sessionManager.writeProgress(progress);
  }

  // ============================================================================
  // 阶段 1: 规划
  // ============================================================================

  /**
   * 执行规划阶段
   */
  private async executePlanPhase(
    task: OrchestratorTask,
    signal: AbortSignal
  ): Promise<PlanResult> {
    // 检查中断
    if (signal.aborted) {
      return {
        success: false,
        error: 'Aborted',
        tokensUsed: { input: 0, output: 0 },
        retryCount: 0,
        degraded: false,
      };
    }

    const input: PlannerInput = {
      task,
      maxSubtasks: this.orchestratorConfig.planner.defaultMaxSubtasks,
    };

    return this.planner.plan(input);
  }

  // ============================================================================
  // 阶段 2: 分配与执行
  // ============================================================================

  /**
   * 执行分配阶段
   */
  private async executeAssignPhase(
    taskId: string,
    planOutput: PlannerOutput,
    signal: AbortSignal
  ): Promise<AggregatedResult> {
    const { subtasks, delegation, executionPlan } = planOutput;

    // 创建子任务映射
    const subtaskMap = new Map<string, SubTask>();
    for (const subtask of subtasks) {
      subtaskMap.set(subtask.id, subtask);
    }

    // DAG 校验：执行前检查环依赖和步骤一致性
    const dagError = this.validatePlanDAG(subtasks, executionPlan);
    if (dagError) {
      throw new Error(`Plan DAG validation failed: ${dagError}`);
    }

    // 按执行计划逐步执行
    for (let i = 0; i < executionPlan.steps.length; i++) {
      if (signal.aborted) {
        break;
      }

      const step = executionPlan.steps[i]!;
      this.executionState!.currentStep = i + 1;

      await this.updateProgressToSession(taskId);

      // 执行当前步骤的所有子任务
      await this.executeStep(
        taskId,
        step,
        subtaskMap,
        delegation.timeout,
        delegation.retryPolicy,
        signal
      );
    }

    // 聚合结果
    this.emit('aggregate:start', taskId, {});
    const aggregatedResult = this.aggregateResults(subtaskMap);
    this.emit('aggregate:complete', taskId, { result: aggregatedResult });

    return aggregatedResult;
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(
    taskId: string,
    step: ExecutionStep,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal
  ): Promise<void> {
    const subtaskIds = step.subtaskIds;

    if (step.parallel) {
      // 并行执行
      const promises = subtaskIds.map((id) =>
        this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal)
      );
      await Promise.all(promises);
    } else {
      // 串行执行
      for (const id of subtaskIds) {
        if (signal.aborted) break;
        await this.executeSubtask(taskId, id, subtaskMap, timeout, retryPolicy, signal);
      }
    }
  }

  /**
   * 执行单个子任务（带重试）
   */
  private async executeSubtask(
    taskId: string,
    subtaskId: string,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal
  ): Promise<SubTaskExecutionResult> {
    const subtask = subtaskMap.get(subtaskId);
    if (!subtask) {
      return {
        subtaskId,
        success: false,
        error: `Subtask ${subtaskId} not found`,
        retryCount: 0,
      };
    }

    // 检查依赖是否完成
    if (subtask.dependencies) {
      for (const depId of subtask.dependencies) {
        if (!this.executionState!.completedSubtasks.has(depId)) {
          return {
            subtaskId,
            success: false,
            error: `Dependency ${depId} not completed`,
            retryCount: 0,
          };
        }
      }
    }

    // 标记为运行中
    this.executionState!.runningSubtasks.add(subtaskId);
    subtask.status = 'running';

    this.emit('subtask:assigned', taskId, { subtaskId, subtask }, subtaskId);

    let retryCount = 0;
    let lastError: string | undefined;

    while (true) {
      if (signal.aborted) {
        this.executionState!.runningSubtasks.delete(subtaskId);
        return {
          subtaskId,
          success: false,
          error: 'Aborted',
          retryCount,
        };
      }

      try {
        // 分配给 Worker
        const assignResult = await this.assignToWorker(subtask, timeout, retryPolicy);

        if (!assignResult.success) {
          lastError = assignResult.error;

          // 检查是否应该重试
          if (shouldRetry(retryPolicy, retryCount)) {
            retryCount++;
            this.executionState!.totalRetries++;
            subtask.status = 'retrying';

            this.emit('subtask:retrying', taskId, { retryCount, error: lastError }, subtaskId);

            // 等待重试延迟
            const delay = calculateRetryDelay(retryPolicy, retryCount);
            await this.sleep(delay);
            continue;
          }

          // 重试耗尽，标记为失败
          const failureError = lastError || 'Unknown error';
          this.markSubtaskFailed(subtask, subtaskId, failureError);

          this.emit('subtask:failed', taskId, { error: failureError, retryCount }, subtaskId);

          return {
            subtaskId,
            success: false,
            error: failureError,
            retryCount,
          };
        }

        // 等待 Worker 完成（简化实现，实际应监控 Worker 状态）
        const result = await this.waitForWorkerCompletion(
          subtask,
          assignResult.workerId!,
          timeout
        );

        // 标记为完成
        this.executionState!.runningSubtasks.delete(subtaskId);
        this.executionState!.completedSubtasks.set(subtaskId, result);
        subtask.status = 'success';
        subtask.result = result;

        // 累加 Worker 执行的 token 用量
        if (result.metrics?.tokensUsed) {
          this.executionState!.totalTokens += result.metrics.tokensUsed;
        }

        this.emit('subtask:complete', taskId, { result }, subtaskId);

        return {
          subtaskId,
          success: true,
          result,
          retryCount,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        // 检查是否应该重试
        if (shouldRetry(retryPolicy, retryCount)) {
          retryCount++;
          this.executionState!.totalRetries++;
          subtask.status = 'retrying';

          this.emit('subtask:retrying', taskId, { retryCount, error: lastError }, subtaskId);

          const delay = calculateRetryDelay(retryPolicy, retryCount);
          await this.sleep(delay);
          continue;
        }

        // 重试耗尽
        this.markSubtaskFailed(subtask, subtaskId, lastError);

        this.emit('subtask:failed', taskId, { error: lastError, retryCount }, subtaskId);

        return {
          subtaskId,
          success: false,
          error: lastError,
          retryCount,
        };
      }
    }
  }

  /**
   * 标记子任务失败
   */
  private markSubtaskFailed(subtask: SubTask, subtaskId: string, error: string): void {
    this.executionState!.runningSubtasks.delete(subtaskId);
    this.executionState!.failedSubtasks.set(subtaskId, error);
    subtask.status = 'failure';
  }

  /**
   * 验证计划的 DAG 有效性
   *
   * 检查：
   * 1. 所有依赖引用的子任务都存在
   * 2. 没有循环依赖
   * 3. 执行步骤中的所有 subtaskId 都存在
   * 4. 每个子任务只出现在一个执行步骤中
   *
   * @param subtasks - 子任务列表
   * @param executionPlan - 执行计划
   * @returns 错误消息，如果有效则返回 null
   */
  private validatePlanDAG(
    subtasks: SubTask[],
    executionPlan: ExecutionPlan
  ): string | null {
    const subtaskIds = new Set(subtasks.map((st) => st.id));

    // 1. 检查依赖引用
    for (const subtask of subtasks) {
      if (subtask.dependencies) {
        for (const depId of subtask.dependencies) {
          if (!subtaskIds.has(depId)) {
            return `Subtask ${subtask.id} depends on unknown subtask: ${depId}`;
          }
          if (depId === subtask.id) {
            return `Subtask ${subtask.id} cannot depend on itself`;
          }
        }
      }
    }

    // 2. 检测循环依赖（使用 DFS）
    const visited = new Set<string>();
    const stack = new Set<string>();

    const hasCycle = (id: string): boolean => {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;

      visited.add(id);
      stack.add(id);

      const subtask = subtasks.find((st) => st.id === id);
      if (subtask?.dependencies) {
        for (const depId of subtask.dependencies) {
          if (hasCycle(depId)) return true;
        }
      }

      stack.delete(id);
      return false;
    };

    for (const subtask of subtasks) {
      if (hasCycle(subtask.id)) {
        return 'Circular dependency detected in subtasks';
      }
    }

    // 3. 检查执行步骤中的 subtaskId
    const seenInSteps = new Set<string>();
    for (const step of executionPlan.steps) {
      for (const id of step.subtaskIds) {
        if (!subtaskIds.has(id)) {
          return `ExecutionPlan references unknown subtask: ${id}`;
        }
        if (seenInSteps.has(id)) {
          return `Subtask ${id} appears in multiple execution steps`;
        }
        seenInSteps.add(id);
      }
    }

    return null; // 验证通过
  }

  /**
   * 分配子任务给 Worker
   */
  private async assignToWorker(
    subtask: SubTask,
    timeout: number,
    retryPolicy: RetryPolicy
  ): Promise<AssignmentResult> {
    // 注册 Worker（如果池为空）
    if (this.workerPool.workerCount === 0) {
      await this.registerDefaultWorkers();
    }

    return this.workerPool.assign(subtask, timeout, retryPolicy);
  }

  /**
   * 注册默认 Workers
   *
   * @param planWorkerCount - 计划指定的 worker 数量（可选，默认使用配置值）
   */
  private async registerDefaultWorkers(planWorkerCount?: number): Promise<void> {
    // 优先使用计划指定的 workerCount，但不超过池上限
    const requestedCount = planWorkerCount ?? this.orchestratorConfig.delegation.workerCount;
    const workerCount = Math.min(
      requestedCount,
      this.orchestratorConfig.workerPool.maxWorkers
    );

    for (let i = 0; i < workerCount; i++) {
      this.workerPool.register({
        id: `worker-${i}`,
        status: 'idle',
        capabilities: ['general'],
      });

      // 注册到 SessionManager
      if (this.sessionManager) {
        await this.sessionManager.registerWorker(`worker-${i}`);
      }
    }
  }

  /**
   * 等待 Worker 完成
   *
   * TODO: 实现真实的 Worker 状态监控 (Task 5 完成后补充)
   *
   * 需要实现的功能：
   * 1. 轮询读取 workers/{workerId}/status.json
   * 2. 支持 timeout 超时处理
   * 3. 支持 AbortSignal 取消
   * 4. 检测 Worker 心跳，超时则标记失败
   * 5. 读取 actions.jsonl 获取执行结果
   * 6. 处理 Worker 失败/错误状态
   *
   * @param subtask - 子任务
   * @param workerId - Worker ID
   * @param timeout - 超时时间（毫秒）
   * @param signal - 可选的取消信号
   *
   * @see Task 5 Worker 实现后需补充此逻辑
   */
  private async waitForWorkerCompletion(
    subtask: SubTask,
    _workerId: string,
    _timeout: number,
    _signal?: AbortSignal
  ): Promise<TaskResult> {
    // 当前为占位实现，直接返回成功结果
    // 真实实现应监控 Worker 状态文件并处理各种情况
    return {
      taskId: subtask.id,
      status: 'success',
      output: { completed: true, objective: subtask.objective },
      artifacts: [],
      metrics: {
        startTime: Date.now(),
        endTime: Date.now(),
        duration: 0,
        tokensUsed: 0,
        toolCallCount: 0,
        retryCount: 0,
      },
      trace: {
        traceId: generateTimestampId('trace'),
        spanId: generateTimestampId('span'),
        operation: `subtask.${subtask.id}`,
        attributes: {},
        events: [],
        duration: 0,
      },
    };
  }

  // ============================================================================
  // 阶段 3: 聚合
  // ============================================================================

  /**
   * 聚合所有子任务结果
   */
  private aggregateResults(subtaskMap: Map<string, SubTask>): AggregatedResult {
    const state = this.executionState!;
    const config = this.orchestratorConfig.aggregation;

    const successCount = state.completedSubtasks.size;
    const failureCount = state.failedSubtasks.size;
    const totalCount = subtaskMap.size;

    // 确定最终状态
    let status: 'success' | 'failure' | 'partial';
    if (failureCount === 0 && successCount === totalCount) {
      status = 'success';
    } else if (successCount === 0) {
      status = 'failure';
    } else {
      // 检查部分成功阈值
      const successRate = successCount / totalCount;
      if (config.allowPartialSuccess && successRate >= (config.partialSuccessThreshold || 0)) {
        status = 'partial';
      } else {
        status = 'failure';
      }
    }

    // 合并输出
    const output = this.mergeOutputs(state.completedSubtasks, config.strategy);

    return {
      status,
      output,
      subtaskResults: state.completedSubtasks,
      successCount,
      failureCount,
      metadata: {
        totalDuration: Date.now() - state.startTime,
        totalTokens: state.totalTokens,
        totalRetries: state.totalRetries,
      },
    };
  }

  /**
   * 合并输出
   */
  private mergeOutputs(
    completedSubtasks: Map<string, TaskResult>,
    strategy: string
  ): unknown {
    switch (strategy) {
      case 'merge': {
        // 合并所有输出到数组
        const outputs: unknown[] = [];
        for (const result of completedSubtasks.values()) {
          outputs.push(result.output);
        }
        return outputs;
      }
      case 'select-best': {
        // 选择第一个成功的结果
        for (const result of completedSubtasks.values()) {
          if (result.status === 'success') {
            return result.output;
          }
        }
        return null;
      }
      default:
        return Array.from(completedSubtasks.values()).map((r) => r.output);
    }
  }

  // ============================================================================
  // 结果创建
  // ============================================================================

  /**
   * 创建最终结果
   */
  private createFinalResult(
    taskId: string,
    aggregatedResult: AggregatedResult,
    startTime: number
  ): TaskResult {
    const endTime = Date.now();
    const duration = endTime - startTime;

    // 收集所有产出物
    const artifacts: Artifact[] = [];
    for (const result of aggregatedResult.subtaskResults.values()) {
      artifacts.push(...result.artifacts);
    }

    // 计算指标
    const metrics: TaskMetrics = {
      startTime,
      endTime,
      duration,
      tokensUsed: aggregatedResult.metadata?.totalTokens || 0,
      toolCallCount: 0,
      retryCount: aggregatedResult.metadata?.totalRetries || 0,
    };

    // 创建追踪数据
    const trace: TraceData = {
      traceId: generateTimestampId('trace'),
      spanId: generateTimestampId('span'),
      operation: `orchestrator.${this.id}.run`,
      attributes: {
        taskId,
        successCount: aggregatedResult.successCount,
        failureCount: aggregatedResult.failureCount,
      },
      events: [],
      duration,
    };

    return {
      taskId,
      status: aggregatedResult.status,
      output: aggregatedResult.output,
      artifacts,
      metrics,
      trace,
    };
  }

  /**
   * 创建失败结果
   */
  private createFailureResult(
    taskId: string,
    error: string,
    startTime: number,
    tokensUsed: { input: number; output: number }
  ): TaskResult {
    const endTime = Date.now();

    return {
      taskId,
      status: 'failure',
      output: { error },
      artifacts: [],
      metrics: {
        startTime,
        endTime,
        duration: endTime - startTime,
        tokensUsed: tokensUsed.input + tokensUsed.output,
        toolCallCount: 0,
        retryCount: 0,
      },
      trace: {
        traceId: generateTimestampId('trace'),
        spanId: generateTimestampId('span'),
        operation: `orchestrator.${this.id}.run`,
        attributes: { taskId, error },
        events: [],
        duration: endTime - startTime,
      },
    };
  }

  // ============================================================================
  // 工具方法
  // ============================================================================

  /**
   * 等待指定时间（支持 AbortSignal 取消）
   *
   * @param ms - 等待时间（毫秒）
   * @param signal - 可选的取消信号
   * @throws 如果 signal 已 abort 则抛出错误
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      // 如果已经 abort，立即拒绝
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const timer = setTimeout(resolve, ms);

      // 监听 abort 事件
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  /**
   * 清理资源
   */
  protected override async cleanup(): Promise<void> {
    // 关闭会话
    await this.closeSession();

    // 关闭 Worker 池
    await this.workerPool.shutdown();

    // 清除事件监听器
    this.eventListeners.clear();
    
    // 关闭 Planner（释放其内部 MemoryService 连接）
    await this.planner.close();
    
    // 关闭 Orchestrator 自身的 MemoryService
    if (this.memoryService) {
      await this.memoryService.close();
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Orchestrator 实例
 *
 * @param id - Orchestrator ID
 * @param options - 选项
 * @returns Orchestrator 实例
 *
 * @example
 * ```ts
 * const orchestrator = createOrchestrator('orch-001', {
 *   config: {
 *     workerPool: { maxWorkers: 10 }
 *   }
 * });
 *
 * const result = await orchestrator.run(task);
 * ```
 */
export function createOrchestrator(
  id: string,
  options?: OrchestratorOptions
): Orchestrator {
  return new Orchestrator(id, options);
}
