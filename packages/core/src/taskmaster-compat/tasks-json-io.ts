/**
 * Task Master `tasks.json` IO（面向 Tachikoma）
 *
 * 目标：
 * - 读取/写回 Task Master 的 tasks.json（支持 standard / tag 容器）
 * - 只做 schema 内字段的最小更新（status/updatedAt/metadata 计数等）
 * - 不写入 Tachikoma 专属字段
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../orchestrator/session/utils';
import { FormatHandler, type FileFormat } from './format-handler';
import { resolveTasksJsonPath } from './path-resolver';
import type { Task, TaskMetadata, TaskStatus, Subtask } from './types';

export interface TasksJsonRef {
  path: string;
  tag: string;
}

export interface ReadTasksJsonOptions {
  projectRoot: string;
  file?: string;
  tag?: string;
}

export interface ReadTasksJsonResult {
  tasksPath: string;
  format: FileFormat;
  /** 实际读取到的 tag（当请求 master 但文件无 master 时，可能回退到第一个 tag） */
  tag: string;
  /** 原始 JSON（用于写回合并时保留其他 tag/字段） */
  rawData: any;
  tasks: Task[];
  metadata: TaskMetadata;
}

const formatHandler = new FormatHandler();

function resolveTagForRead(rawData: any, requestedTag: string): string {
  const format = formatHandler.detectFormat(rawData);
  // 标准格式（顶层 tasks/metadata）本质只有 master；
  // 但在“session tag 隔离”场景下，我们允许读取非 master tag 时视为“空 tag”，避免误读 master 计划。
  if (format === 'standard') {
    return requestedTag === 'master' ? 'master' : requestedTag;
  }

  if (rawData && typeof rawData === 'object' && requestedTag in rawData) {
    return requestedTag;
  }

  // 与上游 extractTasksFromLegacy 保持一致：master 不存在时回退到第一个 tag
  const tags = formatHandler.extractTags(rawData);
  if (requestedTag === 'master' && tags.length > 0) {
    return tags.at(0) ?? requestedTag;
  }

  return requestedTag;
}

function ensureMetadata(tasks: Task[], maybe: TaskMetadata | null, tag: string): TaskMetadata {
  if (maybe) return maybe;
  return formatHandler.generateMetadataFromTasks(tasks, tag);
}

async function readJsonIfExists(filePath: string): Promise<any | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as any;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTasksJson(opts: ReadTasksJsonOptions): Promise<ReadTasksJsonResult> {
  const tasksPath = resolveTasksJsonPath({
    projectRoot: opts.projectRoot,
    ...(opts.file ? { file: opts.file } : {}),
  });
  const raw = (await readJsonIfExists(tasksPath)) ?? {};

  const requestedTag = opts.tag ?? 'master';
  const resolvedTag = resolveTagForRead(raw, requestedTag);

  const format = formatHandler.detectFormat(raw);
  // 标准格式下读取非 master tag：视为“空 tag”，不返回 master.tasks
  const tasks =
    format === 'standard' && resolvedTag !== 'master'
      ? []
      : formatHandler.extractTasks(raw, resolvedTag);
  const metadata = ensureMetadata(
    tasks,
    format === 'standard' && resolvedTag !== 'master'
      ? null
      : formatHandler.extractMetadata(raw, resolvedTag),
    resolvedTag
  );

  return {
    tasksPath,
    format,
    tag: resolvedTag,
    rawData: raw,
    tasks,
    metadata,
  };
}

export interface WriteTasksJsonOptions {
  projectRoot: string;
  file?: string;
  tag?: string;
  /**
   * 若提供，则以该 rawData 作为写回基底（用于保留其他 tag）。
   * 否则会重新从磁盘读取。
   */
  rawData?: any;
  tasks: Task[];
  metadata?: TaskMetadata;
}

