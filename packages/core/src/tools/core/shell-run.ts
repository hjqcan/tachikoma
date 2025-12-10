/**
 * shell_run 工具
 *
 * 执行 shell 命令，支持输出截断
 */

import { spawn } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { ShellRunInput, ShellRunOutput, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import {
  validatePath,
  ensureWorkDir,
  truncateOutput,
  DEFAULT_MAX_OUTPUT,
} from './utils';

/** Shell 运行输入（扩展版） */
interface ExtendedShellRunInput extends ShellRunInput {
  /** 最大输出长度（默认 50000） */
  maxOutput?: number;
}

/** Shell 运行输出（扩展版） */
interface ExtendedShellRunOutput extends ShellRunOutput {
  /** stdout 是否被截断 */
  stdoutTruncated?: boolean;
  /** stderr 是否被截断 */
  stderrTruncated?: boolean;
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
 * 合并环境变量
 * 使用context.env覆盖process.env，实现多租户隔离
 */
function mergeEnv(context: ExecutionContext): Record<string, string> {
  // 基础环境变量白名单
  const envWhitelist = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG'];
  
  const baseEnv: Record<string, string> = {};
  for (const key of envWhitelist) {
    const value = process.env[key];
    if (value) {
      baseEnv[key] = value;
    }
  }
  
  // context.env优先级更高，并添加安全限制
  return {
    ...baseEnv,
    ...context.env,
    FORCE_COLOR: '0',
    TERM: 'dumb',
  };
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
        stderr: timedOut ? stderr + '\n[Command timed out and was killed]' : stderr,
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
  description: `在工作目录执行 shell 命令。
- 支持超时控制（默认 30 秒）
- 危险命令会被拒绝执行
- 大输出会自动截断（默认最大 50000 字符）`,
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
        description: '超时时间（毫秒，默认 30000）',
        default: 30000,
      },
      maxOutput: {
        type: 'number',
        description: '最大输出长度（默认 50000 字符）',
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
      timeout = 30000,
      maxOutput = DEFAULT_MAX_OUTPUT,
    } = input as ExtendedShellRunInput;

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

      // 执行命令
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
