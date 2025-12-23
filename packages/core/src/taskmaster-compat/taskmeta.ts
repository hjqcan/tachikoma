/**
 * Tachikoma 专属元数据文件：`tachikoma.taskmeta.json`
 *
 * 目的：
 * - roles/capabilities 映射不污染 Task Master 的 `tasks.json`
 * - 可选：记录 tasks.json 引用（path/tag）与执行偏好
 *
 * 注意：该文件不要求 1:1 对齐 Task Master；只要不向 tasks.json 写入额外字段即可。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../orchestrator/session/utils';

export const TASKMETA_FILENAME = 'tachikoma.taskmeta.json';

export interface TaskmetaRoleDefinition {
  /** role id，例如 "generalist" */
  id: string;
  /** 展示名 */
  name: string;
  /** capabilities，例如 ["role:generalist"] */
  capabilities: string[];
  /** 可选：职责说明 */
  responsibilities?: string;
}

export interface TaskmetaRoleAssignment {
  roleId?: string;
  requiredCapabilities?: string[];
}

export interface TaskmetaFileV1 {
  version: 1;
  tasksJson?: {
    path?: string;
    tag?: string;
  };
  roles?: {
    byId?: Record<string, Omit<TaskmetaRoleDefinition, 'id'>>;
    assignments?: Record<string, Record<string, TaskmetaRoleAssignment>>;
  };
  execution?: {
    failureWriteback?: 'keep-status';
    allowRefinement?: boolean;
  };
}

export type TaskmetaFile = TaskmetaFileV1;

export function getTaskmetaPath(projectRoot: string): string {
  return path.join(projectRoot, TASKMETA_FILENAME);
}

export async function readTaskmeta(projectRoot: string): Promise<TaskmetaFile | null> {
  const p = getTaskmetaPath(projectRoot);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, 'utf-8');
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== 'object') return null;
  const v = (data as any).version;
  if (v !== 1) return null;
  return data as TaskmetaFileV1;
}

export async function writeTaskmeta(projectRoot: string, data: TaskmetaFile): Promise<void> {
  const p = getTaskmetaPath(projectRoot);
  await atomicWriteFile(p, JSON.stringify(data, null, 2));
}

export function getRoleDefinitionsFromTaskmeta(taskmeta: TaskmetaFile | null): TaskmetaRoleDefinition[] {
  const byId = taskmeta?.roles?.byId ?? {};
  const out: TaskmetaRoleDefinition[] = [];
  for (const [id, def] of Object.entries(byId)) {
    if (!def || typeof def !== 'object') continue;
    const name = typeof (def as any).name === 'string' ? (def as any).name : id;
    const capsRaw = (def as any).capabilities;
    const capabilities = Array.isArray(capsRaw) ? capsRaw.map(String) : [];
    const responsibilities =
      typeof (def as any).responsibilities === 'string' ? (def as any).responsibilities : undefined;
    out.push({ id, name, capabilities, ...(responsibilities ? { responsibilities } : {}) });
  }
  return out;
}

export function getRoleAssignmentFromTaskmeta(
  taskmeta: TaskmetaFile | null,
  tag: string,
  id: string
): TaskmetaRoleAssignment | null {
  const assignments = taskmeta?.roles?.assignments ?? {};
  const scoped = assignments[tag] ?? assignments['master'] ?? null;
  if (!scoped) return null;
  const v = scoped[id];
  if (!v || typeof v !== 'object') return null;
  const roleId = typeof (v as any).roleId === 'string' ? (v as any).roleId : undefined;
  const capsRaw = (v as any).requiredCapabilities;
  const requiredCapabilities = Array.isArray(capsRaw) ? capsRaw.map(String) : undefined;
  return { ...(roleId ? { roleId } : {}), ...(requiredCapabilities ? { requiredCapabilities } : {}) };
}

/**
 * 确保 taskmeta 存在且为 v1（不存在时创建空的 v1）
 *
 * 注意：返回对象会被调用方直接修改并写回。
 */
export function ensureTaskmetaV1(taskmeta: TaskmetaFile | null): TaskmetaFileV1 {
  if (taskmeta?.version === 1) return taskmeta;
  return { version: 1 };
}

/**
 * 确保 roles.byId 至少包含传入的默认角色定义（不会覆盖已有定义）
 */
export function ensureRoleDefinitions(
  taskmeta: TaskmetaFileV1,
  defaults: TaskmetaRoleDefinition[]
): { changed: boolean } {
  let changed = false;
  taskmeta.roles ??= {};
  taskmeta.roles.byId ??= {};

  for (const def of defaults) {
    if (!def?.id) continue;
    if (taskmeta.roles.byId[def.id]) continue;

    taskmeta.roles.byId[def.id] = {
      name: def.name,
      capabilities: Array.isArray(def.capabilities) ? def.capabilities : [],
      ...(typeof def.responsibilities === 'string' && def.responsibilities
        ? { responsibilities: def.responsibilities }
        : {}),
    };
    changed = true;
  }

  return { changed };
}

/**
 * 为指定 tag 的指定 task/subtask id 写入 role 映射（只补齐缺失字段，不覆盖已有值）
 */
export function upsertRoleAssignment(
  taskmeta: TaskmetaFileV1,
  tag: string,
  id: string,
  assignment: TaskmetaRoleAssignment
): { changed: boolean } {
  if (!tag || !id) return { changed: false };

  taskmeta.roles ??= {};
  taskmeta.roles.assignments ??= {};
  const scoped = taskmeta.roles.assignments[tag] ?? (taskmeta.roles.assignments[tag] = {});
  const existing = scoped[id];

  // 若不存在，直接写入
  if (!existing || typeof existing !== 'object') {
    scoped[id] = {
      ...(assignment.roleId ? { roleId: assignment.roleId } : {}),
      ...(Array.isArray(assignment.requiredCapabilities) && assignment.requiredCapabilities.length > 0
        ? { requiredCapabilities: assignment.requiredCapabilities }
        : {}),
    };
    return { changed: true };
  }

  // 否则仅补齐缺失字段
  let changed = false;
  if (!('roleId' in existing) && assignment.roleId) {
    (existing as any).roleId = assignment.roleId;
    changed = true;
  }
  if (
    !('requiredCapabilities' in existing) &&
    Array.isArray(assignment.requiredCapabilities) &&
    assignment.requiredCapabilities.length > 0
  ) {
    (existing as any).requiredCapabilities = assignment.requiredCapabilities;
    changed = true;
  }

  return { changed };
}


