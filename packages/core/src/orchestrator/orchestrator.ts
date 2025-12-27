/**
 * Orchestrator
 *
 * 统筹者智能体：负责 plan → assign → aggregate 的统筹执行。
 * 内部按职责拆分到 `runner/*`（session/progress/checkpoint/execution/worker 等）。
 */

import type { Task, TaskResult } from '../types';
import { BaseAgent } from '../abstracts/base-agent';
import { Planner } from '../planner';
import { DefaultWorkerPool, type IWorkerPool } from './worker-pool';
import type { MCPClientManager } from '../mcp';
import { MemoryService } from '../memory';
import { CollaborationManager } from '../collaboration';

import type { OrchestratorConfig, OrchestratorEventType, OrchestratorEventHandler } from './types';
import { createOrchestratorConfig, type PartialOrchestratorConfig } from './config';
import type { ISessionFileManager, PendingApprovalFile, SessionFileEvent } from './session';

import { createOrchestratorState } from './state';
import type { OrchestratorState } from './state';
import { EventService } from './services/event-service';
import { AggregationEngine } from './engines/aggregation-engine';
import { ExecutionEngine } from './engines/execution-engine';
import { TaskMasterPlanEngine } from './engines/taskmaster-plan-engine';
import { CheckpointResumeEngine } from './engines/checkpoint-resume-engine';
import { TaskMasterAdapter } from './adapters/taskmaster-adapter';
import { ApprovalArbitrationService } from './services/approval-arbitration';
import { VerificationGateService } from './services/verification-gate';

import type { EmitFn, ResumeFromOptions } from './runner/types';
import { ProgressReporter } from './runner/progress-reporter';
import { CheckpointService } from './runner/checkpoint-service';
import { WorkerManager } from './runner/worker-manager';
import { SessionController } from './runner/session-controller';
import { ExecutionLoop } from './runner/execution-loop';
import { RunService } from './runner/run-service';
import { ResumeService } from './runner/resume-service';

export type { ResumeFromOptions } from './runner/types';

// ============================================================================
// 选项类型
// ============================================================================

export interface OrchestratorOptions {
  config?: PartialOrchestratorConfig;
  planner?: Planner;
  workerPool?: IWorkerPool;
  sessionManager?: ISessionFileManager;
  mcpClient?: MCPClientManager;
}

// ============================================================================
// Orchestrator 实现
// ============================================================================

export class Orchestrator extends BaseAgent {
  private readonly orchestratorConfig: OrchestratorConfig;
  private readonly planner: Planner;
  private readonly workerPool: IWorkerPool;
  private readonly workerPoolInjected: boolean;
  private readonly injectedSessionManager: ISessionFileManager | null;
  private readonly mcpClient?: MCPClientManager;

  // 状态（使用不同名称避免与 BaseAgent.state 冲突）
  readonly orchestratorState: OrchestratorState;

  // 引擎 & 适配器
  private readonly eventService: EventService;
  private readonly aggregationEngine: AggregationEngine;
  private readonly executionEngine: ExecutionEngine;
  private readonly planEngine: TaskMasterPlanEngine;
  private readonly checkpointResumeEngine: CheckpointResumeEngine;
  private readonly taskMasterAdapter: TaskMasterAdapter;

  // 可选模块
  private readonly memoryService?: MemoryService;
  private readonly collaborationManager?: CollaborationManager;

  // runner 内部服务
  private readonly progress: ProgressReporter;
  private readonly session: SessionController;
  private readonly checkpoints: CheckpointService;
  private readonly workers: WorkerManager;
  private readonly execution: ExecutionLoop;
  private readonly runService: RunService;
  private readonly resumeService: ResumeService;

  // 运行期对象
  private approvalService: ApprovalArbitrationService | null = null;
  private readonly verificationGateService: VerificationGateService;

