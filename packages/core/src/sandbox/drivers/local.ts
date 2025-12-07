/**
 * 本地沙盒驱动
 *
 * 提供无 Docker 依赖的本地沙盒实现，用于开发和测试
 *
 * ⚠️ 警告：此驱动仅供开发/测试使用，生产环境应使用 Docker 驱动
 *
 * 特性：
 * - 使用 Bun.spawn 执行命令
 * - 限制工作目录（带完整符号链接保护）
 * - 基础超时控制
 * - 命令白名单安全限制（不使用 shell，直接 argv 执行）
 * - 子进程跟踪和清理
 *
 * 安全特性：
 * - 完整路径祖先遍历防止符号链接绕过（包括新文件写入）
 * - 白名单模式下不使用 shell，防止命令注入
 * - 未配置白名单需显式启用 allowUnsafeShell
 * - 安全路径验证防止危险的 rm -rf
 * - 唯一文件名防止并发竞态
 */

import { mkdir, rm, readFile, writeFile, readdir, access, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

/** 安全的工作目录基础路径（默认为系统临时目录） */
const SAFE_WORKDIR_BASES = [
  tmpdir(),
  '/tmp',
  '/var/tmp',
];

/** 沙盒目录前缀 */
const SANDBOX_DIR_PREFIX = 'local-sandbox-';

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
 * 命令解析错误
 *
 * 当命令无法安全解析为 argv 时抛出
 */
export class CommandParseError extends Error {
  /** 无法解析的命令 */
  readonly command: string;

  constructor(command: string, reason: string) {
    super(`Failed to parse command: ${reason}. Command: ${command}`);
    this.name = 'CommandParseError';
    this.command = command;
  }
}

/**
 * 不安全 Shell 执行错误
 *
 * 当尝试在未启用 allowUnsafeShell 的情况下执行 shell 命令时抛出
 */
export class UnsafeShellError extends Error {
  constructor() {
    super(
      'Shell execution requires allowUnsafeShell flag or allowedCommands whitelist. ' +
      'Without a whitelist, shell commands are vulnerable to injection attacks.'
    );
    this.name = 'UnsafeShellError';
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

/**
 * 符号链接不允许错误
 *
 * 当路径包含指向工作目录外的符号链接时抛出
 */
export class SymlinkNotAllowedError extends Error {
  /** 符号链接路径 */
  readonly path: string;

  constructor(path: string) {
    super(`Symlink pointing outside workspace not allowed: ${path}`);
    this.name = 'SymlinkNotAllowedError';
    this.path = path;
  }
}

/**
 * 不安全的工作目录错误
 *
 * 当工作目录配置不安全时抛出
 */
export class UnsafeWorkdirError extends Error {
  /** 不安全的路径 */
  readonly path: string;

  constructor(path: string) {
    super(`Unsafe workdir configuration: ${path}. Workdir must be under a safe base directory and contain sandbox ID.`);
    this.name = 'UnsafeWorkdirError';
    this.path = path;
  }
}

// ============================================================================
// 命令解析工具
// ============================================================================

/**
 * 简单的命令行解析器
 *
 * 将命令字符串解析为 argv 数组，支持引号和转义
 * 这是一个安全的解析器，不会执行任何 shell 特性
 *
 * @example
 * parseCommandToArgv('echo "hello world"') // ['echo', 'hello world']
 * parseCommandToArgv("node -e 'console.log(1)'") // ['node', '-e', 'console.log(1)']
 */
function parseCommandToArgv(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if ((char === ' ' || char === '\t') && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  // 检查未闭合的引号
  if (inSingleQuote || inDoubleQuote) {
    throw new CommandParseError(command, 'Unclosed quote');
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * 检查命令是否包含需要 shell 的特性
 *
 * 这些特性无法通过简单的 argv 执行，需要 shell：
 * - 管道 (|)
 * - 重定向 (>, <, >>)
 * - 命令链 (&&, ||, ;)
 * - 后台执行 (&)
 * - 命令替换 ($(), ``)
 * - 变量扩展 ($VAR, ${VAR})
 * - 通配符 (*, ?, [])
 */
function requiresShell(command: string): boolean {
  // 检查是否在引号外有 shell 特殊字符
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // 在引号外检查 shell 特殊字符
    if (!inSingleQuote && !inDoubleQuote) {
      // 管道、重定向、命令链、后台执行
      if ('|><;&'.includes(char)) {
        return true;
      }
      // 命令替换和变量扩展
      if (char === '$') {
        return true;
      }
      // 反引号命令替换
      if (char === '`') {
        return true;
      }
      // 通配符（在引号外）
      if ('*?['.includes(char)) {
        return true;
      }
      // 换行符
      if (char === '\n' || char === '\r') {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// 扩展的本地运行时配置
// ============================================================================

/**
 * 扩展的本地运行时配置
 */
interface ExtendedLocalRuntimeConfig extends LocalRuntimeConfig {
  /**
   * 允许不安全的 shell 执行
   *
   * ⚠️ 警告：启用此选项会允许命令注入攻击
   * 仅在完全信任命令来源时使用
   *
   * 当设置为 true 且未配置 allowedCommands 时，允许任意 shell 命令执行
   */
  allowUnsafeShell?: boolean;
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
 * // 安全模式：使用命令白名单
 * const config = createSandboxConfig({
 *   runtime: 'local',
 *   timeout: 30000,
 *   runtimeConfig: {
 *     allowedCommands: ['node', 'npm', 'bun', 'echo'],
 *   },
 * });
 *
 * const sandbox = new LocalSandbox('dev-sandbox-001', config);
 * await sandbox.initialize();
 *
 * // 命令会被解析为 argv 并直接执行（不通过 shell）
 * const result = await sandbox.runCommand('echo "Hello"');
 * console.log(result.stdout); // "Hello"
 *
 * await sandbox.destroy();
 * ```
 *
 * @example
 * ```ts
 * // 不安全模式：允许任意 shell 命令（仅用于信任的开发环境）
 * const config = createSandboxConfig({
 *   runtime: 'local',
 *   runtimeConfig: {
 *     allowUnsafeShell: true, // ⚠️ 危险：允许命令注入
 *   },
 * });
 * ```
 */
export class LocalSandbox extends BaseSandbox {
  /** 工作目录路径 */
  private workdir: string;

  /** 工作目录的真实路径（realpath 解析后） */
  private realWorkdir: string | null = null;

  /** 本地运行时配置 */
  private localConfig: ExtendedLocalRuntimeConfig;

  /** 是否已清理 */
  private cleaned = false;

  /** 活跃的子进程集合（用于清理） */
  private activeProcesses = new Set<{ kill: () => void; pid?: number }>();

  /** 是否使用自动生成的工作目录 */
  private autoGeneratedWorkdir: boolean;

  constructor(id: string | undefined, config: SandboxConfig) {
    super(id, config);

    // 获取本地运行时配置
    this.localConfig = (config.runtimeConfig as ExtendedLocalRuntimeConfig) || {};

    // 设置工作目录（使用配置的或创建临时目录）
    if (config.filesystem?.workdir) {
      this.workdir = resolve(config.filesystem.workdir);
      this.autoGeneratedWorkdir = false;
    } else {
      this.workdir = join(tmpdir(), `${SANDBOX_DIR_PREFIX}${this.id}`);
      this.autoGeneratedWorkdir = true;
    }
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
   * 创建工作目录并验证安全性
   */
  protected async doInitialize(): Promise<void> {
    // 验证工作目录安全性（仅对自动生成的目录或用户配置的目录）
    this.validateWorkdirSafety();

    // 创建工作目录
    await mkdir(this.workdir, { recursive: true });

    // 获取工作目录的真实路径
    this.realWorkdir = await realpath(this.workdir);

    // 记录警告：仅用于开发/测试
    console.warn(
      `[LocalSandbox ${this.id}] ⚠️ Local sandbox is for development/testing only. ` +
      'Use Docker sandbox for production environments.'
    );

    // 网络模式警告
    if (this.config.network.mode === 'full') {
      console.warn(
        `[LocalSandbox ${this.id}] ⚠️ Network mode is 'full'. ` +
        'Local sandbox does not enforce network restrictions.'
      );
    }

    // 不安全 shell 模式警告
    if (this.localConfig.allowUnsafeShell && !this.localConfig.allowedCommands?.length) {
      console.warn(
        `[LocalSandbox ${this.id}] ⚠️ allowUnsafeShell is enabled without command whitelist. ` +
        'This allows arbitrary command execution and is vulnerable to injection attacks!'
      );
    }
  }

  /**
   * 执行代码
   *
   * 将代码写入唯一临时文件，然后使用 Bun 执行
   * 使用 UUID 文件名防止并发竞态条件
   */
  protected async doExecute(code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();

    // 使用唯一文件名防止并发竞态
    const uniqueId = randomUUID();
    const codeFile = join(this.workdir, `_code_${uniqueId}.ts`);

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
   * 安全执行命令：
   * 1. 如果配置了白名单：解析为 argv，不使用 shell 直接执行
   * 2. 如果未配置白名单但启用了 allowUnsafeShell：通过 shell 执行（危险）
   * 3. 否则拒绝执行
   */
  protected async doRunCommand(command: string, options?: ExecutionOptions): Promise<CommandResult> {
    const startTime = Date.now();
    const trimmedCommand = command.trim();

    const allowedCommands = this.localConfig.allowedCommands;
    const hasWhitelist = allowedCommands && allowedCommands.length > 0;

    let args: string[];
    let useShell = false;
    let extraEnv: Record<string, string> | undefined;

    if (hasWhitelist) {
      // 白名单模式：解析命令并直接执行（不使用 shell）
      const parsed = this.parseAndValidateCommand(trimmedCommand, allowedCommands);
      args = parsed.argv;
      extraEnv = parsed.extraEnv;
    } else if (this.localConfig.allowUnsafeShell) {
      // 不安全 shell 模式：通过 shell 执行
      useShell = true;
      const shell = this.localConfig.shell || DEFAULT_SHELL;
      const shellArgs = process.platform === 'win32'
        ? ['/c', trimmedCommand]
        : ['-c', trimmedCommand];
      args = [shell, ...shellArgs];
    } else {
      // 默认拒绝：既没有白名单也没有启用 allowUnsafeShell
      throw new UnsafeShellError();
    }

    const result = await this.spawnProcess(args, options, extraEnv);

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
    await this.validatePathSafety(fullPath);

    // 确保父目录存在
    const parentDir = dirname(fullPath);
    await mkdir(parentDir, { recursive: true });

    await writeFile(fullPath, content, 'utf-8');
  }

  /**
   * 读取文件
   */
  protected async doReadFile(path: string): Promise<string> {
    const fullPath = this.resolvePath(path);
    await this.validatePathSafety(fullPath);

    return readFile(fullPath, 'utf-8');
  }

  /**
   * 检查文件是否存在
   */
  protected async doFileExists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);

    try {
      await this.validatePathSafety(fullPath);
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
    await this.validatePathSafety(fullPath);

    return readdir(fullPath);
  }

  /**
   * 销毁沙盒
   *
   * 终止所有活跃进程并清理工作目录
   */
  protected async doDestroy(): Promise<void> {
    if (this.cleaned) {
      return;
    }

    // 终止所有活跃的子进程
    const processes = Array.from(this.activeProcesses);
    for (const proc of processes) {
      try {
        proc.kill();
      } catch {
        // 忽略终止失败（进程可能已退出）
      }
    }
    this.activeProcesses.clear();

    // 验证工作目录安全性再删除
    if (!this.isWorkdirSafeToDelete()) {
      console.error(
        `[LocalSandbox ${this.id}] ⚠️ Refusing to delete potentially unsafe workdir: ${this.workdir}`
      );
      this.cleaned = true;
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
   * 验证路径安全性（完整符号链接检查）
   *
   * 遍历路径中的每个祖先目录，检查是否存在指向工作目录外的符号链接
   * 这可以防止通过 "workdir/symlink_to_etc/evil" 这样的路径逃逸
   *
   * @throws {PathOutOfBoundsError} 路径超出工作目录
   * @throws {SymlinkNotAllowedError} 符号链接指向工作目录外
   */
  private async validatePathSafety(fullPath: string): Promise<void> {
    // 确保有真实工作目录路径
    if (!this.realWorkdir) {
      throw new Error('Sandbox not initialized');
    }

    const normalizedPath = resolve(fullPath);
    const normalizedWorkdir = resolve(this.workdir);

    // 首先做基础路径检查（快速失败）
    const logicalRelative = relative(normalizedWorkdir, normalizedPath);
    if (logicalRelative.startsWith('..') || isAbsolute(logicalRelative)) {
      throw new PathOutOfBoundsError(fullPath);
    }

    // 遍历路径中的每个祖先，检查符号链接
    // 从工作目录开始，逐级检查到目标路径
    await this.validatePathAncestors(normalizedPath, normalizedWorkdir);
  }

  /**
   * 验证路径的所有祖先目录
   *
   * 检查从工作目录到目标路径的每个中间目录，确保没有符号链接指向外部
   */
  private async validatePathAncestors(
    targetPath: string,
    workdir: string
  ): Promise<void> {
    // 获取从工作目录到目标路径的相对路径
    const relativePath = relative(workdir, targetPath);
    const segments = relativePath.split(sep).filter(Boolean);

    // 从工作目录开始，逐级检查每个路径段
    let currentPath = workdir;

    for (const segment of segments) {
      currentPath = join(currentPath, segment);

      // 检查当前路径是否存在
      let exists = false;
      try {
        await access(currentPath);
        exists = true;
      } catch {
        // 路径不存在，这是正常的（可能是新文件的中间目录）
        // 继续检查，因为后续的 mkdir 会创建它
        continue;
      }

      if (exists) {
        // 检查是否是符号链接
        const stat = await lstat(currentPath);
        if (stat.isSymbolicLink()) {
          // 获取符号链接的真实目标
          let realTarget: string;
          try {
            realTarget = await realpath(currentPath);
          } catch {
            // realpath 失败，可能是断开的符号链接，拒绝
            throw new SymlinkNotAllowedError(currentPath);
          }

          // 检查真实目标是否在工作目录内
          const targetRelative = relative(this.realWorkdir!, realTarget);
          if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
            throw new SymlinkNotAllowedError(currentPath);
          }

          // 符号链接指向工作目录内，更新 currentPath 为真实路径继续检查
          currentPath = realTarget;
        }
      }
    }

    // 最终检查：如果目标路径存在，验证其 realpath
    try {
      await access(targetPath);
      const realTargetPath = await realpath(targetPath);
      const finalRelative = relative(this.realWorkdir!, realTargetPath);
      if (finalRelative.startsWith('..') || isAbsolute(finalRelative)) {
        throw new PathOutOfBoundsError(targetPath);
      }
    } catch (error) {
      if (error instanceof PathOutOfBoundsError || error instanceof SymlinkNotAllowedError) {
        throw error;
      }
      // 文件不存在是正常的
    }
  }

  /**
   * 验证工作目录配置的安全性
   *
   * 确保工作目录在安全的基础路径下，防止误删系统重要目录
   */
  private validateWorkdirSafety(): void {
    const normalizedWorkdir = resolve(this.workdir);

    // 检查是否是危险路径
    const dangerousPaths = ['/', '/tmp', '/var', '/etc', '/usr', '/home', '/root', tmpdir()];
    if (dangerousPaths.includes(normalizedWorkdir)) {
      throw new UnsafeWorkdirError(normalizedWorkdir);
    }

    // 如果是自动生成的目录，检查是否包含沙盒前缀
    if (this.autoGeneratedWorkdir) {
      const dirName = basename(normalizedWorkdir);
      if (!dirName.startsWith(SANDBOX_DIR_PREFIX)) {
        throw new UnsafeWorkdirError(normalizedWorkdir);
      }
    }

    // 如果是用户配置的目录，验证路径看起来合理
    if (!this.autoGeneratedWorkdir) {
      // 检查是否在安全基础路径下
      const isUnderSafeBase = SAFE_WORKDIR_BASES.some(base => {
        const rel = relative(base, normalizedWorkdir);
        return !rel.startsWith('..') && !isAbsolute(rel) && rel.length > 0;
      });

      // 如果不在安全基础路径下，至少确保路径深度足够（防止 /home, /var 等）
      const pathDepth = normalizedWorkdir.split('/').filter(Boolean).length;
      if (!isUnderSafeBase && pathDepth < 3) {
        console.warn(
          `[LocalSandbox ${this.id}] ⚠️ Workdir "${normalizedWorkdir}" may not be safe. ` +
          'Consider using a path under /tmp or a dedicated sandbox directory.'
        );
      }
    }
  }

  /**
   * 检查工作目录是否安全删除
   *
   * 防止误删系统重要目录
   */
  private isWorkdirSafeToDelete(): boolean {
    const normalizedWorkdir = resolve(this.workdir);

    // 绝对不能删除的路径
    const forbiddenPaths = ['/', '/tmp', '/var', '/etc', '/usr', '/home', '/root', tmpdir()];
    if (forbiddenPaths.includes(normalizedWorkdir)) {
      return false;
    }

    // 自动生成的目录必须包含沙盒前缀和 ID
    if (this.autoGeneratedWorkdir) {
      const dirName = basename(normalizedWorkdir);
      return dirName.startsWith(SANDBOX_DIR_PREFIX) && dirName.includes(this.id);
    }

    // 用户配置的目录需要更严格的检查
    // 路径深度必须 >= 3（如 /tmp/sandbox/my-dir）
    const pathDepth = normalizedWorkdir.split('/').filter(Boolean).length;
    return pathDepth >= 3;
  }

  /**
   * 解析并验证命令
   *
   * 将命令字符串解析为 argv，并验证程序是否在白名单中
   * 如果命令需要 shell 特性（管道、重定向等），抛出错误
   *
   * @throws {CommandParseError} 命令无法安全解析
   * @throws {CommandNotAllowedError} 命令不在白名单中
   */
  private parseAndValidateCommand(
    command: string,
    allowedCommands: string[]
  ): { argv: string[]; extraEnv?: Record<string, string> } {
    // 检查命令是否需要 shell 特性
    if (requiresShell(command)) {
      throw new CommandParseError(
        command,
        'Command contains shell features (pipes, redirects, etc.) that cannot be safely executed without a shell. ' +
        'Use allowUnsafeShell if you trust the command source.'
      );
    }

    // 解析命令为 argv
    const argv = parseCommandToArgv(command);

    if (argv.length === 0) {
      throw new CommandParseError(command, 'Empty command');
    }

    // 提取前置环境变量赋值（例如 FOO=bar node app.ts）
    const extraEnv: Record<string, string> = {};
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) {
      const [key, ...rest] = argv.shift()!.split('=');
      extraEnv[key] = rest.join('=');
    }

    if (argv.length === 0) {
      throw new CommandParseError(command, 'Command contains only environment assignments with no program');
    }

    // 获取程序名（第一个参数）
    const program = argv[0];
    const programName = basename(program);

    // 检查是否在白名单中
    const isAllowed = allowedCommands.some(allowed => {
      // 支持完整路径或命令名匹配
      return program === allowed ||
             programName === allowed ||
             program.endsWith(`/${allowed}`);
    });

    if (!isAllowed) {
      throw new CommandNotAllowedError(program);
    }

    return { argv, extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined };
  }

  /**
   * 构建环境变量
   */
  private buildEnv(
    options?: ExecutionOptions,
    extraEnv?: Record<string, string>
  ): Record<string, string> {
    const baseEnv = this.localConfig.inheritEnv
      ? { ...process.env }
      : {};

    return {
      ...baseEnv,
      ...this.config.env,
      ...options?.env,
      ...(extraEnv ?? {}),
      // 设置工作目录环境变量
      PWD: options?.cwd ? this.resolvePath(options.cwd) : this.workdir,
    } as Record<string, string>;
  }

  /**
   * 执行进程
   *
   * 使用 Bun.spawn 执行命令，支持超时控制和进程跟踪
   */
  private async spawnProcess(
    args: string[],
    options?: ExecutionOptions,
    envOverride?: Record<string, string>
  ): Promise<Omit<ExecutionResult, 'duration'>> {
    const timeout = options?.timeout ?? this.config.timeout;
    const cwd = options?.cwd ? this.resolvePath(options.cwd) : this.workdir;
    const env = envOverride ?? this.buildEnv(options);

    // 验证工作目录
    await this.validatePathSafety(cwd);

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

        // 跟踪活跃进程
        this.activeProcesses.add(proc);

        // 设置超时计时器
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          this.activeProcesses.delete(proc);
          reject(new TimeoutError(timeout));
        }, timeout);

        // 等待进程完成
        proc.exited.then(async (exitCode) => {
          this.activeProcesses.delete(proc);

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
          this.activeProcesses.delete(proc);

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

// ============================================================================
// 已弃用的导出（保持向后兼容）
// ============================================================================

/**
 * @deprecated 使用 CommandParseError 或检查 requiresShell
 */
export const CommandInjectionError = CommandParseError;