export async function writeTasksJson(opts: WriteTasksJsonOptions): Promise<void> {
  const tasksPath = resolveTasksJsonPath({
    projectRoot: opts.projectRoot,
    ...(opts.file ? { file: opts.file } : {}),
  });
  const resolvedTag = opts.tag ?? 'master';

  // 确保目录存在
  await mkdir(path.dirname(tasksPath), { recursive: true });

  // 读取现有数据（保留其他 tags/字段）
  let existingData = opts.rawData;
  if (!existingData) {
    existingData = (await readJsonIfExists(tasksPath)) ?? {};
  }

  const normalizedTasks = formatHandler.normalizeTasks(opts.tasks);

  const existingFormat = formatHandler.detectFormat(existingData);
  const existingMetadata =
    // 标准格式仅 master 有意义；写入非 master tag 时不要复用 master.metadata（避免 tag 污染）
    existingFormat === 'standard' && resolvedTag !== 'master'
      ? null
      : (formatHandler.extractMetadata(existingData, resolvedTag) as TaskMetadata | null);

  const metadata: TaskMetadata =
    opts.metadata ??
    ({
      ...(existingMetadata ??
        formatHandler.generateMetadataFromTasks(normalizedTasks, resolvedTag)),
      lastModified: new Date().toISOString(),
      taskCount: normalizedTasks.length,
      // 上游 tm-core 的统计口径是 status === 'done'
      completedCount: normalizedTasks.filter((t) => t.status === 'done').length,
      tags: [resolvedTag],
    } as TaskMetadata);

  // === 按 tm-core FileStorage.saveTasks 的行为合并回写（保留其他 tag） ===
  if (
    formatHandler.detectFormat(existingData) === 'legacy' ||
    Object.keys(existingData).some((k) => k !== 'tasks' && k !== 'metadata')
  ) {
    // tag 容器
    existingData[resolvedTag] = {
      tasks: normalizedTasks,
      metadata,
    };
  } else if (resolvedTag === 'master') {
    // standard master
    existingData = {
      tasks: normalizedTasks,
      metadata,
    };
  } else {
    // standard → tag 容器（增加非 master tag 时）
    const masterTasks = existingData.tasks || [];
    const masterMetadata = existingData.metadata || metadata;
    existingData = {
      master: {
        tasks: masterTasks,
        metadata: masterMetadata,
      },
      [resolvedTag]: {
        tasks: normalizedTasks,
        metadata,
      },
    };
  }

  await atomicWriteFile(tasksPath, JSON.stringify(existingData, null, 2));
}

// ============================================================================
// Tag Operations (session 隔离 / 归档)
// ============================================================================

export interface MoveTasksJsonTagOptions {
  projectRoot: string;
  file?: string;
  fromTag: string;
  toTag: string;
}

export async function moveTasksJsonTag(opts: MoveTasksJsonTagOptions): Promise<{ moved: boolean; tasksPath: string }> {
  const tasksPath = resolveTasksJsonPath({
    projectRoot: opts.projectRoot,
    ...(opts.file ? { file: opts.file } : {}),
  });
  const raw = await readJsonIfExists(tasksPath);
  if (!raw || typeof raw !== 'object') {
    return { moved: false, tasksPath };
  }

  const format = formatHandler.detectFormat(raw);
  if (format === 'standard') {
    // 标准格式没有 tag 容器语义；保持保守：不做隐式迁移（避免破坏用户现有 master 文件）。
    return { moved: false, tasksPath };
  }

  // legacy(tag 容器)
  const from = opts.fromTag;
  const to = opts.toTag;
  if (!(from in raw)) {
    return { moved: false, tasksPath };
  }
  if (to in raw) {
    // 避免覆盖已有 archive
    return { moved: false, tasksPath };
  }

  raw[to] = raw[from];
  delete raw[from];

  // best-effort: 修正 metadata.tags/lastModified
  try {
    const tagData = raw[to];
    const tasks: Task[] = Array.isArray(tagData?.tasks) ? tagData.tasks : [];
    const now = new Date().toISOString();
    const nextMetadata: TaskMetadata = {
      ...(tagData?.metadata ?? formatHandler.generateMetadataFromTasks(tasks, to)),
      lastModified: now,
      taskCount: tasks.length,
      completedCount: tasks.filter((t) => t.status === 'done').length,
      tags: [to],
    };
    raw[to] = {
      ...tagData,
      tasks,
      metadata: nextMetadata,
    };
  } catch {
    // ignore
  }

  await atomicWriteFile(tasksPath, JSON.stringify(raw, null, 2));
  return { moved: true, tasksPath };
}

