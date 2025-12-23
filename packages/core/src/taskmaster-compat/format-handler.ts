/**
 * tasks.json 格式处理（1:1 vendoring，做最小必要改动以适配 Tachikoma 目录结构）
 *
 * 来源：`third_party/claude-task-master/packages/tm-core/src/modules/storage/adapters/file-storage/format-handler.ts`
 */

import type { Task, TaskMetadata } from './types';

export interface FileStorageData {
  tasks: Task[];
  metadata: TaskMetadata;
}

export type FileFormat = 'legacy' | 'standard';

export class FormatHandler {
  detectFormat(data: any): FileFormat {
    if (!data || typeof data !== 'object') {
      return 'standard';
    }

    const keys = Object.keys(data);
    const hasLegacyFormat = keys.some((key) => key !== 'tasks' && key !== 'metadata');
    return hasLegacyFormat ? 'legacy' : 'standard';
  }

  extractTasks(data: any, tag: string): Task[] {
    if (!data) return [];

    const format = this.detectFormat(data);
    if (format === 'legacy') return this.extractTasksFromLegacy(data, tag);
    return this.extractTasksFromStandard(data);
  }

  private extractTasksFromLegacy(data: any, tag: string): Task[] {
    if (tag in data) {
      const tagData = data[tag];
      return tagData?.tasks || [];
    }

    const availableKeys = Object.keys(data).filter((key) => key !== 'tasks' && key !== 'metadata');
    if (tag === 'master' && availableKeys.length > 0) {
      const firstTag = availableKeys[0];
      const tagData = data[firstTag];
      return tagData?.tasks || [];
    }

    return [];
  }

  private extractTasksFromStandard(data: any): Task[] {
    return data?.tasks || [];
  }

  extractMetadata(data: any, tag: string): TaskMetadata | null {
    if (!data) return null;

    const format = this.detectFormat(data);
    if (format === 'legacy') return this.extractMetadataFromLegacy(data, tag);
    return this.extractMetadataFromStandard(data);
  }

  private extractMetadataFromLegacy(data: any, tag: string): TaskMetadata | null {
    if (tag in data) {
      const tagData = data[tag];
      if (!tagData?.metadata && tagData?.tasks) {
        return this.generateMetadataFromTasks(tagData.tasks, tag);
      }
      return tagData?.metadata || null;
    }

    const availableKeys = Object.keys(data).filter((key) => key !== 'tasks' && key !== 'metadata');
    if (tag === 'master' && availableKeys.length > 0) {
      const firstTag = availableKeys[0];
      const tagData = data[firstTag];
      if (!tagData?.metadata && tagData?.tasks) {
        return this.generateMetadataFromTasks(tagData.tasks, firstTag);
      }
      return tagData?.metadata || null;
    }

    return null;
  }

  private extractMetadataFromStandard(data: any): TaskMetadata | null {
    return data?.metadata || null;
  }

  extractTags(data: any): string[] {
    if (!data) return [];

    const format = this.detectFormat(data);
    if (format === 'legacy') {
      const keys = Object.keys(data);
      return keys.filter((key) => key !== 'tasks' && key !== 'metadata');
    }

    return ['master'];
  }

  /**
   * Normalize task IDs - keep Task IDs as strings, Subtask IDs as numbers
   */
  normalizeTasks(tasks: Task[]): Task[] {
    return tasks.map((task) => ({
      ...task,
      id: String(task.id),
      dependencies: task.dependencies?.map((dep) => String(dep)) || [],
      subtasks:
        task.subtasks?.map((subtask) => ({
          ...subtask,
          // 兼容更深层级的 subtask id（例如 "1.1" 表示 full id "1.1.1"）
          // - 若是带 '.' 的 string：保持 string
          // - 否则：尽量归一为 number；无法转换则保持原 string（避免 NaN -> JSON null）
          id: (() => {
            const raw = subtask.id as unknown;
            if (typeof raw === 'string') {
              const trimmed = raw.trim();
              if (trimmed.includes('.')) return trimmed;
              const n = Number(trimmed);
              return Number.isFinite(n) ? n : trimmed;
            }
            const n = Number(raw as any);
            return Number.isFinite(n) ? n : String(raw);
          })(),
          parentId: String(subtask.parentId),
        })) || [],
    }));
  }

  /**
   * Generate metadata from tasks when not present
   * （与上游一致：completedCount 仅统计 status === 'done'）
   */
  generateMetadataFromTasks(tasks: Task[], tag: string): TaskMetadata {
    return {
      version: '1.0.0',
      lastModified: new Date().toISOString(),
      taskCount: tasks.length,
      completedCount: tasks.filter((t: any) => t.status === 'done').length,
      tags: [tag],
    };
  }
}


