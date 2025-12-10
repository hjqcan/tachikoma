/**
 * type_check 工具
 *
 * 运行 TypeScript 类型检查 (tsc --noEmit)
 */

import { spawn } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { TypeCheckInput, TypeCheckOutput, ToolResult } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { truncateWithNotice, DEFAULT_MAX_OUTPUT } from './security';

/** 默认类型检查超时时间 (120 秒) */
const DEFAULT_TYPECHECK_TIMEOUT = 120000;

/**
 * 解析 tsc 输出，提取错误数量
 */
function parseErrorCount(output: string): number {
  // tsc 输出格式：Found X errors.
  const match = output.match(/Found (\d+) errors?\./i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }

  // 也可能是逐行错误，统计包含 "error TS" 的行数
  const errorLines = output.split('\n').filter((line) =>
    line.includes('error TS')
  );
  return errorLines.length;
}

/**
 * 执行 tsc 命令
 */
async function executeTscCommand(
  args: string[],
  cwd: string,
  timeout: number
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  spawnError?: string; // spawn 失败时的错误信息
}> {
  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError: string | undefined;

    // 使用 npx tsc 以确保找到正确的 tsc
    const child = spawn('npx', ['tsc', ...args], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
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
        stderr: timedOut ? stderr + '\n[Type check timed out and was killed]' : stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
      });
    });

    child.on('error', (error) => {
      spawnError = error.message;
      resolve({
        stdout,
        stderr: stderr + '\n' + error.message,
        exitCode: 1,
        timedOut: false,
        spawnError,
      });
    });

    // 超时处理
    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
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
        child.kill('SIGKILL');
      }
    }, timeout);

    child.on('exit', () => {
      clearTimeout(timeoutId);
    });
  });
}

/**
 * type_check 工具定义
 */
export const typeCheckTool: Tool = {
  name: 'type_check',
  description: `运行 TypeScript 类型检查 (tsc --noEmit)。
- 不生成输出文件，仅检查类型
- 支持 --project 参数指定 tsconfig
- 超时默认 120 秒`,
  isCommandBased: true,
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: '工作目录（相对于上下文 workDir）',
      },
      project: {
        type: 'string',
        description: 'tsconfig 项目路径（--project 参数）',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒，默认 120000）',
        default: 120000,
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          errorCount: { type: 'number' },
          diagnostics: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      error: { type: 'string' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<TypeCheckOutput>> {
    const {
      cwd,
      project,
      timeout = DEFAULT_TYPECHECK_TIMEOUT,
    } = (input as TypeCheckInput) || {};

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      // 确定工作目录
      const workingDir = cwd ? validatePath(cwd, context.workDir) : context.workDir;

      // 构建参数
      const args = ['--noEmit'];
      if (project) {
        args.push('--project', project);
      }

      // 执行类型检查
      const result = await executeTscCommand(args, workingDir, timeout);

      // 合并输出
      const fullOutput = result.stdout + result.stderr;

      // 解析错误数量
      const errorCount = result.exitCode === 0 ? 0 : parseErrorCount(fullOutput);

      // 截断输出
      const { content: diagnostics, truncated } = truncateWithNotice(
        fullOutput,
        DEFAULT_MAX_OUTPUT
      );

      // 检测工具执行失败（spawn 失败或命令不存在）
      const isToolFailure = Boolean(result.spawnError) ||
        fullOutput.includes('ENOENT') ||
        fullOutput.includes('not found') ||
        fullOutput.includes('command not found');

      if (isToolFailure) {
        return {
          success: false,
          error: result.spawnError || 'tsc/npx command failed or not found',
          data: {
            passed: false,
            errorCount: 0,
            diagnostics,
            truncated,
          },
        };
      }

      // 工具执行成功，返回类型检查结果
      return {
        success: true,
        data: {
          passed: result.exitCode === 0,
          errorCount,
          diagnostics,
          truncated,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to run type check',
      };
    }
  },
};