// ============================================================================
// Status Updates (执行期回写)
// ============================================================================

export type TaskOrSubtaskId = string; // task: "1" | subtask: "1.2"

export interface UpdateStatusOptions {
  projectRoot: string;
  file?: string;
  tag?: string;
  /** 用于失败回滚：如果传入，失败时可将 status 恢复为该值 */
  restoreStatus?: TaskStatus;
  /** 是否同时更新 updatedAt（写入 schema 内字段，默认 true） */
  touchUpdatedAt?: boolean;
}

function normalizeStatusForWrite(status: TaskStatus): TaskStatus {
  // 保持原枚举；上游允许 'completed' 但很多逻辑只处理 done/in-progress/pending。
  return status;
}

function autoAdjustParentStatusFromSubtasks(subs: Subtask[], current: TaskStatus): TaskStatus {
  // 参考上游 FileStorage.updateSubtaskStatusInFile：done-like 仅 (done|completed)
  const norm = (s: any): TaskStatus => (s?.status as TaskStatus) || 'pending';
  const isDoneLike = (s: any): boolean => {
    const st = norm(s);
    return st === 'done' || st === 'completed';
  };
  const allDone = subs.length > 0 && subs.every(isDoneLike);
  const anyInProgress = subs.some((s) => norm(s) === 'in-progress');
  const anyDone = subs.some(isDoneLike);
  const allPending = subs.length > 0 && subs.every((s) => norm(s) === 'pending');

  if (allDone) return 'done';
  if (anyInProgress || anyDone) return 'in-progress';
  if (allPending) return 'pending';
  return current;
}

export async function updateTaskOrSubtaskStatus(
  id: TaskOrSubtaskId,
  status: TaskStatus,
  opts: UpdateStatusOptions
): Promise<void> {
  const { tasksPath, tag, rawData, tasks } = await readTasksJson({
    projectRoot: opts.projectRoot,
    ...(opts.file ? { file: opts.file } : {}),
    ...(opts.tag ? { tag: opts.tag } : {}),
  });

  const resolvedTag = tag;
  const touch = opts.touchUpdatedAt !== false;
  const now = new Date().toISOString();

  const nextStatus = normalizeStatusForWrite(status);

  const { taskId, suffix } = splitTaskAndSuffix(id);

  if (!suffix) {
    const idx = tasks.findIndex((t) => String(t.id) === String(id));
    if (idx === -1) return;
    const t = tasks[idx]!;
    tasks[idx] = {
      ...t,
      status: nextStatus,
      ...(touch ? { updatedAt: now } : {}),
    };
    await writeTasksJson({
      projectRoot: opts.projectRoot,
      file: tasksPath,
      tag: resolvedTag,
      rawData,
      tasks,
    });
    return;
  }

  const parentIdx = tasks.findIndex((t) => String(t.id) === String(taskId));
  if (parentIdx === -1) return;
  const parent = tasks[parentIdx]!;

  const stIdx = parent.subtasks.findIndex((st) => String(st.id) === String(suffix));
  if (stIdx === -1) return;

  const updatedSub: Subtask = {
    ...parent.subtasks[stIdx]!,
    status: nextStatus,
    ...(touch ? { updatedAt: now } : {}),
  };

  const nextSubtasks = parent.subtasks.slice();
  nextSubtasks[stIdx] = updatedSub;

  const parentNewStatus = autoAdjustParentStatusFromSubtasks(nextSubtasks, parent.status);

  tasks[parentIdx] = {
    ...parent,
    subtasks: nextSubtasks,
    ...(parentNewStatus !== parent.status ? { status: parentNewStatus } : {}),
    ...(touch ? { updatedAt: now } : {}),
  };

  await writeTasksJson({
    projectRoot: opts.projectRoot,
    file: tasksPath,
    tag: resolvedTag,
    rawData,
    tasks,
  });
}

