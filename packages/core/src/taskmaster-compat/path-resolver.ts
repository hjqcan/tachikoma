/**
 * tasks.json 路径解析（贴合 Task Master 默认约定）
 *
 * 参考：`third_party/claude-task-master/packages/tm-core/src/common/constants/paths.ts`
 * - 标准：`.taskmaster/tasks/tasks.json`
 *
 * 注意：这里不做任何 CLI 迁移/自动创建，仅做“探测 + 默认路径”。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export const TASKMASTER_TASKS_FILE = '.taskmaster/tasks/tasks.json';

export interface ResolveTasksJsonPathOptions {
  projectRoot: string;
  /**
   * 显式指定 tasks.json 路径（相对 projectRoot 或绝对路径）
   * 若提供则优先使用。
   */
  file?: string;
}

export function resolveTasksJsonPath(opts: ResolveTasksJsonPathOptions): string {
  const { projectRoot, file } = opts;

  if (!projectRoot) {
    throw new Error('resolveTasksJsonPath: projectRoot is required');
  }

  if (file) {
    // 始终返回绝对路径，避免上层把“已解析路径”再次拼接导致路径重复
    return path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
  }

  const standard = path.resolve(projectRoot, TASKMASTER_TASKS_FILE);
  if (existsSync(standard)) return standard;

  // 默认写入位置：标准路径（与用户确认的优先级一致）
  return standard;
}


