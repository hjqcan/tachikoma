/**
 * Orchestrator 实现
 *
 * 统筹者智能体，负责任务规划、分配、聚合和监控
 * 实现 plan → assign → aggregate 主流程
 */

import type { Task, TaskResult, Artifact, TaskMetrics, TraceData, RetryPolicy } from '../types';
import { BaseAgent } from '../abstracts/base-agent';
import { WorkerAgent } from '../agents/worker-agent';
import { join } from 'node:path';
import { DEFAULT_RESOURCE_LIMITS } from '../worker/types';
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
  PlannerRole,
} from './types';
import {
  calculateRetryDelay,
  shouldRetry,
  resolveRetryPolicy,
  createOrchestratorConfig,
  type PartialOrchestratorConfig,
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
  CheckpointManager,
  listDir,
  fileExists,
  type ISessionFileManager,
  type ProgressFile,
  type PendingApprovalFile,
  type ApprovalResponseFile,
  type SessionFileEvent,
  type ThinkingRecord,
  type ActionRecord,
  type InterventionFile,
  type DecisionRecord,
  type CheckpointRestoreOptions,
  type RecoveryStrategy,
} from './session';
import { MemoryService } from '../memory';
import { CollaborationManager } from '../collaboration';
import type { MCPClientManager } from '../mcp';
import { z } from 'zod';

// ============================================================================
// 类型定义
// ============================================================================

const PLANNER_METADATA_SCHEMA = z
  .object({
    mode: z.enum(['full', 'patch']).optional(),
    maxSubtasks: z.number().finite().positive().optional(),
    previousError: z.string().min(1).optional(),
    previousFiles: z.array(z.string()).optional(),
  })
  .passthrough();

type PlannerMetadata = z.infer<typeof PLANNER_METADATA_SCHEMA>;

const MAX_SUBTASK_REFINEMENT_DEPTH = 2;
const DEFAULT_REFINEMENT_MAX_SUBTASKS = 4;
const DEFAULT_REFINEMENT_MAX_TURNS = DEFAULT_RESOURCE_LIMITS.maxThinkingRounds;

/**
 * Orchestrator 选项
 */
export interface OrchestratorOptions {
  /** 配置 */
  config?: PartialOrchestratorConfig;
  /** Planner 实例（可选，用于注入测试） */
  planner?: Planner;
  /** WorkerPool 实例（可选，用于注入测试） */
  workerPool?: IWorkerPool;
  /** SessionFileManager 实例（可选，用于注入测试） */
  sessionManager?: ISessionFileManager;
  /** MCP 客户端管理器（可选，用于 Worker MCP 工具集成） */
  mcpClient?: MCPClientManager;
}

/**
 * 从检查点恢复选项
 */
export interface ResumeFromCheckpointOptions {
  /** 恢复策略 */
  strategy?: RecoveryStrategy;
  /** 是否跳过失败的子任务 */
  skipFailed?: boolean;
  /** 是否重置重试计数 */
  resetRetryCount?: boolean;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 取消信号 */
  signal?: AbortSignal;
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

  /** Worker 思考转发处理器 */
  private readonly boundThinkingForwarder: (event: SessionFileEvent<ThinkingRecord>) => void;

  /** Worker 行动转发处理器 */
  private readonly boundActionForwarder: (event: SessionFileEvent<ActionRecord>) => void;

  /** 偏离检测定时器 */
  private deviationDetectionTimer: ReturnType<typeof setInterval> | null = null;

  /** 各 Worker 的最后干预时间（用于冷却控制） */
  private readonly workerInterventionCooldowns = new Map<string, number>();

  /** 已处理的审批请求缓存（requestId -> 处理时间戳，用于 TTL 清理） */
  private readonly processedApprovalRequests = new Map<string, number>();

  /** 审批请求缓存 TTL（5 分钟） */
  private static readonly REQUEST_CACHE_TTL = 5 * 60 * 1000;

  /** 角色定义缓存（用于懒加载 Worker 创建） */
  private roleDefinitions: PlannerRole[] = [];

  /** Memory 服务（跨会话记忆） */
  private memoryService?: MemoryService;

  /** 协作管理器 */
  private collaborationManager?: CollaborationManager;

  /** MCP 客户端管理器（用于 Worker MCP 工具集成） */
  private mcpClient: MCPClientManager | undefined;

  /** 当前运行上下文（从 task.context.metadata 派生） */
  private currentRunMetadata: Record<string, unknown> | null = null;

  /** 子任务复审缓存（避免重复拆分） */
  private readonly refinedSubtaskIds = new Set<string>();

  private isDebugEnabled(): boolean {
    const levelRaw = process.env.TACHIKOMA_LOG_LEVEL ?? '';
    const level = String(levelRaw).toLowerCase();
    return level === 'debug' || level === 'trace';
  }

  private getPlannerMetadata(): PlannerMetadata {
    const meta = this.currentRunMetadata;
    const planner =
      meta && typeof meta.planner === 'object' && meta.planner
        ? (meta.planner as Record<string, unknown>)
        : {};
    const parsed = PLANNER_METADATA_SCHEMA.safeParse(planner);
    return parsed.success ? parsed.data : {};
  }

  private getPlannerMode(): 'full' | 'patch' {
    return this.getPlannerMetadata().mode === 'patch' ? 'patch' : 'full';
  }

  private getPlannerMaxSubtasks(): number | undefined {
    return this.getPlannerMetadata().maxSubtasks;
  }

  private getPlannerPreviousError(): string | undefined {
    return this.getPlannerMetadata().previousError;
  }

  private getPlannerPreviousFiles(): string[] | undefined {
    return this.getPlannerMetadata().previousFiles;
  }

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
    this.boundThinkingForwarder = this.forwardThinkingEvent.bind(this);
    this.boundActionForwarder = this.forwardActionEvent.bind(this);
    
    // 初始化 MemoryService（如果配置启用）
    if (config.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(config.memoryConfig);
      console.debug('[Orchestrator] MemoryService initialized');
    }

    // 初始化协作管理器（如果配置启用）
    if (config.collaborationConfig?.enabled) {
      this.collaborationManager = new CollaborationManager({
        backend: config.collaborationConfig.backend ?? 'file',
        rootDir: config.session.rootDir,
        ...(config.collaborationConfig.redis && { redis: config.collaborationConfig.redis }),
      });
      console.debug('[Orchestrator] CollaborationManager created');
    }

    // 保存 MCP 客户端管理器（用于 Worker MCP 工具集成）
    this.mcpClient = options.mcpClient;
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

