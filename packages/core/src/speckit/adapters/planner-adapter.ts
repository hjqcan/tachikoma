/**
 * SpecKit-Planner 适配器
 *
 * 将 SpecKit 的任务分解转换为 Planner 可用的 SubTask 格式
 */

import type { SubTask } from '../../orchestrator/types';
import type {
  SpecTask,
  TaskBreakdown,
  Specification,
  ImplementationPlan,
} from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 适配器配置
 */
export interface PlannerAdapterConfig {
  /** 默认估算时长乘数（小时转毫秒） */
  durationMultiplier?: number;
  /** 默认单任务时长（毫秒） */
  defaultTaskDuration?: number;
}

/**
 * 转换选项
 */
export interface ConversionOptions {
  /** 父任务 ID */
  parentId?: string;
  /** 基础优先级 */
  basePriority?: 'high' | 'medium' | 'low';
}

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_CONFIG: Required<PlannerAdapterConfig> = {
  durationMultiplier: 3600000, // 1 hour in ms
  defaultTaskDuration: 3600000, // 1 hour default
};

// ============================================================================
// PlannerAdapter
// ============================================================================

/**
 * SpecKit-Planner 适配器
 *
 * 提供 SpecKit 输出到 Planner SubTask 格式的转换
 */
export class PlannerAdapter {
  private readonly config: Required<PlannerAdapterConfig>;

  constructor(config: PlannerAdapterConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 将 TaskBreakdown 转换为 SubTask 数组
   */
  convertTasks(breakdown: TaskBreakdown, options: ConversionOptions = {}): SubTask[] {
    const { parentId = 'root', basePriority = 'medium' } = options;

    return breakdown.tasks.map((task, index) => this.convertTask(task, {
      parentId,
      basePriority,
      index,
    }));
  }

  /**
   * 将单个 SpecTask 转换为 SubTask
   */
  convertTask(
    task: SpecTask,
    context: { parentId: string; basePriority: string; index: number }
  ): SubTask {
    const { parentId, basePriority, index } = context;

    // 计算优先级
    const priority = this.calculatePriority(task, basePriority, index);

    // 构建约束
    const constraints: string[] = [];
    if (task.testFirst) {
      constraints.push('Write tests before implementation (TDD)');
    }
    if (task.dependencies.length > 0) {
      constraints.push(`Depends on: ${task.dependencies.join(', ')}`);
    }
    if (task.filePaths.length > 0) {
      constraints.push(`Target files: ${task.filePaths.join(', ')}`);
    }

    // 估算时长
    const estimatedDuration = task.estimatedHours
      ? task.estimatedHours * this.config.durationMultiplier
      : this.config.defaultTaskDuration;

    return {
      id: task.id,
      parentId,
      objective: `${task.title}: ${task.description}`,
      constraints,
      priority,
      estimatedDuration,
      status: this.convertStatus(task.status),
      dependencies: task.dependencies,
    };
  }

  /**
   * 从 Specification 构建任务上下文
   */
  buildContextFromSpec(spec: Specification): string {
    let context = `# Specification: ${spec.name}\n\n`;
    context += `${spec.description}\n\n`;

    if (spec.userStories.length > 0) {
      context += `## User Stories\n`;
      for (const story of spec.userStories) {
        context += `- ${story.id}: ${story.description}\n`;
      }
      context += '\n';
    }

    if (spec.acceptanceCriteria.length > 0) {
      context += `## Acceptance Criteria\n`;
      for (const ac of spec.acceptanceCriteria) {
        context += `- ${ac}\n`;
      }
      context += '\n';
    }

    if (spec.outOfScope.length > 0) {
      context += `## Out of Scope\n`;
      for (const item of spec.outOfScope) {
        context += `- ${item}\n`;
      }
    }

    return context;
  }

  /**
   * 从 ImplementationPlan 构建任务上下文
   */
  buildContextFromPlan(plan: ImplementationPlan): string {
    let context = '# Implementation Plan\n\n';

    if (plan.techStack) {
      context += `## Tech Stack\n`;
      if (plan.techStack.runtime) context += `- Runtime: ${plan.techStack.runtime}\n`;
      if (plan.techStack.frontend) context += `- Frontend: ${plan.techStack.frontend}\n`;
      if (plan.techStack.backend) context += `- Backend: ${plan.techStack.backend}\n`;
      if (plan.techStack.database) context += `- Database: ${plan.techStack.database}\n`;
      context += '\n';
    }

    if (plan.architecture) {
      context += `## Architecture\n`;
      if (plan.architecture.pattern) {
        context += `Pattern: ${plan.architecture.pattern}\n`;
      }
      if (plan.architecture.decisions?.length) {
        context += `Decisions:\n`;
        for (const decision of plan.architecture.decisions) {
          context += `- ${decision}\n`;
        }
      }
      context += '\n';
    }

    if (plan.phases.length > 0) {
      context += `## Phases\n`;
      for (const phase of plan.phases) {
        context += `- ${phase.name}: ${phase.description || ''}\n`;
      }
    }

    return context;
  }

  /**
   * 获取并行任务分组
   */
  getParallelGroups(breakdown: TaskBreakdown): SubTask[][] {
    const groups: SubTask[][] = [];

    for (const group of breakdown.parallelGroups) {
      const tasks = group
        .map((taskId) => breakdown.tasks.find((t) => t.id === taskId))
        .filter((t): t is SpecTask => t !== undefined)
        .map((task, index) => this.convertTask(task, {
          parentId: breakdown.planId,
          basePriority: 'medium',
          index,
        }));

      if (tasks.length > 0) {
        groups.push(tasks);
      }
    }

    return groups;
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  private calculatePriority(
    task: SpecTask,
    basePriority: string,
    index: number
  ): 'high' | 'medium' | 'low' {
    // 基于依赖关系和索引计算优先级
    // 没有依赖的任务优先级更高
    if (task.dependencies.length === 0 && index < 3) {
      return 'high';
    }

    if (basePriority === 'high') {
      return task.testFirst ? 'high' : 'medium';
    }

    return basePriority as 'high' | 'medium' | 'low';
  }

  private convertStatus(status: SpecTask['status']): SubTask['status'] {
    switch (status) {
      case 'done':
        return 'success';
      case 'in-progress':
        return 'running';
      case 'failed':
        return 'failure';
      case 'skipped':
        return 'cancelled';
      default:
        return 'pending';
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Planner 适配器
 */
export function createPlannerAdapter(config?: PlannerAdapterConfig): PlannerAdapter {
  return new PlannerAdapter(config);
}
