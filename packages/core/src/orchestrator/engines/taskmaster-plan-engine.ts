/**
 * TaskMaster 规划引擎
 *
 * 从 Orchestrator 提取的 executeTaskMasterPlanPhase 核心逻辑
 * 负责从 tasks.json 读取任务并转换为 PlannerOutput
 */

import type { OrchestratorTask, SubTask, PlannerOutput, ExecutionPlan, ExecutionStep, PlannerRole } from '../types';
import type { PlanResult } from '../../planner';
import type { Planner } from '../../planner';
import {
  readTasksJson,
  writeTasksJson,
  readTaskmeta,
  writeTaskmeta,
  ensureTaskmetaV1,
  upsertRoleAssignment,
  getRoleDefinitionsFromTaskmeta,
  getRoleAssignmentFromTaskmeta,
  type Task as TaskMasterTask,
  type TaskStatus as TaskMasterTaskStatus,
  type TaskPriority as TaskMasterTaskPriority,
} from '../../taskmaster-compat';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * TaskMaster 规划引擎配置
 */
export interface TaskMasterPlanEngineConfig {
  defaultMaxSubtasks: number;
}

/**
 * 规划引擎依赖
 */
export interface TaskMasterPlanEngineDeps {
  planner: Planner;
  config: TaskMasterPlanEngineConfig;
  getMaxSubtasks?: () => number | undefined;
}

/**
 * TaskMaster 引用
 */
export interface TaskMasterRef {
  projectRoot: string;
  tag: string;
  file?: string;
}

/**
 * 规划引擎结果
 */
export interface PlanEngineResult extends PlanResult {
  tasksPath?: string;
  effectiveTag?: string;
  originalStatuses?: Record<string, TaskMasterTaskStatus>;
}

// ============================================================================
// TaskMasterPlanEngine 实现
// ============================================================================

/**
 * TaskMaster 规划引擎
 *
 * 负责从 tasks.json 读取任务并转换为 PlannerOutput
 */
export class TaskMasterPlanEngine {
  private readonly deps: TaskMasterPlanEngineDeps;

  // 执行期间收集的原始状态
  private originalStatuses: Record<string, TaskMasterTaskStatus> = {};

  constructor(deps: TaskMasterPlanEngineDeps) {
    this.deps = deps;
  }

  /**
   * 执行 TaskMaster 规划阶段
   */
  async executePlanPhase(
    task: OrchestratorTask,
    ref: TaskMasterRef,
    signal: AbortSignal,
    ensureRound = 0
  ): Promise<PlanEngineResult> {
    if (signal.aborted) {
      return {
        success: false,
        error: 'Aborted',
        tokensUsed: { input: 0, output: 0 },
        retryCount: 0,
        degraded: false,
      };
    }

    // 清空原始状态
    this.originalStatuses = {};

    const taskmetaRaw = await readTaskmeta(ref.projectRoot).catch(() => null);
    const taskmetaV1 = ensureTaskmetaV1(taskmetaRaw);
    let taskmetaDirty = taskmetaRaw === null;
    const roleDefsFromMeta = getRoleDefinitionsFromTaskmeta(taskmetaV1);

    const effectiveTag = ref.tag || taskmetaV1.tasksJson?.tag || 'master';

    const read = await readTasksJson({
      projectRoot: ref.projectRoot,
      tag: effectiveTag,
      ...(ref.file ? { file: ref.file } : {}),
    });

    const maxEnsureRounds = 2;

    // 如果 tasks.json 为空，尝试用 Planner 生成新任务
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

      const appendResult = await this.planAndAppendTasks(
        task,
        [],
        ref,
        read,
        effectiveTag
      );
      if (appendResult) return appendResult;
      return this.executePlanPhase(task, ref, signal, ensureRound + 1);
    }

    // 转换 tasks.json 为 SubTask[]
    const subtasks = this.convertTasksToSubtasks(read.tasks, task);

    // 如果没有可执行任务，尝试追加新任务
    if (subtasks.length === 0 && ensureRound < maxEnsureRounds) {
      const appendResult = await this.planAndAppendTasks(
        task,
        read.tasks,
        ref,
        read,
        effectiveTag
      );
      if (appendResult) return appendResult;
      return this.executePlanPhase(task, ref, signal, ensureRound + 1);
    }

    // 拓扑排序生成执行计划
    const executionPlan = this.buildExecutionPlan(subtasks);

    // 角色推理（简化版：使用 generalist）
    const { roles, updatedSubtasks, tokensUsed, retryCount, dirty } = await this.inferRoles(
      task,
      subtasks,
      taskmetaV1,
      roleDefsFromMeta.map(r => ({ ...r, responsibilities: r.responsibilities ?? '' })),
      effectiveTag
    );