// ============================================================================
// Dependencies (写回 tasks.json)
// ============================================================================

export interface AddDependencyOptions {
  projectRoot: string;
  file?: string;
  tag?: string;
  /** 是否同时更新 updatedAt / metadata.lastModified（默认 true） */
  touchUpdatedAt?: boolean;
}

/**
 * 为 task 或 subtask 追加依赖（去重，保持 schema 1:1）
 *
 * - dependerId: "1" 或 "1.2"
 * - dependsOnId: "2" 或 "1.1"
 */
export async function addTaskOrSubtaskDependency(
  dependerId: TaskOrSubtaskId,
  dependsOnId: TaskOrSubtaskId,
  opts: AddDependencyOptions
): Promise<void> {
  const depender = String(dependerId);
  const dependency = String(dependsOnId);
  if (!depender || !dependency) return;
  if (depender === dependency) return;

  const { tasksPath, tag, rawData, tasks, metadata } = await readTasksJson({
    projectRoot: opts.projectRoot,
    ...(opts.file ? { file: opts.file } : {}),
    ...(opts.tag ? { tag: opts.tag } : {}),
  });

  const resolvedTag = tag;
  const touch = opts.touchUpdatedAt !== false;
  const now = new Date().toISOString();

  const { taskId, suffix } = splitTaskAndSuffix(depender);

  // === Task dependency ===
  if (!suffix) {
    const idx = tasks.findIndex((t) => String(t.id) === taskId);
    if (idx === -1) return;
    const t = tasks[idx]!;
    const existing = Array.isArray(t.dependencies) ? t.dependencies.map(String) : [];
    const nextDeps = Array.from(new Set([...existing, dependency]));

    tasks[idx] = {
      ...t,
      dependencies: nextDeps,
      ...(touch ? { updatedAt: now } : {}),
    };

    await writeTasksJson({
      projectRoot: opts.projectRoot,
      file: tasksPath,
      tag: resolvedTag,
      rawData,
      tasks,
      metadata: touch ? { ...metadata, lastModified: now } : metadata,
    });
    return;
  }

  // === Subtask dependency ===
  const parentIdx = tasks.findIndex((t) => String(t.id) === String(taskId));
  if (parentIdx === -1) return;
  const parent = tasks[parentIdx]!;
  const stIdx = parent.subtasks.findIndex((st) => String(st.id) === String(suffix));
  if (stIdx === -1) return;

  const st = parent.subtasks[stIdx]!;
  const stExisting = Array.isArray(st.dependencies) ? st.dependencies.map(String) : [];
  const stNextDeps = Array.from(new Set([...stExisting, dependency]));

  const nextSubtasks = parent.subtasks.slice();
  nextSubtasks[stIdx] = {
    ...st,
    dependencies: stNextDeps,
    ...(touch ? { updatedAt: now } : {}),
  };

  tasks[parentIdx] = {
    ...parent,
    subtasks: nextSubtasks,
    ...(touch ? { updatedAt: now } : {}),
  };

  await writeTasksJson({
    projectRoot: opts.projectRoot,
    file: tasksPath,
    tag: resolvedTag,
    rawData,
    tasks,
    metadata: touch ? { ...metadata, lastModified: now } : metadata,
  });
}

// ============================================================================
// Expand (写回 tasks.json)
// ============================================================================

