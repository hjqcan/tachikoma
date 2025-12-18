/**
 * Task Manager Tool
 *
 * 管理项目任务列表 (tasks.md)
 * 支持：读取下一个任务、标记任务完成、添加新任务
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';
import { validatePath, ensureWorkDir } from './utils';

// =============================================================================
// 类型定义
// =============================================================================

export interface TaskItem {
  id: number;
  line: number;
  status: 'pending' | 'completed' | 'in_progress';
  title: string;
  description: string;
}

export interface TaskManagerInput {
  /** 任务文件路径 (默认 tasks.md) */
  taskFile?: string;
  /** 操作类型 */
  action: 'read_next' | 'mark_complete' | 'list_all' | 'add_task';
  /** 任务 ID (用于 mark_complete) */
  taskId?: number;
  /** 任务内容 (用于 add_task) */
  taskContent?: string;
}

export interface TaskManagerOutput {
  action: string;
  task?: TaskItem;
  tasks?: TaskItem[];
  message: string;
}

// =============================================================================
// 工具定义
// =============================================================================

export const taskManagerTool: Tool = {
  name: 'task_manager',
  title: 'Task Manager',
  description: 'Manage project tasks in tasks.md. Retrieve next pending task or update status.',
  
  category: ToolCategory.Agent,
  layer: ToolLayer.Atomic,
  permissions: [ToolPermission.FileSystemRead, ToolPermission.FileSystemWrite],
  
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read_next', 'mark_complete', 'list_all', 'add_task'],
        description: 'Action to perform',
      },
      taskFile: {
        type: 'string',
        description: 'Path to tasks.md input file (default: specs/tasks.md or tasks.md)',
      },
      taskId: {
        type: 'number',
        description: 'Task ID (line index) for mark_complete',
      },
      taskContent: {
        type: 'string',
        description: 'Content for new task (add_task only)',
      },
    },
    required: ['action'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          task: { type: 'object' },
          tasks: { type: 'array' },
          message: { type: 'string' },
        },
      },
    },
  },

  execute: async (input: unknown, context: ExecutionContext): Promise<ToolResult<TaskManagerOutput>> => {
    const {
      action,
      taskFile: inputTaskFile,
      taskId,
      taskContent
    } = input as TaskManagerInput;

    // 1. 确定文件路径
    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) return { success: false, error: workDirCheck.error ?? 'Invalid workDir' };

    let filePath = inputTaskFile;
    if (!filePath) {
      // 自动查找
      const candidates = ['specs/tasks.md', 'tasks.md'];
      for (const c of candidates) {
        if (existsSync(join(context.workDir, c))) {
          filePath = c;
          break;
        }
      }
    }
    
    if (!filePath) {
      // 如果是添加任务且文件不存在，默认创建 specs/tasks.md
      if (action === 'add_task') {
        filePath = 'specs/tasks.md';
      } else {
        return { success: false, error: 'tasks.md not found. Generate it first using research_to_spec.' };
      }
    }

    const fullPath = validatePath(filePath, context.workDir);
    
    // 2. 读取/初始化文件
    let content = '';
    if (existsSync(fullPath)) {
      content = await readFile(fullPath, 'utf-8');
    }

    const lines = content.split('\n');
    const tasks: TaskItem[] = [];

    // 3. 解析任务 (简单的 Markdown Checklist 解析)
    // 格式: - [ ] Task Name: Description
    // 或者: - [x] ...
    const taskRegex = /^(\s*)-\s*\[([ xX/])\]\s*(.*)$/;

    lines.forEach((line, index) => {
      const match = line.match(taskRegex);
      if (match) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_full, _indent, mark, text] = match;
        const taskText: string = text || '';
        const status = mark === ' ' ? 'pending' : (mark === '/' ? 'in_progress' : 'completed');
        tasks.push({
          id: index + 1, // 使用行号作为 ID (1-based)
          line: index,
          status,
          title: (taskText.split(':')[0] ?? '').trim(),
          description: taskText.substring(taskText.indexOf(':') + 1).trim() || taskText,
        });
      }
    });

    // 4. 执行动作
    switch (action) {
      case 'read_next': {
        const nextTask = tasks.find(t => t.status === 'pending');
        if (!nextTask) {
          return {
            success: true,
            data: {
              action,
              message: 'No pending tasks found. All done!',
            },
          };
        }
        return {
          success: true,
          data: {
            action,
            task: nextTask,
            message: `Next task: ${nextTask.title}`,
          },
        };
      }

      case 'list_all': {
        return {
          success: true,
          data: {
            action,
            tasks,
            message: `Found ${tasks.length} tasks (${tasks.filter(t => t.status === 'completed').length} completed)`,
          },
        };
      }

      case 'mark_complete': {
        if (!taskId) return { success: false, error: 'taskId is required for mark_complete' };
        
        const taskIndex = tasks.findIndex(t => t.id === taskId);
        if (taskIndex === -1) return { success: false, error: `Task ID ${taskId} not found` };
        
        const task = tasks[taskIndex];
        if (!task) return { success: false, error: `Task not found (index mismatch) at ${taskIndex}` };

        const lineIdx = task.line;
        
        // 更新行内容: [ ] -> [x]
        const originalLine = lines[lineIdx];
        if (originalLine === undefined) {
          return { success: false, error: `Lines out of sync at ${lineIdx}` };
        }

        lines[lineIdx] = originalLine.replace('[ ]', '[x]').replace('[/]', '[x]');
        
        await writeFile(fullPath, lines.join('\n'), 'utf-8');
        
        return {
          success: true,
          data: {
            action,
            task: { ...task, status: 'completed' },
            message: `Task ${taskId} marked as completed`,
          },
        };
      }
      
      case 'add_task': {
        if (!taskContent) return { success: false, error: 'taskContent is required for add_task' };
        
        const newLine = `- [ ] ${taskContent}`;
        // 添加到文件末尾，或者找到最后一个任务之后
        // 简单起见，追加到末尾
        if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') {
          lines.push('');
        }
        lines.push(newLine);
        
        await writeFile(fullPath, lines.join('\n'), 'utf-8');
        
        return {
          success: true,
          data: {
            action,
            message: 'Task added successfully',
          },
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};
