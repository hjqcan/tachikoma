import { WorkerAgent } from '../../agents/worker-agent';
import type { MCPClientManager } from '../../mcp';
import type { IWorkerPool } from '../worker-pool';
import type { OrchestratorConfig, PlannerOutput } from '../types';
import type { OrchestratorState } from '../state';
import type { CollaborationService } from '../services/collaboration-service';

/**
 * WorkerManager
 *
 * 负责按“旧版并行模型”创建/扩容 workers：
 * - 每个 role 允许多个 worker
 * - 优先满足 executionPlan 同一步骤的同 role 并行需求
 * - 注入 WorkerPool 时不做自动创建（由调用方负责）
 */
export class WorkerManager {
  constructor(
    private readonly orchestratorConfig: OrchestratorConfig,
    private readonly state: OrchestratorState,
    private readonly workerPool: IWorkerPool,
    private readonly mcpClient: MCPClientManager | undefined,
    private readonly getCollaborationService: () => CollaborationService | null
  ) {}

  async ensureWorkersForPlan(workDir: string, planOutput: PlannerOutput): Promise<void> {
    const delegation = planOutput.delegation;
    const desiredCount = Math.max(1, delegation.workerCount);
    const roles = Array.isArray(planOutput.roles) && planOutput.roles.length > 0 ? planOutput.roles : [];

    const rolePool =
      roles.length > 0
        ? roles
        : [
            {
              id: 'generalist',
              name: '通用执行者',
              responsibilities: '通用执行者',
              capabilities: ['role:generalist'],
            },
          ];

    const isBarrier = (st: any): boolean =>
      Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.includes('internal:barrier');

    const roleBySubtaskId = new Map<string, string>();
    for (const st of planOutput.subtasks ?? []) {
      if (isBarrier(st)) continue;
      const roleId = typeof st.roleId === 'string' && st.roleId.length > 0 ? st.roleId : 'generalist';
      roleBySubtaskId.set(st.id, roleId);
    }

    const requiredByRole = new Map<string, number>();
    for (const roleId of roleBySubtaskId.values()) {
      requiredByRole.set(roleId, Math.max(1, requiredByRole.get(roleId) ?? 0));
    }

    for (const step of planOutput.executionPlan.steps ?? []) {
      if (!step.parallel) continue;
      const counts = new Map<string, number>();
      for (const id of step.subtaskIds ?? []) {
        const roleId = roleBySubtaskId.get(id);
        if (!roleId) continue;
        counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
      }
      for (const [roleId, count] of counts.entries()) {
        requiredByRole.set(roleId, Math.max(requiredByRole.get(roleId) ?? 0, count));
      }
    }

    if (requiredByRole.size === 0) {
      const fallbackRoleId = rolePool[0]?.id ?? 'generalist';
      requiredByRole.set(fallbackRoleId, 1);
    }

    const sumRequired = (): number => Array.from(requiredByRole.values()).reduce((a, b) => a + b, 0);
    const targetTotal = Math.max(sumRequired(), desiredCount);
    const roleIdsForDistribution = rolePool
      .map((r) => r.id)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    let rr = 0;
    while (sumRequired() < targetTotal && roleIdsForDistribution.length > 0) {
      const roleId = roleIdsForDistribution[rr % roleIdsForDistribution.length]!;
      requiredByRole.set(roleId, (requiredByRole.get(roleId) ?? 0) + 1);
      rr++;
    }

    const roleDefById = new Map(rolePool.map((r) => [r.id, r] as const));
    const nextWorkerIdForRole = (roleId: string): string => {
      let seq = 0;
      while (this.workerPool.getWorker(`worker-${roleId}-${seq}`)) seq++;
      return `worker-${roleId}-${seq}`;
    };

    for (const [roleId, needed] of requiredByRole.entries()) {
      if (!Number.isFinite(needed) || needed <= 0) continue;
      const existing = this.workerPool.getWorkersByRole(roleId).length;
      const missing = Math.max(0, needed - existing);
      if (missing === 0) continue;

      const role = roleDefById.get(roleId) ?? {
        id: roleId,
        name: roleId,
        responsibilities: '',
        capabilities: [`role:${roleId}`],
      };

      for (let i = 0; i < missing; i++) {
        const workerId = nextWorkerIdForRole(roleId);
        const sessionManager = this.state.sessionManager ?? undefined;
        const caps = Array.from(new Set([...(role.capabilities ?? []), `role:${role.id}`]));

        const collaborationConfig = this.getCollaborationService()?.buildWorkerCollaborationConfig(
          workerId,
          this.state.sessionId ?? 'default',
          caps
        );

        const agent = new WorkerAgent(workerId, this.orchestratorConfig.agent, {
          workDir,
          ...(sessionManager ? { sessionManager } : {}),
          ...(this.mcpClient ? { mcpClient: this.mcpClient } : {}),
          ...(collaborationConfig ? { collaborationConfig } : {}),
        });

        const ok = this.workerPool.register({
          id: workerId,
          status: 'idle',
          agent,
          capabilities: caps,
        });
        if (!ok) break;

        if (sessionManager) {
          await sessionManager.registerWorker(workerId).catch(() => undefined);
        }
      }
    }
  }
}