  constructor(id: string, options: OrchestratorOptions = {}) {
    const orchestratorConfig = createOrchestratorConfig(options.config);
    super(id, 'orchestrator', orchestratorConfig.agent);

    this.orchestratorConfig = orchestratorConfig;
    // Pass cwd and skillsConfig to Planner for orchestrator skills discovery
    // Use config.workDir if provided, otherwise fall back to process.cwd()
    const workDir = orchestratorConfig.workDir ?? process.cwd();
    this.planner = options.planner ?? new Planner({
      config: orchestratorConfig.planner,
      cwd: workDir,
      ...(orchestratorConfig.skillsConfig && { skillsConfig: orchestratorConfig.skillsConfig }),
    });
    this.workerPool = options.workerPool ?? new DefaultWorkerPool(orchestratorConfig.workerPool);
    this.workerPoolInjected = options.workerPool !== undefined;
    this.injectedSessionManager = options.sessionManager ?? null;
    if (options.mcpClient) {
      this.mcpClient = options.mcpClient;
    }

    this.orchestratorState = createOrchestratorState();
    this.eventService = new EventService();
    this.aggregationEngine = new AggregationEngine();
    this.executionEngine = new ExecutionEngine();
    this.taskMasterAdapter = new TaskMasterAdapter();
    this.planEngine = new TaskMasterPlanEngine({
      planner: this.planner,
      config: { defaultMaxSubtasks: orchestratorConfig.planner.defaultMaxSubtasks },
    });
    this.checkpointResumeEngine = new CheckpointResumeEngine({
      orchestratorId: this.id,
      orchestratorConfig,
      planEngine: this.planEngine,
    });

    if (orchestratorConfig.memoryConfig?.enabled) {
      this.memoryService = new MemoryService(orchestratorConfig.memoryConfig);
    }
    if (orchestratorConfig.collaborationConfig?.enabled) {
      this.collaborationManager = new CollaborationManager({
        backend: orchestratorConfig.collaborationConfig.backend ?? 'file',
        rootDir: orchestratorConfig.session.rootDir,
      });
    }

    // runner 内部服务初始化
    const emitFn: EmitFn = this.emit.bind(this);

    this.progress = new ProgressReporter(this.orchestratorState);

    const onPendingApproval = async (event: SessionFileEvent<PendingApprovalFile>): Promise<void> => {
      await this.approvalService?.handlePendingApproval(event);
    };

    this.session = new SessionController({
      orchestratorId: this.id,
      orchestratorConfig,
      state: this.orchestratorState,
      workerPool: this.workerPool,
      injectedSessionManager: this.injectedSessionManager,
      mcpClient: this.mcpClient,
      eventService: this.eventService,
      collaborationManager: this.collaborationManager,
      memoryService: this.memoryService,
      taskMasterAdapter: this.taskMasterAdapter,
      onPendingApproval,
    });

    this.checkpoints = new CheckpointService(
      orchestratorConfig,
      this.orchestratorState,
      emitFn,
      () => this.session.getCheckpointManager()
    );

    this.workers = new WorkerManager(
      orchestratorConfig,
      this.orchestratorState,
      this.workerPool,
      this.mcpClient,
      () => this.session.getCollaborationService()
    );

    // Initialize Verification Gate for multi-layer verification
    this.verificationGateService = new VerificationGateService({
      timeout: orchestratorConfig.delegation.timeout,
      useLsp: true, // Use LSP for faster diagnostics
    });

    this.execution = new ExecutionLoop({
      orchestratorConfig,
      state: this.orchestratorState,
      workerPool: this.workerPool,
      workerPoolInjected: this.workerPoolInjected,
      aggregationEngine: this.aggregationEngine,
      executionEngine: this.executionEngine,
      planEngine: this.planEngine,
      taskMasterAdapter: this.taskMasterAdapter,
      emit: emitFn,
      progress: this.progress,
      checkpoints: this.checkpoints,
      workers: this.workers,
      getApprovalService: () => this.approvalService,
      getIntegrationService: () => this.session.getIntegrationService(),
      verificationGateService: this.verificationGateService,
    });

    this.runService = new RunService(
      orchestratorConfig,
      this.orchestratorState,
      this.planEngine,
      this.taskMasterAdapter,
      this.aggregationEngine,
      emitFn,
      this.progress,
      this.checkpoints,
      this.execution,
      this.session,
      this.memoryService
    );

    this.resumeService = new ResumeService(
      this.orchestratorState,
      this.checkpointResumeEngine,
      this.taskMasterAdapter,
      this.execution,
      this.aggregationEngine,
      emitFn,
      this.session,
      this.progress
    );
  }