export interface ExpandGeneratedSubtaskSpec {
  title: string;
  description: string;
  details: string;
  testStrategy: string;
  /** 可选：是否允许并行（默认串行由调用方决定），未来可扩展为更细粒度依赖 */
}

export interface ExpandOptions {
  projectRoot: string;
  file?: string;
  tag?: string;
  /** 是否强制替换（若目标已存在 subtasks） */
  force?: boolean;
  /** task-level expand 的默认策略：serial=默认串行，parallel=全部可并行 */
  strategy?: 'serial' | 'parallel';
}

function splitTaskAndSuffix(id: string): { taskId: string; suffix?: string } {
  const parts = String(id).split('.');
  const taskId = parts.at(0) ?? '';
  if (parts.length === 1) return { taskId };
  return { taskId, suffix: parts.slice(1).join('.') };
}

function normalizeSubtaskStatusForExpand(): TaskStatus {
  // expand 生成的新子任务默认 pending
  return 'pending';
}

function buildSubtaskObject(params: {
  id: number | string;
  parentId: string;
  priority: Task['priority'];
  title: string;
  description: string;
  details: string;
  testStrategy: string;
  dependencies: string[];
}): Subtask {
  return {
    id: params.id,
    parentId: params.parentId,
    title: params.title,
    description: params.description,
    status: normalizeSubtaskStatusForExpand(),
    priority: params.priority,
    dependencies: params.dependencies,
    details: params.details,
    testStrategy: params.testStrategy,
  };
}

