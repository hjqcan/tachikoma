/**
 * 本地沙盒驱动
 *
 * 提供无 Docker 依赖的本地沙盒实现，用于开发和测试
 *
 * ⚠️ 警告：此驱动仅供开发/测试使用，生产环境应使用 Docker 驱动
 *
 * 特性：
 * - 使用 Bun.spawn 执行命令
 * - 限制工作目录
 * - 基础超时控制
 * - 可选命令白名单安全限制
 */

import { mkdir, rm, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseSandbox, TimeoutError } from '../base';
import type {
  SandboxConfig,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  LocalRuntimeConfig,
} from '../types';

// ============================================================================
// 常量定义
// ============================================================================

/** 默认 Shell 路径 */
const DEFAULT_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

/** 默认代码文件名 */
const DEFAULT_CODE_FILENAME = '_code.ts';

// ============================================================================
// 自定义错误类型
// ============================================================================

/**
 * 命令不允许错误
 *
 * 当执行的命令不在白名单中时抛出
 */
export class CommandNotAllowedError extends Error {
  /** 被禁止的命令 */
  readonly command: string;

  constructor(command: string) {
    super(`Command not allowed: ${command}`);
    this.name = 'CommandNotAllowedError';
    this.command = command;
  }
}

/**
 * 路径越界错误
 *
 * 当访问的路径超出工作目录范围时抛出
 */
export class PathOutOfBoundsError extends Error {
  /** 尝试访问的路径 */
  readonly path: string;

  constructor(path: string) {
    super(`Path is outside of sandbox workspace: ${path}`);
    this.name = 'PathOutOfBoundsError';
    this.path = path;
  }
}

// ============================================================================
// LocalSandbox 实现
// ============================================================================

/**
 * 本地沙盒实现
 *
 * 使用 Bun.spawn 直接执行命令，无需 Docker 依赖
 * 仅用于开发和测试环境
 *
 * @example
 * ```ts
 * const config = createSandboxConfig({
 *   runtime: 'local',
 *   timeout: 30000,
 *   runtimeConfig: {
 *     shell: '/bin/bash',
 *     inheritEnv: false,
 *     allowedCommands: ['node', 'npm', 'bun'],
 *   },
 * });
 *
 * const sandbox = new LocalSandbox('dev-sandbox-001', config);
 * await sandbox.initialize();
 *
 * const result = await sandbox.runCommand('echo "Hello"');
 * console.log(result.stdout); // "Hello"
 *
 * await sandbox.destroy();
 * ```
 */
export class LocalSandbox extends BaseSandbox {
  /** 工作目录路径 */
  private workdir: string;

  /** 本地运行时配置 */
  private localConfig: LocalRuntimeConfig;

  /** 是否已清理 */
  private cleaned = false;

  constructor(id: string | undefined, config: SandboxConfig) {
    super(id, config);

    // 获取本地运行时配置
    this.localConfig = (config.runtimeConfig as LocalRuntimeConfig) || {};

    // 设置工作目录（使用配置的或创建临时目录）
    this.workdir = config.filesystem?.workdir
      ? resolve(config.filesystem.workdir)
      : join(tmpdir(), `local-sandbox-${this.id}`);
  }

  // ==========================================================================
  // 公共方法
  // ==========================================================================

  /**
   * 获取工作目录路径
   */
  getWorkdir(): string {
    return this.workdir;
  }

  // ==========================================================================
  // 保护方法实现
  // ==========================================================================

  /**
   * 初始化本地沙盒
   *
   * 创建工作目录
   */
  protected async doInitialize(): Promise<void> {
    // 创建工作目录
    await mkdir(this.workdir, { recursive: true });

    // 记录警告：仅用于开发/测试
    console.warn(
      `[LocalSandbox ${this.id}] ⚠️ Local sandbox is for development/testing only. ` +
      'Use Docker sandbox for production environments.'
    );
  }

/**
 * 执行代码
 *
 * 将代码写入临时文件，然后使用 Bun 执行
 */
protected async doExecute(code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
  const startTime = Date.now();

  // 写入代码到临时文件
  const codeFile = join(this.workdir, DEFAULT_CODE_FILENAME);
  await writeFile(codeFile, code, 'utf-8');

  try {
    // 使用 bun run 执行代码（使用当前进程的 Bun 路径）
    const bunPath = process.execPath;
    const result = await this.spawnProcess(
      [bunPath, 'run', codeFile],
      options
    );

    return {
      ...result,
      duration: Date.now() - startTime,
    };
  } finally {
    // 清理临时代码文件
    try {
      await rm(codeFile, { force: true });
    } catch {
      // 忽略清理失败
    }
  }
}

