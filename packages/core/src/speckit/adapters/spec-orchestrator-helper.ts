/**
 * SpecKit Orchestrator Extension
 *
 * 为 Orchestrator 添加 SpecKit 感知能力
 * 实现基于规范的任务执行和进度追踪
 */

import type { TaskResult } from '../../types';
import type { SubTask, PlannerOutput, ExecutionPlan, ExecutionStep } from '../../orchestrator/types';
import type { TaskBreakdown, Specification, ImplementationPlan, SpecTask } from '../types';
import type { SpecKitFileManager } from '../file-manager';
import { PlannerAdapter } from './planner-adapter';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * SpecKit Orchestrator 配置
 */
export interface SpecOrchestratorConfig {
  /** 文件管理器 */
  fileManager: SpecKitFileManager;
  /** 计划适配器 */
  plannerAdapter?: PlannerAdapter;
}

/**
 * 规范执行选项
 */
export interface SpecExecutionOptions {
  /** 规范 ID */
  specId: string;
  /** 父任务 ID */
  parentTaskId?: string;
  /** 是否验证规范完整性 */
  validateSpec?: boolean;
  /** 进度回调 */
  onProgress?: (progress: SpecExecutionProgress) => void;
}

/**
 * 规范执行进度
 */
export interface SpecExecutionProgress {
  /** 当前阶段 */
  phase: 'loading' | 'validating' | 'converting' | 'executing' | 'complete';
  /** 总任务数 */
  totalTasks: number;
  /** 已完成任务数 */
  completedTasks: number;
  /** 当前任务 ID */
  currentTaskId?: string;
  /** 进度百分比 */
  percentage: number;
  /** 消息 */
  message: string;
}

/**
 * 规范验证结果
 */
export interface SpecValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 规范转换输出
 */
export interface SpecConversionOutput {
  /** 规范 */
  specification: Specification;
  /** 实现计划 */
  plan: ImplementationPlan;
  /** 任务分解 */
  breakdown: TaskBreakdown;
  /** 转换后的 SubTask 列表 */
  subtasks: SubTask[];
  /** 执行计划 */
  executionPlan: ExecutionPlan;
  /** Planner 兼容输出 */
  plannerOutput: PlannerOutput;
}

// ============================================================================
// SpecKitOrchestratorHelper
// ============================================================================

/**
 * SpecKit Orchestrator 辅助类
 *
 * 提供规范执行、验证和进度追踪功能
 */
export class SpecKitOrchestratorHelper {
  private readonly fileManager: SpecKitFileManager;
  private readonly adapter: PlannerAdapter;

  constructor(config: SpecOrchestratorConfig) {
    this.fileManager = config.fileManager;
    this.adapter = config.plannerAdapter ?? new PlannerAdapter();
  }

  // ==========================================================================
  // 规范验证
  // ==========================================================================

  /**
   * 验证规范完整性
   */
  async validateSpec(specId: string): Promise<SpecValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查规范文件是否存在
    const spec = await this.fileManager.readSpec(specId);
    if (!spec) {
      errors.push(`Specification not found: ${specId}`);
      return { valid: false, errors, warnings };
    }

    // 检查规范内容
    if (!spec.name || spec.name.trim().length === 0) {
      errors.push('Specification name is required');
    }

    if (!spec.userStories || spec.userStories.length === 0) {
      warnings.push('No user stories defined');
    }

    if (!spec.acceptanceCriteria || spec.acceptanceCriteria.length === 0) {
      warnings.push('No acceptance criteria defined');
    }

    // 检查实现计划
    const plan = await this.fileManager.readPlan(specId);
    if (!plan) {
      errors.push('Implementation plan not found');
    } else {
      if (!plan.phases || plan.phases.length === 0) {
        warnings.push('No phases defined in implementation plan');
      }
    }