function rewriteDependencies(
  deps: Array<string | number> | undefined,
  parentTaskId: string,
  replaceFromFullId: string,
  replaceToFullId: string
): string[] {
  const out: string[] = [];
  for (const d of deps ?? []) {
    const raw = String(d);
    const full = raw.includes('.') ? raw : `${parentTaskId}.${raw}`;
    if (full === replaceFromFullId) {
      out.push(replaceToFullId);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/**
 * Expand 一个 task 或 subtask，并把变化写回 tasks.json
 *
 * - task: "1" -> 生成 subtasks: 1,2,3...
 * - subtask: "1.1" -> 不生成 "1.1.1" 深层级；采用“改写为 part1 + 新增兄弟 subtasks + 依赖重写”
 */
export async function expandTaskOrSubtask(
  id: string,
  generated: ExpandGeneratedSubtaskSpec[],
  opts: ExpandOptions
): Promise<void> {
  const read = await readTasksJson({
    projectRoot: opts.projectRoot,
    ...(opts.file ? { file: opts.file } : {}),
    ...(opts.tag ? { tag: opts.tag } : {}),
  });

  const { taskId, suffix } = splitTaskAndSuffix(id);
  const tasks = read.tasks;

  const parentIdx = tasks.findIndex((t) => String(t.id) === String(taskId));
  if (parentIdx === -1) return;

  const parent = tasks[parentIdx]!;
  const parentPriority = parent.priority ?? 'medium';

  const now = new Date().toISOString();

  // === Expand task ===
  if (!suffix) {
    const existingSubs = Array.isArray(parent.subtasks) ? parent.subtasks : [];
    if (existingSubs.length > 0 && !opts.force) {
      return;
    }

    // 生成连续数字 id（从 1 开始；force 则替换）
    const nextSubs: Subtask[] = [];
    for (let i = 0; i < generated.length; i++) {
      const n = i + 1;
      const spec = generated[i]!;
      const strategy = opts.strategy === 'parallel' ? 'parallel' : 'serial';
      const deps =
        strategy === 'parallel'
          ? []
          : n === 1
              ? []
              : [`${String(parent.id)}.${n - 1}`];
      nextSubs.push(
        buildSubtaskObject({
          id: n,
          parentId: String(parent.id),
          priority: parentPriority,
          title: spec.title,
          description: spec.description,
          details: spec.details,
          testStrategy: spec.testStrategy,
          dependencies: deps,
        })
      );
    }

    tasks[parentIdx] = {
      ...parent,
      subtasks: nextSubs,
      ...(parent.updatedAt ? {} : {}),
      updatedAt: now,
    };

    await writeTasksJson({
      projectRoot: opts.projectRoot,
      file: read.tasksPath,
      tag: read.tag,
      rawData: read.rawData,
      tasks,
      metadata: {
        ...read.metadata,
        lastModified: now,
      },
    });
    return;
  }

  // === Expand subtask（不生成 1.1.1：改写 + 新增兄弟 + 依赖重写） ===
  const subs = Array.isArray(parent.subtasks) ? parent.subtasks : [];
  const targetIdx = subs.findIndex((st) => String(st.id) === String(suffix));
  if (targetIdx === -1) return;

  const target = subs[targetIdx]!;

  const targetFullId = `${taskId}.${String(target.id)}`;
  const specs = Array.isArray(generated) ? generated : [];
  if (specs.length === 0) return;

  // 1) 改写 target 为 part1（保持 id 不变）
  const part1 = specs[0]!;
  const rewrittenTarget: Subtask = {
    ...target,
    title: part1.title,
    description: part1.description,
    details: part1.details,
    testStrategy: part1.testStrategy,
    status: normalizeSubtaskStatusForExpand(),
    ...(target.updatedAt ? {} : {}),
    updatedAt: now,
  };

  // 2) 新增兄弟子任务作为后续 part（使用新的数字 id）
  const existingNumericIds = subs
    .map((st) => Number(String(st.id)))
    .filter((n) => Number.isFinite(n));
  let nextId = (existingNumericIds.length > 0 ? Math.max(...existingNumericIds) : subs.length) + 1;

  const created: Subtask[] = [];
  let prevFullId = targetFullId;
  for (let i = 1; i < specs.length; i++) {
    const spec = specs[i]!;
    const idNum = nextId++;
    const fullId = `${taskId}.${idNum}`;
    created.push(
      buildSubtaskObject({
        id: idNum,
        parentId: String(parent.id),
        priority: target.priority ?? parentPriority,
        title: spec.title,
        description: spec.description,
        details: spec.details,
        testStrategy: spec.testStrategy,
        dependencies: [prevFullId],
      })
    );
    prevFullId = fullId;
  }

  const finalFullId = prevFullId; // 若没有新增 part，则仍为 targetFullId

  // 3) 全局依赖重写：把依赖 targetFullId 的下游改为依赖 finalFullId
  const updatedTasks = tasks.map((t) => {
    const tDeps = rewriteDependencies(t.dependencies as any, String(t.id), targetFullId, finalFullId);
    const nextSubtasks = Array.isArray(t.subtasks)
      ? t.subtasks.map((st) => ({
          ...st,
          dependencies: rewriteDependencies(
            (st as any).dependencies as any,
            String(t.id),
            targetFullId,
            finalFullId
          ),
        }))
      : [];

    return {
      ...t,
      dependencies: tDeps,
      subtasks: nextSubtasks,
    };
  });

  // 4) 回写 parent.subtasks：替换 target + 追加 created
  const parentIdx2 = updatedTasks.findIndex((t) => String(t.id) === String(taskId));
  const parent2 = updatedTasks[parentIdx2]!;
  const updatedSubs = Array.isArray(parent2.subtasks) ? parent2.subtasks.slice() : [];
  const targetIdx2 = updatedSubs.findIndex((st) => String(st.id) === String(suffix));
  if (targetIdx2 === -1) return;

  updatedSubs[targetIdx2] = rewrittenTarget;
  updatedSubs.push(...created);

  updatedTasks[parentIdx2] = {
    ...parent2,
    subtasks: updatedSubs,
    updatedAt: now,
  };

  await writeTasksJson({
    projectRoot: opts.projectRoot,
    file: read.tasksPath,
    tag: read.tag,
    rawData: read.rawData,
    tasks: updatedTasks,
    metadata: {
      ...read.metadata,
      lastModified: now,
    },
  });
}


