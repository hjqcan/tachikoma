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
  ensureRoleDefinitions,
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

    // 角色推理（父任务级别 + 子任务继承）：
    // - 每个父任务（root taskId）只允许一个 role
    // - 所有子任务继承父任务 role（用户确认）
    const { roles, updatedSubtasks, tokensUsed, retryCount, dirty } = await this.inferRoles(
      task,
      read.tasks,
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

      // Check if we should force sequential execution for inter-dependent tasks
      const forceSequential = this.shouldForceSequentialExecution(layer, byId);

      steps.push({
        order: steps.length + 1,
        subtaskIds: layer,
        parallel: layer.length > 1 && !forceSequential,
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
   * Detect if subtasks in the same layer should be forced to run sequentially.
   *
   * Heuristic: If multiple subtasks involve creating React components, hooks, stores,
   * or other inter-dependent frontend modules, they likely import from each other.
   * Running them in parallel causes "Cannot find name" errors.
   *
   * @param subtaskIds - IDs of subtasks in the same execution layer
   * @param subtaskMap - Map of subtask ID to SubTask object
   * @returns true if sequential execution should be forced
   */
  private shouldForceSequentialExecution(
    subtaskIds: string[],
    subtaskMap: Map<string, SubTask>
  ): boolean {
    if (subtaskIds.length < 2) return false;

    // Patterns that indicate React/frontend component creation
    const componentPatterns = [
      /\.(tsx|jsx)\b/i,              // File extensions
      /\bcomponent\b/i,              // "Create component"
      /创建.*组件/i,                  // Chinese: "Create component"
      /实现.*组件/i,                  // Chinese: "Implement component"
      /\bstore\b/i,                  // State stores (zustand, redux)
      /\bhook\b/i,                   // Custom hooks
      /\bcontext\b/i,                // React contexts
      /\bprovider\b/i,               // Context providers
      /MainPlayer|AudioPlayer|Playlist|SongList/i, // Common component names
    ];

    let componentTaskCount = 0;
    for (const id of subtaskIds) {
      const subtask = subtaskMap.get(id);
      if (!subtask) continue;

      const objective = subtask.objective ?? '';
      const constraints = (subtask.constraints ?? []).join(' ');
      const text = `${objective} ${constraints}`;

      if (componentPatterns.some(pattern => pattern.test(text))) {
        componentTaskCount++;
      }
    }

    // If 2+ tasks in the same layer are component-related, assume they may import each other
    if (componentTaskCount >= 2) {
      console.info(`[TaskMasterPlanEngine] Forcing sequential execution for ${componentTaskCount} component-related tasks in same layer`);
      return true;
    }

    return false;
  }

  /**
   * 角色推理（父任务级别）并应用继承规则：
   *
   * 规则（用户确认）：
   * - 子任务的角色 = 父任务（root taskId）的角色
   *
   * 实现策略：
   * - 优先读取 taskmeta 中对“父任务 id”的 role assignment
   * - 若缺失，则对“父任务集合”调用 Planner.inferRolesForSubtasks() 推理一次（不会对每个子任务推理）
   * - 将父任务 role 映射应用到所有子任务（1.x）并写回 taskmeta（保持跨 run 稳定）
   */
  private async inferRoles(
    task: OrchestratorTask,
    tasks: TaskMasterTask[],
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

    const normalizeRoleId = (raw: string): string => {
      const s = raw.trim().toLowerCase();
      const normalized = s
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || 'generalist';
    };

    const getRootTaskId = (id: string): string => {
      const root = String(id).split('.')[0];
      return root && root.length > 0 ? root : String(id);
    };

    let dirty = false;
    const roleIdsUsed = new Set<string>();

    // 收集本轮涉及的父任务集合（root taskId）
    const activeRootIds = new Set<string>();
    for (const st of roleTargets) {
      activeRootIds.add(getRootTaskId(st.id));
    }
    // barrier 节点也能带来 rootId（例如某些场景没有可执行子任务，但仍需要 role）
    for (const st of subtasks) {
      activeRootIds.add(getRootTaskId(st.id));
    }

    const tasksById = new Map<string, TaskMasterTask>();
    for (const t of tasks) {
      tasksById.set(String(t.id), t);
    }

    // 父任务 -> roleId（本轮确定）
    const rootRoleId = new Map<string, string>();

    // 先从 taskmeta 读取已存在的父任务 role 映射，作为 fixedAssignments
    const fixedAssignments: Record<string, { roleId: string }> = {};
    for (const rootId of activeRootIds) {
      const existing = getRoleAssignmentFromTaskmeta(taskmetaV1, effectiveTag, rootId);
      if (existing?.roleId && typeof existing.roleId === 'string' && existing.roleId.trim()) {
        const roleId = normalizeRoleId(existing.roleId);
        fixedAssignments[rootId] = { roleId };
        rootRoleId.set(rootId, roleId);
        roleIdsUsed.add(roleId);
      }
    }

    const rootSubtasksForInference: Array<{ id: string; objective: string; constraints?: string[] }> = [];
    for (const rootId of Array.from(activeRootIds).sort()) {
      const t = tasksById.get(rootId);
      // 仅对能从 tasks.json 找到的父任务做推理输入；找不到的（例如异常 id）后续走默认兜底
      if (!t) continue;
      const title = String(t.title ?? '').trim();
      const description = String(t.description ?? '').trim();
      const objective = `${title}${title && description ? ': ' : ''}${description}`.trim() || `Task ${rootId}`;
      const constraints: string[] = [];
      if (t.details) constraints.push(`details: ${String(t.details)}`);
      if (t.testStrategy) constraints.push(`testStrategy: ${String(t.testStrategy)}`);
      rootSubtasksForInference.push({ id: rootId, objective, ...(constraints.length > 0 ? { constraints } : {}) });
    }

    // 如果存在未分配 role 的父任务，则对父任务集合做一次 LLM 推理
    const needsInference = rootSubtasksForInference.some((s) => !(s.id in fixedAssignments));

    let inferredRoles: PlannerRole[] = [];
    let inferredAssignments: Record<string, { roleId: string; requiredCapabilities?: string[] }> = {};
    let tokensUsed = { input: 0, output: 0 };
    let retryCount = 0;

    if (needsInference && rootSubtasksForInference.length > 0) {
      const infer = await this.deps.planner.inferRolesForSubtasks({
        task,
        subtasks: rootSubtasksForInference,
        ...(Object.keys(fixedAssignments).length > 0 ? { fixedAssignments } : {}),
      });

      tokensUsed = infer.tokensUsed;
      retryCount = infer.retryCount;

      if (infer.success && infer.roles && infer.roleAssignments) {
        inferredRoles = infer.roles;
        inferredAssignments = infer.roleAssignments;
      } else {
        // 推理失败：保底 generalist（不阻断执行）
        for (const s of rootSubtasksForInference) {
          if (!(s.id in fixedAssignments)) {
            inferredAssignments[s.id] = { roleId: 'generalist', requiredCapabilities: ['role:generalist'] };
          }
        }
      }
    }

    // 确保 taskmeta.roles.byId 至少包含已用/推理出的角色定义（不会覆盖已有定义）
    const defaults = [
      { id: 'generalist', name: '通用执行者', responsibilities: '根据 tasks.json 的任务描述执行实现与验证工作', capabilities: ['role:generalist'] },
      ...inferredRoles.map((r) => ({
        id: normalizeRoleId(r.id),
        name: r.name,
        responsibilities: r.responsibilities ?? '',
        capabilities: Array.from(new Set([...(Array.isArray(r.capabilities) ? r.capabilities : []), `role:${normalizeRoleId(r.id)}`])),
      })),
    ];
    const ensured = ensureRoleDefinitions(taskmetaV1, defaults);
    if (ensured.changed) dirty = true;

    // 写入/修正父任务 roleAssignments，并构建 rootRoleId 映射
    taskmetaV1.roles ??= {};
    taskmetaV1.roles.assignments ??= {};
    const scoped = taskmetaV1.roles.assignments[effectiveTag] ?? (taskmetaV1.roles.assignments[effectiveTag] = {});

    const setAssignment = (id: string, roleId: string, caps: string[]): void => {
      const next = { roleId, requiredCapabilities: caps };
      const prev = scoped[id] as { roleId?: unknown; requiredCapabilities?: unknown } | undefined;
      const prevRoleId = prev && typeof prev.roleId === 'string' ? prev.roleId : undefined;
      const prevCapsRaw = prev?.requiredCapabilities;
      const prevCaps = Array.isArray(prevCapsRaw) ? prevCapsRaw.map(String) : undefined;
      const changed =
        prevRoleId !== roleId ||
        (Array.isArray(prevCaps) ? prevCaps.join('|') : '') !== caps.join('|');
      if (changed) {
        scoped[id] = next;
        dirty = true;
      }
    };

    for (const rootId of activeRootIds) {
      if (rootRoleId.has(rootId)) continue;
      const fromInfer = inferredAssignments[rootId];
      const roleId = normalizeRoleId(
        (fromInfer?.roleId && typeof fromInfer.roleId === 'string' && fromInfer.roleId.trim())
          ? fromInfer.roleId
          : 'generalist'
      );
      const stableCap = `role:${roleId}`;
      const caps = Array.from(
        new Set([
          stableCap,
          ...((Array.isArray(fromInfer?.requiredCapabilities) ? fromInfer!.requiredCapabilities! : []).filter(
            (c): c is string => typeof c === 'string' && c.length > 0
          )),
        ])
      );
      rootRoleId.set(rootId, roleId);
      roleIdsUsed.add(roleId);
      setAssignment(rootId, roleId, caps);
    }

    // 子任务继承父任务 role，并写回 taskmeta（保持全量可查询）
    for (const st of roleTargets) {
      const rootId = getRootTaskId(st.id);
      const roleId = rootRoleId.get(rootId) ?? 'generalist';
      const stableCap = `role:${roleId}`;
      st.roleId = roleId;
      st.requiredCapabilities = Array.from(new Set([stableCap, ...(st.requiredCapabilities ?? [])]));
      roleIdsUsed.add(roleId);

      // 强制写回（保证子任务 role == 父任务 role 的不变量；避免旧数据残留导致分歧）
      setAssignment(st.id, roleId, st.requiredCapabilities);
    }

    const allRoleIds = Array.from(roleIdsUsed).sort();
    if (allRoleIds.length === 0) allRoleIds.push('generalist');

    const defsById = new Map(roleDefsFromMeta.map((r) => [r.id, r] as const));
    const inferredById = new Map(inferredRoles.map((r) => [normalizeRoleId(r.id), r] as const));
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

      const fromInfer = inferredById.get(roleId);
      if (fromInfer) {
        const caps = Array.isArray(fromInfer.capabilities) ? fromInfer.capabilities : [];
        return {
          id: roleId,
          name: fromInfer.name || roleId,
          responsibilities: fromInfer.responsibilities ?? '',
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
      tokensUsed,
      retryCount,
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
