/**
 * Worker 协调器
 *
 * 负责 Worker 的注册、分配和协调
 * 从 Orchestrator 类中提取
 */

import type { PlannerOutput, PlannerRole } from '../types';
import type { IWorkerPool } from '../worker-pool';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 并行需求映射
 */
export type ParallelRequirements = Map<string, number>;

/**
 * Worker 创建配置
 */
export interface WorkerCreationConfig {
  workerId: string;
  roleId: string;
  capabilities: string[];
}

// ============================================================================
// WorkerCoordinator 实现
// ============================================================================

/**
 * Worker 协调器
 *
 * 负责分析执行计划、管理角色定义、协调 Worker 分配
 *
 * @example
 * ```ts
 * const coordinator = new WorkerCoordinator({ workerPool });
 *
 * coordinator.setRoleDefinitions(roles);
 * const requirements = coordinator.extractParallelRequirements(plan);
 * const capabilities = coordinator.getRoleCapabilities('backend');
 * ```
 */
export class WorkerCoordinator {
  private readonly workerPool: IWorkerPool;

  // 角色定义
  private roleDefinitions: PlannerRole[] = [];

  // Worker ID 计数器（用于生成唯一 ID）
  private workerIdCounters = new Map<string, number>();

  constructor(options: { workerPool: IWorkerPool }) {
    this.workerPool = options.workerPool;
  }

  /**
   * 设置角色定义
   */
  setRoleDefinitions(roles: PlannerRole[]): void {
    this.roleDefinitions = roles;
  }

  /**
   * 获取角色定义
   */
  getRoleDefinitions(): PlannerRole[] {
    return this.roleDefinitions;
  }

  /**
   * 分析执行计划，提取每个角色需要的最大并行 Worker 数
   */
  extractParallelRequirements(plan: PlannerOutput): ParallelRequirements {
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
   * 生成唯一的 Worker ID
   */
  generateWorkerId(roleId: string): string {
    const existing = this.workerPool.getWorkersByRole(roleId);
    if (existing.length === 0) return `worker-${roleId}`;
    return `worker-${roleId}-${existing.length}`;
  }

  /**
   * 获取角色对应的能力列表
   */
  getRoleCapabilities(roleId: string): string[] {
    const role = this.roleDefinitions.find((r) => r.id === roleId);
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
   * 查找空闲的 Worker
   */
  findIdleWorkerByRole(roleId: string): string | undefined {
    const roleCap = `role:${roleId}`;
    const idle = this.workerPool.findIdleByCapability(roleCap);
    return idle?.id;
  }

  /**
   * 检查是否可以创建新 Worker
   */
  canCreateWorker(maxWorkers: number): boolean {
    return this.workerPool.workerCount < maxWorkers;
  }

  /**
   * 获取 Worker 创建配置
   */
  getWorkerCreationConfig(roleId: string): WorkerCreationConfig {
    return {
      workerId: this.generateWorkerId(roleId),
      roleId,
      capabilities: this.getRoleCapabilities(roleId),
    };
  }

  /**
   * 重置协调器状态
   */
  reset(): void {
    this.roleDefinitions = [];
    this.workerIdCounters.clear();
  }
}

/**
 * 创建 Worker 协调器
 */
export function createWorkerCoordinator(options: {
  workerPool: IWorkerPool;
}): WorkerCoordinator {
  return new WorkerCoordinator(options);
}