    // 检查任务分解
    const tasks = await this.fileManager.readTasks(specId);
    if (!tasks) {
      errors.push('Task breakdown not found');
    } else {
      if (!tasks.tasks || tasks.tasks.length === 0) {
        errors.push('No tasks defined in breakdown');
      }

      // 验证任务依赖
      const taskIds = new Set(tasks.tasks.map((t) => t.id));
      for (const task of tasks.tasks) {
        for (const dep of task.dependencies) {
          if (!taskIds.has(dep)) {
            errors.push(`Task ${task.id} depends on non-existent task: ${dep}`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ==========================================================================
  // 规范到 SubTask 转换
  // ==========================================================================

  /**
   * 将规范转换为 Planner 兼容的输出
   */
  async convertSpecToSubtasks(
    specId: string,
    parentTaskId = 'root'
  ): Promise<SpecConversionOutput | null> {
    // 加载规范文档
    const spec = await this.fileManager.readSpec(specId);
    if (!spec) return null;

    const plan = await this.fileManager.readPlan(specId);
    if (!plan) return null;

    const breakdown = await this.fileManager.readTasks(specId);
    if (!breakdown) return null;

    // 使用适配器转换任务
    const subtasks = this.adapter.convertTasks(breakdown, { parentId: parentTaskId });

    // 生成执行计划
    const executionPlan = this.buildExecutionPlan(breakdown, subtasks);

    // 构建 PlannerOutput
    const plannerOutput = this.buildPlannerOutput(parentTaskId, subtasks, executionPlan);

    return {
      specification: spec,
      plan,
      breakdown,
      subtasks,
      executionPlan,
      plannerOutput,
    };
  }

  /**
   * 构建执行计划
   */
  private buildExecutionPlan(breakdown: TaskBreakdown, subtasks: SubTask[]): ExecutionPlan {
    // 按依赖关系分组任务
    const steps: ExecutionStep[] = [];
    const scheduled = new Set<string>();
    let order = 0;

    while (scheduled.size < subtasks.length) {
      const readyTasks: string[] = [];

      for (const task of breakdown.tasks) {
        if (scheduled.has(task.id)) continue;

        // 检查所有依赖是否已调度
        const depsReady = task.dependencies.every((dep) => scheduled.has(dep));
        if (depsReady) {
          readyTasks.push(task.id);
        }
      }

      if (readyTasks.length === 0 && scheduled.size < subtasks.length) {
        // 存在循环依赖或未解决的依赖
        // 将剩余任务添加到最后一步
        const remaining = breakdown.tasks
          .filter((t) => !scheduled.has(t.id))
          .map((t) => t.id);
        steps.push({
          order: order++,
          subtaskIds: remaining,
          parallel: false,
        });
        break;
      }

      // 添加步骤
      steps.push({
        order: order++,
        subtaskIds: readyTasks,
        parallel: readyTasks.length > 1,
      });

      readyTasks.forEach((id) => scheduled.add(id));
    }

    return {
      steps,
      isParallel: steps.some((s) => s.parallel),
      criticalPath: this.findCriticalPath(breakdown),
    };
  }

  /**
   * 查找关键路径（最长执行路径）
   */
  private findCriticalPath(breakdown: TaskBreakdown): string[] {
    const taskMap = new Map(breakdown.tasks.map((t) => [t.id, t]));
    let longestPath: string[] = [];

    const findPath = (taskId: string, currentPath: string[]): void => {
      const task = taskMap.get(taskId);
      if (!task) return;

      const newPath = [...currentPath, taskId];

      if (newPath.length > longestPath.length) {
        longestPath = newPath;
      }

      // 查找依赖此任务的下游任务
      for (const t of breakdown.tasks) {
        if (t.dependencies.includes(taskId)) {
          findPath(t.id, newPath);
        }
      }
    };

    // 从没有依赖的任务开始
    for (const task of breakdown.tasks) {
      if (task.dependencies.length === 0) {
        findPath(task.id, []);
      }
    }

    return longestPath;
  }

  /**
   * 构建 PlannerOutput
   */
  private buildPlannerOutput(
    taskId: string,
    subtasks: SubTask[],
    executionPlan: ExecutionPlan
  ): PlannerOutput {
    const totalDuration = subtasks.reduce((sum, t) => sum + (t.estimatedDuration ?? 3600000), 0);

    return {
      taskId,
      subtasks,
      delegation: {
        mode: 'shared-memory', // SpecKit uses shared memory mode
        workerCount: Math.min(subtasks.length, 5),
        timeout: totalDuration * 1.5,
        retryPolicy: {
          maxRetries: 3,
          baseDelay: 1000,
          backoffFactor: 2,
          maxDelay: 30000,
        },
      },
      executionPlan,
      reasoning: 'Generated from SpecKit specification',
      estimatedTotalDuration: totalDuration,
      estimatedTokens: subtasks.length * 2000, // 估算
    };
  }

  // ==========================================================================
  // 进度追踪
  // ==========================================================================

  /**
   * 更新任务完成状态
   */
  async updateTaskProgress(
    specId: string,
    taskId: string,
    result: TaskResult
  ): Promise<void> {
    const status = result.status === 'success' ? 'done' : 'failed';
    await this.fileManager.updateTaskStatus(specId, taskId, status);
  }

  /**
   * 获取规范执行进度
   */
  async getSpecProgress(specId: string): Promise<SpecExecutionProgress | null> {
    const tasks = await this.fileManager.readTasks(specId);
    if (!tasks) return null;

    const totalTasks = tasks.tasks.length;
    const completedTasks = tasks.tasks.filter((t) => t.status === 'done').length;
    const inProgressTask = tasks.tasks.find((t) => t.status === 'in-progress');

    const percentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const result: SpecExecutionProgress = {
      phase: completedTasks === totalTasks ? 'complete' : 'executing',
      totalTasks,
      completedTasks,
      percentage,
      message: `${completedTasks}/${totalTasks} tasks completed (${percentage}%)`,
    };

    if (inProgressTask) {
      result.currentTaskId = inProgressTask.id;
    }

    return result;
  }

  /**
   * 获取未完成的任务列表
   */
  async getPendingTasks(specId: string): Promise<SpecTask[]> {
    const tasks = await this.fileManager.readTasks(specId);
    if (!tasks) return [];

    return tasks.tasks.filter((t) => t.status === 'pending' || t.status === 'in-progress');
  }

  /**
   * 获取可执行的任务（依赖已完成）
   */
  async getExecutableTasks(specId: string): Promise<SpecTask[]> {
    const tasks = await this.fileManager.readTasks(specId);
    if (!tasks) return [];

    const completedIds = new Set(
      tasks.tasks.filter((t) => t.status === 'done').map((t) => t.id)
    );

    return tasks.tasks.filter((t) => {
      if (t.status !== 'pending') return false;
      return t.dependencies.every((dep) => completedIds.has(dep));
    });
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 SpecKit Orchestrator 辅助类
 */
export function createSpecKitOrchestratorHelper(
  config: SpecOrchestratorConfig
): SpecKitOrchestratorHelper {
  return new SpecKitOrchestratorHelper(config);
}