  /**
   * 从检查点恢复执行
   *
   * 加载指定检查点并从未完成的子任务继续执行
   *
   * @param checkpointId - 检查点 ID
   * @param options - 恢复选项
   * @returns 执行结果
   *
   * @example
   * ```ts
   * const result = await orchestrator.resumeFrom('ckpt-20251215-xxx', {
   *   strategy: 'resume',
   *   skipFailed: true,
   * });
   * ```
   */
  async resumeFrom(
    checkpointId: string,
    options: ResumeFromCheckpointOptions = {}
  ): Promise<TaskResult> {
    if (this.executionState || this.sessionManager) {
      return this.createFailureResult(
        'unknown',
        'Cannot resume from checkpoint while orchestrator is already running',
        Date.now(),
        { input: 0, output: 0 }
      );
    }

    const startTime = Date.now();
    const signal =
      options.signal ??
      (options.timeout ? AbortSignal.timeout(options.timeout) : new AbortController().signal);

    const rootDir = this.orchestratorConfig.session.rootDir;
    const sessionId = await this.findSessionIdForCheckpoint(checkpointId, rootDir);
    if (!sessionId) {
      return this.createFailureResult(
        'unknown',
        `Checkpoint not found: ${checkpointId}`,
        startTime,
        { input: 0, output: 0 }
      );
    }

    // 1. 绑定到检查点所属 session（只读恢复，不启用 watch，避免额外开销）
    const sessionManager = await createAndInitializeSessionFileManager(sessionId, {
      rootDir,
      enableWatch: false,
      autoCreateDirs: false,
    });

    // 2. 创建 CheckpointManager 并恢复
    const checkpointManager = new CheckpointManager(
      sessionId,
      sessionManager,
      {
        rootDir,
        autoSave: false,
      }
    );

    const restoreOptions: Partial<CheckpointRestoreOptions> = {
      strategy: options.strategy ?? 'resume',
      skipFailed: options.skipFailed ?? false,
      resetRetryCount: options.resetRetryCount ?? false,
    };

    const restoreResult = await checkpointManager.restoreFromCheckpoint(checkpointId, restoreOptions);

    if (!restoreResult.success || !restoreResult.checkpoint) {
      try {
        await checkpointManager.close();
      } finally {
        await sessionManager.close();
      }
      return this.createFailureResult('unknown', `Checkpoint restore failed: ${restoreResult.error}`, startTime, {
        input: 0,
        output: 0,
      });
    }

    const { checkpoint, workerSnapshots, planData, resumableSubtaskIds } = restoreResult;

    if (!planData?.plannerOutput) {
      try {
        await checkpointManager.close();
      } finally {
        await sessionManager.close();
      }
      return this.createFailureResult(
        checkpoint.taskId,
        'Plan data not found in checkpoint session',
        startTime,
        { input: 0, output: 0 }
      );
    }

    // 保存旧状态并临时切换到恢复 session（执行结束后恢复）
    const prevSessionManager = this.sessionManager;
    const prevSessionId = this.currentSessionId;
    const prevExecutionState = this.executionState;
    const prevRunMetadata = this.currentRunMetadata;

    // 3. 设置当前 Session
    this.sessionManager = sessionManager;
    this.currentSessionId = sessionId;
    // best-effort：恢复上下文数据（可能包含 workDir/llm 等）
    this.currentRunMetadata = (checkpoint.contextData as Record<string, unknown> | undefined) ?? null;
    this.refinedSubtaskIds.clear();

    try {
      // 4. 确保 WorkerPool 有可执行的 agent 绑定
      const existingExecutableWorkers = this.workerPool
        .getAllWorkers()
        .filter((w) => !!w.agent);
      if (existingExecutableWorkers.length === 0) {
        const roles = planData.plannerOutput.roles;
        const workerCount =
          (Array.isArray(roles) && roles.length > 0)
            ? roles.length
            : (planData.plannerOutput.delegation?.workerCount ?? this.orchestratorConfig.delegation.workerCount);
        await this.registerDefaultWorkers({
          workerCount,
          ...(Array.isArray(roles) ? { roles } : {}),
        });
      }

      // 5. 如果需要，可根据快照更新现有 WorkerPool 的状态（不创建新 worker）
      if (workerSnapshots && workerSnapshots.length > 0 && this.workerPool.rebuildFromSnapshots) {
        this.workerPool.rebuildFromSnapshots(workerSnapshots);
      }

      // 6. 构建仅执行“可恢复子任务”的计划：保留全部 subtasks（用于统计/依赖），仅过滤 steps
      const resumableSet = new Set(resumableSubtaskIds ?? []);
      const resumePlan = this.filterPlanToResumableSubtasks(planData.plannerOutput, resumableSet);

      // 7. 初始化执行状态（从检查点恢复）
      const carriedFailed = checkpoint.failedSubtaskIds.filter((id) => !resumableSet.has(id));
      const carriedRunning = checkpoint.runningSubtaskIds.filter((id) => !resumableSet.has(id));
      const failedSubtasks = new Map<string, string>([
        ...carriedFailed.map((id) => [id, 'Previously failed'] as const),
        ...carriedRunning.map((id) => [id, 'Previously running'] as const),
      ]);

      const completedSubtasks = new Map<string, TaskResult>();
      for (const id of checkpoint.completedSubtaskIds) {
        const output = (checkpoint.completedResults as Record<string, unknown>)[id];
        completedSubtasks.set(id, {
          taskId: id,
          status: 'success',
          output,
          artifacts: [],
          metrics: {
            startTime: checkpoint.createdAt,
            endTime: checkpoint.createdAt,
            duration: 0,
            tokensUsed: 0,
            toolCallCount: 0,
            retryCount: 0,
          },
          trace: {
            traceId: generateTimestampId('trace'),
            spanId: generateTimestampId('span'),
            operation: `orchestrator.${this.id}.resumeFrom.checkpoint`,
            attributes: { restored: true, checkpointId },
            events: [],
            duration: 0,
          },
        });
      }

      this.executionState = {
        currentStep: 0,
        totalSteps: resumePlan.executionPlan.steps.length,
        completedSubtasks,
        failedSubtasks,
        runningSubtasks: new Set(),
        startTime,
        totalTokens: checkpoint.totalTokens,
        totalRetries: checkpoint.totalRetries,
      };

      this.emit('checkpoint:restored', checkpoint.taskId, {
        checkpointId,
        strategy: restoreOptions.strategy,
        resumableCount: resumableSubtaskIds?.length ?? 0,
      });

      const aggregatedResult = await this.executeAssignPhase(checkpoint.taskId, resumePlan, signal);
      return this.createFinalResult(checkpoint.taskId, aggregatedResult, startTime);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return this.createFailureResult(
        checkpoint.taskId,
        err.message,
        startTime,
        { input: 0, output: 0 }
      );
    } finally {
      this.executionState = prevExecutionState;
      this.currentRunMetadata = prevRunMetadata;
      this.sessionManager = prevSessionManager;
      this.currentSessionId = prevSessionId;
      await checkpointManager.close().catch(() => undefined);
      await sessionManager.close().catch(() => undefined);
    }
  }

  /**
   * 过滤计划只保留可恢复的子任务
   */
  private filterPlanToResumableSubtasks(
    planOutput: PlannerOutput,
    resumableIds: Set<string>
  ): PlannerOutput {
    // 过滤执行步骤
    const filteredSteps = planOutput.executionPlan.steps
      .map(step => ({
        ...step,
        subtaskIds: step.subtaskIds.filter(id => resumableIds.has(id)),
      }))
      .filter(step => step.subtaskIds.length > 0);

    return {
      ...planOutput,
      executionPlan: {
        ...planOutput.executionPlan,
        steps: filteredSteps,
      },
    };
  }

