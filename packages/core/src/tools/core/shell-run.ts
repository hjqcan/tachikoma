/**
 * shell_run 工具
 *
 * 执行 shell 命令，支持输出截断
 */

import { spawn } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { ShellRunInput, ShellRunOutput, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir, truncateOutput, DEFAULT_MAX_OUTPUT } from './utils';
import { mergeEnv } from '../env-utils';
import { shellSessionManager } from './shell-session-manager';

// =============================================================================
// Timeout Configuration (inspired by OpenCode & Codex best practices)
// =============================================================================

/** Minimum timeout to prevent unreasonably short timeouts (5 seconds) */
const MIN_TIMEOUT = 5_000;

/** Default timeout (30 seconds), can be overridden via TACHIKOMA_BASH_TIMEOUT env */
const DEFAULT_TIMEOUT = parseInt(process.env.TACHIKOMA_BASH_TIMEOUT || '', 10) || 30_000;

/**
 * Long-running command patterns with recommended timeouts
 * These commands often require network access or heavy computation
 */
const LONG_RUNNING_COMMANDS: { pattern: RegExp; timeout: number; description: string }[] = [
  // Package managers (5 minutes)
  { pattern: /^(npm|yarn|pnpm|bun)\s+(install|i|add|ci)\b/i, timeout: 300_000, description: 'package install' },
  { pattern: /^pip3?\s+install\b/i, timeout: 300_000, description: 'pip install' },
  { pattern: /^python3?\s+-m\s+pip\s+install\b/i, timeout: 300_000, description: 'python pip install' },
  { pattern: /^gem\s+install\b/i, timeout: 300_000, description: 'gem install' },
  { pattern: /^composer\s+(install|update)\b/i, timeout: 300_000, description: 'composer install' },
  
  // Build tools (10 minutes)
  { pattern: /^cargo\s+(build|install)\b/i, timeout: 600_000, description: 'cargo build' },
  { pattern: /^go\s+(build|install|get)\b/i, timeout: 600_000, description: 'go build' },
  { pattern: /^mvn\s+(install|package|compile)\b/i, timeout: 600_000, description: 'maven build' },
  { pattern: /^gradle\s+(build|assemble)\b/i, timeout: 600_000, description: 'gradle build' },
  { pattern: /^dotnet\s+(build|restore)\b/i, timeout: 600_000, description: 'dotnet build' },
  
  // Docker (15 minutes)
  { pattern: /^docker\s+(build|pull|push)\b/i, timeout: 900_000, description: 'docker build/pull' },
  { pattern: /^docker-compose\s+(build|up|pull)\b/i, timeout: 900_000, description: 'docker-compose' },
  
  // Tests (5 minutes)
  { pattern: /^(npm|yarn|pnpm|bun)\s+(run\s+)?(test|e2e|spec)\b/i, timeout: 300_000, description: 'test suite' },
  { pattern: /^pytest\b/i, timeout: 300_000, description: 'pytest' },
  { pattern: /^jest\b/i, timeout: 300_000, description: 'jest' },
  { pattern: /^cargo\s+test\b/i, timeout: 300_000, description: 'cargo test' },
  { pattern: /^go\s+test\b/i, timeout: 300_000, description: 'go test' },
];

/**
 * Get smart timeout based on command pattern matching
 * Returns the appropriate timeout for long-running commands
 */
function getSmartTimeout(command: string, explicitTimeout?: number): { timeout: number; reason?: string } {
  // If explicit timeout is provided and valid, use it (but enforce minimum)
  if (explicitTimeout !== undefined && explicitTimeout >= MIN_TIMEOUT) {
    return { timeout: explicitTimeout };
  }
  
  // Check for long-running command patterns
  for (const { pattern, timeout, description } of LONG_RUNNING_COMMANDS) {
    if (pattern.test(command.trim())) {
      return { timeout, reason: description };
    }
  }
  
  // Use default timeout, but enforce minimum
  const baseTimeout = explicitTimeout ?? DEFAULT_TIMEOUT;
  return { timeout: Math.max(baseTimeout, MIN_TIMEOUT) };
}

/** Shell 运行输入（扩展版） */
interface ExtendedShellRunInput extends ShellRunInput {
  /** 最大输出长度（默认 50000） */
  maxOutput?: number;
  /** 
   * Run command in background (like Claude Code's Ctrl+B).
   * Returns PID immediately without waiting for completion.
   * Use for long-running processes like dev servers.
   */
  background?: boolean;
  /**
   * Use persistent shell session (Codex-like).
   * Commands run in a long-lived shell process, preserving environment and working directory.
   * Default: true for foreground commands, false for background.
   */
  persistent?: boolean;
}

