/**
 * Task Master 适配器
 *
 * 负责与 Task Master (tasks.json) 的集成，包括：
 * - 任务状态管理
 * - Runtime 保存
 * - 原始状态跟踪（用于失败回滚）
 *
 * 从 Orchestrator 类中提取
 */

import type { ISessionFileManager } from '../session';
import type { ExecutionPlan, PlannerOutput, PlannerRole } from '../types';
import {
  updateTaskOrSubtaskStatus,
  readTasksJson,
  readTaskmeta,
  writeTaskmeta,
  ensureTaskmetaV1,
  type TaskmetaFileV1,
  addTaskOrSubtaskDependency,
  expandTaskOrSubtask,
} from '../../taskmaster-compat';
import { relative, isAbsolute } from 'node:path';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Task Master 任务状态
 */
export type TaskMasterTaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'blocked'
  | 'review'
  | 'deferred'
  | 'cancelled'
  | 'completed';

/**
 * Task Master 引用
 */
export interface TaskMasterRef {
  projectRoot: string;
  file: string;
  tag: string;
}

/**
 * Runtime 数据结构
 */
export interface TaskMasterRuntimeData {
  kind: 'taskmaster';
  taskId: string;
  createdAt: number;
  version: number;
  tasksJson: {
    path: string;
    tag: string;
  };
  executionPlan: ExecutionPlan;
  roles?: PlannerRole[];
  roleAssignments?: Record<string, { roleId?: string; requiredCapabilities?: string[] }>;
  originalStatuses?: Record<string, TaskMasterTaskStatus>;
}

// ============================================================================
// TaskMasterAdapter 实现
// ============================================================================

/**
 * Task Master 适配器
 *
 * 管理与 Task Master (tasks.json) 的集成
 *
 * @example
 * ```ts
 * const adapter = new TaskMasterAdapter({
 *   projectRoot: '/path/to/project',
 *   tasksPath: 'tasks/tasks.json',
 *   tag: 'master',
 * });
 *
 * await adapter.writeStatus('1.1', 'in-progress');
 * await adapter.saveRuntime(sessionManager, taskId, planOutput);
 * ```
 */
export class TaskMasterAdapter {
  private projectRoot: string | null = null;
  private tasksPath: string | null = null;
  private tag = 'master';

  // 原始状态跟踪（用于失败回滚）
  private readonly originalStatuses: Record<string, TaskMasterTaskStatus> = {};

  // 按任务 ID 的引用缓存
  private readonly refsByTaskId = new Map<string, TaskMasterRef>();

  /**
   * 初始化适配器
   */
  initialize(options: {
    projectRoot: string;
    tasksPath: string;
    tag?: string;
  }): void {
    this.projectRoot = options.projectRoot;
    this.tasksPath = options.tasksPath;
    this.tag = options.tag ?? 'master';
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return !!(this.projectRoot && this.tasksPath);
  }

  /**
   * 获取当前引用
   */
  getRef(): TaskMasterRef | null {
    if (!this.projectRoot || !this.tasksPath) return null;
    return {
      projectRoot: this.projectRoot,
      file: this.tasksPath,
      tag: this.tag,
    };
  }

  /**
   * 设置任务引用
   */
  setRefForTask(taskId: string, ref: TaskMasterRef): void {
    this.refsByTaskId.set(taskId, ref);
  }

  /**
   * 获取任务引用
   */
  getRefForTask(taskId: string): TaskMasterRef | null {
    return this.refsByTaskId.get(taskId) ?? this.getRef();
  }

  /**
   * 记录原始状态
   */
  recordOriginalStatus(id: string, status: TaskMasterTaskStatus): void {
    this.originalStatuses[id] ??= status;
  }

  /**
   * 获取原始状态
   */
  getOriginalStatus(id: string): TaskMasterTaskStatus {
    return this.originalStatuses[id] ?? 'pending';
  }

  /**
   * 获取所有原始状态
   */
  getAllOriginalStatuses(): Record<string, TaskMasterTaskStatus> {
    return { ...this.originalStatuses };
  }

  /**
   * 合并“执行起始时的原始状态快照”
   *
   * 规则：只补齐缺失项，不覆盖已有值。
   * 这样可以确保：
   * - 首次 run() 记录的快照在后续 replan 时不会被覆盖
   * - expand_commit 新增的任务/子任务可在后续 plan 中补齐快照
   */
  mergeOriginalStatuses(statuses?: Record<string, TaskMasterTaskStatus>): void {
    if (!statuses) return;
    for (const [id, status] of Object.entries(statuses)) {
      if (!id) continue;
      this.originalStatuses[id] ??= status;
    }
  }