  private normalizePlanRoles(plan: PlannerOutput): PlannerOutput {
    const roles = Array.isArray(plan.roles) ? plan.roles : [];
    if (roles.length === 0) return plan;

    const normalizeId = (raw: string): string => {
      const s = raw.trim().toLowerCase();
      const normalized = s
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || 'role';
    };

    const used = new Set<string>();
    const idMap = new Map<string, string>();

    const normalizedRoles: PlannerRole[] = roles.map((r, idx) => {
      const base = normalizeId(r.id || `role-${idx + 1}`);
      let candidate = base;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${n++}`;
      }
      used.add(candidate);
      idMap.set(r.id, candidate);

      const caps = Array.isArray(r.capabilities)
        ? r.capabilities.filter((c) => typeof c === 'string' && c.trim())
        : [];
      const stableCap = `role:${candidate}`;
      const mergedCaps = Array.from(new Set([stableCap, ...caps]));

      return {
        id: candidate,
        name: r.name,
        responsibilities: r.responsibilities,
        capabilities: mergedCaps,
      };
    });

    const normalizedSubtasks = plan.subtasks.map((st) => {
      const rawRoleId = st.roleId;
      if (!rawRoleId) return st;

      const mapped = idMap.get(rawRoleId) ?? normalizeId(rawRoleId);
      const role = normalizedRoles.find((r) => r.id === mapped);
      const roleExists = !!role;
      if (!roleExists) {
        const { roleId: _roleId, requiredCapabilities: _requiredCapabilities, ...rest } = st;
        return rest as SubTask;
      }

      const stableCap = `role:${mapped}`;
      const existing = Array.isArray(st.requiredCapabilities) ? st.requiredCapabilities : [];
      const requiredCapabilities = Array.from(
        new Set([stableCap, ...existing.filter((c) => typeof c === 'string' && c.trim())])
      );

      const roleConstraint = `你的角色：${role!.name}。职责：${role!.responsibilities}`.trim();
      const constraints = Array.isArray(st.constraints) ? st.constraints : [];
      const mergedConstraints = constraints.includes(roleConstraint)
        ? constraints
        : [roleConstraint, ...constraints];

      return {
        ...st,
        roleId: mapped,
        requiredCapabilities,
        constraints: mergedConstraints,
      };
    });

    const intake = plan.intake
      ? {
          ...plan.intake,
          roles: normalizedRoles,
        }
      : undefined;

    return {
      ...plan,
      roles: normalizedRoles,
      ...(intake && { intake }),
      subtasks: normalizedSubtasks,
    };
  }

  private async findSessionIdForCheckpoint(
    checkpointId: string,
    rootDir: string
  ): Promise<string | null> {
    const sessionsDir = join(rootDir, 'sessions');
    const sessionIds = await listDir(sessionsDir).catch(() => []);

    for (const sessionId of sessionIds) {
      const p = join(
        sessionsDir,
        sessionId,
        'orchestrator',
        'checkpoints',
        `${checkpointId}.json`
      );
      if (fileExists(p)) return sessionId;
    }

    return null;
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
    this.currentRunMetadata = task.context?.metadata ?? null;
    this.refinedSubtaskIds.clear();
    await this.initializeSession(task.id, task.context?.sessionId);
    await this.initializeSharedContext(orchestratorTask);

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

      // 规范化角色/能力标识（用于 worker 路由与稳定 workerId）
      const normalizedPlan = this.normalizePlanRoles(planResult.output);

      this.emit('plan:complete', task.id, { plan: normalizedPlan });

      // 保存计划到会话文件
      await this.savePlanToSession(task.id, normalizedPlan);

      // 入口评估：信息不足时不执行，转为对话澄清
      if (normalizedPlan.intake?.ready === false) {
        const questions = normalizedPlan.intake.questions ?? [];
        const missingInfo = normalizedPlan.intake.missingInfo ?? [];
        const question = questions.length > 0
          ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
          : '请补充关键需求信息后再继续。';
        return this.createNeedUserInputResult(task.id, startTime, planResult.tokensUsed, question, missingInfo);
      }

      // 确保 Worker 已注册（增量注册：已存在的跳过，缺少的补充）
      // 分析执行计划中每个角色需要的最大并行 Worker 数
      const parallelRequirements = this.extractParallelRequirements(normalizedPlan);
      await this.registerDefaultWorkers({
        workerCount: normalizedPlan.delegation.workerCount,
        ...(Array.isArray(normalizedPlan.roles) ? { roles: normalizedPlan.roles } : {}),
        parallelRequirements,
      });

      // 阶段 2: 执行（分配与聚合）
      const aggregatedResult = await this.executeAssignPhase(
        task.id,
        normalizedPlan,
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
      this.currentRunMetadata = null;
      
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
   * 初始化共享上下文（selective memory sync 的载体）
   */
  private async initializeSharedContext(task: OrchestratorTask): Promise<void> {
    if (!this.sessionManager || !this.currentSessionId) return;

    // 若已存在则不覆盖（允许跨 run 复用同一 sessionId）
    const existing = await this.sessionManager.readSharedContext().catch(() => null);
    if (existing) return;

    const workDir = this.extractWorkDirFromMetadata() ?? process.cwd();

    await this.sessionManager.writeSharedContext({
      objective: task.objective,
      constraints: task.constraints,
      sharedKnowledge: { data: {}, updatedAt: Date.now() },
      workspace: { rootPath: workDir, keyFiles: [] },
    });
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
  private async initializeSession(_taskId: string, sessionId?: string): Promise<void> {
    this.currentSessionId = sessionId ?? generateTimestampId('session');

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

    // 转发 Worker 日志事件（用于 Runtime 流式输出）
    this.sessionManager.on<ThinkingRecord>('thinking_updated', this.boundThinkingForwarder);
    this.sessionManager.on<ActionRecord>('action_completed', this.boundActionForwarder);

    // 启动文件监控（如果配置启用且 SessionManager 支持）
    // 对于注入的 SessionManager，由调用者负责管理监控生命周期
    if (!this.injectedSessionManager && this.sessionManager) {
      await this.sessionManager.startWatching();
    }

    // 启动偏离检测定时器（如果配置启用）
    this.startDeviationDetection();

    // 启动协作管理器（如果配置启用）- best-effort，不阻断主流程
    if (this.collaborationManager && this.orchestratorConfig.collaborationConfig?.enabled) {
      try {
        await this.collaborationManager.start(`orchestrator-${this.id}`, {
          sessionId: this.currentSessionId!,
          type: 'orchestrator',
          capabilities: ['planning', 'coordination'],
          status: 'online',
          priority: 10,
        });
        
        // 注册协作请求处理器
        this.registerCollaborationRequestHandler();
        
        console.debug('[Orchestrator] Collaboration started');
      } catch (error) {
        console.warn('[Orchestrator] Failed to start collaboration (non-fatal):', error);
        // 协作启动失败不影响主流程
      }
    }
  }

  /**
   * 关闭会话
   *
   * 先取消事件监听、停止文件监控，再关闭 SessionManager
   */
  private async closeSession(): Promise<void> {
    // 重置所有 Worker 状态（防止上次任务未正常结束导致 worker 卡在 busy）
    if (this.workerPool) {
      for (const worker of this.workerPool.getAllWorkers()) {
        if (worker.status === 'busy') {
          if (worker.currentTaskId) {
            this.workerPool.completeTask(worker.currentTaskId);
          } else {
            this.workerPool.updateWorkerStatus(worker.id, 'idle');
          }
        }
      }
    }

    // 停止偏离检测定时器
    this.stopDeviationDetection();

    // 停止协作管理器
    if (this.collaborationManager) {
      await this.collaborationManager.stop();
    }

    // 取消审批事件监听
    if (this.sessionManager) {
      this.sessionManager.off<PendingApprovalFile>(
        'pending_approval_created',
        this.boundApprovalHandler
      );
      this.sessionManager.off<ThinkingRecord>('thinking_updated', this.boundThinkingForwarder);
      this.sessionManager.off<ActionRecord>('action_completed', this.boundActionForwarder);
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
   * 转发 Worker 思考事件为 Orchestrator 事件
   */
  private forwardThinkingEvent(event: SessionFileEvent<ThinkingRecord>): void {
    const workerId = this.deriveWorkerIdFromEvent(event) ?? 'unknown';
    const taskId = this.currentTask?.id ?? '';
    this.emit('worker:thinking', taskId, { workerId, record: event.data }, event.data.subtaskId);
  }

  /**
   * 转发 Worker 行动事件为 Orchestrator 事件
   */
  private forwardActionEvent(event: SessionFileEvent<ActionRecord>): void {
    const workerId = this.deriveWorkerIdFromEvent(event) ?? 'unknown';
    const taskId = this.currentTask?.id ?? '';
    // 仅在 debug 时输出事件转发日志，避免污染上层输出
    if (this.isDebugEnabled() && event.data.description?.startsWith('Calling tool:')) {
      console.debug(`[Orchestrator] Forwarding worker:action: ${event.data.description}`);
    }
    this.emit('worker:action', taskId, { workerId, record: event.data }, event.data.subtaskId);
  }

  private deriveWorkerIdFromEvent(event: { workerId?: string; filePath?: string }): string | undefined {
    if (event.workerId) return event.workerId;
    if (!event.filePath) return undefined;
    // 兼容不同平台分隔符：.../workers/<id>/...
    const m = event.filePath.match(/[\\/]+workers[\\/]+([^\\/]+)[\\/]+/);
    return m?.[1];
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

    const maxSubtasks = this.getPlannerMaxSubtasks() ?? this.orchestratorConfig.planner.defaultMaxSubtasks;
    const input: PlannerInput = {
      task,
      maxSubtasks,
    };

    if (this.getPlannerMode() !== 'patch') {
      return this.planner.plan(input);
    }

    const previousContext = await this.buildPatchPreviousContext().catch(() => '');
    return this.planner.planPatch(input, previousContext);
  }

  private async buildPatchPreviousContext(): Promise<string> {
    if (!this.sessionManager) return '';

    const MAX_CHARS = 8000;
    const parts: string[] = [];
    let used = 0;

    const tryAppendLine = (line: string): boolean => {
      const extra = (parts.length === 0 ? 0 : 1) + line.length;
      if (used + extra > MAX_CHARS) return false;
      parts.push(line);
      used += extra;
      return true;
    };

    const appendSection = (header: string, lines: string[]): void => {
      if (lines.length === 0) return;
      if (parts.length > 0) tryAppendLine('');
      if (!tryAppendLine(header)) return;
      for (const line of lines) {
        if (!tryAppendLine(line)) {
          tryAppendLine('... (truncated)');
          return;
        }
      }
    };

    const previousError = this.getPlannerPreviousError();
    const previousFiles = this.getPlannerPreviousFiles();

    const [plan, progress, decisions, shared] = await Promise.all([
      this.sessionManager.readOrchestratorPlan().catch(() => null),
      this.sessionManager.readProgress().catch(() => null),
      this.sessionManager.readDecisions(10).catch(() => []),
      this.sessionManager.readSharedContext().catch(() => null),
    ]);

    const syncLog = shared?.sharedKnowledge?.data?.syncLog;

    // High priority: previousError + execution status (failed/running)
    if (previousError) {
      appendSection('### Previous error', [previousError.slice(0, 1500)]);
    }

    if (progress) {
      const lines: string[] = [];
      lines.push(`- status: ${progress.status}`);
      lines.push(`- step: ${progress.currentStep}/${progress.totalSteps}`);
      if (progress.completedSubtasks.length > 0) {
        lines.push(
          `- completed: ${progress.completedSubtasks.slice(0, 10).join(', ')}${
            progress.completedSubtasks.length > 10 ? ', ...' : ''
          }`
        );
      }
      if (progress.failedSubtasks.length > 0) {
        lines.push(
          `- failed: ${progress.failedSubtasks.slice(0, 10).join(', ')}${
            progress.failedSubtasks.length > 10 ? ', ...' : ''
          }`
        );
      }
      if (progress.runningSubtasks.length > 0) {
        lines.push(
          `- running: ${progress.runningSubtasks.slice(0, 10).join(', ')}${
            progress.runningSubtasks.length > 10 ? ', ...' : ''
          }`
        );
      }
      appendSection('### Previous execution status', lines);
    }

    // Medium priority: file hints (deduped) + plan summary + decisions
    const fileHints: string[] = [];
    const seenFiles = new Set<string>();

    if (Array.isArray(previousFiles)) {
      for (const f of previousFiles) {
        if (!f || seenFiles.has(f)) continue;
        seenFiles.add(f);
        fileHints.push(f);
      }
    }

    if (Array.isArray(syncLog)) {
      for (const item of syncLog.slice(-10)) {
        if (!item?.modifiedFiles || !Array.isArray(item.modifiedFiles)) continue;
        for (const f of item.modifiedFiles) {
          if (!f || seenFiles.has(f)) continue;
          seenFiles.add(f);
          fileHints.push(f);
        }
      }
    }

    if (fileHints.length > 0) {
      appendSection(
        '### Previously affected files (hint)',
        fileHints.slice(0, 30).map((f) => `- ${f}`)
      );
    }

    if (plan?.plannerOutput) {
      const p = plan.plannerOutput;
      appendSection(
        '### Previous plan',
        p.subtasks.slice(0, 20).map((st) => `- ${st.id}: ${st.objective}`)
      );
    }

    if (decisions.length > 0) {
      const lines: string[] = [];
      for (const d of decisions.slice(-5)) {
        const ref = [d.subtaskId, d.workerId].filter(Boolean).join(' / ');
        const head = `[${d.type}]${ref ? ` ${ref}:` : ''}`;
        const reason = d.decision?.reason ? String(d.decision.reason) : '';
        lines.push(`- ${head} ${reason.slice(0, 200)}`.trim());
      }
      appendSection('### Recent orchestrator decisions', lines);
    }

    // Low priority: sync log summaries
    if (Array.isArray(syncLog) && syncLog.length > 0) {
      const lines: string[] = [];
      for (const item of syncLog.slice(-5)) {
        const decisionsSummary =
          Array.isArray(item.decisions) && item.decisions.length > 0
            ? ` | decisions: ${item.decisions
                .slice(0, 3)
                .map(
                  (d) =>
                    `${d.type}${
                      d.approved === undefined ? '' : d.approved ? '(approved)' : '(rejected)'
                    }:${d.reason}`
                )
                .join('; ')}`
            : '';
        const outputSummary =
          typeof item.output === 'string' && item.output.trim()
            ? ` | output: ${item.output.trim().slice(0, 200)}${item.output.length > 200 ? '...' : ''}`
            : '';
        lines.push(
          `- ${item.subtaskId} (${item.workerId}): ${item.objective}` +
            (item.modifiedFiles && item.modifiedFiles.length > 0
              ? ` | files: ${item.modifiedFiles.join(', ')}`
              : '') +
            decisionsSummary +
            outputSummary
        );
      }
      appendSection('### Recent syncLog (selective)', lines);
    }

    return parts.join('\n').trim();
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
      // 设计说明：retryPolicy 采用“配置优先 + 可选 guardrail”
      // - config: 基础设施默认策略
      // - planner: 允许 Planner 调整（缺省字段回退配置）
      // - guardrail: Planner 调整，但受配置上限/下限保护
      const effectiveRetryPolicy = resolveRetryPolicy(
        delegation.retryPolicy,
        this.orchestratorConfig.delegation.retryPolicy,
        this.orchestratorConfig.delegation.retryPolicyMode ?? 'config'
      );
      await this.executeStep(
        taskId,
        step,
        subtaskMap,
        delegation.timeout,
        effectiveRetryPolicy,
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
      await this.ensureParallelWorkersForStep(step, subtaskMap);
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
    signal: AbortSignal,
    refinementDepth = 0
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

    if (signal.aborted) {
      return {
        subtaskId,
        success: false,
        error: 'Aborted',
        retryCount: 0,
      };
    }

    const refinementResult = await this.maybeRefineSubtask(
      taskId,
      subtask,
      subtaskMap,
      timeout,
      retryPolicy,
      signal,
      refinementDepth
    );
    if (refinementResult) {
      return refinementResult;
    }

    // 标记为运行中
    this.executionState!.runningSubtasks.add(subtaskId);
    subtask.status = 'running';

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

        const workerId = assignResult.workerId!;
        subtask.assignedWorkerId = workerId;

        // Emit after a concrete worker is chosen so consumers can display accurate routing info.
        this.emit('subtask:assigned', taskId, { subtaskId, subtask, workerId }, subtaskId);

        // 等待 Worker 完成（WorkerAgent 驱动）
        const result = await this.waitForWorkerCompletion(subtask, workerId, timeout, signal);

        // selective sync：将关键决策/产物写入 shared context（best-effort）
        await this.syncSharedContextSelective(workerId, subtask, result).catch(() => undefined);

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

  private async maybeRefineSubtask(
    taskId: string,
    subtask: SubTask,
    subtaskMap: Map<string, SubTask>,
    timeout: number,
    retryPolicy: RetryPolicy,
    signal: AbortSignal,
    refinementDepth: number
  ): Promise<SubTaskExecutionResult | null> {
    if (refinementDepth >= MAX_SUBTASK_REFINEMENT_DEPTH) {
      return null;
    }

    if (this.refinedSubtaskIds.has(subtask.id)) {
      return null;
    }

    this.refinedSubtaskIds.add(subtask.id);

    const estimatedMinutes =
      typeof subtask.estimatedDuration === 'number' && subtask.estimatedDuration > 0
        ? Math.max(1, Math.round(subtask.estimatedDuration / 60000))
        : undefined;

    // Skip refinement for short tasks (<=10 minutes) - no LLM call needed
    // This prevents unnecessary splitting of already-small subtasks like subtask-3.1
    const SKIP_REFINEMENT_THRESHOLD_MINUTES = 10;
    if (typeof estimatedMinutes === 'number' && estimatedMinutes <= SKIP_REFINEMENT_THRESHOLD_MINUTES) {
      console.debug(
        `[Orchestrator] Skipping refinement for ${subtask.id}: only ${estimatedMinutes} min (threshold: ${SKIP_REFINEMENT_THRESHOLD_MINUTES})`
      );
      return null;
    }

    const refineResult = await this.planner.refineSubtask({
      objective: subtask.objective,
      constraints: subtask.constraints,
      maxSubtasks: DEFAULT_REFINEMENT_MAX_SUBTASKS,
      maxThinkingRounds: DEFAULT_REFINEMENT_MAX_TURNS,
      estimatedMinutes,
    });

    if (this.executionState) {
      this.executionState.totalTokens +=
        refineResult.tokensUsed.input + refineResult.tokensUsed.output;
    }

    if (!refineResult.success || !refineResult.shouldSplit || !refineResult.subtasks) {
      return null;
    }

    const refinedSubtasks = this.createRefinedSubtasks(
      subtask,
      refineResult.subtasks,
      subtaskMap
    );

    if (refinedSubtasks.length < 2) {
      return null;
    }

    // Archive refined subtasks to plan.json
    if (this.sessionManager) {
      await this.sessionManager.appendRefinedSubtasks({
        parentId: subtask.id,
        refinedSubtasks,
      });
    }

    if (signal.aborted) {
      return {
        subtaskId: subtask.id,
        success: false,
        error: 'Aborted',
        retryCount: 0,
      };
    }

    this.executionState!.runningSubtasks.add(subtask.id);
    subtask.status = 'running';

    for (const refined of refinedSubtasks) {
      subtaskMap.set(refined.id, refined);
    }

    const startTime = Date.now();
    const childResults: SubTaskExecutionResult[] = [];
    let failure: SubTaskExecutionResult | null = null;

    for (const refined of refinedSubtasks) {
      if (signal.aborted) {
        failure = {
          subtaskId: subtask.id,
          success: false,
          error: 'Aborted',
          retryCount: 0,
        };
        break;
      }

      const result = await this.executeSubtask(
        taskId,
        refined.id,
        subtaskMap,
        timeout,
        retryPolicy,
        signal,
        refinementDepth + 1
      );
      childResults.push(result);

      if (!result.success) {
        failure = result;
        break;
      }
    }

    this.executionState!.runningSubtasks.delete(subtask.id);

    if (failure) {
      const errorMessage = failure.error || `Subtask ${failure.subtaskId} failed`;
      this.markSubtaskFailed(subtask, subtask.id, errorMessage);
      this.emit('subtask:failed', taskId, { error: errorMessage, retryCount: 0 }, subtask.id);
      return {
        subtaskId: subtask.id,
        success: false,
        error: errorMessage,
        retryCount: 0,
      };
    }

    const result = this.buildRefinedSubtaskResult(subtask, refinedSubtasks, startTime, childResults);
    this.executionState!.completedSubtasks.set(subtask.id, result);
    subtask.status = 'success';
    subtask.result = result;

    this.emit('subtask:complete', taskId, { result }, subtask.id);

    return {
      subtaskId: subtask.id,
      success: true,
      result,
      retryCount: 0,
    };
  }

  private createRefinedSubtasks(
    parent: SubTask,
    refined: Array<{
      objective: string;
      constraints: string[];
      estimatedMinutes?: number;
    }>,
    subtaskMap: Map<string, SubTask>
  ): SubTask[] {
    const refinedList = refined.slice(0, DEFAULT_REFINEMENT_MAX_SUBTASKS);
    const result: SubTask[] = [];
    const reservedIds = new Set(subtaskMap.keys());
    const parentDependencies = Array.isArray(parent.dependencies)
      ? Array.from(new Set(parent.dependencies.filter((dep) => dep && dep !== parent.id)))
      : [];

    for (let i = 0; i < refinedList.length; i++) {
      const item = refinedList[i];
      const id = this.generateRefinedSubtaskId(parent.id, i + 1, reservedIds);
      const constraints = this.mergeConstraints(parent.constraints, item.constraints);
      const estimatedDuration =
        typeof item.estimatedMinutes === 'number' && Number.isFinite(item.estimatedMinutes)
          ? item.estimatedMinutes * 60 * 1000
          : undefined;
      const dependencies = result.length > 0
        ? [result[result.length - 1].id]
        : [...parentDependencies];

      result.push({
        id,
        parentId: parent.id,
        objective: item.objective,
        constraints,
        ...(parent.roleId !== undefined && { roleId: parent.roleId }),
        ...(Array.isArray(parent.requiredCapabilities) && parent.requiredCapabilities.length > 0
          ? { requiredCapabilities: parent.requiredCapabilities }
          : {}),
        ...(typeof estimatedDuration === 'number' ? { estimatedDuration } : {}),
        ...(parent.priority !== undefined && { priority: parent.priority }),
        dependencies,
        status: 'pending',
      });

      reservedIds.add(id);
    }

    return result;
  }

  private generateRefinedSubtaskId(
    baseId: string,
    index: number,
    reservedIds: Set<string>
  ): string {
    let candidate = `${baseId}.${index}`;
    let suffix = index;
    while (reservedIds.has(candidate)) {
      suffix += 1;
      candidate = `${baseId}.${suffix}`;
    }
    return candidate;
  }

  private mergeConstraints(parentConstraints: string[], childConstraints?: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    const pushUnique = (value: string): void => {
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      merged.push(trimmed);
    };

    for (const item of parentConstraints) {
      if (typeof item === 'string') {
        pushUnique(item);
      }
    }

    if (Array.isArray(childConstraints)) {
      for (const item of childConstraints) {
        if (typeof item === 'string') {
          pushUnique(item);
        }
      }
    }

    return merged;
  }

  private buildRefinedSubtaskResult(
    parent: SubTask,
    refinedSubtasks: SubTask[],
    startTime: number,
    childResults: SubTaskExecutionResult[]
  ): TaskResult {
    const endTime = Date.now();
    const traceId = generateTimestampId('trace');
    const spanId = generateTimestampId('span');

    return {
      taskId: parent.id,
      status: 'success',
      output: {
        message: `Refined into ${refinedSubtasks.length} subtasks`,
        subtasks: childResults.map((r) => ({
          id: r.subtaskId,
          success: r.success,
          ...(r.error ? { error: r.error } : {}),
        })),
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
      trace: {
        traceId,
        spanId,
        operation: `orchestrator.${this.id}.refine`,
        attributes: {
          refined: true,
          parentSubtaskId: parent.id,
        },
        events: [],
        duration: endTime - startTime,
      },
    };
  }

  private async ensureParallelWorkersForStep(
    step: ExecutionStep,
    subtaskMap: Map<string, SubTask>
  ): Promise<void> {
    const maxWorkers = this.orchestratorConfig.workerPool.maxWorkers;
    if (this.workerPool.workerCount >= maxWorkers) {
      return;
    }

    const roleCounts = new Map<string, number>();
    for (const subtaskId of step.subtaskIds) {
      const roleId = subtaskMap.get(subtaskId)?.roleId;
      if (!roleId) continue;
      roleCounts.set(roleId, (roleCounts.get(roleId) ?? 0) + 1);
    }

    for (const [roleId, requiredCount] of roleCounts.entries()) {
      if (this.workerPool.workerCount >= maxWorkers) break;
      const existingCount = this.workerPool.getWorkersByRole(roleId).length;
      const needed = requiredCount - existingCount;
      if (needed <= 0) continue;

      const toCreate = Math.min(needed, maxWorkers - this.workerPool.workerCount);
      for (let i = 0; i < toCreate; i++) {
        const newWorkerId = this.generateWorkerId(roleId);
        const capabilities = this.getRoleCapabilities(roleId);
        await this.createAndRegisterWorker(newWorkerId, roleId, capabilities);
        console.debug(`[Orchestrator] Created new worker ${newWorkerId} for parallel role ${roleId}`);
      }
    }
  }

  private getMemorySyncStrategy(): 'selective' | 'nightly_full' {
    const meta = this.currentRunMetadata;
    const raw = meta && typeof meta.memorySync === 'object' && meta.memorySync ? (meta.memorySync as Record<string, unknown>) : null;
    const strategy = raw && typeof raw.strategy === 'string' ? raw.strategy : 'selective';
    return strategy === 'nightly_full' ? 'nightly_full' : 'selective';
  }

  private async syncSharedContextSelective(
    workerId: string,
    subtask: SubTask,
    result: TaskResult
  ): Promise<void> {
    if (!this.sessionManager) return;
    if (this.getMemorySyncStrategy() !== 'selective') return;

    const shared = await this.sessionManager.readSharedContext().catch(() => null);
    if (!shared) return;

    const actions = await this.sessionManager.readActionLogs(workerId, 200).catch(() => []);
    const modifiedFiles = this.extractModifiedFilesFromActions(actions, subtask.id);

    const decisions = await this.sessionManager.readDecisions(200).catch(() => []);
    const decisionSummary = this.extractDecisionSummary(decisions, workerId, subtask.id);

    const outputText = this.extractResultText(result);

    const nextData = {
      ...(shared.sharedKnowledge?.data ?? {}),
    };

    const syncLog = Array.isArray(nextData.syncLog) ? nextData.syncLog.slice(-19) : [];

    syncLog.push({
      subtaskId: subtask.id,
      workerId,
      objective: subtask.objective,
      updatedAt: Date.now(),
      ...(modifiedFiles.length > 0 && { modifiedFiles }),
      ...(decisionSummary.length > 0 && { decisions: decisionSummary }),
      ...(outputText && { output: outputText }),
    });

    nextData.syncLog = syncLog;

    await this.sessionManager.writeSharedContext({
      objective: shared.objective,
      constraints: shared.constraints,
      sharedKnowledge: { data: nextData, updatedAt: Date.now() },
      ...(shared.workspace && { workspace: shared.workspace }),
    });
  }

  private extractModifiedFilesFromActions(actions: ActionRecord[], subtaskId: string): string[] {
    const files = new Set<string>();
    for (const a of actions) {
      if (a.subtaskId !== subtaskId) continue;
      if (!a.params || typeof a.params !== 'object') continue;
      const tool = (a.params as Record<string, unknown>).tool;
      if (tool !== 'apply_patch' && tool !== 'file_write') continue;
      const input = (a.params as Record<string, unknown>).input;
      if (!input || typeof input !== 'object') continue;
      const path = (input as Record<string, unknown>).path;
      if (typeof path === 'string' && path) files.add(path);
    }
    return Array.from(files);
  }

  private extractDecisionSummary(
    decisions: DecisionRecord[],
    workerId: string,
    subtaskId: string
  ): Array<{ type: string; reason: string; approved?: boolean }> {
    return decisions
      .filter((d) => d.workerId === workerId && d.subtaskId === subtaskId)
      .slice(-20)
      .map((d) => ({
        type: d.type,
        reason: d.decision.reason,
        ...(d.decision.approved !== undefined && { approved: d.decision.approved }),
      }));
  }

  private extractResultText(result: TaskResult): string | undefined {
    const out = result.output as unknown;
    if (!out || typeof out !== 'object') return undefined;
    const text = (out as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) {
      const sanitized = this.stripToolUseXml(text);
      if (sanitized) return sanitized.slice(0, 800);
    }
    const message = (out as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      const sanitized = this.stripToolUseXml(message);
      if (sanitized) return sanitized.slice(0, 800);
    }
    return undefined;
  }

  private stripToolUseXml(input: string): string | undefined {
    const original = input.trim();
    if (!original) return undefined;

    // Remove complete tool_use blocks.
    let cleaned = original.replace(/<tool_use[\s\S]*?<\/tool_use>/g, '').trim();
    // Remove dangling tool_use content if model output got cut mid-block.
    cleaned = cleaned.replace(/<tool_use[\s\S]*$/g, '').trim();

    // Normalize whitespace/newlines.
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    return cleaned || undefined;
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
   * 分配子任务给 Worker（懒加载模式）
   * 
   * 工作流程：
   * 1. 尝试找到具有匹配能力的空闲 Worker
   * 2. 如果没有空闲 Worker 且池未满，按需创建新 Worker
   * 3. 如果池已满，通过 WorkerPool 等待队列处理
   */
  private async assignToWorker(
    subtask: SubTask,
    timeout: number,
    retryPolicy: RetryPolicy
  ): Promise<AssignmentResult> {
    const roleId = subtask.roleId;
    const roleCap = roleId ? `role:${roleId}` : undefined;
    
    const requiredCapabilities = Array.isArray(subtask.requiredCapabilities) && subtask.requiredCapabilities.length > 0
      ? subtask.requiredCapabilities
      : undefined;
    
    // 1. 尝试找到匹配的空闲 Worker
    if (roleCap) {
      const idleWorker = this.workerPool.findIdleByCapability(roleCap);
      if (idleWorker) {
        console.debug(`[Orchestrator] Reusing idle worker ${idleWorker.id} for subtask ${subtask.id}`);
        return this.workerPool.assign(subtask, timeout, retryPolicy, {
          preferredWorkerId: idleWorker.id,
          ...(requiredCapabilities && { requiredCapabilities }),
        });
      }
    }

    // 2. 如果没有空闲 Worker，尝试按需创建
    const maxWorkers = this.orchestratorConfig.workerPool.maxWorkers;
    if (this.workerPool.workerCount < maxWorkers && roleId) {
      const newWorkerId = this.generateWorkerId(roleId);
      const capabilities = this.getRoleCapabilities(roleId);
      
      await this.createAndRegisterWorker(newWorkerId, roleId, capabilities);
      console.debug(`[Orchestrator] Created new worker ${newWorkerId} for subtask ${subtask.id}`);
      
      return this.workerPool.assign(subtask, timeout, retryPolicy, {
        preferredWorkerId: newWorkerId,
        ...(requiredCapabilities && { requiredCapabilities }),
      });
    }

    // 3. 池已满或无角色信息，通过 WorkerPool 标准分配流程处理
    const preferredWorkerId = roleId ? `worker-${roleId}` : undefined;
    return this.workerPool.assign(subtask, timeout, retryPolicy, {
      ...(requiredCapabilities && { requiredCapabilities }),
      ...(preferredWorkerId && { preferredWorkerId }),
    });
  }

  /**
   * 生成唯一的 Worker ID
   */
  private generateWorkerId(roleId: string): string {
    const existing = this.workerPool.getWorkersByRole(roleId);
    if (existing.length === 0) return `worker-${roleId}`;
    return `worker-${roleId}-${existing.length}`;
  }

  /**
   * 获取角色对应的能力列表
   */
  private getRoleCapabilities(roleId: string): string[] {
    const role = this.roleDefinitions.find(r => r.id === roleId);
    const stableRoleCap = `role:${roleId}`;
    if (role) {
      return [
        'general',
        ...role.capabilities,
        ...(role.capabilities.includes(stableRoleCap) ? [] : [stableRoleCap]),
      ];
    }
    // 如果没有找到角色定义，返回基本能力
    return ['general', stableRoleCap];
  }

  /**
   * 按需创建并注册 Worker
   */
  private async createAndRegisterWorker(
    workerId: string,
    _roleId: string,
    capabilities: string[]
  ): Promise<void> {
    const llm = this.extractLLMFromMetadata();
    const workDir = this.extractWorkDirFromMetadata();
    const canUseRealWorkerAgent = !!(llm && llm.apiKey);

    // 获取协作配置（如果启用）
    const collaborationConfig = this.buildWorkerCollaborationConfig(workerId, capabilities);

    const agent = canUseRealWorkerAgent
      ? new WorkerAgent(
          workerId,
          {
            provider: llm?.provider ?? this.config.provider,
            model: llm?.model ?? this.config.model,
            maxTokens: this.config.maxTokens,
            ...(this.config.temperature !== undefined && { temperature: this.config.temperature }),
          },
          {
            ...(workDir !== undefined && { workDir }),
            ...(this.sessionManager && { sessionManager: this.sessionManager }),
            backendConfig: {
              ...(llm?.apiKey && { apiKey: llm.apiKey }),
              ...(llm?.baseUrl && { baseUrl: llm.baseUrl }),
            },
            ...(collaborationConfig && { collaborationConfig }),
            // MCP 工具集成
            ...(this.mcpClient && { mcpClient: this.mcpClient }),
          }
        )
      : {
          id: workerId,
          type: 'worker' as const,
          config: { provider: 'mock', model: 'mock', maxTokens: 0 },
          run: async (t: Task): Promise<TaskResult> => ({
            taskId: t.id,
            status: 'success',
            output: { objective: t.objective, message: 'mock worker' },
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
              operation: `mock-worker.${workerId}.run`,
              attributes: {},
              events: [],
              duration: 0,
            },
          }),
          stop: async () => undefined,
        };

    this.workerPool.register({
      id: workerId,
      status: 'idle',
      capabilities,
      agent,
    });

    // 注册到 SessionManager
    if (this.sessionManager) {
      await this.sessionManager.registerWorker(workerId);
    }
  }

  /**
   * 分析执行计划，提取每个角色需要的最大并行 Worker 数
   *
   * 遍历执行计划的每个步骤，统计同一步骤内同一角色的子任务数量，
   * 取每个角色在所有步骤中的最大值。
   *
   * @param plan - 规划输出
   * @returns 角色 ID 到最大并行数的映射
   */
  private extractParallelRequirements(plan: PlannerOutput): Map<string, number> {
    const requirements = new Map<string, number>();

    // 构建 subtaskId -> roleId 的映射
    const subtaskRoleMap = new Map<string, string>();
    for (const subtask of plan.subtasks) {
      if (subtask.roleId) {
        subtaskRoleMap.set(subtask.id, subtask.roleId);
      }
    }

    // 遍历每个执行步骤
    for (const step of plan.executionPlan.steps) {
      if (!step.parallel) {
        // 非并行步骤中每个任务顺序执行，不需要多 worker
        continue;
      }

      // 统计该步骤中每个角色的子任务数量
      const stepRoleCounts = new Map<string, number>();
      for (const subtaskId of step.subtaskIds) {
        const roleId = subtaskRoleMap.get(subtaskId);
        if (roleId) {
          stepRoleCounts.set(roleId, (stepRoleCounts.get(roleId) ?? 0) + 1);
        }
      }

      // 更新全局最大值
      for (const [roleId, count] of stepRoleCounts) {
        const current = requirements.get(roleId) ?? 1;
        if (count > current) {
          requirements.set(roleId, count);
        }
      }
    }

    return requirements;
  }

  /**
   * 初始化 Worker 配置（懒加载模式）
   *
   * 在懒加载模式下，此方法只存储角色定义，不再预创建 Workers。
   * Workers 将在 assignToWorker 中按需创建。
   * 
   * @param opts.roles - 角色定义列表
   */
  private async registerDefaultWorkers(opts?: {
    workerCount?: number;
    roles?: PlannerRole[];
    /** 每个角色需要的最大并发 Worker 数（已废弃，懒加载模式下忽略） */
    parallelRequirements?: Map<string, number>;
  }): Promise<void> {
    const roles = Array.isArray(opts?.roles) && opts.roles.length > 0 ? opts.roles : null;

    // 懒加载模式：只存储角色定义，不预创建 Workers
    // Workers 将在 assignToWorker 中按需创建
    if (roles) {
      this.roleDefinitions = roles;
      console.debug(`[Orchestrator] Lazy worker mode: stored ${roles.length} role definitions`);
    } else {
      // 非角色化模式：清空角色定义
      this.roleDefinitions = [];
    }

    // 注意：不再在这里预创建任何 Worker
    // 所有 Worker 创建都通过 assignToWorker -> createAndRegisterWorker 按需进行
  }

  private extractWorkDirFromMetadata(): string | undefined {
    const meta = this.currentRunMetadata;
    const workDir = meta && typeof meta.workDir === 'string' ? meta.workDir : undefined;
    return workDir ?? undefined;
  }

  private extractLLMFromMetadata(): { provider: string; model: string; apiKey?: string; baseUrl?: string } | null {
    const meta = this.currentRunMetadata;
    const llm = meta && typeof meta.llm === 'object' && meta.llm ? (meta.llm as Record<string, unknown>) : null;
    if (!llm) return null;
    const provider = typeof llm.provider === 'string' ? llm.provider : undefined;
    const model = typeof llm.model === 'string' ? llm.model : undefined;
    if (!provider || !model) return null;
    return {
      provider,
      model,
      ...(typeof llm.apiKey === 'string' && llm.apiKey ? { apiKey: llm.apiKey } : {}),
      ...(typeof llm.baseUrl === 'string' && llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
    };
  }

  /**
   * 为 Worker 构建协作配置
   * 
   * 确保 Worker 使用与 Orchestrator 相同的 rootDir，
   * 使得所有 Agent 能够通过共享文件系统互相发现和通信。
   * 
   * @param workerId - Worker ID
   * @param capabilities - Worker 能力列表
   * @returns 协作配置，如果协作未启用则返回 undefined
   */
  private buildWorkerCollaborationConfig(
    workerId: string,
    capabilities: string[]
  ): {
    enabled: boolean;
    agentId: string;
    sessionId: string;
    capabilities: string[];
    priority: number;
    backend: 'file' | 'redis';
    rootDir: string;
    redis?: { url: string; prefix?: string };
  } | undefined {
    const config = this.orchestratorConfig.collaborationConfig;
    if (!config?.enabled) return undefined;

    return {
      enabled: true,
      agentId: workerId,
      sessionId: this.currentSessionId ?? 'default',
      capabilities,
      priority: 5, // Worker 默认优先级（Orchestrator 是 10）
      backend: config.backend ?? 'file',
      rootDir: this.orchestratorConfig.session.rootDir, // 使用相同的 rootDir
      ...(config.redis && { redis: config.redis }),
    };
  }

  /**
   * 注册 Orchestrator 协作请求处理器
   * 
   * Orchestrator 作为协作中心，接收 Worker 的协作请求并路由到合适的 Worker。
   * 处理策略：
   * 1. 根据请求的 requiredCapabilities 查找合适的空闲 Worker
   * 2. 优先选择能力匹配且优先级高的 Worker
   * 3. 发出协作事件用于追踪
   */
  private registerCollaborationRequestHandler(): void {
    if (!this.collaborationManager) return;

    this.collaborationManager.onRequest(async (request) => {
      const taskId = this.currentTask?.id ?? 'unknown';
      
      // 发出请求接收事件
      this.emit('collaboration:request_received', taskId, {
        requestId: request.id,
        fromAgent: request.fromAgentId,
        type: request.type,
      });

      // 解析请求要求（兼容旧 payload）
      const payload = request.payload as {
        kind?: string;
        requiredCapabilities?: string[];
        taskDescription?: string;
        taskPayload?: unknown;
        preferredWorkerId?: string;
        strictPreferredWorker?: boolean;
        // legacy
        description?: string;
        data?: unknown;
        targetAgentId?: string;
      } | undefined;

      const requiredCapabilities = Array.isArray(payload?.requiredCapabilities)
        ? payload!.requiredCapabilities.filter((c): c is string => typeof c === 'string' && c.length > 0)
        : undefined;

      const taskDescription =
        (typeof payload?.taskDescription === 'string' && payload.taskDescription.trim())
          ? payload.taskDescription.trim()
          : (typeof payload?.description === 'string' && payload.description.trim())
              ? payload.description.trim()
              : undefined;

      const taskPayload =
        payload?.taskPayload !== undefined ? payload.taskPayload : payload?.data;

      const preferredWorkerId =
        (typeof payload?.preferredWorkerId === 'string' && payload.preferredWorkerId.trim())
          ? payload.preferredWorkerId.trim()
          : (typeof payload?.targetAgentId === 'string' && payload.targetAgentId.trim())
              ? payload.targetAgentId.trim()
              : undefined;

      const strictPreferredWorker = payload?.strictPreferredWorker === true;

      const availableWorkers = this.workerPool.getWorkersByCapability(requiredCapabilities);

      if (availableWorkers.length === 0) {
        console.debug(
          `[Orchestrator] No available workers for collaboration request: ${request.id}`
        );
        this.emit('collaboration:request_completed', taskId, {
          requestId: request.id,
          workerId: undefined,
          success: false,
        });
        return {
          success: false,
          error: 'No available workers matching the required capabilities',
          payload: { 
            requestId: request.id,
            ...(requiredCapabilities && { requiredCapabilities }),
            ...(preferredWorkerId && { preferredWorkerId }),
          },
        };
      }

      // 选择 Worker：
      // - preferredWorkerId 命中：优先返回该 worker（best-effort，除非 strict）
      // - 否则：返回优先级最高的 worker
      const preferredMatch = preferredWorkerId
        ? availableWorkers.find((w) => w.id === preferredWorkerId) ?? null
        : null;

      if (!preferredMatch && preferredWorkerId && strictPreferredWorker) {
        this.emit('collaboration:request_completed', taskId, {
          requestId: request.id,
          workerId: undefined,
          success: false,
        });
        return {
          success: false,
          error: `Preferred worker ${preferredWorkerId} is not available`,
          payload: {
            requestId: request.id,
            ...(requiredCapabilities && { requiredCapabilities }),
            preferredWorkerId,
            strictPreferredWorker: true,
          },
        };
      }

      const selectedWorker = preferredMatch ?? availableWorkers[0];
      
      // 发出路由事件
      this.emit('collaboration:request_routed', taskId, {
        requestId: request.id,
        targetWorkerId: selectedWorker?.id,
        workerCount: availableWorkers.length,
      });

      console.debug(
        `[Orchestrator] Routed collaboration request ${request.id} to worker ${selectedWorker?.id}`
      );

      // 当前仅返回路由信息，实际执行由请求发起方自行协调（不在此处执行）。
      this.emit('collaboration:request_completed', taskId, {
        requestId: request.id,
        workerId: selectedWorker?.id,
        success: true,
      });

      // 返回路由结果
      return {
        success: true,
        payload: {
          routed: true,
          targetWorkerId: selectedWorker?.id,
          targetCapabilities: selectedWorker?.capabilities,
          availableWorkerCount: availableWorkers.length,
          ...(requiredCapabilities && { requiredCapabilities }),
          ...(taskDescription && { taskDescription }),
          ...(taskPayload !== undefined && { taskPayload }),
          ...(preferredWorkerId && { preferredWorkerId }),
          ...(preferredWorkerId && { preferredMatched: selectedWorker?.id === preferredWorkerId }),
        },
      };
    });
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
    workerId: string,
    timeout: number,
    signal?: AbortSignal
  ): Promise<TaskResult> {
    const worker = this.workerPool.getWorker(workerId);
    const agent = worker?.agent;
    if (!agent) {
      throw new Error(`Worker ${workerId} has no bound agent`);
    }

    const abortOnSignal = () => {
      if (signal?.aborted) {
        void agent.interrupt?.().catch(() => undefined);
      }
    };
    abortOnSignal();
    signal?.addEventListener('abort', abortOnSignal, { once: true });

    // 额外超时兜底：WorkerPool 会负责 timeout 事件与 cancelTask，这里只做 best-effort 中断
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        void agent.interrupt?.().catch(() => undefined);
      }, timeout + 1000);
    }

    try {
      const workerTask: Task = {
        id: subtask.id,
        type: 'atomic',
        objective: subtask.objective,
        constraints: subtask.constraints,
        ...(subtask.outputSchema !== undefined && { outputSchema: subtask.outputSchema }),
        context: {
          parentTaskId: subtask.parentId,
          ...(this.currentSessionId && { sessionId: this.currentSessionId }),
          ...(this.currentTask?.context?.traceId && { traceId: this.currentTask.context.traceId }),
          metadata: {
            workerId,
            // 传递 noApproval 配置到 Worker
            ...(this.currentRunMetadata?.noApproval === true && { noApproval: true }),
          },
        },
      };

      const result = await agent.run(workerTask); //这里调用基类base-agent.ts的run方法，继而调用抽象方法executeTask，workerAgent继承baseAgent，实现executeTask，这里实际调用的就是workerAgent的executeTask方法

      if (result.status !== 'success') {
        const err = (result.output as { error?: string } | undefined)?.error ?? 'Worker execution failed';
        throw new Error(err);
      }

      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.workerPool.completeTask(subtask.id);
    }
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

  private createNeedUserInputResult(
    taskId: string,
    startTime: number,
    tokensUsed: { input: number; output: number },
    question: string,
    missingInfo: string[]
  ): TaskResult {
    const endTime = Date.now();
    return {
      taskId,
      status: 'failure',
      output: {
        error: 'need_user_input',
        question,
        ...(missingInfo.length > 0 && { missingInfo }),
      },
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
        attributes: { taskId, needUserInput: true },
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