    if (dirty) {
      taskmetaDirty = true;
    }

    if (taskmetaDirty) {
      await writeTaskmeta(ref.projectRoot, taskmetaV1);
    }

    const delegation = task.delegation ?? {
      mode: 'communication' as const,
      workerCount: 3,
      timeout: 300000,
      retryPolicy: { maxRetries: 2, baseDelay: 1000 },
    };

    const output: PlannerOutput = {
      taskId: task.id,
      subtasks: updatedSubtasks,
      delegation,
      executionPlan,
      roles,
    };

    return {
      success: true,
      output,
      tokensUsed,
      retryCount,
      degraded: false,
      tasksPath: read.tasksPath,
      effectiveTag,
      originalStatuses: this.originalStatuses,
    };
  }

  /**
   * 获取收集的原始状态
   */
  getOriginalStatuses(): Record<string, TaskMasterTaskStatus> {
    return { ...this.originalStatuses };
  }

  /**
   * 用 Planner 生成新任务并追加到 tasks.json
   */
  private async planAndAppendTasks(
    task: OrchestratorTask,
    existing: TaskMasterTask[],
    ref: TaskMasterRef,
    read: { tasksPath: string; rawData: unknown },
    effectiveTag: string
  ): Promise<PlanEngineResult | null> {
    const maxSubtasks = this.deps.getMaxSubtasks?.() ?? this.deps.config.defaultMaxSubtasks;

    const plan = await this.deps.planner.plan({ task, maxSubtasks });
    if (!plan.success || !plan.output) {
      return plan as PlanEngineResult;
    }

    if (plan.output.intake?.ready === false) {
      return plan as PlanEngineResult;
    }

    const nowIso = new Date().toISOString();
    const existingIds = existing.map((t) => Number(String(t.id))).filter((n) => Number.isFinite(n));
    const baseId = existingIds.length > 0 ? Math.max(...existingIds) : existing.length;

    const priorityRaw = String(task.priority ?? 'medium') as TaskMasterTaskPriority;
    const priority: TaskMasterTaskPriority =
      priorityRaw === 'critical' || priorityRaw === 'high' || priorityRaw === 'medium' || priorityRaw === 'low'
        ? priorityRaw
        : 'medium';

    const plannedSubtasks = Array.isArray(plan.output.subtasks) ? plan.output.subtasks : [];

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

      const details = Array.isArray(st.constraints) && st.constraints.length > 0 ? st.constraints.join('\n') : '';

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
  }

  /**
   * 转换 TaskMaster tasks 为 SubTask[]
   */
  private convertTasksToSubtasks(tasks: TaskMasterTask[], parentTask: OrchestratorTask): SubTask[] {
    const terminalComplete = new Set<TaskMasterTaskStatus>(['done', 'completed', 'cancelled']);
    const isSatisfied = (status: TaskMasterTaskStatus | undefined): boolean => {
      if (!status) return false;
      return terminalComplete.has(status);
    };

    const completedIds = new Set<string>();
    for (const t of tasks) {
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

    const subtasks: SubTask[] = [];

    for (const t of tasks) {
      const tid = String(t.id);
      const taskStatus = (t.status ?? 'pending') as TaskMasterTaskStatus;
      const taskPriority = (t.priority ?? 'medium') as TaskMasterTaskPriority;
      const priority =
        taskPriority === 'critical' || taskPriority === 'high' || taskPriority === 'medium' || taskPriority === 'low'
          ? taskPriority
          : 'medium';

      const taskDepsRaw = Array.isArray(t.dependencies) ? t.dependencies : [];
      const taskDeps = taskDepsRaw.map((dep) => String(dep)).filter((dep) => !completedIds.has(dep));

      const subs = Array.isArray(t.subtasks) ? t.subtasks : [];

      if (subs.length === 0) {
        if (isSatisfied(taskStatus)) continue;
        this.recordOriginalStatus(tid, taskStatus);
        subtasks.push({
          id: tid,
          parentId: parentTask.id,
          parentObjective: parentTask.objective,
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

      // 处理子任务
      const sortedSubs = subs.slice().sort((a, b) => Number(a.id) - Number(b.id));
      const executableChildIds: string[] = [];

      for (const st of sortedSubs) {
        const fullId = `${tid}.${String(st.id)}`;
        const stStatus = (st.status ?? 'pending') as TaskMasterTaskStatus;
        if (isSatisfied(stStatus)) continue;

        this.recordOriginalStatus(fullId, stStatus);

        const stDepsRaw = Array.isArray(st.dependencies) ? st.dependencies : [];
        const stDepsNorm = stDepsRaw.map((dep) => {
          const depId = String(dep);
          return depId.includes('.') ? depId : `${tid}.${depId}`;
        });

        const deps = [...taskDeps, ...stDepsNorm].filter((dep) => !completedIds.has(dep));

        subtasks.push({
          id: fullId,
          parentId: parentTask.id,
          parentObjective: parentTask.objective,
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

      // 内部 barrier 节点
      if (!isSatisfied(taskStatus)) {
        this.recordOriginalStatus(tid, taskStatus);
        subtasks.push({
          id: tid,
          parentId: parentTask.id,
          parentObjective: parentTask.objective,
          objective: `【内部】完成任务: ${t.title}`.trim(),
          constraints: [`barrier: ${t.title}`],
          dependencies: [...taskDeps, ...executableChildIds].filter((dep) => !completedIds.has(dep)),
          status: 'pending',
          priority,
          requiredCapabilities: ['internal:barrier'],
        });
      }
    }

    return subtasks;
  }

  /**
   * 记录原始状态
   */
  private recordOriginalStatus(id: string, status: TaskMasterTaskStatus): void {
    if (this.originalStatuses[id] === undefined) {
      this.originalStatuses[id] = status;
    }
  }

  /**
   * 构建拓扑排序执行计划
   */
  private buildExecutionPlan(subtasks: SubTask[]): ExecutionPlan {
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
        if (!byId.has(dep)) continue;
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

    // 检测环
    const hasCycle = visited.size !== subtasks.length;
    if (hasCycle) {
      const serialOrder = subtasks.map((st) => st.id);
      return {
        steps: serialOrder.map((id, idx) => ({
          order: idx + 1,
          subtaskIds: [id],
          parallel: false,
        })),
        isParallel: false,
      };
    }

    return {
      steps,
      isParallel: steps.some((s) => s.parallel),
    };
  }

  /**
   * 简化的角色推理（默认使用 generalist）
   */
  private async inferRoles(
    _task: OrchestratorTask,
    subtasks: SubTask[],
    taskmetaV1: ReturnType<typeof ensureTaskmetaV1>,
    roleDefsFromMeta: PlannerRole[],
    effectiveTag: string
  ): Promise<{
    roles: PlannerRole[];
    updatedSubtasks: SubTask[];
    tokensUsed: { input: number; output: number };
    retryCount: number;
    dirty: boolean;
  }> {
    const isBarrier = (st: SubTask): boolean =>
      Array.isArray(st.requiredCapabilities) && st.requiredCapabilities.includes('internal:barrier');
    const roleTargets = subtasks.filter((st) => !isBarrier(st));

    let dirty = false;
    const roleIdsUsed = new Set<string>();

    for (const st of roleTargets) {
      const a = getRoleAssignmentFromTaskmeta(taskmetaV1, effectiveTag, st.id);
      const roleId = a?.roleId && typeof a.roleId === 'string' && a.roleId.trim() ? a.roleId.trim() : 'generalist';
      const stableCap = `role:${roleId}`;

      st.roleId = roleId;
      st.requiredCapabilities = Array.from(new Set([stableCap, ...(st.requiredCapabilities ?? [])]));
      roleIdsUsed.add(roleId);

      if (!a?.roleId) {
        const upserted = upsertRoleAssignment(taskmetaV1, effectiveTag, st.id, {
          roleId,
          requiredCapabilities: st.requiredCapabilities,
        });
        dirty = dirty || upserted.changed;
      }
    }

    const allRoleIds = Array.from(roleIdsUsed).sort();
    if (allRoleIds.length === 0) allRoleIds.push('generalist');

    const defsById = new Map(roleDefsFromMeta.map((r) => [r.id, r] as const));
    const roles: PlannerRole[] = allRoleIds.map((roleId) => {
      const fromMeta = defsById.get(roleId);
      if (fromMeta) {
        const caps = Array.isArray(fromMeta.capabilities) ? fromMeta.capabilities : [];
        return {
          id: roleId,
          name: fromMeta.name || roleId,
          responsibilities: fromMeta.responsibilities ?? '',
          capabilities: Array.from(new Set([`role:${roleId}`, ...caps])),
        };
      }

      return {
        id: roleId,
        name: roleId === 'generalist' ? '通用执行者' : roleId,
        responsibilities: roleId === 'generalist' ? '根据 tasks.json 的任务描述执行实现与验证工作' : '',
        capabilities: [`role:${roleId}`],
      };
    });

    return {
      roles,
      updatedSubtasks: subtasks,
      tokensUsed: { input: 0, output: 0 },
      retryCount: 0,
      dirty,
    };
  }
}

/**
 * 创建 TaskMaster 规划引擎
 */
export function createTaskMasterPlanEngine(deps: TaskMasterPlanEngineDeps): TaskMasterPlanEngine {
  return new TaskMasterPlanEngine(deps);
}
