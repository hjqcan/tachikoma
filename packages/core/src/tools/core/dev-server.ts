/**
 * dev_server tool
 *
 * Manages long-running development servers (start/stop/status) to avoid shell tool timeouts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { mergeEnv } from '../env-utils';

// =============================================================================
// 类型定义
// =============================================================================

interface DevServerInput {
  /** 操作类型 */
  action: 'start' | 'stop' | 'status';
  /** 启动命令 (action=start 时必填) */
  command?: string;
  /** 端口号 */
  port?: number;
  /** 健康检查 URL */
  healthUrl?: string;
  /** 健康检查超时 (ms)，默认 60000 */
  healthTimeout?: number;
  /** 健康检查间隔 (ms)，默认 1000 */
  healthInterval?: number;
  /** 服务器 ID (用于 stop/status)，默认使用 port */
  serverId?: string;
  /** 工作目录（相对于 context.workDir） */
  cwd?: string;
}

interface DevServerOutput {
  /** 服务器是否正在运行 */
  running: boolean;
  /** 进程 ID */
  pid?: number | undefined;
  /** 端口号 */
  port?: number | undefined;
  /** 访问 URL */
  url?: string | undefined;
  /** 服务器 ID */
  serverId?: string | undefined;
  /** 错误信息 */
  error?: string | undefined;
  /** 启动日志（前 500 字符） */
  startupLog?: string | undefined;
}

interface ServerInstance {
  process: ChildProcess;
  port: number;
  url: string;
  command: string;
  startedAt: number;
  logs: string[];
  taskId: string;
  agentId: string;
}

// =============================================================================
// 全局服务器实例管理
// =============================================================================

const runningServers = new Map<string, ServerInstance>();

/**
 * 生成服务器 ID
 */
function getServerId(input: DevServerInput): string {
  return input.serverId || `server-${input.port || 'default'}`;
}

/**
 * 健康检查
 */
async function waitForHealth(
  url: string,
  timeout: number,
  interval: number
): Promise<{ healthy: boolean; error?: string }> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      
      if (response.ok || response.status < 500) {
        return { healthy: true };
      }
    } catch {
      // 继续等待
    }
    
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  
  return {
    healthy: false,
    error: `Health check failed: ${url} did not respond within ${timeout}ms`,
  };
}

/**
 * 跨平台进程组终止
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 taskkill 终止进程树
      spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { detached: true });
    } else {
      // Unix: 使用负 PID 终止进程组
      process.kill(-pid, signal);
    }
  } catch {
    // 进程可能已经退出
  }
}

/**
 * 启动服务器
 */
async function startServer(
  input: DevServerInput,
  context: ExecutionContext
): Promise<ToolResult<DevServerOutput>> {
  const {
    command,
    port = 3000,
    healthUrl,
    healthTimeout = 60000,
    healthInterval = 1000,
    cwd,
  } = input;

  if (!command) {
    return {
      success: false,
      error: 'command is required for action=start',
    };
  }

  const serverId = getServerId(input);

  // 检查是否已有同 ID 的服务器在运行
  const existing = runningServers.get(serverId);
  if (existing && !existing.process.killed) {
    return {
      success: true,
      data: {
        running: true,
        pid: existing.process.pid,
        port: existing.port,
        url: existing.url,
        serverId,
        startupLog: 'Server already running',
      },
    };
  }

  // 确定工作目录
  const workingDir = cwd ? validatePath(cwd, context.workDir) : context.workDir;

  // 启动进程（跨平台支持）
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
  
  const child = spawn(shell, shellArgs, {
    cwd: workingDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: mergeEnv(context),
  });

  const logs: string[] = [];
  
  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString();
    logs.push(line);
    // 保留最近 50 行日志
    if (logs.length > 50) logs.shift();
  });

  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    logs.push(`[stderr] ${line}`);
    if (logs.length > 50) logs.shift();
  });

  const url = healthUrl || `http://localhost:${port}`;
  
  // 记录服务器实例
  const instance: ServerInstance = {
    process: child,
    port,
    url,
    command,
    startedAt: Date.now(),
    logs,
    taskId: context.taskId,
    agentId: context.agentId,
  };
  runningServers.set(serverId, instance);

  // 进程退出时清理
  child.on('exit', () => {
    const current = runningServers.get(serverId);
    if (current?.process === child) {
      runningServers.delete(serverId);
    }
  });

  // 健康检查
  const healthResult = await waitForHealth(url, healthTimeout, healthInterval);

  if (!healthResult.healthy) {
    // 健康检查失败，停止服务器以避免资源泄漏
    if (child.pid && !child.killed) {
      killProcessGroup(child.pid, 'SIGKILL');
    }
    runningServers.delete(serverId);
    
    return {
      success: false,
      data: {
        running: false,
        pid: undefined,
        port,
        url,
        serverId,
        startupLog: logs.join('').slice(0, 500),
      },
      error: healthResult.error ?? 'Health check failed, server stopped',
    };
  }

  return {
    success: true,
    data: {
      running: true,
      pid: child.pid,
      port,
      url,
      serverId,
      startupLog: logs.join('').slice(0, 500),
    },
  };
}

