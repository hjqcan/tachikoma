import { WorkerAgent } from '../../agents/worker-agent';
import type { MCPClientManager } from '../../mcp';
import type { IWorkerPool } from '../worker-pool';
import type { OrchestratorConfig, PlannerOutput, PlannerRole } from '../types';
import type { OrchestratorState } from '../state';
import type { CollaborationService } from '../services/collaboration-service';

/**
 * LLM 配置（从 metadata 提取）
 */
interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * WorkerManager（懒加载模式）
 *
 * 与旧版保持一致的懒加载模式：
 * - storeRoleDefinitions() 只存储角色定义，不预创建 Workers
 * - createWorkerForRole() 在 assignToWorker 时按需创建
 * - 优先复用空闲 Worker，没有才创建新的
 */
export class WorkerManager {
  /** 存储角色定义（懒加载模式） */
  private roleDefinitions: PlannerRole[] = [];

  /** 当前工作目录 */
  private workDir: string = process.cwd();

  constructor(
    private readonly orchestratorConfig: OrchestratorConfig,
    private readonly state: OrchestratorState,
    private readonly workerPool: IWorkerPool,
    private readonly mcpClient: MCPClientManager | undefined,
    private readonly getCollaborationService: () => CollaborationService | null
  ) {}

  /**
   * 从 currentRunMetadata 提取 LLM 配置
   *
   * 支持 metadata.llm 对象格式：{ provider, model, apiKey?, baseUrl? }
   */
  private extractLLMFromMetadata(): LLMConfig | null {
    const meta = this.state.currentRunMetadata;
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
   * 存储角色定义（懒加载模式）
   *
   * 只存储角色定义，不预创建 Workers。
   * Workers 将在 createWorkerForRole 中按需创建。
   */
  storeRoleDefinitions(workDir: string, planOutput: PlannerOutput): void {
    this.workDir = workDir;
    const roles = Array.isArray(planOutput.roles) && planOutput.roles.length > 0 ? planOutput.roles : [];

    if (roles.length > 0) {
      this.roleDefinitions = roles;
      console.debug(`[WorkerManager] Lazy worker mode: stored ${roles.length} role definitions`);
    } else {
      // 非角色化模式：使用默认的 generalist 角色
      this.roleDefinitions = [
        {
          id: 'generalist',
          name: '通用执行者',
          responsibilities: '通用执行者',
          capabilities: ['role:generalist'],
        },
      ];
      console.debug('[WorkerManager] Lazy worker mode: using default generalist role');
    }
  }

  /**
   * 生成 Worker ID
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
    const role = this.roleDefinitions.find((r) => r.id === roleId);
    const stableRoleCap = `role:${roleId}`;
    if (role) {
      const caps = role.capabilities ?? [];
      return ['general', ...caps, ...(caps.includes(stableRoleCap) ? [] : [stableRoleCap])];
    }
    // 如果没有找到角色定义，返回基本能力
    return ['general', stableRoleCap];
  }

  /**
   * 按需创建并注册 Worker（懒加载核心方法）
   *
   * @param roleId - 角色 ID
   * @returns 创建的 Worker ID，如果创建失败返回 null
   */
  async createWorkerForRole(roleId: string): Promise<string | null> {
    const maxWorkers = this.orchestratorConfig.workerPool.maxWorkers;

    // 检查是否已达到最大 Worker 数
    if (this.workerPool.workerCount >= maxWorkers) {
      console.debug(`[WorkerManager] Worker pool is full (${maxWorkers}), cannot create new worker`);
      return null;
    }

    const workerId = this.generateWorkerId(roleId);
    const capabilities = this.getRoleCapabilities(roleId);
    const sessionManager = this.state.sessionManager ?? undefined;

    const collaborationConfig = this.getCollaborationService()?.buildWorkerCollaborationConfig(
      workerId,
      this.state.sessionId ?? 'default',
      capabilities
    );

    // 提取 LLM 配置（API key 等）从 metadata
    const llm = this.extractLLMFromMetadata();
    const agentConfig = llm
      ? {
          ...this.orchestratorConfig.agent,
          provider: llm.provider,
          model: llm.model,
        }
      : this.orchestratorConfig.agent;

    // 构建 backendConfig（传递 apiKey 和 baseUrl）
    const backendConfig: Record<string, unknown> = {};
    if (llm?.apiKey) backendConfig.apiKey = llm.apiKey;
    if (llm?.baseUrl) backendConfig.baseUrl = llm.baseUrl;

    const agent = new WorkerAgent(workerId, agentConfig, {
      workDir: this.workDir,
      ...(sessionManager ? { sessionManager } : {}),
      ...(this.mcpClient ? { mcpClient: this.mcpClient } : {}),
      ...(collaborationConfig ? { collaborationConfig } : {}),
      ...(Object.keys(backendConfig).length > 0 ? { backendConfig } : {}),
    });

    const ok = this.workerPool.register({
      id: workerId,
      status: 'idle',
      agent,
      capabilities,
    });

    if (!ok) {
      console.warn(`[WorkerManager] Failed to register worker ${workerId}`);
      return null;
    }

    console.debug(`[WorkerManager] Created worker ${workerId} for role ${roleId}`);

    if (sessionManager) {
      await sessionManager.registerWorker(workerId).catch(() => undefined);
    }

    return workerId;
  }

  /**
   * 查找或创建匹配角色的 Worker（懒加载分配）
   *
   * 工作流程：
   * 1. 尝试找到具有匹配能力的空闲 Worker
   * 2. 如果没有空闲 Worker 且池未满，按需创建新 Worker
   * 3. 返回可用的 Worker ID
   *
   * @param roleId - 角色 ID
   * @returns Worker ID，如果无法获取返回 null
   */
  async findOrCreateWorkerForRole(roleId: string): Promise<string | null> {
    const roleCap = `role:${roleId}`;

    // 1. 尝试找到匹配的空闲 Worker
    const idleWorker = this.workerPool.findIdleByCapability(roleCap);
    if (idleWorker) {
      console.debug(`[WorkerManager] Reusing idle worker ${idleWorker.id} for role ${roleId}`);
      return idleWorker.id;
    }

    // 2. 如果没有空闲 Worker，尝试按需创建
    const newWorkerId = await this.createWorkerForRole(roleId);
    return newWorkerId;
  }
}
