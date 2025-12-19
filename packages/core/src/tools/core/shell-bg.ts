/**
 * shell_bg tool
 *
 * Manage background processes started with shell_run { background: true }
 * Provides list/kill/logs actions similar to Claude Code's /bashes command
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import {
  listBackgroundProcesses,
  killBackgroundProcess,
  getBackgroundProcessOutput,
} from './shell-run';

// =============================================================================
// 类型定义
// =============================================================================

interface ShellBgInput {
  /** Action to perform */
  action: 'list' | 'kill' | 'logs';
  /** Process ID (required for kill and logs) */
  processId?: string;
}

interface ProcessInfo {
  id: string;
  pid: number;
  command: string;
  startedAt: number;
  killed: boolean;
  runningFor: string;
}

interface ShellBgOutput {
  /** List of processes (for action=list) */
  processes?: ProcessInfo[];
  /** Whether kill was successful (for action=kill) */
  killed?: boolean;
  /** Process output logs (for action=logs) */
  logs?: string;
  /** Error message */
  error?: string;
}

// =============================================================================
// 工具实现
// =============================================================================

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export const shellBgTool: Tool = {
  name: 'shell_bg',
  title: 'Manage Background Shell Processes',
  description: `Manage background processes started with shell_run { background: true }.
Scope: current task only.

Actions:
- **list**: List all background processes with their status
- **kill**: Kill a background process by processId
- **logs**: Get buffered output from a background process

Similar to Claude Code's /bashes command.`,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'kill', 'logs'],
        description: 'Action to perform',
      },
      processId: {
        type: 'string',
        description: 'Process ID (required for kill and logs actions)',
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
          processes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                pid: { type: 'number' },
                command: { type: 'string' },
                startedAt: { type: 'number' },
                killed: { type: 'boolean' },
                runningFor: { type: 'string' },
              },
            },
          },
          killed: { type: 'boolean' },
          logs: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
  },

  permissions: ['process:read', 'process:kill'],
  layer: ToolLayer.Atomic,
  category: ToolCategory.Shell,

  annotations: {
    audience: ['assistant'],
    priority: 0.5,
    idempotent: true,
    estimatedDuration: 100,
  },

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<ShellBgOutput>> {
    const { action, processId } = input as ShellBgInput;
    const filter = { taskId: context.taskId };

    switch (action) {
      case 'list': {
        const processes = listBackgroundProcesses(filter);
        const now = Date.now();
        return {
          success: true,
          data: {
            processes: processes.map((p) => ({
              ...p,
              runningFor: formatDuration(now - p.startedAt),
            })),
          },
        };
      }

      case 'kill': {
        if (!processId) {
          return {
            success: false,
            error: 'processId is required for kill action',
          };
        }
        const killed = killBackgroundProcess(processId, filter);
        return {
          success: killed,
          data: { killed },
          ...(killed ? {} : { error: `Process ${processId} not found or already killed` }),
        };
      }

      case 'logs': {
        if (!processId) {
          return {
            success: false,
            error: 'processId is required for logs action',
          };
        }
        const logs = getBackgroundProcessOutput(processId, filter);
        if (logs === null) {
          return {
            success: false,
            error: `Process ${processId} not found`,
          };
        }
        return {
          success: true,
          data: { logs },
        };
      }

      default:
        return {
          success: false,
          error: `Unknown action: ${action}`,
        };
    }
  },
};
