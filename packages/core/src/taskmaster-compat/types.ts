/**
 * Task Master `tasks.json` 核心类型（1:1 vendoring）
 *
 * 来源：`third_party/claude-task-master/packages/tm-core/src/common/types/index.ts`
 * 目的：在 Tachikoma 内部使用 Task Master 的 `tasks.json` schema 作为唯一任务真相。
 *
 * 注意：这里的类型命名与 Task Master 保持一致（Task/Subtask/TaskStatus...），
 * 使用侧可通过 import alias 避免与 Tachikoma 自身 Task 类型冲突。
 */

// ============================================================================
// Type Literals
// ============================================================================

export type StorageType = 'file' | 'api' | 'auto';

export type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'deferred'
  | 'cancelled'
  | 'blocked'
  | 'review'
  | 'completed';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export type TaskComplexity = 'simple' | 'moderate' | 'complex' | 'very-complex';

// ============================================================================
// AI Metadata Types (Task Master schema)
// ============================================================================

export interface RelevantFile {
  path: string;
  description: string;
  action: 'create' | 'modify' | 'reference';
}

export interface ExistingInfrastructure {
  name: string;
  location: string;
  usage: string;
}

export interface ScopeBoundaries {
  included?: string;
  excluded?: string;
}

export type TaskCategory =
  | 'research'
  | 'design'
  | 'development'
  | 'testing'
  | 'documentation'
  | 'review';

export interface TaskImplementationMetadata {
  relevantFiles?: RelevantFile[];
  codebasePatterns?: string[];
  existingInfrastructure?: ExistingInfrastructure[];
  scopeBoundaries?: ScopeBoundaries;
  implementationApproach?: string;
  technicalConstraints?: string[];
  acceptanceCriteria?: string[];
  skills?: string[];
  category?: TaskCategory;
}

// ============================================================================
// Core Interfaces
// ============================================================================

export interface PlaceholderTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
}

export interface Task extends TaskImplementationMetadata {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[];
  details: string;
  testStrategy: string;
  subtasks: Subtask[];

  createdAt?: string;
  updatedAt?: string;
  effort?: number;
  actualEffort?: number;
  tags?: string[];
  assignee?: string;
  databaseId?: string;
  complexity?: TaskComplexity | number;
  recommendedSubtasks?: number;
  expansionPrompt?: string;
  complexityReasoning?: string;
}

export interface Subtask extends Omit<Task, 'id' | 'subtasks'> {
  id: number | string;
  parentId: string;
  subtasks?: never;
}

export interface TaskMetadata {
  version: string;
  lastModified: string;
  taskCount: number;
  completedCount: number;
  projectName?: string;
  description?: string;
  tags?: string[];
  created?: string;
  updated?: string;
}

export interface TaskCollection {
  tasks: Task[];
  metadata: TaskMetadata;
}

export interface TaskTag {
  name: string;
  tasks: string[];
  metadata: Record<string, any>;
}

// ============================================================================
// Utility Types
// ============================================================================

export type CreateTask = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'subtasks'> & {
  subtasks?: Omit<Subtask, 'id' | 'parentId' | 'createdAt' | 'updatedAt'>[];
};

export type UpdateTask = Partial<Omit<Task, 'id'>> & { id: string };

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  tags?: string[];
  hasSubtasks?: boolean;
  search?: string;
  assignee?: string;
}

export interface TaskSortOptions {
  field: keyof Task;
  direction: 'asc' | 'desc';
}

// ============================================================================
// Type Guards (保持与 Task Master 一致的“有效集合”)
// ============================================================================

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    [
      'pending',
      'in-progress',
      'done',
      'deferred',
      'cancelled',
      'blocked',
      'review'
      // 注意：Task Master 源码里 type 包含 'completed'，但 type-guard 并未包含它（上游确实存在不一致）。
      // 为保持 1:1 行为，这里也不把 'completed' 视为 isTaskStatus 的有效值。
    ].includes(value)
  );
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && ['low', 'medium', 'high', 'critical'].includes(value);
}

export function isTaskComplexity(value: unknown): value is TaskComplexity {
  return (
    typeof value === 'string' && ['simple', 'moderate', 'complex', 'very-complex'].includes(value)
  );
}

export function isTask(obj: unknown): obj is Task {
  if (!obj || typeof obj !== 'object') return false;
  const task = obj as Record<string, unknown>;

  return (
    typeof task.id === 'string' &&
    typeof task.title === 'string' &&
    typeof task.description === 'string' &&
    isTaskStatus(task.status) &&
    isTaskPriority(task.priority) &&
    Array.isArray(task.dependencies) &&
    typeof task.details === 'string' &&
    typeof task.testStrategy === 'string' &&
    Array.isArray(task.subtasks)
  );
}

export function isSubtask(obj: unknown): obj is Subtask {
  if (!obj || typeof obj !== 'object') return false;
  const subtask = obj as Record<string, unknown>;

  return (
    typeof subtask.id === 'number' &&
    typeof subtask.parentId === 'string' &&
    typeof subtask.title === 'string' &&
    typeof subtask.description === 'string' &&
    isTaskStatus(subtask.status) &&
    isTaskPriority(subtask.priority) &&
    !('subtasks' in subtask)
  );
}


