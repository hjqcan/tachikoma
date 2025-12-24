/**
 * Orchestrator 实现
 *
 * 统筹者智能体，负责任务规划、分配、聚合和监控
 * 实现 plan → assign → aggregate 主流程
 */

import type { Task, TaskResult, Artifact, TaskMetrics, TraceData, RetryPolicy } from '../types';
import { BaseAgent } from '../abstracts/base-agent';
import { WorkerAgent } from '../agents/worker-agent';
import { join, relative, isAbsolute } from 'node:path';
import { DEFAULT_RESOURCE_LIMITS } from '../worker/types';
import type {
  OrchestratorTask,
  SubTask,
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
  createSubtaskSnapshots,
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
  type CheckpointData,
  type CheckpointRestoreOptions,
  type RecoveryStrategy,
  type ApiSpec,
  type ApiEndpoint,
} from './session';
import { MemoryService } from '../memory';
import { CollaborationManager } from '../collaboration';
import type { MCPClientManager } from '../mcp';
import { z } from 'zod';
import {
  readTasksJson,
  writeTasksJson,
  updateTaskOrSubtaskStatus,
  addTaskOrSubtaskDependency,
  expandTaskOrSubtask,
  type Task as TaskMasterTask,
  type TaskStatus as TaskMasterTaskStatus,
  type TaskPriority as TaskMasterTaskPriority,
  readTaskmeta,
  writeTaskmeta,
  ensureTaskmetaV1,
  upsertRoleAssignment,
  getRoleDefinitionsFromTaskmeta,
  getRoleAssignmentFromTaskmeta,
} from '../taskmaster-compat';

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

  /** 检查点管理器（用于断点恢复） */
  private checkpointManager: CheckpointManager | null = null;

  /** 当前规划输出（用于生成子任务快照） */
  private currentPlanOutput: PlannerOutput | null = null;

  /** 检查点保存中标记（防止并发写入） */
  private checkpointInFlight = false;

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

  // ============================================================================
  // 文件写入冲突串行化（通过审批协议仲裁 + 回写 tasks.json 依赖）
  // ============================================================================

  /** 文件锁：path -> 当前持有锁的 subtaskId */
  private readonly fileLocks = new Map<string, string>();

  /** 等待队列：path -> 等待该文件锁的 subtaskIds（按到达顺序） */
  private readonly fileWaitQueues = new Map<string, string[]>();

  /** 子任务最近一次宣称会写入的文件集合（用于多文件请求） */
  private readonly subtaskWriteFiles = new Map<string, Set<string>>();

  /**
   * taskId -> { projectRoot, tasksPathAbs, tag }
   * 用于在“审批仲裁点”回写 tasks.json 依赖（不依赖当前全局状态，避免并行时混乱）。
   */
  private readonly taskMasterRefsByTaskId = new Map<
    string,
    { projectRoot: string; file: string; tag: string }
  >();

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

  /** 延迟审批：subtaskId -> 待批准的请求（用于文件锁/expand_commit 等仲裁点） */
  private readonly delayedApprovalsBySubtaskId = new Map<
    string,
    { workerId: string; approval: PendingApprovalFile; reason: string }
  >();

  /** 执行期发生 expand_commit 后需要重新读取 tasks.json 并刷新执行计划 */
  private pendingReplan = false;

  /** 记录哪些 subtask 在本轮通过 expand_commit 触发了结构变更（用于避免把其写成 done） */
  private readonly expandedSubtaskIds = new Set<string>();

  // ============================================================================
  // tasks.json 作为唯一任务真相（新约束）
  // ============================================================================

  /** tasks.json 项目根目录（通常来自 metadata.workDir） */
  private taskMasterProjectRoot: string | null = null;

  /** tasks.json 文件路径（绝对路径） */
  private taskMasterTasksPath: string | null = null;

  /** 当前 tag（默认 master） */
  private taskMasterTag = 'master';

  /**
   * 执行开始时的“原始 status”快照（用于 failure 回滚：保持原 status）
   * key: "1" 或 "1.2"
   */
  private taskMasterOriginalStatuses: Record<string, TaskMasterTaskStatus> = {};

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

  private getTaskMasterMetadata(): { tag?: string; file?: string } {
    const meta = this.currentRunMetadata ?? null;
    const taskmaster =
      meta && typeof meta.taskmaster === 'object' && meta.taskmaster
        ? (meta.taskmaster as Record<string, unknown>)
        : null;
    const tag =
      (taskmaster && typeof taskmaster.tag === 'string' ? taskmaster.tag : undefined) ??
      (meta && typeof meta.tag === 'string' ? String(meta.tag) : undefined);
    const file = taskmaster && typeof taskmaster.file === 'string' ? taskmaster.file : undefined;

    return {
      ...(tag ? { tag } : {}),
      ...(file ? { file } : {}),
    };
  }

  private getPlannerMaxSubtasks(): number | undefined {
    return this.getPlannerMetadata().maxSubtasks;
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

    const { checkpoint, workerSnapshots, runtimeData, resumableSubtaskIds } = restoreResult;

    // 恢复 PlannerOutput：仅允许从 tasks.json 引用重建（runtime.json 脱敏，不读取描述文本）
    let restoredPlanOutput: PlannerOutput | null = null;

    if (runtimeData && runtimeData.kind === 'taskmaster') {
      // 从 checkpoint.contextData 恢复 workDir，作为 projectRoot
      const workDir = this.extractWorkDirFromMetadata();
      if (!workDir) {
        try {
          await checkpointManager.close();
        } finally {
          await sessionManager.close();
        }
        return this.createFailureResult(
          checkpoint.taskId,
          'Task Master checkpoint restore requires metadata.workDir (projectRoot).',
          startTime,
          { input: 0, output: 0 }
        );
      }
      const tasksJsonPath = runtimeData.tasksJson?.path;
      const tasksJsonTag = runtimeData.tasksJson?.tag ?? 'master';
      if (typeof tasksJsonPath === 'string' && tasksJsonPath) {
        const abs = isAbsolute(tasksJsonPath) ? tasksJsonPath : join(workDir, tasksJsonPath);
        this.taskMasterProjectRoot = workDir;
        this.taskMasterTasksPath = abs;
        this.taskMasterTag = tasksJsonTag;
        this.taskMasterOriginalStatuses = runtimeData.originalStatuses ?? {};

        const dummyTask = {
          id: checkpoint.taskId,
          type: 'composite',
          objective: '',
          constraints: [],
          priority: 'medium',
          complexity: 'moderate',
        } as OrchestratorTask;

        const rebuilt = await this.executeTaskMasterPlanPhase(
          dummyTask,
          { projectRoot: workDir, tag: tasksJsonTag, file: abs },
          signal ?? new AbortController().signal
        );
        restoredPlanOutput = rebuilt.success ? rebuilt.output ?? null : null;
      }
    }

    if (!restoredPlanOutput) {
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
        const roles = restoredPlanOutput.roles;
        const workerCount =
          (Array.isArray(roles) && roles.length > 0)
            ? roles.length
            : (restoredPlanOutput.delegation?.workerCount ?? this.orchestratorConfig.delegation.workerCount);
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
      const resumePlan = this.filterPlanToResumableSubtasks(restoredPlanOutput, resumableSet);

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
    const taskMasterMeta = this.getTaskMasterMetadata();
    const workDirFromMetadata = this.extractWorkDirFromMetadata();
    const sessionIdFromTask = task.context?.sessionId;
    // Safety guard: 必须显式提供 workDir 和 sessionId，避免 fallback 到 process.cwd() 导致污染仓库根 tasks.json
    if (!workDirFromMetadata || typeof workDirFromMetadata !== 'string' || workDirFromMetadata.trim() === '') {
      return this.createFailureResult(
        task.id,
        'task.context.metadata.workDir is required. ' +
          'Without an explicit workDir, Orchestrator would fallback to process.cwd() and may write to an unintended tasks.json.',
        startTime,
        { input: 0, output: 0 }
      );
    }
    if (!sessionIdFromTask || typeof sessionIdFromTask !== 'string' || sessionIdFromTask.trim() === '') {
      return this.createFailureResult(
        task.id,
        'task.context.sessionId is required. ' +
          'Without an explicit sessionId, a random timestamp-based tag would be generated, polluting tasks.json with orphan sessions.',
        startTime,
        { input: 0, output: 0 }
      );
    }
    this.refinedSubtaskIds.clear();
    // 执行期仲裁状态清理（每次 run 独立）
    this.fileLocks.clear();
    this.fileWaitQueues.clear();
    this.subtaskWriteFiles.clear();
    this.delayedApprovalsBySubtaskId.clear();
    this.pendingReplan = false;
    this.expandedSubtaskIds.clear();
    await this.initializeSession(task.id, sessionIdFromTask);
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

    if (this.checkpointManager && this.shouldCheckpoint()) {
      this.checkpointManager.setAutoSaveCallback(async () => {
        return this.buildCheckpointData(task.id, 'executing');
      });
      this.checkpointManager.startAutoSave();
    }

    try {
      // 阶段 1: 规划
      this.emit('plan:start', task.id, { task: orchestratorTask });
      this.taskMasterProjectRoot = workDirFromMetadata;
      // 默认按 sessionId 做 tag 隔离（避免所有对话都写入 master）
      this.taskMasterTag = taskMasterMeta.tag ?? this.currentSessionId ?? 'master';
      this.taskMasterTasksPath = null;
      this.taskMasterOriginalStatuses = {};

      const planResult = await this.executeTaskMasterPlanPhase(
        orchestratorTask,
        {
          projectRoot: this.taskMasterProjectRoot,
          tag: this.taskMasterTag,
          ...(taskMasterMeta.file ? { file: taskMasterMeta.file } : {}),
        },
        signal
      );

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

      // 保存运行时快照到会话文件（runtime.json）
      await this.saveTaskMasterRuntimeToSession(task.id, normalizedPlan);

      // 记录本次 task 的 tasks.json 引用（用于执行期仲裁点回写依赖/expand）
      if (this.taskMasterProjectRoot && this.taskMasterTasksPath) {
        this.taskMasterRefsByTaskId.set(task.id, {
          projectRoot: this.taskMasterProjectRoot,
          file: this.taskMasterTasksPath,
          tag: this.taskMasterTag ?? 'master',
        });
      }

      this.currentPlanOutput = normalizedPlan;
      await this.saveCheckpointSnapshot(task.id, 'executing', 'plan-ready');

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
      this.currentPlanOutput = null;
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

    if (this.sessionManager) {
      this.checkpointManager = new CheckpointManager(this.currentSessionId, this.sessionManager, {
        ...this.orchestratorConfig.checkpoint,
        rootDir: this.orchestratorConfig.session.rootDir,
      });
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

    if (this.checkpointManager) {
      await this.checkpointManager.close().catch(() => undefined);
      this.checkpointManager = null;
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

  private getTaskMasterRefForCurrentTask(): { projectRoot: string; file: string; tag: string } | null {
    const taskId = this.currentTask?.id;
    if (!taskId) return null;
    const ref = this.taskMasterRefsByTaskId.get(taskId);
    if (ref) return ref;
    if (this.taskMasterProjectRoot && this.taskMasterTasksPath) {
      return {
        projectRoot: this.taskMasterProjectRoot,
        file: this.taskMasterTasksPath,
        tag: this.taskMasterTag ?? 'master',
      };
    }
    return null;
  }

  private extractApprovalActionAndInput(approval: PendingApprovalFile): {
    action: string | undefined;
    input: Record<string, unknown> | undefined;
    affectedFiles: string[];
  } {
    const meta = approval.details?.metadata as Record<string, unknown> | undefined;
    const action = meta && typeof meta.action === 'string' ? String(meta.action) : undefined;
    const inputRaw = (meta?.input ?? meta?.toolInput) as unknown;
    const input = inputRaw && typeof inputRaw === 'object' ? (inputRaw as Record<string, unknown>) : undefined;

    const filesRaw = approval.details?.affectedFiles;
    const affectedFiles = Array.isArray(filesRaw)
      ? filesRaw.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : [];

    // fallback：从输入推导 path
    if (affectedFiles.length === 0 && input && typeof input.path === 'string' && input.path.trim()) {
      affectedFiles.push(input.path.trim());
    }

    return { action, input, affectedFiles };
  }

  private async approvePendingApproval(workerId: string, approval: PendingApprovalFile, approved: boolean, reason: string): Promise<void> {
    if (!this.sessionManager) return;
    const response: ApprovalResponseFile = {
      requestId: approval.requestId,
      respondedAt: Date.now(),
      approved,
      respondedBy: 'orchestrator',
      reason,
    };
    await this.sessionManager.writeApprovalResponse(workerId, response);
    this.emit('approval:complete', approval.subtaskId, {
      requestId: approval.requestId,
      workerId,
      approved,
      reason,
    });
  }

  private async handleFileWriteArbitration(params: {
    workerId: string;
    approval: PendingApprovalFile;
    action: 'apply_patch' | 'file_write';
    affectedFiles: string[];
  }): Promise<boolean> {
    const { workerId, approval, action, affectedFiles } = params;
    const subtaskId = approval.subtaskId;
    const ref = this.getTaskMasterRefForCurrentTask();

    // 只处理单文件场景（apply_patch/file_write 当前均为单文件工具）
    const filePath = affectedFiles[0];
    if (!filePath) {
      await this.approvePendingApproval(workerId, approval, true, `Auto-approved ${action} (no affectedFiles provided)`);
      return true;
    }

    // 文件被其他子任务占用：进入队列 + 写回 dependencies（方案 A）
    const holder = this.fileLocks.get(filePath);
    if (holder && holder !== subtaskId) {
      const queue = this.fileWaitQueues.get(filePath) ?? [];
      const predecessor = queue.length > 0 ? queue.at(-1) : holder;
      if (predecessor && predecessor !== subtaskId && ref) {
        await addTaskOrSubtaskDependency(subtaskId, predecessor, ref).catch(() => undefined);
      }

      if (!queue.includes(subtaskId)) {
        queue.push(subtaskId);
        this.fileWaitQueues.set(filePath, queue);
      }
      this.delayedApprovalsBySubtaskId.set(subtaskId, {
        workerId,
        approval,
        reason: `Waiting for file lock: ${filePath} (held by ${holder})`,
      });
      return false;
    }

    // 获取锁（首次写入该文件时占用到子任务结束）
    this.fileLocks.set(filePath, subtaskId);
    const set = this.subtaskWriteFiles.get(subtaskId) ?? new Set<string>();
    set.add(filePath);
    this.subtaskWriteFiles.set(subtaskId, set);

    await this.approvePendingApproval(workerId, approval, true, `Approved ${action} (acquired file lock: ${filePath})`);
    return true;
  }

  private async releaseFileLocksForSubtask(subtaskId: string): Promise<void> {
    const files = this.subtaskWriteFiles.get(subtaskId);
    if (!files || files.size === 0) return;

    for (const filePath of files) {
      const holder = this.fileLocks.get(filePath);
      if (holder !== subtaskId) continue;
      this.fileLocks.delete(filePath);

      const queue = this.fileWaitQueues.get(filePath);
      if (!queue || queue.length === 0) continue;

      const nextSubtaskId = queue.shift();
      if (!nextSubtaskId) continue;
      if (queue.length === 0) this.fileWaitQueues.delete(filePath);
      else this.fileWaitQueues.set(filePath, queue);

      // 把锁转交给下一个等待者，并批准其 pending_approval
      this.fileLocks.set(filePath, nextSubtaskId);
      const delayed = this.delayedApprovalsBySubtaskId.get(nextSubtaskId);
      if (!delayed) continue;

      this.delayedApprovalsBySubtaskId.delete(nextSubtaskId);

      // 记录该子任务会写入的文件（用于后续释放）
      const nextFiles = this.subtaskWriteFiles.get(nextSubtaskId) ?? new Set<string>();
      nextFiles.add(filePath);
      this.subtaskWriteFiles.set(nextSubtaskId, nextFiles);

      await this.approvePendingApproval(
        delayed.workerId,
        delayed.approval,
        true,
        `Approved after waiting (acquired file lock: ${filePath})`
      );
    }

    // 清理
    this.subtaskWriteFiles.delete(subtaskId);
  }

  private async handleExpandCommitArbitration(params: {
    workerId: string;
    approval: PendingApprovalFile;
    input: Record<string, unknown> | undefined;
  }): Promise<void> {
    const { workerId, approval } = params;
    const ref = this.getTaskMasterRefForCurrentTask();
    if (!ref) {
      await this.approvePendingApproval(workerId, approval, false, 'No tasks.json reference available for expand_commit');
      return;
    }

    const input = params.input ?? {};
    const rawTargetId = typeof input.targetId === 'string' ? input.targetId.trim() : '';
    const targetId = rawTargetId || approval.subtaskId;

    const rawStrategy = typeof input.strategy === 'string' ? input.strategy : '';
    const strategy: 'serial' | 'parallel' = rawStrategy === 'parallel' ? 'parallel' : 'serial';
    const force = input.force === true;

    const rawSubs = input.subtasks;
    if (!Array.isArray(rawSubs) || rawSubs.length < 2) {
      await this.approvePendingApproval(workerId, approval, false, 'expand_commit requires subtasks (array) with length >= 2');
      return;
    }

    const generated = rawSubs.map((s) => {
      const obj = (s && typeof s === 'object') ? (s as Record<string, unknown>) : {};
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      const description = typeof obj.description === 'string' ? obj.description.trim() : '';
      const details = typeof obj.details === 'string' ? obj.details : '';
      const testStrategy = typeof obj.testStrategy === 'string' ? obj.testStrategy : '';
      return { title, description, details, testStrategy };
    });

    if (generated.some((g) => !g.title || !g.description)) {
      await this.approvePendingApproval(workerId, approval, false, 'expand_commit subtasks must include non-empty title and description');
      return;
    }

    // 1) 写回 tasks.json（不生成 1.1.1；subtask-level 采用 A：改写 + 新增兄弟 + 依赖重写）
    await expandTaskOrSubtask(targetId, generated, {
      projectRoot: ref.projectRoot,
      file: ref.file,
      tag: ref.tag,
      ...(force ? { force } : {}),
      strategy,
    });

    // 2) role 继承：新生成的子任务必须继承父任务 role（写回 taskmeta，不污染 tasks.json）
    const taskmetaRaw = await readTaskmeta(ref.projectRoot).catch(() => null);
    const taskmetaV1 = ensureTaskmetaV1(taskmetaRaw);
    let taskmetaDirty = taskmetaRaw === null;

    const tag = ref.tag;
    const fromPlan = this.currentPlanOutput?.subtasks.find((s) => s.id === targetId);
    const fromMeta = getRoleAssignmentFromTaskmeta(taskmetaV1, tag, targetId);
    const inheritedRoleId =
      (typeof fromPlan?.roleId === 'string' && fromPlan.roleId.trim())
        ? fromPlan.roleId.trim()
        : (typeof fromMeta?.roleId === 'string' && fromMeta.roleId.trim())
          ? fromMeta.roleId.trim()
          : 'generalist';

    const stableCap = `role:${inheritedRoleId}`;
    const capsFromPlan = Array.isArray(fromPlan?.requiredCapabilities) ? fromPlan!.requiredCapabilities! : [];
    const capsFromMeta = Array.isArray(fromMeta?.requiredCapabilities) ? fromMeta!.requiredCapabilities! : [];
    const inheritedCaps = Array.from(new Set([stableCap, ...capsFromPlan, ...capsFromMeta]));

    taskmetaV1.roles ??= {};
    taskmetaV1.roles.byId ??= {};
    if (!taskmetaV1.roles.byId[inheritedRoleId]) {
      taskmetaV1.roles.byId[inheritedRoleId] = {
        name: inheritedRoleId === 'generalist' ? '通用执行者' : inheritedRoleId,
        capabilities: inheritedCaps,
        responsibilities: inheritedRoleId === 'generalist' ? '根据 tasks.json 的任务描述执行实现与验证工作' : '',
      };
      taskmetaDirty = true;
    }

    taskmetaV1.roles.assignments ??= {};
    const scoped = taskmetaV1.roles.assignments[tag] ?? (taskmetaV1.roles.assignments[tag] = {});

    const rootTaskId = String(targetId).split('.').at(0) ?? targetId;
    const after = await readTasksJson({
      projectRoot: ref.projectRoot,
      file: ref.file,
      tag: ref.tag,
    });
    const parentTask = after.tasks.find((t) => String(t.id) === String(rootTaskId));
    const subs = Array.isArray(parentTask?.subtasks) ? parentTask!.subtasks : [];

    for (const st of subs) {
      const fullId = `${rootTaskId}.${String(st.id)}`;
      scoped[fullId] = { roleId: inheritedRoleId, requiredCapabilities: inheritedCaps };
      taskmetaDirty = true;

      // failures 不回写时需要 originalStatuses 支撑回滚：新子任务默认 pending
      if (this.taskMasterOriginalStatuses[fullId] === undefined) {
        this.taskMasterOriginalStatuses[fullId] = 'pending';
      }
    }

    if (taskmetaDirty) {
      await writeTaskmeta(ref.projectRoot, taskmetaV1);
    }

    // 3) 标记需要重规划：当前执行的父任务不应被写为 done
    this.pendingReplan = true;
    this.expandedSubtaskIds.add(approval.subtaskId);

    await this.approvePendingApproval(
      workerId,
      approval,
      true,
      `expand_commit applied: ${targetId} -> ${subs.length} subtasks (strategy: ${strategy})`
    );
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

    // =========================================================================
    // Orchestrator 仲裁点：文件写入串行化（apply_patch/file_write）
    // =========================================================================
    const extracted = this.extractApprovalActionAndInput(approval);
    if (extracted.action === 'apply_patch' || extracted.action === 'file_write') {
      await this.handleFileWriteArbitration({
        workerId,
        approval,
        action: extracted.action,
        affectedFiles: extracted.affectedFiles,
      });
      return;
    }
    if (extracted.action === 'expand_commit') {
      await this.handleExpandCommitArbitration({
        workerId,
        approval,
        input: extracted.input,
      });
      return;
    }

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

    await this.approvePendingApproval(workerId, approval, approved, reason);
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
   * 保存 Task Master tasks.json-only 脱敏运行时快照到会话文件（runtime.json）
   *
   * 约束：runtime.json 不允许落盘任务描述文本，因此只保存：
   * - tasks.json 引用（path + tag）
   * - executionPlan（仅 id 顺序）
   * - roles 与 roleAssignments（角色化路由所需）
   * - originalStatuses（failure keep-status 的回滚依据）
   */
  private async saveTaskMasterRuntimeToSession(
    taskId: string,
    planOutput: PlannerOutput
  ): Promise<void> {
    if (!this.sessionManager) return;
    if (!this.taskMasterProjectRoot || !this.taskMasterTasksPath) return;

    const projectRoot = this.taskMasterProjectRoot;
    const tasksPathAbs = this.taskMasterTasksPath;

    // 尽量写相对路径（方便外部投喂/迁移）；若不在 projectRoot 下则写绝对路径
    let tasksPathForPlan = tasksPathAbs;
    try {
      const rel = relative(projectRoot, tasksPathAbs);
      const withinProject = rel && !rel.startsWith('..') && !isAbsolute(rel);
      if (withinProject) {
        tasksPathForPlan = rel;
      }
    } catch {
      // ignore
    }

    const roleAssignments: Record<
      string,
      { roleId?: string; requiredCapabilities?: string[] }
    > = {};
    for (const st of planOutput.subtasks) {
      if (st.roleId || (Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.length > 0)) {
        roleAssignments[st.id] = {
          ...(st.roleId ? { roleId: st.roleId } : {}),
          ...(Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.length > 0
            ? { requiredCapabilities: st.requiredCapabilities }
            : {}),
        };
      }
    }

    await this.sessionManager.writeRuntime({
      kind: 'taskmaster',
      taskId,
      createdAt: Date.now(),
      version: 1,
      tasksJson: {
        path: tasksPathForPlan,
        tag: this.taskMasterTag ?? 'master',
      },
      executionPlan: planOutput.executionPlan,
      ...(Array.isArray(planOutput.roles) && planOutput.roles.length > 0 ? { roles: planOutput.roles } : {}),
      ...(Object.keys(roleAssignments).length > 0 ? { roleAssignments } : {}),
      ...(this.taskMasterOriginalStatuses && Object.keys(this.taskMasterOriginalStatuses).length > 0
        ? { originalStatuses: this.taskMasterOriginalStatuses }
        : {}),
    });
  }

  private getTaskMasterOriginalStatus(id: string): TaskMasterTaskStatus {
    return (this.taskMasterOriginalStatuses[id] ?? 'pending') as TaskMasterTaskStatus;
  }

  private async writeTaskMasterStatus(id: string, status: TaskMasterTaskStatus): Promise<void> {
    if (!this.taskMasterProjectRoot || !this.taskMasterTasksPath) return;

    await updateTaskOrSubtaskStatus(id, status, {
      projectRoot: this.taskMasterProjectRoot,
      file: this.taskMasterTasksPath,
      tag: this.taskMasterTag ?? 'master',
      touchUpdatedAt: true,
    });
  }

  private async restoreTaskMasterStatus(id: string): Promise<void> {
    const original = this.getTaskMasterOriginalStatus(id);
    await this.writeTaskMasterStatus(id, original);
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

  private shouldCheckpoint(): boolean {
    return this.orchestratorConfig.checkpoint.enabled;
  }

  private buildCheckpointData(
    taskId: string,
    planStatus: CheckpointData['planStatus']
  ): Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'> | null {
    if (!this.executionState || !this.currentPlanOutput) return null;

    const executionPlan = this.currentPlanOutput.executionPlan
      ? {
          steps: this.currentPlanOutput.executionPlan.steps.map((step) => ({
            order: step.order,
            subtaskIds: step.subtaskIds,
            parallel: step.parallel,
          })),
        }
      : undefined;

    const subtaskSnapshots = createSubtaskSnapshots(
      this.currentPlanOutput.subtasks.map((subtask) => ({
        id: subtask.id,
        status: subtask.status ?? 'pending',
        ...(subtask.assignedWorkerId ? { assignedWorkerId: subtask.assignedWorkerId } : {}),
      })),
      {
        completedSubtasks: this.executionState.completedSubtasks,
        failedSubtasks: this.executionState.failedSubtasks,
        runningSubtasks: this.executionState.runningSubtasks,
      }
    );

    const completedResults: Record<string, unknown> = {};
    for (const [id, result] of this.executionState.completedSubtasks.entries()) {
      completedResults[id] = result.output;
    }

    return {
      taskId,
      planStatus,
      currentStep: this.executionState.currentStep,
      totalSteps: this.executionState.totalSteps,
      completedSubtaskIds: Array.from(this.executionState.completedSubtasks.keys()),
      failedSubtaskIds: Array.from(this.executionState.failedSubtasks.keys()),
      runningSubtaskIds: Array.from(this.executionState.runningSubtasks),
      subtaskSnapshots,
      completedResults,
      totalRetries: this.executionState.totalRetries,
      totalTokens: this.executionState.totalTokens,
      ...(executionPlan && { executionPlan }),
      ...(this.currentRunMetadata && { contextData: this.currentRunMetadata }),
    };
  }

  private async saveCheckpointSnapshot(
    taskId: string,
    planStatus: CheckpointData['planStatus'],
    reason?: string
  ): Promise<void> {
    if (!this.checkpointManager || !this.shouldCheckpoint()) return;
    if (this.checkpointInFlight) return;

    const payload = this.buildCheckpointData(taskId, planStatus);
    if (!payload) return;

    this.checkpointInFlight = true;
    try {
      const checkpoint = await this.checkpointManager.saveCheckpoint(payload);
      this.emit('checkpoint:created', taskId, {
        checkpointId: checkpoint.id,
        ...(reason && { reason }),
      });
    } catch (error) {
      console.warn('[Orchestrator] Failed to save checkpoint (non-fatal):', error);
    } finally {
      this.checkpointInFlight = false;
    }
  }

  // ============================================================================
  // 阶段 1: 规划
  // ============================================================================

  /**
   * tasks.json-only 规划阶段：以 Task Master 的 tasks.json 作为唯一任务真相
   *
   * - 不调用 Tachikoma LLM Planner 生成 PlannerOutput（避免产生第二套“任务描述”落盘）
   * - 读取 tasks.json 并在内存中转换为 PlannerOutput（仅用于执行）
   * - 生成 runtime.json 脱敏快照时，仅保存引用/执行顺序/角色映射（见 saveTaskMasterRuntimeToSession）
   */
  private async executeTaskMasterPlanPhase(
    task: OrchestratorTask,
    ref: { projectRoot: string; tag: string; file?: string },
    signal: AbortSignal,
    ensureRound = 0
  ): Promise<PlanResult> {
    if (signal.aborted) {
      return {
        success: false,
        error: 'Aborted',
        tokensUsed: { input: 0, output: 0 },
        retryCount: 0,
        degraded: false,
      };
    }

    const taskmetaRaw = await readTaskmeta(ref.projectRoot).catch(() => null);
    const taskmetaV1 = ensureTaskmetaV1(taskmetaRaw);
    let taskmetaDirty = taskmetaRaw === null;
    const roleDefsFromMeta = getRoleDefinitionsFromTaskmeta(taskmetaV1);

    // 若 taskmeta 指定了 tag，则优先使用（但仍保持显式传入 tag 优先）
    const effectiveTag = ref.tag || taskmetaV1.tasksJson?.tag || 'master';

    const read = await readTasksJson({
      projectRoot: ref.projectRoot,
      tag: effectiveTag,
      ...(ref.file ? { file: ref.file } : {}),
    });

    this.taskMasterTasksPath = read.tasksPath;
    this.taskMasterTag = read.tag;

    const maxEnsureRounds = 2;

    const planAndAppendTasks = async (existing: TaskMasterTask[]): Promise<PlanResult | null> => {
      const maxSubtasks =
        this.getPlannerMaxSubtasks() ?? this.orchestratorConfig.planner.defaultMaxSubtasks;

      const plan = await this.planner.plan({ task, maxSubtasks });
      if (!plan.success || !plan.output) {
        return plan;
      }

      // 信息不足：不写 tasks.json，交由上层触发 need_user_input
      if (plan.output.intake?.ready === false) {
        return plan;
      }

      // === 生成新的 Task Master Tasks（作为本轮对话的“可执行计划”）===
      const nowIso = new Date().toISOString();

      const existingNumericIds = existing
        .map((t) => Number(String(t.id)))
        .filter((n) => Number.isFinite(n));
      const baseId =
        existingNumericIds.length > 0
          ? Math.max(...existingNumericIds)
          : existing.length;

      const priorityRaw = String(task.priority ?? 'medium') as TaskMasterTaskPriority;
      const priority: TaskMasterTaskPriority =
        priorityRaw === 'critical' || priorityRaw === 'high' || priorityRaw === 'medium' || priorityRaw === 'low'
          ? priorityRaw
          : 'medium';

      const plannedSubtasks = Array.isArray(plan.output.subtasks) ? plan.output.subtasks : [];

      // 将 Planner subtasks 映射为 Task Master 顶级 tasks（1-level：1,2,3...）
      const idMap = new Map<string, string>();
      plannedSubtasks.forEach((st, idx) => {
        idMap.set(String(st.id), String(baseId + idx + 1));
      });

      const newTasks: TaskMasterTask[] = plannedSubtasks.map((st, idx) => {
        const id = String(baseId + idx + 1);
        const deps = Array.isArray(st.dependencies) ? st.dependencies : [];
        const mappedDeps = deps
          .map((d) => idMap.get(String(d)))
          .filter((v): v is string => typeof v === 'string' && v.length > 0);

        const obj = String(st.objective ?? '').trim();
        const titleLine = obj.split('\n')[0] ?? '';
        const title = titleLine.length > 80 ? `${titleLine.slice(0, 80)}...` : (titleLine || `Task ${id}`);

        const details =
          Array.isArray(st.constraints) && st.constraints.length > 0 ? st.constraints.join('\n') : '';

        return {
          id,
          title,
          description: obj || title,
          status: 'pending' as TaskMasterTaskStatus,
          priority,
          dependencies: mappedDeps,
          details,
          testStrategy: '为关键逻辑补充必要的测试，并确保测试通过。',
          subtasks: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
      });

      await writeTasksJson({
        projectRoot: ref.projectRoot,
        file: read.tasksPath,
        tag: effectiveTag,
        rawData: read.rawData,
        tasks: [...existing, ...newTasks],
      });

      return null;
    };

    if (!Array.isArray(read.tasks) || read.tasks.length === 0) {
      if (ensureRound >= maxEnsureRounds) {
        return {
          success: false,
          error: `tasks.json is empty or missing tasks (path: ${read.tasksPath})`,
          tokensUsed: { input: 0, output: 0 },
          retryCount: 0,
          degraded: false,
        };
      }

      const maybeEarly = await planAndAppendTasks([]);
      if (maybeEarly) return maybeEarly;
      return this.executeTaskMasterPlanPhase(task, ref, signal, ensureRound + 1);
    }

    const terminalComplete = new Set<TaskMasterTaskStatus>(['done', 'completed', 'cancelled']);
    const isSatisfied = (status: TaskMasterTaskStatus | undefined): boolean => {
      if (!status) return false;
      return terminalComplete.has(status);
    };

    // 任务完成映射：taskId -> completionId（用于把 task-level deps 映射到可执行节点）
    const completionIdByTaskId = new Map<string, string>();
    for (const t of read.tasks) {
      const tid = String(t.id);
      // 允许 subtasks 并行：使用“父 taskId 自身”作为 completion 节点（由 Orchestrator 内部 barrier 自动完成）
      completionIdByTaskId.set(tid, tid);
    }

    // 已完成集合（用于删除已满足依赖）
    const completedIds = new Set<string>();
    for (const t of read.tasks) {
      const tid = String(t.id);
      if (isSatisfied(t.status as TaskMasterTaskStatus)) {
        completedIds.add(tid);
      }
      if (Array.isArray(t.subtasks)) {
        for (const st of t.subtasks) {
          if (isSatisfied(st.status as TaskMasterTaskStatus)) {
            completedIds.add(`${tid}.${String(st.id)}`);
          }
        }
      }
    }

    const toFullSubId = (parentId: string, maybeDotId: string | number): string => {
      const depId = String(maybeDotId);
      return depId.includes('.') ? depId : `${parentId}.${depId}`;
    };

    // 生成可执行 SubTask（执行期使用；不落盘到 runtime.json）
    const subtasks: SubTask[] = [];

    const pushOriginalStatus = (id: string, status: TaskMasterTaskStatus | undefined): void => {
      const s = (status ?? 'pending') as TaskMasterTaskStatus;
      if (this.taskMasterOriginalStatuses[id] === undefined) {
        this.taskMasterOriginalStatuses[id] = s;
      }
    };

    for (const t of read.tasks) {
      const tid = String(t.id);
      const taskStatus = (t.status ?? 'pending') as TaskMasterTaskStatus;

      const taskPriority = (t.priority ?? 'medium') as TaskMasterTaskPriority;
      const priority =
        (taskPriority === 'critical' || taskPriority === 'high' || taskPriority === 'medium' || taskPriority === 'low')
          ? taskPriority
          : 'medium';

      const taskDepsRaw = Array.isArray(t.dependencies) ? t.dependencies : [];
      const taskDeps = taskDepsRaw
        .map((dep) => String(dep))
        .map((dep) => (completionIdByTaskId.get(dep) ?? dep))
        .filter((dep) => !completedIds.has(dep));

      const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (subs.length === 0) {
        if (isSatisfied(taskStatus)) continue;
        pushOriginalStatus(tid, taskStatus);
        subtasks.push({
          id: tid,
          parentId: task.id,
          parentObjective: task.objective,
          objective: `${t.title}: ${t.description}`.trim(),
          constraints: [
            ...(t.details ? [`details: ${t.details}`] : []),
            ...(t.testStrategy ? [`testStrategy: ${t.testStrategy}`] : []),
          ],
          dependencies: taskDeps,
          status: 'pending',
          priority,
        });
        continue;
      }

      // subtasks：按 id 排序（依赖由 tasks.json 决定；允许并行）
      const sortedSubs = subs
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id));
      const executableChildIds: string[] = [];
      for (const st of sortedSubs) {
        const fullId = `${tid}.${String(st.id)}`;
        const stStatus = (st.status ?? 'pending') as TaskMasterTaskStatus;
        if (isSatisfied(stStatus)) {
          continue;
        }

        pushOriginalStatus(fullId, stStatus);

        const stDepsRaw = Array.isArray(st.dependencies) ? st.dependencies : [];
        const stDepsNorm = stDepsRaw.map((dep) => toFullSubId(tid, dep));

        const deps = [
          ...taskDeps,
          ...stDepsNorm,
        ]
          .map((dep) => (completionIdByTaskId.get(dep) ?? dep))
          .filter((dep) => !completedIds.has(dep));

        subtasks.push({
          id: fullId,
          parentId: task.id,
          parentObjective: task.objective,
          objective: `${st.title || `Subtask ${st.id}`}: ${st.description || ''}`.trim(),
          constraints: [
            `parentTask: ${t.title}`,
            ...(t.description ? [`parentDescription: ${t.description}`] : []),
            ...(st.details ? [`details: ${st.details}`] : []),
            ...(st.testStrategy ? [`testStrategy: ${st.testStrategy}`] : []),
          ],
          dependencies: deps,
          status: 'pending',
          priority,
        });
        executableChildIds.push(fullId);
      }

      // 内部 barrier：taskId 作为 completion 节点，依赖于本 task 的所有可执行子任务
      // 说明：用于支持 subtasks 并行同时保持 task-level deps 的正确语义（其他 task 依赖 taskId 时会映射到该节点）
      if (!isSatisfied(taskStatus)) {
        pushOriginalStatus(tid, taskStatus);
        subtasks.push({
          id: tid,
          parentId: task.id,
          parentObjective: task.objective,
          objective: `【内部】完成任务: ${t.title}`.trim(),
          constraints: [`barrier: ${t.title}`],
          dependencies: [...taskDeps, ...executableChildIds].filter((dep) => !completedIds.has(dep)),
          status: 'pending',
          priority,
          requiredCapabilities: ['internal:barrier'],
        });
      }
    }

    // 若没有任何可执行节点（例如当前 tag 下所有 task 都已完成），则把本轮用户输入转成新 task 追加进去再重试
    if (subtasks.length === 0 && ensureRound < maxEnsureRounds) {
      const maybeEarly = await planAndAppendTasks(read.tasks);
      if (maybeEarly) return maybeEarly;
      return this.executeTaskMasterPlanPhase(task, ref, signal, ensureRound + 1);
    }

    // topo sort（分层并行 steps：满足依赖的任务可并行执行）
    const byId = new Map(subtasks.map((st) => [st.id, st] as const));
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, Set<string>>();

    for (const st of subtasks) {
      inDegree.set(st.id, 0);
      outgoing.set(st.id, new Set());
    }

    for (const st of subtasks) {
      const deps = Array.isArray(st.dependencies) ? st.dependencies : [];
      for (const dep of deps) {
        if (!byId.has(dep)) continue; // dep 可能已满足或不在本次执行集合
        outgoing.get(dep)!.add(st.id);
        inDegree.set(st.id, (inDegree.get(st.id) ?? 0) + 1);
      }
    }

    const visited = new Set<string>();
    let available: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) available.push(id);
    }
    available.sort();

    const steps: ExecutionStep[] = [];
    while (available.length > 0) {
      const layer = available.slice();
      for (const id of layer) {
        visited.add(id);
      }

      steps.push({
        order: steps.length + 1,
        subtaskIds: layer,
        parallel: layer.length > 1,
      });

      const nextSet = new Set<string>();
      for (const id of layer) {
        for (const next of outgoing.get(id) ?? []) {
          const nextDeg = (inDegree.get(next) ?? 0) - 1;
          inDegree.set(next, nextDeg);
          if (nextDeg === 0 && !visited.has(next)) {
            nextSet.add(next);
          }
        }
      }

      available = Array.from(nextSet);
      available.sort();
    }

    // 若存在环，回退到串行顺序（validatePlanDAG 会给出提示）
    const hasCycle = visited.size !== subtasks.length;
    const serialOrder = subtasks.map((st) => st.id);
    const executionPlan: ExecutionPlan = hasCycle
      ? {
          steps: serialOrder.map((id, idx) => ({
            order: idx + 1,
            subtaskIds: [id],
            parallel: false,
          })),
          isParallel: false,
        }
      : {
          steps,
          isParallel: steps.some((s) => s.parallel),
        };

    const delegation = task.delegation ?? {
      mode: this.orchestratorConfig.delegation.mode,
      workerCount: this.orchestratorConfig.delegation.workerCount,
      timeout: this.orchestratorConfig.delegation.timeout,
      retryPolicy: this.orchestratorConfig.delegation.retryPolicy,
    };

    // 角色推理（LLM）：产出 roles + roleAssignments（不写入 tasks.json）
    const tagForRoleAssignments = this.taskMasterTag ?? 'master';
    const defsById = new Map(roleDefsFromMeta.map((r) => [r.id, r] as const));
    const isBarrier = (st: SubTask): boolean =>
      Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.includes('internal:barrier');
    const roleTargets = subtasks.filter((st) => !isBarrier(st));

    // 1) 收集显式映射（作为固定分配，LLM 不应修改）
    const fixedAssignments: Record<string, { roleId: string }> = {};
    const explicitBySubtaskId = new Set<string>();
    for (const st of roleTargets) {
      const a = getRoleAssignmentFromTaskmeta(taskmetaV1, tagForRoleAssignments, st.id);
      if (a?.roleId && typeof a.roleId === 'string' && a.roleId.trim()) {
        fixedAssignments[st.id] = { roleId: a.roleId.trim() };
        explicitBySubtaskId.add(st.id);
      }
    }

    const needsRoleInference = roleTargets.some((st) => !explicitBySubtaskId.has(st.id));

    // 2) LLM 推理（仅当存在未分配 role 的子任务）
    let inferredRoles: PlannerRole[] = [];
    let inferredAssignments: Record<string, { roleId: string; requiredCapabilities?: string[] }> = {};
    let roleTokensUsed: { input: number; output: number } = { input: 0, output: 0 };
    let roleRetryCount = 0;

    if (needsRoleInference) {
      const inferResult = await this.planner.inferRolesForSubtasks({
        task,
        subtasks: roleTargets.map((st) => ({
          id: st.id,
          objective: st.objective,
          constraints: st.constraints,
        })),
        ...(Object.keys(fixedAssignments).length > 0 ? { fixedAssignments } : {}),
        // 默认不限制（模型会尽量少角色）；可后续放到 taskmeta.execution 里做配置
      });

      roleTokensUsed = inferResult.tokensUsed;
      roleRetryCount = inferResult.retryCount;

      if (inferResult.success && inferResult.roles && inferResult.roleAssignments) {
        inferredRoles = inferResult.roles;
        inferredAssignments = inferResult.roleAssignments;

        // 把 LLM 推理出的 role 定义写入 taskmeta.roles.byId（仅补齐，不覆盖用户已有定义）
        taskmetaV1.roles ??= {};
        taskmetaV1.roles.byId ??= {};
        for (const r of inferredRoles) {
          if (!r?.id) continue;
          if (taskmetaV1.roles.byId[r.id]) continue;
          taskmetaV1.roles.byId[r.id] = {
            name: r.name,
            capabilities: Array.isArray(r.capabilities) ? r.capabilities : [`role:${r.id}`],
            ...(typeof r.responsibilities === 'string' && r.responsibilities
              ? { responsibilities: r.responsibilities }
              : {}),
          };
          taskmetaDirty = true;
        }
      } else {
        // 推理失败：保底使用 generalist（不阻断执行）
        inferredRoles = [
          {
            id: 'generalist',
            name: '通用执行者',
            responsibilities: '根据 tasks.json 的任务描述执行实现与验证工作',
            capabilities: ['role:generalist'],
          },
        ];
        for (const st of roleTargets) {
          if (!explicitBySubtaskId.has(st.id)) {
            inferredAssignments[st.id] = { roleId: 'generalist', requiredCapabilities: ['role:generalist'] };
          }
        }
      }
    }

    // 3) 合并分配：显式映射优先，其次 LLM 推理，否则 generalist
    const roleIdsUsed = new Set<string>();
    for (const st of roleTargets) {
      const a = getRoleAssignmentFromTaskmeta(taskmetaV1, tagForRoleAssignments, st.id);
      const explicitRoleId = a?.roleId && typeof a.roleId === 'string' && a.roleId.trim() ? a.roleId.trim() : undefined;
      const explicitCapsRaw = Array.isArray(a?.requiredCapabilities) ? a!.requiredCapabilities! : undefined;
      const explicitCaps = Array.isArray(explicitCapsRaw)
        ? explicitCapsRaw.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [];

      const inferred = inferredAssignments[st.id];
      const roleId = explicitRoleId ?? (typeof inferred?.roleId === 'string' && inferred.roleId ? inferred.roleId : 'generalist');
      const stableCap = `role:${roleId}`;

      const inferredCaps = Array.isArray(inferred?.requiredCapabilities)
        ? inferred!.requiredCapabilities!.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [];

      st.roleId = roleId;
      st.requiredCapabilities = Array.from(new Set([stableCap, ...explicitCaps, ...inferredCaps]));
      roleIdsUsed.add(roleId);

      // 写回推理结果（仅对“没有显式分配”的子任务）
      if (!explicitRoleId) {
        const upserted = upsertRoleAssignment(taskmetaV1, tagForRoleAssignments, st.id, {
          roleId,
          requiredCapabilities: st.requiredCapabilities,
        });
        taskmetaDirty = taskmetaDirty || upserted.changed;
      }
    }

    if (taskmetaDirty) {
      await writeTaskmeta(ref.projectRoot, taskmetaV1);
    }

    // 4) 生成 roles 列表：优先 taskmeta.roles.byId，其次 LLM roles，最后最小兜底
    const inferredById = new Map(inferredRoles.map((r) => [r.id, r] as const));
    const allRoleIds = Array.from(roleIdsUsed).sort((a, b) => a.localeCompare(b));
    if (allRoleIds.length === 0) allRoleIds.push('generalist');

    const roles: PlannerRole[] = allRoleIds.map((roleId) => {
      const fromMeta = defsById.get(roleId);
      if (fromMeta) {
        const caps = Array.isArray(fromMeta.capabilities) ? fromMeta.capabilities : [];
        const stableCap = `role:${roleId}`;
        return {
          id: roleId,
          name: fromMeta.name || roleId,
          responsibilities: fromMeta.responsibilities ?? '',
          capabilities: Array.from(new Set([stableCap, ...caps])),
        };
      }

      const fromInfer = inferredById.get(roleId);
      if (fromInfer) {
        const caps = Array.isArray(fromInfer.capabilities) ? fromInfer.capabilities : [];
        const stableCap = `role:${roleId}`;
        return {
          id: roleId,
          name: fromInfer.name || roleId,
          responsibilities: fromInfer.responsibilities ?? '',
          capabilities: Array.from(new Set([stableCap, ...caps])),
        };
      }

      return {
        id: roleId,
        name: roleId === 'generalist' ? '通用执行者' : roleId,
        responsibilities: roleId === 'generalist' ? '根据 tasks.json 的任务描述执行实现与验证工作' : '',
        capabilities: [`role:${roleId}`],
      };
    });

    const output: PlannerOutput = {
      taskId: task.id,
      subtasks,
      delegation,
      executionPlan,
      roles,
    };

    return {
      success: true,
      output,
      tokensUsed: roleTokensUsed,
      retryCount: roleRetryCount,
      degraded: false,
    };
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

    const { previousError, previousFiles } = this.getPlannerMetadata();

    const [runtime, progress, decisions, shared] = await Promise.all([
      this.sessionManager.readOrchestratorRuntime().catch(() => null),
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

    if (runtime?.kind === 'taskmaster') {
      const steps = runtime.executionPlan?.steps ?? [];
      appendSection(
        '### Previous runtime (taskmaster)',
        steps.slice(0, 20).flatMap((s) => s.subtaskIds.map((id) => `- ${id}`))
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
    // 累积子任务映射（支持执行期 expand_commit 触发的重规划）
    const subtaskMap = new Map<string, SubTask>();
    const mergeSubtasks = (subs: SubTask[]): void => {
      for (const st of subs) subtaskMap.set(st.id, st);
    };

    let activePlan = planOutput;
    mergeSubtasks(activePlan.subtasks);

    while (true) {
      const { subtasks, delegation, executionPlan } = activePlan;

      // DAG 校验：执行前检查环依赖和步骤一致性
      const dagError = this.validatePlanDAG(subtasks, executionPlan);
      if (dagError) {
        throw new Error(`Plan DAG validation failed: ${dagError}`);
      }

      // 更新 progress.totalSteps（可随重规划变化）
      this.executionState!.totalSteps = executionPlan.steps.length;
      this.executionState!.currentStep = 0;
      await this.updateProgressToSession(taskId);

      // 按执行计划逐步执行
      for (let i = 0; i < executionPlan.steps.length; i++) {
        if (signal.aborted) break;

        const step = executionPlan.steps[i]!;
        this.executionState!.currentStep = i + 1;
        await this.updateProgressToSession(taskId);

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

        if (this.pendingReplan) break;
      }

      if (signal.aborted) break;
      if (!this.pendingReplan) break;

      // === expand_commit 触发：重规划（从 tasks.json 重新构建 DAG）===
      this.pendingReplan = false;

      const base = this.currentTask;
      const ref = this.getTaskMasterRefForCurrentTask();
      if (!base || !ref) {
        throw new Error('Cannot replan: missing currentTask or tasks.json reference');
      }

      const replanned = await this.executeTaskMasterPlanPhase(
        this.convertToOrchestratorTask(base),
        { projectRoot: ref.projectRoot, tag: ref.tag, file: ref.file },
        signal
      );
      if (!replanned.success || !replanned.output) {
        throw new Error(`Replan failed: ${replanned.error ?? 'unknown error'}`);
      }

      const normalized = this.normalizePlanRoles(replanned.output);
      this.currentPlanOutput = normalized;
      await this.saveTaskMasterRuntimeToSession(taskId, normalized).catch(() => undefined);
      await this.registerDefaultWorkers({
        workerCount: normalized.delegation.workerCount,
        ...(Array.isArray(normalized.roles) ? { roles: normalized.roles } : {}),
        parallelRequirements: this.extractParallelRequirements(normalized),
      });

      activePlan = normalized;
      mergeSubtasks(activePlan.subtasks);
    }

    // 聚合结果（包含本轮执行过程中出现过的所有子任务 id）
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

    // 内部 barrier：不分配 worker，仅用于依赖收敛（task-level completion 节点）
    if (Array.isArray(subtask.requiredCapabilities) && subtask.requiredCapabilities.includes('internal:barrier')) {
      const startTime = Date.now();

      // 直接标记为完成（依赖已在上方检查）
      this.executionState!.completedSubtasks.set(subtaskId, {
        taskId: subtaskId,
        status: 'success',
        output: { text: `Barrier completed: ${subtask.objective}` },
        artifacts: [],
        metrics: {
          startTime,
          endTime: startTime,
          duration: 0,
          tokensUsed: 0,
          toolCallCount: 0,
          retryCount: 0,
        },
        trace: {
          traceId: generateTimestampId('trace'),
          spanId: generateTimestampId('span'),
          operation: `orchestrator.${this.id}.barrier`,
          attributes: { subtaskId },
          events: [],
          duration: 0,
        },
      });

      subtask.status = 'success';
      await this.writeTaskMasterStatus(subtaskId, 'done').catch(() => undefined);

      this.emit('subtask:complete', taskId, { result: this.executionState!.completedSubtasks.get(subtaskId) }, subtaskId);
      await this.updateProgressToSession(taskId);
      await this.saveCheckpointSnapshot(taskId, 'executing', 'barrier-complete');

      return {
        subtaskId,
        success: true,
        result: this.executionState!.completedSubtasks.get(subtaskId)!,
        retryCount: 0,
      };
    }

    // 以 tasks.json 作为唯一任务真相时：refine/expand 必须写回 tasks.json，不能把“细分后的描述”写入 runtime.json。
    // 这里先禁用旧 refine 链路（后续会实现 Task Master 风格的 expand 并落到 tasks.json）。
    // P2: 增强集成类子任务的上下文（注入 API 信息和文件清单）
    const activeSubtask = await this.enhanceSubtaskForIntegration(subtask);
    // 更新 subtaskMap 中的子任务（如果有增强）
    if (activeSubtask !== subtask) {
      subtaskMap.set(subtaskId, activeSubtask);
    }

    // 标记为运行中
    this.executionState!.runningSubtasks.add(subtaskId);
    activeSubtask.status = 'running';
    // 回写 tasks.json（failure 将在失败路径恢复原 status）
    await this.writeTaskMasterStatus(subtaskId, 'in-progress').catch(() => undefined);
    await this.updateProgressToSession(taskId);

    let retryCount = 0;
    let lastError: string | undefined;

    while (true) {
      if (signal.aborted) {
        this.executionState!.runningSubtasks.delete(subtaskId);
        await this.restoreTaskMasterStatus(subtaskId).catch(() => undefined);
        await this.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);
        return {
          subtaskId,
          success: false,
          error: 'Aborted',
          retryCount,
        };
      }

      try {
        // 分配给 Worker（使用增强后的子任务）
        const assignResult = await this.assignToWorker(activeSubtask, timeout, retryPolicy);

        if (!assignResult.success) {
          lastError = assignResult.error;

          // 检查是否应该重试
          if (shouldRetry(retryPolicy, retryCount)) {
            retryCount++;
            this.executionState!.totalRetries++;
            activeSubtask.status = 'retrying';

            this.emit('subtask:retrying', taskId, { retryCount, error: lastError }, subtaskId);

            // 等待重试延迟
            const delay = calculateRetryDelay(retryPolicy, retryCount);
            await this.sleep(delay);
            continue;
          }

          // 重试耗尽，标记为失败
          const failureError = lastError || 'Unknown error';
          this.markSubtaskFailed(activeSubtask, subtaskId, failureError);
          await this.restoreTaskMasterStatus(subtaskId).catch(() => undefined);
          await this.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);

          this.emit('subtask:failed', taskId, { error: failureError, retryCount }, subtaskId);
          await this.updateProgressToSession(taskId);
          await this.saveCheckpointSnapshot(taskId, 'executing', 'subtask-failed');

          return {
            subtaskId,
            success: false,
            error: failureError,
            retryCount,
          };
        }

        const workerId = assignResult.workerId!;
        activeSubtask.assignedWorkerId = workerId;

        // Emit after a concrete worker is chosen so consumers can display accurate routing info.
        this.emit('subtask:assigned', taskId, { subtaskId, subtask: activeSubtask, workerId }, subtaskId);

        // 等待 Worker 完成（WorkerAgent 驱动）
        const result = await this.waitForWorkerCompletion(activeSubtask, workerId, timeout, signal);

        // selective sync：将关键决策/产物写入 shared context（best-effort）
        await this.syncSharedContextSelective(workerId, activeSubtask, result).catch(() => undefined);

        // expand_commit：父任务仅负责“提交扩展”，不应在这里写为 done；交由重规划后的 barrier 节点完成
        if (this.expandedSubtaskIds.has(subtaskId)) {
          this.expandedSubtaskIds.delete(subtaskId);
          this.executionState!.runningSubtasks.delete(subtaskId);

          // 父任务释放：不写 completedSubtasks，不写 tasks.json done
          activeSubtask.status = 'pending';
          // exactOptionalPropertyTypes: optional 字段用 delete 清理
          delete (activeSubtask as any).assignedWorkerId;
          await this.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);

          this.emit('subtask:complete', taskId, { result }, subtaskId);
          await this.updateProgressToSession(taskId);
          await this.saveCheckpointSnapshot(taskId, 'executing', 'expanded');

          return {
            subtaskId,
            success: true,
            result,
            retryCount,
          };
        }

        // 标记为完成
        this.executionState!.runningSubtasks.delete(subtaskId);
        this.executionState!.completedSubtasks.set(subtaskId, result);
        activeSubtask.status = 'success';
        activeSubtask.result = result;
        await this.writeTaskMasterStatus(subtaskId, 'done').catch(() => undefined);
        await this.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);

        // 累加 Worker 执行的 token 用量
        if (result.metrics?.tokensUsed) {
          this.executionState!.totalTokens += result.metrics.tokensUsed;
        }

        this.emit('subtask:complete', taskId, { result }, subtaskId);
        await this.updateProgressToSession(taskId);
        await this.saveCheckpointSnapshot(taskId, 'executing', 'subtask-complete');

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
          activeSubtask.status = 'retrying';

          this.emit('subtask:retrying', taskId, { retryCount, error: lastError }, subtaskId);

          const delay = calculateRetryDelay(retryPolicy, retryCount);
          await this.sleep(delay);
          continue;
        }

        // 重试耗尽
        this.markSubtaskFailed(activeSubtask, subtaskId, lastError);
        await this.restoreTaskMasterStatus(subtaskId).catch(() => undefined);
        await this.releaseFileLocksForSubtask(subtaskId).catch(() => undefined);

        this.emit('subtask:failed', taskId, { error: lastError, retryCount }, subtaskId);
        await this.saveCheckpointSnapshot(taskId, 'executing', 'subtask-failed');

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
      ...(typeof estimatedMinutes === 'number' ? { estimatedMinutes } : {}),
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

    // Archive refined subtasks to runtime.json
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
    refined: {
      objective: string;
      constraints: string[];
      estimatedMinutes?: number;
    }[],
    subtaskMap: Map<string, SubTask>
  ): SubTask[] {
    const refinedList = refined.slice(0, DEFAULT_REFINEMENT_MAX_SUBTASKS);
    const result: SubTask[] = [];
    const reservedIds = new Set(subtaskMap.keys());
    const parentDependencies = Array.isArray(parent.dependencies)
      ? Array.from(new Set(parent.dependencies.filter((dep) => dep && dep !== parent.id)))
      : [];

    for (const [idx, item] of refinedList.entries()) {
      const id = this.generateRefinedSubtaskId(parent.id, idx + 1, reservedIds);
      const constraints = this.mergeConstraints(parent.constraints, item.constraints);
      const estimatedDuration =
        typeof item.estimatedMinutes === 'number' && Number.isFinite(item.estimatedMinutes)
          ? item.estimatedMinutes * 60 * 1000
          : undefined;
      const prev = result.at(-1);
      const dependencies = prev ? [prev.id] : [...parentDependencies];

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

    // P1-B: 同步 generatedFiles (按 worker ID 分组累积)
    if (modifiedFiles.length > 0) {
      const generatedFiles = (nextData.generatedFiles as Record<string, string[]>) ?? {};
      const existingFiles = generatedFiles[workerId] ?? [];
      const merged = Array.from(new Set([...existingFiles, ...modifiedFiles]));
      generatedFiles[workerId] = merged;
      nextData.generatedFiles = generatedFiles;
    }

    // P1-B: 从 backend worker 提取 API 接口定义
    const extractedApiSpec = this.extractApiSpecFromResult(result, workerId, subtask);
    if (extractedApiSpec) {
      nextData.apiSpec = extractedApiSpec;
    }

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
  ): { type: string; reason: string; approved?: boolean }[] {
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
   * P1-B: 从 backend worker 的结果中提取 API 接口定义
   *
   * 检测条件（满足任一）：
   * 1. workerId 包含 "backend" 或 "api"
   * 2. subtask.objective 包含 "API", "endpoint", "backend", "server" 等关键词
   * 3. subtask.roleId 包含 "backend"
   *
   * 提取逻辑：
   * - 从 result.output 中解析 JSON 格式的 API 定义
   * - 或从 result.artifacts 中寻找 API 规格文件
   */
  private extractApiSpecFromResult(
    result: TaskResult,
    workerId: string,
    subtask: SubTask
  ): ApiSpec | null {
    // 1. 检测是否是 backend/API 相关的 worker
    const isBackendWorker = this.isBackendOrApiWorker(workerId, subtask);
    if (!isBackendWorker) return null;

    // 2. 尝试从 result.output 中提取 API 信息
    let output = result.output as unknown;
    
    // P1-B Fix: 当 output 为字符串时，尝试解析为 JSON
    if (typeof output === 'string' && output.trim()) {
      const parsed = this.tryParseApiSpecFromText(output);
      if (parsed) {
        return {
          ...parsed,
          updatedAt: Date.now(),
          producedBy: workerId,
        };
      }
      // 尝试直接 JSON.parse
      try {
        output = JSON.parse(output);
      } catch {
        // 解析失败，继续检查 artifacts
      }
    }
    
    if (!output || typeof output !== 'object') return null;

    const outputObj = output as Record<string, unknown>;

    // 2a. 检查是否有显式的 apiSpec 字段
    if (outputObj.apiSpec && typeof outputObj.apiSpec === 'object') {
      const spec = outputObj.apiSpec as Record<string, unknown>;
      if (Array.isArray(spec.endpoints)) {
        return {
          endpoints: this.normalizeApiEndpoints(spec.endpoints),
          ...(typeof spec.baseUrl === 'string' && { baseUrl: spec.baseUrl }),
          updatedAt: Date.now(),
          producedBy: workerId,
        };
      }
    }

    // 2b. 检查是否有 endpoints 字段
    if (Array.isArray(outputObj.endpoints)) {
      return {
        endpoints: this.normalizeApiEndpoints(outputObj.endpoints),
        ...(typeof outputObj.baseUrl === 'string' && { baseUrl: outputObj.baseUrl }),
        updatedAt: Date.now(),
        producedBy: workerId,
      };
    }

    // 2c. 尝试从 text/message 中解析 JSON
    const textContent = outputObj.text || outputObj.message;
    if (typeof textContent === 'string') {
      const parsed = this.tryParseApiSpecFromText(textContent);
      if (parsed) {
        return {
          ...parsed,
          updatedAt: Date.now(),
          producedBy: workerId,
        };
      }
    }

    // 3. 检查 artifacts 中是否有 API 规格文件
    if (result.artifacts && result.artifacts.length > 0) {
      for (const artifact of result.artifacts) {
        if (
          artifact.name?.toLowerCase().includes('api') ||
          artifact.name?.toLowerCase().includes('openapi') ||
          artifact.name?.toLowerCase().includes('swagger')
        ) {
          // 如果有 API 相关的 artifact，尝试解析其内容
          if (typeof artifact.content === 'string') {
            const parsed = this.tryParseApiSpecFromText(artifact.content);
            if (parsed) {
              return {
                ...parsed,
                updatedAt: Date.now(),
                producedBy: workerId,
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * 检测是否是 backend 或 API 相关的 worker
   */
  private isBackendOrApiWorker(workerId: string, subtask: SubTask): boolean {
    const backendKeywords = ['backend', 'api', 'server', 'endpoint'];
    const workerIdLower = workerId.toLowerCase();
    const objectiveLower = subtask.objective.toLowerCase();
    const roleIdLower = (subtask.roleId ?? '').toLowerCase();

    // 检查 workerId
    if (backendKeywords.some(k => workerIdLower.includes(k))) return true;

    // 检查 objective
    if (backendKeywords.some(k => objectiveLower.includes(k))) return true;

    // 检查 roleId
    if (backendKeywords.some(k => roleIdLower.includes(k))) return true;

    return false;
  }

  /**
   * 规范化 API endpoints 数组
   */
  private normalizeApiEndpoints(
    endpoints: unknown[]
  ): ApiEndpoint[] {
    return endpoints
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map(e => ({
        path: typeof e.path === 'string' ? e.path : String(e.path ?? '/unknown'),
        method: typeof e.method === 'string' ? e.method.toUpperCase() : 'GET',
        description: typeof e.description === 'string' ? e.description : '',
        ...(e.requestParams && typeof e.requestParams === 'object'
          ? { requestParams: e.requestParams as Record<string, string> }
          : {}),
        ...(typeof e.responseFormat === 'string'
          ? { responseFormat: e.responseFormat }
          : {}),
      }));
  }

  /**
   * 尝试从文本中解析 API 规格
   */
  private tryParseApiSpecFromText(
    text: string
  ): { endpoints: ApiEndpoint[]; baseUrl?: string } | null {
    // 尝试找到 JSON 块
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || 
                      text.match(/\{[\s\S]*"endpoints"[\s\S]*\}/);
    
    if (!jsonMatch) return null;

    try {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      
      if (Array.isArray(parsed.endpoints)) {
        return {
          endpoints: this.normalizeApiEndpoints(parsed.endpoints),
          baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
        };
      }
      
      if (Array.isArray(parsed)) {
        return { endpoints: this.normalizeApiEndpoints(parsed) };
      }
    } catch {
      // JSON 解析失败，忽略
    }

    return null;
  }

  /**
   * 标记子任务失败
   */
  private markSubtaskFailed(subtask: SubTask, subtaskId: string, error: string): void {
    this.executionState!.runningSubtasks.delete(subtaskId);
    this.executionState!.failedSubtasks.set(subtaskId, error);
    subtask.status = 'failure';
  }

  // ============================================================================
  // P2: 集成阶段上下文注入
  // ============================================================================

  /**
   * P2: 检测是否是集成类子任务
   *
   * 检测条件（满足任一）：
   * 1. 名称或描述包含 "integration", "connect", "integrate", "wire up" 等关键词
   * 2. 依赖多个不同类型的子任务（如 frontend + backend）
   */
  private isIntegrationSubtask(subtask: SubTask): boolean {
    const integrationKeywords = [
      'integration', 'integrate', 'connect', 'wire up', 'wiring',
      'hook up', 'combine', 'merge', 'link', 'bridge',
    ];
    const objectiveLower = subtask.objective.toLowerCase();

    // 1. 检查 objective 中是否包含集成关键词
    if (integrationKeywords.some(k => objectiveLower.includes(k))) {
      return true;
    }

    // 2. 检查是否有多个依赖且依赖类型多样（如同时依赖 frontend 和 backend）
    const deps = subtask.dependencies ?? [];
    if (deps.length >= 2) {
      // 简单启发式：如果依赖包含不同角色的任务，可能是集成任务
      // 后续可以扩展为检查实际的 roleId
      return true;
    }

    return false;
  }

  /**
   * P2: 为集成类子任务构建上下文
   *
   * 从 sharedKnowledge 读取：
   * - apiSpec: 后端 API 接口定义
   * - generatedFiles: 各 Worker 生成的文件清单
   *
   * 返回格式化的上下文字符串，可直接附加到子任务的 objective 或 constraints
   */
  private async buildIntegrationContext(subtask: SubTask): Promise<string> {
    if (!this.isIntegrationSubtask(subtask)) return '';
    if (!this.sessionManager) return '';

    const context = await this.sessionManager.readSharedContext().catch(() => null);
    if (!context?.sharedKnowledge?.data) return '';

    const parts: string[] = [];
    const data = context.sharedKnowledge.data;

    // 1. 注入 API 接口定义
    if (data.apiSpec && data.apiSpec.endpoints?.length > 0) {
      parts.push('[已有 API 接口]');
      if (data.apiSpec.baseUrl) {
        parts.push(`Base URL: ${data.apiSpec.baseUrl}`);
      }
      parts.push('Endpoints:');
      for (const ep of data.apiSpec.endpoints.slice(0, 10)) { // 限制最多10个
        parts.push(`  ${ep.method} ${ep.path} - ${ep.description}`);
      }
      if (data.apiSpec.endpoints.length > 10) {
        parts.push(`  ... 还有 ${data.apiSpec.endpoints.length - 10} 个端点`);
      }
    }

    // 2. 注入依赖子任务的生成文件清单
    if (data.generatedFiles) {
      const generatedFiles = data.generatedFiles as Record<string, string[]>;
      const workerIds = Object.keys(generatedFiles);
      if (workerIds.length > 0) {
        parts.push('');
        parts.push('[已生成文件]');
        for (const workerId of workerIds.slice(0, 5)) { // 限制最多5个 worker
          const files = generatedFiles[workerId];
          if (files && files.length > 0) {
            parts.push(`${workerId}:`);
            for (const file of files.slice(0, 5)) { // 每个 worker 最多5个文件
              parts.push(`  - ${file}`);
            }
            if (files.length > 5) {
              parts.push(`  ... 还有 ${files.length - 5} 个文件`);
            }
          }
        }
      }
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /**
   * P2: 在分配子任务前增强其上下文
   *
   * 如果检测到集成类子任务，自动附加 API 接口和文件清单信息
   */
  private async enhanceSubtaskForIntegration(subtask: SubTask): Promise<SubTask> {
    const integrationContext = await this.buildIntegrationContext(subtask);
    if (!integrationContext) return subtask;

    // 将集成上下文附加到 constraints
    const enhancedConstraints = [
      ...(subtask.constraints ?? []),
      integrationContext,
    ];

    return {
      ...subtask,
      constraints: enhancedConstraints,
    };
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
        ...(subtask.parentObjective !== undefined && { parentObjective: subtask.parentObjective }),
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