  // ============================================================================
  // 公共方法
  // ============================================================================

  getOrchestratorConfig(): OrchestratorConfig {
    return { ...this.orchestratorConfig };
  }

  getSessionId(): string | null {
    return this.orchestratorState.sessionId;
  }

  /** @deprecated Use getSessionId() instead */
  getCurrentSessionId(): string | null {
    return this.getSessionId();
  }

  getPlanner(): Planner {
    return this.planner;
  }

  getWorkerPool(): IWorkerPool {
    return this.workerPool;
  }

  /**
   * 从检查点恢复执行
   */
  async resumeFrom(checkpointId: string, options: ResumeFromOptions = {}): Promise<TaskResult> {
    const alreadyRunning =
      this.orchestratorState.executionState !== null || this.orchestratorState.sessionManager !== null;
    if (alreadyRunning) {
      return this.aggregationEngine.createFailureResult(
        checkpointId,
        'Cannot resume from checkpoint while orchestrator is already running',
        Date.now(),
        { input: 0, output: 0 }
      );
    }

    this.approvalService = null;
    return await this.resumeService.resumeFrom(checkpointId, options, {
      afterSessionReady: async () => {
        this.approvalService = this.createApprovalService();
        this.session.setApprovalService(this.approvalService);
        this.session.setIntegrationSyncStrategy(this.getMemorySyncStrategy());
      },
      onPendingApproval: async (event: SessionFileEvent<PendingApprovalFile>) => {
        await this.approvalService?.handlePendingApproval(event);
      },
    });
  }

  // ============================================================================
  // 事件方法
  // ============================================================================

  on<T = unknown>(type: OrchestratorEventType, handler: OrchestratorEventHandler<T>): void {
    this.eventService.on(type, handler);
  }

  off<T = unknown>(type: OrchestratorEventType, handler: OrchestratorEventHandler<T>): void {
    this.eventService.off(type, handler);
  }

  private emit<T>(type: OrchestratorEventType, taskId: string, data: T, subtaskId?: string): void {
    const sessionId = this.orchestratorState.sessionId;
    this.eventService.setContext({
      ...(sessionId ? { sessionId } : {}),
      orchestratorId: this.id,
    });
    this.eventService.emit(type, taskId, data, subtaskId);
  }

  // ============================================================================
  // BaseAgent hook
  // ============================================================================

  protected override async executeTask(task: Task, signal: AbortSignal): Promise<TaskResult> {
    this.approvalService = null;
    return await this.runService.run(task, signal, {
      afterSessionOpen: async ({ taskId }) => {
        this.approvalService = this.createApprovalService();
        this.session.setApprovalService(this.approvalService);
        this.session.setIntegrationSyncStrategy(this.getMemorySyncStrategy());

        // checkpoint auto-save
        const ckpt = this.session.getCheckpointManager();
        if (ckpt && this.orchestratorConfig.checkpoint.enabled) {
          ckpt.setAutoSaveCallback(async () => {
            return this.checkpoints.buildPayload(taskId, 'executing') ?? null;
          });
          ckpt.startAutoSave();
        }
      },
    });
  }

  // ============================================================================
  // 清理
  // ============================================================================

  async cleanup(): Promise<void> {
    await this.workerPool.shutdown();
    if (this.memoryService) {
      await this.memoryService.close();
    }
    if (this.collaborationManager) {
      await this.collaborationManager.stop();
    }
    await super.cleanup();
  }

  // ============================================================================
  // 私有辅助
  // ============================================================================

