import type { OrchestratorTask, OrchestratorConfig } from '../types';
import type { OrchestratorState } from '../state';
import type { IWorkerPool } from '../worker-pool';
import type { MCPClientManager } from '../../mcp';
import type { ISessionFileManager, PendingApprovalFile, SessionFileEvent, CheckpointManager } from '../session';
import { SessionLifecycleManager } from '../managers/session-lifecycle';
import { CollaborationService } from '../services/collaboration-service';
import { DeviationDetector } from '../engines/deviation-detector';
import { IntegrationContextService } from '../services/integration-context';
import type { MemoryService } from '../../memory';
import type { CollaborationManager } from '../../collaboration';
import type { IEventService } from '../interfaces';
import { ApprovalArbitrationService } from '../services/approval-arbitration';
import { TaskMasterAdapter } from '../adapters/taskmaster-adapter';

export interface SessionControllerDeps {
  orchestratorId: string;
  orchestratorConfig: OrchestratorConfig;
  state: OrchestratorState;
  workerPool: IWorkerPool;
  injectedSessionManager: ISessionFileManager | null;
  mcpClient: MCPClientManager | undefined;
  eventService: IEventService;
  collaborationManager: CollaborationManager | undefined;
  memoryService: MemoryService | undefined;
  taskMasterAdapter: TaskMasterAdapter;
  onPendingApproval: (event: SessionFileEvent<PendingApprovalFile>) => Promise<void>;
}

export class SessionController {
  private sessionLifecycle: SessionLifecycleManager | null = null;
  private checkpointManager: CheckpointManager | null = null;
  private approvalService: ApprovalArbitrationService | null = null;
  private integrationService: IntegrationContextService | null = null;
  private collaborationService: CollaborationService | null = null;
  private deviationDetector: DeviationDetector | null = null;

  constructor(private readonly deps: SessionControllerDeps) {}

  getCheckpointManager(): CheckpointManager | null {
    return this.checkpointManager;
  }

  getApprovalService(): ApprovalArbitrationService | null {
    return this.approvalService;
  }

  getIntegrationService(): IntegrationContextService | null {
    return this.integrationService;
  }

  getCollaborationService(): CollaborationService | null {
    return this.collaborationService;
  }

  /**
   * Get trajectory logs (thinking + action) for all workers for skill learning
   * Returns combined thinking and action records from all workers that executed during this session
   */
  async getTrajectoryForAllWorkers(limit = 100): Promise<{
    thinkingLogs: Awaited<ReturnType<ISessionFileManager['readThinkingLogs']>>;
    actionLogs: Awaited<ReturnType<ISessionFileManager['readActionLogs']>>;
  }> {
    const sm = this.deps.state.sessionManager;
    if (!sm) return { thinkingLogs: [], actionLogs: [] };

    const workers = this.deps.workerPool.getAllWorkers();
    const thinkingLogs: Awaited<ReturnType<ISessionFileManager['readThinkingLogs']>> = [];
    const actionLogs: Awaited<ReturnType<ISessionFileManager['readActionLogs']>> = [];

    for (const worker of workers) {
      try {
        const thinking = await sm.readThinkingLogs(worker.id, limit);
        thinkingLogs.push(...thinking);
      } catch {
        // Worker may not have thinking logs
      }
      try {
        const actions = await sm.readActionLogs(worker.id, limit);
        actionLogs.push(...actions);
      } catch {
        // Worker may not have action logs
      }
    }

    return { thinkingLogs, actionLogs };
  }

