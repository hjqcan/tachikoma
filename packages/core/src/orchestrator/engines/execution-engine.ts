/**
 * 执行引擎
 *
 * 负责 DAG 验证和执行计划的基础操作
 * 从 Orchestrator 类中提取可独立的执行逻辑
 */

import type { SubTask, ExecutionPlan, ExecutionStep } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * DAG 验证结果
 */
export interface DAGValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 子任务执行结果
 */
export interface SubTaskExecutionResult {
  subtaskId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  retryCount: number;
}

// ============================================================================
// ExecutionEngine 实现
// ============================================================================

/**
 * 执行引擎
 *
 * 提供执行计划验证和执行辅助功能
 *
 * @example
 * ```ts
 * const engine = new ExecutionEngine();
 *
 * // 验证 DAG
 * const validation = engine.validatePlanDAG(subtasks, executionPlan);
 * if (!validation.valid) {
 *   console.error(validation.error);
 * }
 * ```
 */
export class ExecutionEngine {
  /**
   * 验证计划的 DAG 有效性
   *
   * 检查：
   * 1. 所有依赖引用的子任务都存在
   * 2. 没有循环依赖
   * 3. 执行步骤中的所有 subtaskId 都存在
   * 4. 每个子任务只出现在一个执行步骤中
   */
  validatePlanDAG(
    subtasks: SubTask[],
    executionPlan: ExecutionPlan
  ): DAGValidationResult {
    const subtaskIds = new Set(subtasks.map((st) => st.id));

    // 1. 检查依赖引用
    for (const subtask of subtasks) {
      if (subtask.dependencies) {
        for (const depId of subtask.dependencies) {
          if (!subtaskIds.has(depId)) {
            return {
              valid: false,
              error: `Subtask ${subtask.id} depends on unknown subtask: ${depId}`,
            };
          }
          if (depId === subtask.id) {
            return {
              valid: false,
              error: `Subtask ${subtask.id} cannot depend on itself`,
            };
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
        return {
          valid: false,
          error: 'Circular dependency detected in subtasks',
        };
      }
    }

    // 3. 检查执行步骤中的 subtaskId
    const seenInSteps = new Set<string>();
    for (const step of executionPlan.steps) {
      for (const id of step.subtaskIds) {
        if (!subtaskIds.has(id)) {
          return {
            valid: false,
            error: `ExecutionPlan references unknown subtask: ${id}`,
          };
        }
        if (seenInSteps.has(id)) {
          return {
            valid: false,
            error: `Subtask ${id} appears in multiple execution steps`,
          };
        }
        seenInSteps.add(id);
      }
    }

    return { valid: true };
  }

  /**
   * 构建子任务映射表
   */
  buildSubtaskMap(subtasks: SubTask[]): Map<string, SubTask> {
    const map = new Map<string, SubTask>();
    for (const subtask of subtasks) {
      map.set(subtask.id, subtask);
    }
    return map;
  }

  /**
   * 检查子任务依赖是否满足
   */
  checkDependencies(
    subtask: SubTask,
    completedSubtasks: Set<string>
  ): { satisfied: boolean; missingDeps: string[] } {
    const missingDeps: string[] = [];

    if (subtask.dependencies) {
      for (const depId of subtask.dependencies) {
        if (!completedSubtasks.has(depId)) {
          missingDeps.push(depId);
        }
      }
    }

    return {
      satisfied: missingDeps.length === 0,
      missingDeps,
    };
  }

  /**
   * 获取可执行的子任务（依赖已满足）
   */
  getExecutableSubtasks(
    step: ExecutionStep,
    subtaskMap: Map<string, SubTask>,
    completedSubtasks: Set<string>,
    runningSubtasks: Set<string>
  ): SubTask[] {
    const executable: SubTask[] = [];

    for (const id of step.subtaskIds) {
      // 跳过已完成或运行中的
      if (completedSubtasks.has(id) || runningSubtasks.has(id)) {
        continue;
      }

      const subtask = subtaskMap.get(id);
      if (!subtask) continue;

      const { satisfied } = this.checkDependencies(subtask, completedSubtasks);
      if (satisfied) {
        executable.push(subtask);
      }
    }

    return executable;
  }

  /**
   * 计算执行进度
   */
  calculateProgress(
    totalSubtasks: number,
    completedCount: number,
    failedCount: number
  ): {
    percentage: number;
    completed: number;
    failed: number;
    remaining: number;
  } {
    const remaining = totalSubtasks - completedCount - failedCount;
    const percentage =
      totalSubtasks > 0 ? Math.round((completedCount / totalSubtasks) * 100) : 0;

    return {
      percentage,
      completed: completedCount,
      failed: failedCount,
      remaining,
    };
  }

  /**
   * 检测是否是内部 barrier 节点
   */
  isBarrierSubtask(subtask: SubTask): boolean {
    return (
      Array.isArray(subtask.requiredCapabilities) &&
      subtask.requiredCapabilities.includes('internal:barrier')
    );
  }
}

/**
 * 创建执行引擎实例
 */
export function createExecutionEngine(): ExecutionEngine {
  return new ExecutionEngine();
}