  /**
   * 写入任务状态
   */
  async writeStatus(id: string, status: TaskMasterTaskStatus): Promise<void> {
    if (!this.projectRoot || !this.tasksPath) return;

    await updateTaskOrSubtaskStatus(id, status, {
      projectRoot: this.projectRoot,
      file: this.tasksPath,
      tag: this.tag,
      touchUpdatedAt: true,
    });
  }

  /**
   * 恢复原始状态
   */
  async restoreStatus(id: string): Promise<void> {
    const original = this.getOriginalStatus(id);
    await this.writeStatus(id, original);
  }

  /**
   * 添加依赖关系
   */
  async addDependency(subtaskId: string, predecessor: string): Promise<void> {
    const ref = this.getRef();
    if (!ref) return;

    await addTaskOrSubtaskDependency(subtaskId, predecessor, ref);
  }

  /**
   * 展开子任务
   */
  async expandSubtask(
    targetId: string,
    subtasks: {
      title: string;
      description: string;
      details: string;
      testStrategy: string;
    }[],
    options: {
      force?: boolean;
      strategy: 'serial' | 'parallel';
    }
  ): Promise<void> {
    const ref = this.getRef();
    if (!ref) return;

    await expandTaskOrSubtask(targetId, subtasks, {
      projectRoot: ref.projectRoot,
      file: ref.file,
      tag: ref.tag,
      ...options,
    });
  }

  /**
   * 保存 Runtime 到会话
   */
  async saveRuntime(
    sessionManager: ISessionFileManager,
    taskId: string,
    planOutput: PlannerOutput
  ): Promise<void> {
    if (!this.projectRoot || !this.tasksPath) return;

    const projectRoot = this.projectRoot;
    const tasksPathAbs = this.tasksPath;

    // 尽量写相对路径
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

    // 构建角色分配
    const roleAssignments: Record<
      string,
      { roleId?: string; requiredCapabilities?: string[] }
    > = {};
    for (const st of planOutput.subtasks) {
      if (
        st.roleId ||
        (Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.length > 0)
      ) {
        roleAssignments[st.id] = {
          ...(st.roleId ? { roleId: st.roleId } : {}),
          ...(Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.length > 0
            ? { requiredCapabilities: st.requiredCapabilities }
            : {}),
        };
      }
    }

    const runtimeData: TaskMasterRuntimeData = {
      kind: 'taskmaster',
      taskId,
      createdAt: Date.now(),
      version: 1,
      tasksJson: {
        path: tasksPathForPlan,
        tag: this.tag,
      },
      executionPlan: planOutput.executionPlan,
      ...(Array.isArray(planOutput.roles) && planOutput.roles.length > 0
        ? { roles: planOutput.roles }
        : {}),
      ...(Object.keys(roleAssignments).length > 0 ? { roleAssignments } : {}),
      ...(Object.keys(this.originalStatuses).length > 0
        ? { originalStatuses: this.originalStatuses }
        : {}),
    };

    await sessionManager.writeRuntime(runtimeData);
  }

  /**
   * 读取 tasks.json
   */
  async readTasks(options?: { file?: string }): Promise<{
    tasks: unknown[];
    tasksPath: string;
    tag: string;
    rawData: unknown;
  }> {
    if (!this.projectRoot) {
      throw new Error('TaskMasterAdapter not initialized');
    }

    const result = await readTasksJson({
      projectRoot: this.projectRoot,
      tag: this.tag,
      ...(options?.file ? { file: options.file } : {}),
    });

    // 更新内部状态
    this.tasksPath = result.tasksPath;

    return result;
  }

  /**
   * 读取 taskmeta
   */
  async readTaskmeta(): Promise<unknown | null> {
    if (!this.projectRoot) return null;
    return readTaskmeta(this.projectRoot).catch(() => null);
  }

  /**
   * 写入 taskmeta
   */
  async writeTaskmeta(data: unknown): Promise<void> {
    if (!this.projectRoot) return;
    const v1 = ensureTaskmetaV1(data as TaskmetaFileV1 | null);
    await writeTaskmeta(this.projectRoot, v1);
  }

  /**
   * 重置适配器状态
   */
  reset(): void {
    this.projectRoot = null;
    this.tasksPath = null;
    this.tag = 'master';
    Object.keys(this.originalStatuses).forEach((key) => {
      delete this.originalStatuses[key];
    });
    this.refsByTaskId.clear();
  }
}

/**
 * 创建 Task Master 适配器
 */
export function createTaskMasterAdapter(): TaskMasterAdapter {
  return new TaskMasterAdapter();
}