  async open(task: OrchestratorTask, sessionId: string): Promise<void> {
    const cfg = this.deps.orchestratorConfig;

    // collaboration wiring（旧版行为）
    const collabCfg = cfg.collaborationConfig;
    const collaborationEnabled = collabCfg?.enabled === true && !!this.deps.collaborationManager;
    if (collaborationEnabled) {
      this.collaborationService = new CollaborationService({
        config: {
          enabled: true,
          backend: collabCfg?.backend ?? 'file',
          rootDir: cfg.session.rootDir,
          ...(collabCfg?.redis ? { redis: collabCfg.redis } : {}),
        },
        workerPool: {
          getWorkersByCapability: (capabilities?: string[]) => {
            const workers = this.deps.workerPool.getWorkersByCapability(capabilities);
            return workers.map((w) => ({
              id: w.id,
              ...(Array.isArray(w.capabilities) ? { capabilities: w.capabilities } : {}),
              status: w.status === 'draining' ? 'busy' : (w.status as 'idle' | 'busy' | 'error'),
            }));
          },
        },
        eventService: this.deps.eventService,
      });
      this.collaborationService.setCurrentTaskId(task.id);
    } else {
      this.collaborationService = null;
    }

    const lifecycle = new SessionLifecycleManager({
      orchestratorId: this.deps.orchestratorId,
      config: {
        rootDir: cfg.session.rootDir,
        ...(cfg.session.enableWatch !== undefined ? { enableWatch: cfg.session.enableWatch } : {}),
        ...(cfg.session.watchPollInterval !== undefined ? { watchPollInterval: cfg.session.watchPollInterval } : {}),
        checkpoint: cfg.checkpoint,
      },
      eventService: this.deps.eventService,
      workerPool: this.deps.workerPool,
      ...(this.deps.injectedSessionManager ? { injectedSessionManager: this.deps.injectedSessionManager } : {}),
      ...(this.deps.collaborationManager ? { collaborationManager: this.deps.collaborationManager } : {}),
      collaborationEnabled,
    });

    lifecycle.setCurrentTask(task);
    lifecycle.setApprovalHandler(this.deps.onPendingApproval);
    lifecycle.setDeviationDetection(
      () => this.startDeviationDetector(),
      () => this.stopDeviationDetector()
    );
    if (collaborationEnabled && this.collaborationService && this.deps.collaborationManager) {
      lifecycle.setCollaborationRequestHandlerRegistrar(() => {
        // CollaborationManager 实现了 ICollaborationManager 接口
        this.collaborationService!.registerRequestHandler(this.deps.collaborationManager!);
      });
    }

    this.sessionLifecycle = lifecycle;
    await lifecycle.initialize(task.id, sessionId);

    const sm = lifecycle.getSessionManager();
    this.deps.state.sessionManager = sm;
    this.deps.state.sessionId = lifecycle.getCurrentSessionId();
    this.checkpointManager = lifecycle.getCheckpointManager();

    if (sm) {
      this.integrationService = new IntegrationContextService({ sessionManager: sm });
      // 默认策略由上层设置；这里保持可用即可
      this.approvalService = null; // 由上层在 runner 中创建（依赖 taskmaster callbacks）
    }
  }

  async close(): Promise<void> {
    const sm = this.deps.state.sessionManager;
    if (sm) {
      sm.off<PendingApprovalFile>('pending_approval_created', this.deps.onPendingApproval);
    }

    await this.sessionLifecycle?.close().catch(() => undefined);
    this.sessionLifecycle = null;
    this.stopDeviationDetector();

    this.approvalService = null;
    this.integrationService = null;
    this.collaborationService = null;
    this.checkpointManager = null;

    this.deps.state.sessionManager = null;
    this.deps.state.sessionId = null;
  }

  setApprovalService(service: ApprovalArbitrationService | null): void {
    this.approvalService = service;
  }

  setIntegrationSyncStrategy(strategy: 'selective' | 'nightly_full'): void {
    this.integrationService?.setMemorySyncStrategy(strategy);
  }

  async ensureSharedContext(objective: string, constraints: string[], workDir: string): Promise<void> {
    const sm = this.deps.state.sessionManager;
    if (!sm || !this.integrationService) return;
    const existing = await sm.readSharedContext().catch(() => null);
    if (existing) return;
    await this.integrationService.initializeSharedContext(objective, constraints, { rootPath: workDir });
  }

  private startDeviationDetector(): void {
    const cfg = this.deps.orchestratorConfig.deviationDetection;
    if (!cfg.enabled) return;
    const sm = this.deps.state.sessionManager;
    if (!sm) return;
    if (this.deviationDetector) return;

    // 适配 IWorkerPool -> IWorkerPoolForDetection（避免 as any）
    const workerPoolAdapter = {
      getAllWorkers: () =>
        this.deps.workerPool.getAllWorkers().map((w) => ({
          id: w.id,
          status: w.status === 'draining' ? ('busy' as const) : (w.status as 'idle' | 'busy' | 'error'),
          ...(w.currentTaskId !== undefined ? { currentTaskId: w.currentTaskId } : {}),
        })),
    };

    this.deviationDetector = new DeviationDetector({
      config: cfg,
      sessionManager: sm,
      workerPool: workerPoolAdapter,
      eventService: this.deps.eventService,
    });
    this.deviationDetector.start();
  }

  private stopDeviationDetector(): void {
    this.deviationDetector?.stop();
    this.deviationDetector = null;
  }
}