  private getMemorySyncStrategy(): 'selective' | 'nightly_full' {
    const meta = this.orchestratorState.currentRunMetadata;
    if (!meta || typeof meta !== 'object' || !('memorySync' in meta)) {
      return 'selective';
    }
    const memorySync = (meta as { memorySync?: unknown }).memorySync;
    if (!memorySync || typeof memorySync !== 'object') {
      return 'selective';
    }
    const strategy = (memorySync as { strategy?: unknown }).strategy;
    return strategy === 'nightly_full' ? 'nightly_full' : 'selective';
  }

  private createApprovalService(): ApprovalArbitrationService {
    const sm = this.orchestratorState.sessionManager;
    if (!sm) {
      throw new Error('SessionManager is not initialized');
    }

    return new ApprovalArbitrationService({
      sessionManager: sm,
      eventService: this.eventService,
      policy: this.orchestratorConfig.approval,
      taskMasterCallbacks: {
        getRefForCurrentTask: () => this.taskMasterAdapter.getRef(),
        addDependency: async (subtaskId: string, predecessor: string) => {
          await this.taskMasterAdapter.addDependency(subtaskId, predecessor);
        },
        expandSubtask: async (targetId, subtasks, opts) => {
          await this.taskMasterAdapter.expandSubtask(targetId, subtasks, {
            strategy: opts.strategy,
            ...(opts.force !== undefined ? { force: opts.force } : {}),
          });
        },
        markPendingReplan: () => {
          this.orchestratorState.pendingReplan = true;
        },
        addExpandedSubtask: (subtaskId: string) => {
          this.orchestratorState.expandedSubtaskIds.add(subtaskId);
        },
        getRoleAssignment: (targetId: string) => {
          const plan = this.orchestratorState.currentPlanOutput;
          const st = plan?.subtasks?.find((s) => s.id === targetId);
          if (!st) return null;
          const roleId = typeof st.roleId === 'string' ? st.roleId : undefined;
          const caps = Array.isArray(st.requiredCapabilities) ? st.requiredCapabilities : undefined;
          return { ...(roleId ? { roleId } : {}), ...(caps ? { requiredCapabilities: caps } : {}) };
        },
        writeRoleAssignment: async (tag: string, subtaskId: string, roleId: string, caps: string[]) => {
          const metaRaw = await this.taskMasterAdapter.readTaskmeta().catch(() => null);
          type TaskmetaShape = {
            version: number;
            roles?: {
              byId?: Record<string, { name: string; capabilities: string[]; responsibilities: string }>;
              assignments?: Record<string, Record<string, { roleId: string; requiredCapabilities: string[] }>>;
            };
          };
          const meta: TaskmetaShape =
            metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
              ? { version: 1, ...(metaRaw as object) }
              : { version: 1 };
          meta.version = 1;
          meta.roles ??= {};
          meta.roles.byId ??= {};
          meta.roles.assignments ??= {};
          meta.roles.byId[roleId] ??= {
            name: roleId === 'generalist' ? '通用执行者' : roleId,
            capabilities: Array.from(new Set([`role:${roleId}`, ...caps])),
            responsibilities: roleId === 'generalist' ? '根据 tasks.json 的任务描述执行实现与验证工作' : '',
          };
          meta.roles.assignments[tag] ??= {};
          meta.roles.assignments[tag][subtaskId] = {
            roleId,
            requiredCapabilities: Array.isArray(caps) ? caps : [],
          };
          await this.taskMasterAdapter.writeTaskmeta(meta);
        },
        recordOriginalStatus: (subtaskId: string, status: string) => {
          if (status === 'pending' || status === 'in-progress' || status === 'done') {
            this.taskMasterAdapter.recordOriginalStatus(subtaskId, status);
          }
        },
      },
    });
  }
}

/**
 * 创建 Orchestrator 实例
 */
export function createOrchestrator(id: string, options?: OrchestratorOptions): Orchestrator {
  return new Orchestrator(id, options);
}
