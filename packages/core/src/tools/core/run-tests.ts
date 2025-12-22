/**
 * run_tests 工具
 *
 * 运行测试命令，支持 bun test 和 npm test
 */

import { spawn } from 'node:child_process';
import type { Tool, ExecutionContext } from '../../types';
import type { RunTestsInput, RunTestsOutput, ToolResult } from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { validatePath, ensureWorkDir } from './utils';
import { mergeEnv } from '../env-utils';
import { truncateWithNotice, DEFAULT_MAX_OUTPUT } from './security';
import { DEFAULT_RESOURCE_LIMITS } from '../constants';

/** 默认测试超时时间 (60秒，使用constants统一默认值的30s的2倍) */
const DEFAULT_TEST_TIMEOUT = DEFAULT_RESOURCE_LIMITS.maxExecutionTime * 2;

/**
 * 执行测试命令
 */
async function executeTestCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  context: ExecutionContext
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: mergeEnv(context), // 使用统一的env合并逻辑
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
        stderr: timedOut ? stderr + '\n[Test timed out and was killed]' : stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
      });
    });

    child.on('error', (error) => {
      resolve({
        stdout,
        stderr: stderr + '\n' + error.message,
        exitCode: 1,
        timedOut: false,
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
 * run_tests 工具定义
 */
export const runTestsTool: Tool = {
  name: 'run_tests',
  title: 'Run Tests',
  description: `运行测试。
- bun 模式：pattern 必填，作为文件过滤参数
- npm 模式：pattern 可选（仅用于日志），实际筛选通过 extraArgs 传递（如 --testPathPattern）
- 支持超时控制（默认 60 秒）
- 输出会自动截断`,
  isCommandBased: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '测试文件路径或模式（bun 模式必填；npm 模式仅用于日志记录）',
      },
      cwd: {
        type: 'string',
        description: '工作目录（相对于上下文 workDir）',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒，默认 60000）',
        default: 60000,
      },
      useBun: {
        type: 'boolean',
        description: '是否使用 bun test（默认 true，false 则使用 npm test）',
        default: true,
      },
      extraArgs: {
        type: 'array',
        items: { type: 'string' },
        description: '额外参数（npm 模式下用于实际筛选，如 --testPathPattern=xxx）',
      },
    },
    // pattern 不再作为全局必填，而是在 bun 模式下运行时检查
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
          truncated: { type: 'boolean' },
          timedOut: { type: 'boolean' },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.9,
    idempotent: false,
    estimatedDuration: 60000,
  },

  permissions: ['shell:exec', 'process:spawn'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Shell,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<RunTestsOutput>> {
    const {
      pattern,
      cwd,
      timeout = DEFAULT_TEST_TIMEOUT,
      useBun = true,
      extraArgs = [],
    } = input as RunTestsInput;

    try {
      // 确保工作目录存在
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      // P1-A: 使用 effectiveCwd 作为默认工作目录，cwd 参数相对于 effectiveCwd 解析
      const baseDir = context.effectiveCwd ?? context.workDir;
      const workingDir = cwd ? validatePath(cwd, baseDir) : baseDir;

      // 构建命令
      let command: string;
      let args: string[];

      if (useBun) {
        // bun 模式：pattern 必填
        if (!pattern || typeof pattern !== 'string' || pattern.trim() === '') {
          return {
            success: false,
            error: 'pattern is required for bun mode and must be a non-empty string',
          };
        }
        command = 'bun';
        args = ['test', pattern, ...extraArgs];
      } else {
        // npm 模式：pattern 可选，仅用于日志
        if (pattern && pattern.trim()) {
          console.log(`[run_tests] npm mode - expected scope: ${pattern}`);
        }
        command = 'npm';
        args = ['test', '--', ...extraArgs];
        // 如果调用者在 npm 模式下未提供 extraArgs，给出警告
        if (extraArgs.length === 0) {
          console.warn('[run_tests] Warning: npm mode without extraArgs may run all tests. Consider using useBun: true or providing extraArgs like --testPathPattern');
        }
      }

      // 执行测试
      const result = await executeTestCommand(command, args, workingDir, timeout, context);

      // 截断输出
      const { content: stdout, truncated: stdoutTruncated } = truncateWithNotice(
        result.stdout,
        DEFAULT_MAX_OUTPUT
      );
      const { content: stderr, truncated: stderrTruncated } = truncateWithNotice(
        result.stderr,
        DEFAULT_MAX_OUTPUT
      );

      return {
        success: result.exitCode === 0,
        data: {
          stdout,
          stderr,
          exitCode: result.exitCode,
          truncated: stdoutTruncated || stderrTruncated,
          timedOut: result.timedOut,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to run tests',
      };
    }
  },
};
