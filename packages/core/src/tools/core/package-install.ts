/**
 * package_install 工具
 *
 * 自动选择包管理器，后台执行安装并轮询日志
 */

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { Tool, ExecutionContext } from '../../types';
import type {
  PackageInstallInput,
  PackageInstallOutput,
  PackageManager,
  ToolResult,
} from '../types';
import { ToolLayer, ToolCategory } from '../types';
import { ensureWorkDir, validatePath } from './utils';
import { detectPackageManager, truncateWithNotice, DEFAULT_MAX_OUTPUT } from './security';
import {
  listBackgroundProcesses,
  getBackgroundProcessOutput,
  killBackgroundProcess,
  startBackgroundProcessWithArgs,
} from './shell-run';

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MIN_POLL_INTERVAL_MS = 500;

const PROJECT_MARKERS = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidPackageName(name: string): boolean {
  return !/[\s;&|><`$]/.test(name);
}

/**
 * 向上寻找项目根目录
 */
export function findProjectRoot(startDir: string, workDir: string): string | null {
  let current = resolve(startDir);
  const root = resolve(workDir);

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(current, marker))) {
        return current;
      }
    }

    if (current === root) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

export function resolvePackageManager(
  projectRoot: string,
  requested?: PackageManager | 'auto'
): { manager: PackageManager; warnings: string[] } {
  if (requested && requested !== 'auto' && requested !== 'unknown') {
    return { manager: requested, warnings: [] };
  }

  const detected = detectPackageManager(projectRoot);
  if (detected !== 'unknown') {
    return { manager: detected, warnings: [] };
  }

  return {
    manager: 'npm',
    warnings: ['No lockfile detected. Falling back to npm.'],
  };
}

export function buildInstallCommand(
  manager: PackageManager,
  packages: string[],
  dev: boolean,
  extraArgs: string[]
): string {
  const { command, args } = buildInstallArgs(manager, packages, dev, extraArgs);
  return `${command} ${args.join(' ')}`.trim();
}

function buildInstallArgs(
  manager: PackageManager,
  packages: string[],
  dev: boolean,
  extraArgs: string[]
): { command: string; args: string[] } {
  const args: string[] = [];
  const hasPackages = packages.length > 0;
  const command = manager === 'unknown' ? 'npm' : manager;

  if (manager === 'npm') {
    args.push('install');
    if (hasPackages) {
      if (dev) args.push('-D');
      args.push(...packages);
    }
  } else if (manager === 'pnpm') {
    args.push(hasPackages ? 'add' : 'install');
    if (hasPackages) {
      if (dev) args.push('-D');
      args.push(...packages);
    }
  } else if (manager === 'yarn') {
    args.push(hasPackages ? 'add' : 'install');
    if (hasPackages) {
      if (dev) args.push('-D');
      args.push(...packages);
    }
  } else if (manager === 'bun') {
    args.push(hasPackages ? 'add' : 'install');
    if (hasPackages) {
      if (dev) args.push('-d');
      args.push(...packages);
    }
  } else {
    args.push('install');
    if (hasPackages) {
      if (dev) args.push('-D');
      args.push(...packages);
    }
  }

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return { command, args };
}

/**
 * package_install 工具定义
 */
export const packageInstallTool: Tool = {
  name: 'package_install',
  title: 'Install Packages',
  description: `安装依赖（自动选择包管理器）。
- 根据 lockfile 自动检测 pnpm/yarn/npm/bun
- 后台执行安装并轮询日志直到完成
- 适用于 npm install / pnpm add / yarn add 等场景`,
  inputSchema: {
    type: 'object',
    properties: {
      packages: {
        type: 'array',
        items: { type: 'string' },
        description: '要安装的包列表（空则执行 install）',
      },
      dev: {
        type: 'boolean',
        description: '是否安装为 devDependencies（仅在 packages 非空时生效）',
        default: false,
      },
      cwd: {
        type: 'string',
        description: '工作目录（相对于上下文 workDir）',
      },
      packageManager: {
        type: 'string',
        enum: ['auto', 'bun', 'npm', 'yarn', 'pnpm', 'unknown'],
        description: '包管理器选择（默认 auto，按 lockfile 自动检测）',
        default: 'auto',
      },
      timeoutMs: {
        type: 'number',
        description: `超时时间（毫秒），默认 ${DEFAULT_INSTALL_TIMEOUT_MS}`,
        default: DEFAULT_INSTALL_TIMEOUT_MS,
      },
      pollIntervalMs: {
        type: 'number',
        description: `日志轮询间隔（毫秒），默认 ${DEFAULT_POLL_INTERVAL_MS}`,
        default: DEFAULT_POLL_INTERVAL_MS,
      },
      maxOutput: {
        type: 'number',
        description: '最大日志输出长度（默认 50000 字符）',
        default: DEFAULT_MAX_OUTPUT,
      },
      extraArgs: {
        type: 'array',
        items: { type: 'string' },
        description: '额外参数（如 --no-audit）',
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
          packageManager: {
            type: 'string',
            enum: ['bun', 'npm', 'yarn', 'pnpm', 'unknown'],
          },
          command: { type: 'string' },
          cwd: { type: 'string' },
          exitCode: { type: 'number' },
          logs: { type: 'string' },
          logsTruncated: { type: 'boolean' },
          durationMs: { type: 'number' },
          timedOut: { type: 'boolean' },
          processId: { type: 'string' },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
  },

  annotations: {
    audience: ['assistant'],
    priority: 0.8,
    idempotent: false,
    estimatedDuration: DEFAULT_INSTALL_TIMEOUT_MS,
  },

  permissions: ['shell:exec', 'process:spawn', 'fs:read'],
  layer: ToolLayer.Sandbox,
  category: ToolCategory.Shell,

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<PackageInstallOutput>> {
    const {
      packages = [],
      dev = false,
      cwd,
      packageManager = 'auto',
      timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      maxOutput = DEFAULT_MAX_OUTPUT,
      extraArgs = [],
    } = input as PackageInstallInput;

    try {
      const workDirCheck = await ensureWorkDir(context.workDir);
      if (!workDirCheck.valid) {
        return {
          success: false,
          error: workDirCheck.error ?? 'Unknown workDir error',
        };
      }

      const baseDir = context.effectiveCwd ?? context.workDir;
      const requestedDir = cwd ? validatePath(cwd, baseDir) : baseDir;

      const projectRoot = findProjectRoot(requestedDir, context.workDir) ?? requestedDir;
      const packageJsonPath = join(projectRoot, 'package.json');

      if (!existsSync(packageJsonPath)) {
        return {
          success: false,
          error: `package.json not found under: ${projectRoot}`,
        };
      }

      const trimmedPackages = packages.map((p) => p.trim()).filter((p) => p.length > 0);
      const normalizedExtraArgs = extraArgs.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
      for (const pkg of trimmedPackages) {
        if (!isValidPackageName(pkg)) {
          return {
            success: false,
            error: `Invalid package name: ${pkg}`,
          };
        }
      }

      const warnings: string[] = [];
      if (dev && trimmedPackages.length === 0) {
        warnings.push('dev=true is ignored when packages list is empty.');
      }

      const { manager, warnings: managerWarnings } = resolvePackageManager(projectRoot, packageManager);
      warnings.push(...managerWarnings);

      const { command: commandName, args: commandArgs } = buildInstallArgs(
        manager,
        trimmedPackages,
        dev,
        normalizedExtraArgs
      );
      const command = buildInstallCommand(manager, trimmedPackages, dev, normalizedExtraArgs);
      const startTime = Date.now();

      const { processId, error } = startBackgroundProcessWithArgs(
        commandName,
        commandArgs,
        projectRoot,
        context
      );
      if (error || !processId) {
        return {
          success: false,
          error: error ?? 'Failed to start package install',
        };
      }

      const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_INSTALL_TIMEOUT_MS;
      const pollInterval = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs);
      const timeoutAt = startTime + effectiveTimeoutMs;

      let logs = '';
      let completed = false;
      let exitCode: number | null = null;

      while (Date.now() < timeoutAt) {
        const output = getBackgroundProcessOutput(processId, {
          taskId: context.taskId,
          agentId: context.agentId,
        });
        if (output !== null) {
          logs = output;
        }

        const proc = listBackgroundProcesses({
          taskId: context.taskId,
          agentId: context.agentId,
        }).find((item) => item.id === processId);

        if (!proc) {
          break;
        }

        if (proc.completed) {
          completed = true;
          exitCode = proc.exitCode ?? 1;
          break;
        }

        await sleep(pollInterval);
      }

      const { content, truncated } = truncateWithNotice(logs, maxOutput);
      const durationMs = Date.now() - startTime;

      if (!completed) {
        killBackgroundProcess(processId, {
          taskId: context.taskId,
          agentId: context.agentId,
        });
        return {
          success: false,
          error: 'Package install timed out',
          data: {
            packageManager: manager,
            command,
            cwd: projectRoot,
            exitCode: 124,
            logs: content,
            logsTruncated: truncated,
            durationMs,
            timedOut: true,
            processId,
            warnings,
          },
        };
      }

      return {
        success: exitCode === 0,
        data: {
          packageManager: manager,
          command,
          cwd: projectRoot,
          exitCode: exitCode ?? 1,
          logs: content,
          logsTruncated: truncated,
          durationMs,
          timedOut: false,
          processId,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        ...(exitCode === 0 ? {} : { error: `Package install failed with exit code ${exitCode}` }),
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: err.message || 'Failed to install packages',
      };
    }
  },
};