/** Shell 运行输出（扩展版） */
interface ExtendedShellRunOutput extends ShellRunOutput {
  /** stdout 是否被截断 */
  stdoutTruncated?: boolean;
  /** stderr 是否被截断 */
  stderrTruncated?: boolean;
  /** Process ID (only for background mode) */
  pid?: number;
  /** Whether process is running (only for background mode) */
  running?: boolean;
  /** Process ID string for management (only for background mode) */
  processId?: string;
}

// =============================================================================
// Background Process Registry (Claude Code-like /bashes)
// =============================================================================

interface BackgroundProcess {
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  logs: string[];
  killed: boolean;
  taskId: string;
  agentId: string;
  completed?: boolean;
  exitCode?: number | null;
}

interface BackgroundProcessFilter {
  taskId?: string;
  agentId?: string;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();
let processCounter = 0;

/**
 * Get all background processes (for future /bashes command)
 */
export function listBackgroundProcesses(
  filter: BackgroundProcessFilter = {}
): { id: string; pid: number; command: string; startedAt: number; killed: boolean; completed?: boolean; exitCode?: number | null }[] {
  const entries = Array.from(backgroundProcesses.entries()).filter(([, proc]) => {
    if (filter.taskId && proc.taskId !== filter.taskId) return false;
    if (filter.agentId && proc.agentId !== filter.agentId) return false;
    return true;
  });

  return entries.map(([id, proc]) => ({
    id,
    pid: proc.pid,
    command: proc.command,
    startedAt: proc.startedAt,
    killed: proc.killed || false,
    completed: proc.completed ?? false,
    exitCode: proc.exitCode ?? null,
  }));
}

/**
 * Kill a background process by ID
 */
export function killBackgroundProcess(
  processId: string,
  filter: BackgroundProcessFilter = {}
): boolean {
  const proc = backgroundProcesses.get(processId);
  if (!proc || proc.killed) return false;

  if (filter.taskId && proc.taskId !== filter.taskId) return false;
  if (filter.agentId && proc.agentId !== filter.agentId) return false;
  
  // CRITICAL: Guard against pid <= 0 to prevent killing current process group
  if (proc.pid <= 0) {
    backgroundProcesses.delete(processId);
    return false;
  }
  
  try {
    process.kill(-proc.pid, 'SIGTERM');
    setTimeout(() => {
      try {
        if (!proc.killed && proc.pid > 0) {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch {
        // Process may have exited
      }
      // Cleanup from registry
      backgroundProcesses.delete(processId);
    }, 1000);
    proc.killed = true;
    return true;
  } catch {
    backgroundProcesses.delete(processId);
    return false;
  }
}

/**
 * Get buffered output from a background process
 */
export function getBackgroundProcessOutput(
  processId: string,
  filter: BackgroundProcessFilter = {}
): string | null {
  const proc = backgroundProcesses.get(processId);
  if (!proc) return null;
  if (filter.taskId && proc.taskId !== filter.taskId) return null;
  if (filter.agentId && proc.agentId !== filter.agentId) return null;
  return proc.logs.join('');
}

/**
 * Cleanup all background processes (call on exit)
 */
export function cleanupBackgroundProcesses(): void {
  for (const [id, proc] of backgroundProcesses.entries()) {
    // CRITICAL: Guard against pid <= 0
    if (!proc.killed && proc.pid > 0) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Process may have exited
      }
    }
    backgroundProcesses.delete(id);
  }
}

export function cleanupBackgroundProcessesForTask(taskId: string): void {
  for (const [id, proc] of backgroundProcesses.entries()) {
    if (proc.taskId !== taskId) continue;
    killBackgroundProcess(id, { taskId });
  }
}

/**
 * Cleanup all shell resources for a task (call when task completes)
 * This cleans up both background processes and persistent shell sessions.
 */
export async function cleanupAllForTask(taskId: string): Promise<void> {
  // Cleanup background processes
  cleanupBackgroundProcessesForTask(taskId);
  
  // Cleanup persistent shell sessions
  await shellSessionManager.destroyForTask(taskId);
}

/**
 * Execute command in background (Claude Code-like)
 */
function executeBackgroundCommand(
  command: string,
  cwd: string,
  context: ExecutionContext
): { pid: number; processId: string; error?: string } {
  const child = spawn('sh', ['-c', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: mergeEnv(context),
  });

  const pid = child.pid;
  
  // CRITICAL: Validate PID before registering
  if (!pid || pid <= 0) {
    child.on('error', () => {
      // Swallow spawn errors to avoid unhandled error events
    });
    return { pid: 0, processId: '', error: 'Failed to spawn process: invalid PID' };
  }

  // Unref so parent can exit independently
  child.unref();

  const processId = `bg-${++processCounter}`;
  const logs: string[] = [];

  child.stdout?.on('data', (data: Buffer) => {
    logs.push(data.toString());
    // Keep last 100 lines
    if (logs.length > 100) logs.shift();
  });

  child.stderr?.on('data', (data: Buffer) => {
    logs.push(`[stderr] ${data.toString()}`);
    if (logs.length > 100) logs.shift();
  });

  const proc: BackgroundProcess = {
    pid,
    command,
    cwd,
    startedAt: Date.now(),
    logs,
    killed: false,
    taskId: context.taskId,
    agentId: context.agentId,
    completed: false,
    exitCode: null,
  };

  backgroundProcesses.set(processId, proc);

  // Mark as completed on exit instead of deleting
  child.on('exit', (code) => {
    proc.completed = true;
    proc.exitCode = code;
    // Don't delete immediately so logs can be inspected
    // backgroundProcesses.delete(processId);
  });

  child.on('error', (err) => {
    proc.completed = true;
    proc.exitCode = 1;
    proc.logs.push(`[error] ${err.message}`);
    // Don't delete immediately
    // backgroundProcesses.delete(processId);
  });

  return { pid, processId };
}

/**
 * 危险命令检查
 */
const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+[/~]/i,
  /rm\s+(-rf?|--recursive)\s+\.\./i,
  /chmod\s+777/i,
  />\s*\/dev\/sd/i,
  /mkfs\./i,
  /dd\s+if=/i,
  /shutdown/i,
  /reboot/i,
  /init\s+[0-6]/i,
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * 执行命令
 */
async function executeCommand(
  command: string,
  cwd: string,
  timeout: number,
  context: ExecutionContext
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }> {
  return new Promise((resolve) => {
    let timedOut = false;
    
    // 使用 shell 执行命令，启用 detached 模式以便能杀死整个进程组
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true, // 创建新进程组
      env: mergeEnv(context),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout,
        stderr: timedOut ? stderr + '\n[Command timed out and was killed. If this is a long-running process (like a server), please use background: true]' : stderr,
        exitCode: timedOut ? 124 : (code ?? 1), // 124 是 timeout 命令的标准退出码
        timedOut,
      });
    });

    child.on('error', (error) => {
      resolve({
        stdout,
        stderr: stderr + '\n' + error.message,
        exitCode: 1,
      });
    });

    // 超时处理：杀死整个进程组
    const timeoutId = setTimeout(() => {
      timedOut = true;
      console.warn(`[shell_run] Command timed out after ${timeout}ms, killing process group...`);
      
      try {
        // 使用负数 pid 杀死整个进程组
        if (child.pid) {
          process.kill(-child.pid, 'SIGTERM');
          setTimeout(() => {
            try {
              if (child.pid && !child.killed) {
                process.kill(-child.pid, 'SIGKILL');
              }
            } catch {
              // 进程可能已经退出
            }
          }, 1000);
        }
      } catch {
        // 进程可能已经退出
        child.kill('SIGKILL');
      }
    }, timeout);

    // 进程正常退出时清除超时
    child.on('exit', () => {
      clearTimeout(timeoutId);
    });
  });
}