  /**
   * 运行命令
   *
   * 使用 Shell 执行命令
   */
  protected async doRunCommand(command: string, options?: ExecutionOptions): Promise<CommandResult> {
    const startTime = Date.now();

    // 检查命令白名单
    this.validateCommand(command);

    const shell = this.localConfig.shell || DEFAULT_SHELL;
    const shellArgs = process.platform === 'win32'
      ? ['/c', command]
      : ['-c', command];

    const result = await this.spawnProcess(
      [shell, ...shellArgs],
      options
    );

    return {
      ...result,
      command,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 写入文件
   */
  protected async doWriteFile(path: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    this.validatePath(fullPath);

    // 确保父目录存在（使用 dirname 正确获取父目录）
    const parentDir = dirname(fullPath);
    await mkdir(parentDir, { recursive: true });

    await writeFile(fullPath, content, 'utf-8');
  }

  /**
   * 读取文件
   */
  protected async doReadFile(path: string): Promise<string> {
    const fullPath = this.resolvePath(path);
    this.validatePath(fullPath);

    return readFile(fullPath, 'utf-8');
  }

  /**
   * 检查文件是否存在
   *
   * 使用 access 替代 exists，确保 Node.js 兼容性
   */
  protected async doFileExists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    this.validatePath(fullPath);

    try {
      await access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出目录内容
   */
  protected async doListDir(path: string): Promise<string[]> {
    const fullPath = this.resolvePath(path);
    this.validatePath(fullPath);

    return readdir(fullPath);
  }

  /**
   * 销毁沙盒
   *
   * 清理工作目录
   */
  protected async doDestroy(): Promise<void> {
    if (this.cleaned) {
      return;
    }

    try {
      // 删除整个工作目录
      await rm(this.workdir, { recursive: true, force: true });
      this.cleaned = true;
    } catch (error) {
      console.warn(
        `[LocalSandbox ${this.id}] Failed to clean up workdir: ${this.workdir}`,
        error
      );
    }
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 解析路径
   *
   * 将相对路径解析为相对于工作目录的绝对路径
   */
  private resolvePath(path: string): string {
    if (isAbsolute(path)) {
      return path;
    }
    return resolve(this.workdir, path);
  }

  /**
   * 验证路径是否在工作目录内
   *
   * 防止路径穿越攻击
   */
  private validatePath(fullPath: string): void {
    const normalizedPath = resolve(fullPath);
    const normalizedWorkdir = resolve(this.workdir);

    // 检查路径是否在工作目录内
    const relativePath = relative(normalizedWorkdir, normalizedPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new PathOutOfBoundsError(fullPath);
    }
  }

  /**
   * 验证命令是否在白名单中
   *
   * 如果配置了白名单，检查命令是否允许执行
   *
   * ⚠️ 安全警告：未配置白名单时任何命令都可执行
   */
  private validateCommand(command: string): void {
    const allowedCommands = this.localConfig.allowedCommands;
    if (!allowedCommands || allowedCommands.length === 0) {
      // 未配置白名单，允许所有命令（仅限开发/测试环境）
      // 生产环境应配置 allowedCommands 限制可执行命令
      return;
    }

    // 提取命令的第一个词（程序名）
    const trimmedCommand = command.trim();
    const firstWord = trimmedCommand.split(/\s+/)[0];
    const commandName = firstWord ?? trimmedCommand;

    // 检查是否在白名单中
    const isAllowed = allowedCommands.some(allowed => {
      // 支持完整路径或命令名匹配
      return commandName === allowed || commandName.endsWith(`/${allowed}`);
    });

    if (!isAllowed) {
      throw new CommandNotAllowedError(commandName);
    }
  }

  /**
   * 构建环境变量
   */
  private buildEnv(options?: ExecutionOptions): Record<string, string> {
    const baseEnv = this.localConfig.inheritEnv
      ? { ...process.env }
      : {};

    return {
      ...baseEnv,
      ...this.config.env,
      ...options?.env,
      // 设置工作目录环境变量
      PWD: options?.cwd ? this.resolvePath(options.cwd) : this.workdir,
    } as Record<string, string>;
  }

  /**
   * 执行进程
   *
   * 使用 Bun.spawn 执行命令，支持超时控制
   */
  private async spawnProcess(
    args: string[],
    options?: ExecutionOptions
  ): Promise<Omit<ExecutionResult, 'duration'>> {
    const timeout = options?.timeout ?? this.config.timeout;
    const cwd = options?.cwd ? this.resolvePath(options.cwd) : this.workdir;
    const env = this.buildEnv(options);

    // 验证工作目录
    this.validatePath(cwd);

    return new Promise((resolve, reject) => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        // 使用 Bun.spawn 执行
        const proc = Bun.spawn(args, {
          cwd,
          env,
          stdin: options?.stdin ? new Blob([options.stdin]) : undefined,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        // 设置超时计时器
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          reject(new TimeoutError(timeout));
        }, timeout);

        // 等待进程完成
        proc.exited.then(async (exitCode) => {
          if (timedOut) {
            return; // 已经被超时处理
          }

          clearTimeout(timer);

          // 读取输出
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();

          resolve({
            success: exitCode === 0,
            stdout,
            stderr,
            exitCode,
            timedOut: false,
          });
        }).catch((error) => {
          if (timedOut) {
            return; // 已经被超时处理
          }

          clearTimeout(timer);
          reject(error);
        });
      } catch (error) {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      }
    });
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建本地沙盒实例
 *
 * @param id - 沙盒 ID（可选，自动生成）
 * @param config - 沙盒配置
 * @returns LocalSandbox 实例
 *
 * @example
 * ```ts
 * const sandbox = await createLocalSandbox('test-001', config);
 * await sandbox.initialize();
 * ```
 */
export function createLocalSandbox(
  id: string | undefined,
  config: SandboxConfig
): LocalSandbox {
  return new LocalSandbox(id, config);
}