/**
 * 停止服务器
 */
async function stopServer(input: DevServerInput): Promise<ToolResult<DevServerOutput>> {
  const serverId = getServerId(input);
  const instance = runningServers.get(serverId);

  if (!instance) {
    return {
      success: true,
      data: {
        running: false,
        serverId,
      },
    };
  }

  try {
    // 先尝试 SIGTERM
    if (instance.process.pid) {
      killProcessGroup(instance.process.pid, 'SIGTERM');
    }

    // 等待 3 秒后强制 SIGKILL
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    if (!instance.process.killed && instance.process.pid) {
      killProcessGroup(instance.process.pid, 'SIGKILL');
    }
  } catch {
    // 进程可能已经退出
  }

  runningServers.delete(serverId);

  return {
    success: true,
    data: {
      running: false,
      serverId,
    },
  };
}

/**
 * 检查服务器状态
 */
function getServerStatus(input: DevServerInput): ToolResult<DevServerOutput> {
  const serverId = getServerId(input);
  const instance = runningServers.get(serverId);

  if (!instance || instance.process.killed) {
    return {
      success: true,
      data: {
        running: false,
        serverId,
      },
    };
  }

  return {
    success: true,
    data: {
      running: true,
      pid: instance.process.pid,
      port: instance.port,
      url: instance.url,
      serverId,
      startupLog: instance.logs.join('').slice(-500),
    },
  };
}

// =============================================================================
// 工具定义
// =============================================================================

export const devServerTool: Tool = {
  name: 'dev_server',
  title: 'Development Server Manager',
  description: `Manage a long-running development server (start/stop/status).

Use this when you need to run a dev server like "npm run dev" without hitting shell tool timeouts.

Actions:
- start: start the server and wait for a health check (command required)
- stop: stop a server by serverId (defaults to port-derived id)
- status: get current server status

Returns pid/url and a short startup log preview.`,

  // isCommandBased 已移除：此工具通过进程内 spawn() 执行，
  // 不走 sandbox.runCommand，避免语义混淆。
  
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status'],
        description: 'Action to perform',
      },
      command: {
        type: 'string',
        description: 'Command to start the server (required for action=start)',
      },
      port: {
        type: 'number',
        description: 'Port number (default 3000)',
      },
      healthUrl: {
        type: 'string',
        description: 'Health check URL (default http://localhost:{port})',
      },
      healthTimeout: {
        type: 'number',
        description: 'Health check timeout in ms (default 60000)',
      },
      healthInterval: {
        type: 'number',
        description: 'Health check interval in ms (default 1000)',
      },
      serverId: {
        type: 'string',
        description: 'Server id (used for stop/status)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (relative to context.workDir)',
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
          running: { type: 'boolean' },
          pid: { type: 'number' },
          port: { type: 'number' },
          url: { type: 'string' },
          serverId: { type: 'string' },
          startupLog: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
  },

  // 权限对齐到现有体系
  permissions: ['process:spawn', 'network:listen', 'fs:read'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Shell,

  // 危险命令提示：此工具可执行任意 shell 命令，依赖上层关键决策审批机制
  annotations: {
    audience: ['assistant'],
    priority: 0.7,
    idempotent: false,
    estimatedDuration: 60000,
  },

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<DevServerOutput>> {
    const typedInput = input as DevServerInput;

    // 确保工作目录存在
    const workDirCheck = await ensureWorkDir(context.workDir);
    if (!workDirCheck.valid) {
      return {
        success: false,
        error: workDirCheck.error ?? 'Unknown workDir error',
      };
    }

    switch (typedInput.action) {
      case 'start':
        return startServer(typedInput, context);
      case 'stop':
        return stopServer(typedInput);
      case 'status':
        return getServerStatus(typedInput);
      default:
        return {
          success: false,
          error: `Unknown action: ${typedInput.action}`,
        };
    }
  },
};

/**
 * 清理所有运行中的服务器（用于进程退出时）
 */
export function cleanupAllServers(): void {
  for (const [serverId, instance] of runningServers.entries()) {
    if (instance.process.pid && !instance.process.killed) {
      killProcessGroup(instance.process.pid, 'SIGKILL');
    }
    runningServers.delete(serverId);
  }
}

export function cleanupServersForTask(taskId: string): void {
  for (const [serverId, instance] of runningServers.entries()) {
    if (instance.taskId !== taskId) continue;
    if (instance.process.pid && !instance.process.killed) {
      killProcessGroup(instance.process.pid, 'SIGKILL');
    }
    runningServers.delete(serverId);
  }
}

/**
 * 重置服务器状态（用于测试）
 */
export function resetServerState(): void {
  cleanupAllServers();
}