/**
 * shell_run 工具定义
 */
export const shellRunTool: Tool = {
  name: 'shell_run',
  title: 'Run Shell Command',
  description: `Execute shell commands in the working directory.

- Supports timeout control (default 30s)
- Dangerous commands are rejected
- Large output is auto-truncated (default max 50000 chars)
- **background mode**: Set background=true to run long-running commands (like dev servers) without blocking. Returns PID immediately.
- Background processes are scoped to the current task and auto-terminated on task completion. Use shell_bg to manage them.`,
  isCommandBased: true,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
      cwd: {
        type: 'string',
        description: '工作目录（相对于上下文 workDir）',
      },
      timeout: {
        type: 'number',
        description: `超时时间（毫秒）。最小值 ${MIN_TIMEOUT}ms，默认 ${DEFAULT_TIMEOUT}ms。长时间命令（npm install等）会自动延长。`,
        default: DEFAULT_TIMEOUT,
      },
      maxOutput: {
        type: 'number',
        description: 'Max output length (default 50000 chars)',
      },
      background: {
        type: 'boolean',
        description: 'Run in background (like Claude Code Ctrl+B). Returns PID immediately without waiting. Use for long-running processes like dev servers. Processes are scoped to the current task and auto-terminated on completion.',
        default: false,
      },
      persistent: {
        type: 'boolean',
        description: 'Use persistent shell session (Codex-like). Commands run in a long-lived shell process, preserving environment and working directory between commands. Default: true for foreground, false for background.',
        default: true,
      },
    },
    required: ['command'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'number' },
          stdoutTruncated: { type: 'boolean' },
          stderrTruncated: { type: 'boolean' },
          pid: { type: 'number', description: 'Process ID (background mode only)' },
          running: { type: 'boolean', description: 'Whether process is running (background mode only)' },
          processId: { type: 'string', description: 'Process ID string for management (background mode only)' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.6,
    idempotent: false,
    estimatedDuration: 30000,
  },

  permissions: ['shell:exec', 'process:spawn'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Shell,

  async execute(input: unknown, context: ExecutionContext): Promise<ToolResult<ExtendedShellRunOutput>> {
    const {
      command,
      cwd,
      timeout: explicitTimeout,
      maxOutput = DEFAULT_MAX_OUTPUT,
      background = false,
    } = input as ExtendedShellRunInput;
    
    // Get smart timeout based on command type (enforces minimum)
    const { timeout, reason: timeoutReason } = getSmartTimeout(command, explicitTimeout);
    if (timeoutReason) {
      console.log(`[shell_run] Auto-detected ${timeoutReason}, using ${timeout}ms timeout`);
    }

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      // 危险命令检查
      if (isDangerousCommand(command)) {
        return {
          success: false,
          error: `Dangerous command rejected: ${command}`,
        };
      }

      // 确定工作目录
      const workingDir = cwd ? validatePath(cwd, context.workDir) : context.workDir;

      // Background mode: spawn and return immediately
      if (background) {
        const { pid, processId, error } = executeBackgroundCommand(command, workingDir, context);
        
        if (error || pid <= 0) {
          return {
            success: false,
            error: error ?? 'Failed to start background process',
          };
        }
        
        return {
          success: true,
          data: {
            stdout: `Background process started with PID ${pid}`,
            stderr: '',
            // exitCode indicates successful spawn (process still running)
            exitCode: 0,
            pid,
            running: true,
            processId,
          },
        };
      }

      // Foreground mode: use persistent shell or one-shot execution
      const {
        persistent = true, // Default to persistent shell
      } = input as ExtendedShellRunInput;

      if (persistent) {
        // Use persistent shell session (Codex-like)
        try {
          const shell = shellSessionManager.getOrCreate({
            taskId: context.taskId,
            agentId: context.agentId,
            cwd: context.workDir, // Use workDir for session creation
          });
          
          // Pass per-call cwd and env to ensure consistent behavior
          const result = await shell.execute(command, {
            cwd: workingDir,  // May differ from session default
            env: context.env, // Inject context environment variables
            timeout,
          });
          
          // Truncate output if needed
          const stdoutTruncated = result.stdout.length > maxOutput;
          const stderrTruncated = result.stderr.length > maxOutput;
          
          if (result.timedOut) {
            console.warn(`[shell_run] Command timed out after ${timeout}ms: ${command.substring(0, 50)}...`);
          }
          
          return {
            success: result.exitCode === 0,
            data: {
              stdout: stdoutTruncated ? truncateOutput(result.stdout, maxOutput) : result.stdout,
              stderr: stderrTruncated ? truncateOutput(result.stderr, maxOutput) : result.stderr,
              exitCode: result.exitCode,
              stdoutTruncated,
              stderrTruncated,
            },
          };
        } catch (shellError) {
          // Fallback to one-shot execution if persistent shell fails
          console.warn(`[shell_run] Persistent shell failed, falling back to one-shot: ${(shellError as Error).message}`);
          // Fall through to one-shot execution below
        }
      }

      // One-shot execution (fallback or persistent=false)
      const result = await executeCommand(command, workingDir, timeout, context);

      // 截断输出
      const stdoutTruncated = result.stdout.length > maxOutput;
      const stderrTruncated = result.stderr.length > maxOutput;

      return {
        success: result.exitCode === 0,
        data: {
          stdout: stdoutTruncated ? truncateOutput(result.stdout, maxOutput) : result.stdout,
          stderr: stderrTruncated ? truncateOutput(result.stderr, maxOutput) : result.stderr,
          exitCode: result.exitCode,
          stdoutTruncated,
          stderrTruncated,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Unknown error executing command',
      };
    }
  },
};
