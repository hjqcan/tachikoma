/**
 * Docker 沙盒驱动实现
 *
 * 基于 Docker API 实现沙盒生命周期管理
 * 任务 5.2 实现
 *
 * 功能包括：
 * - 容器创建（镜像、工作目录挂载、环境变量）
 * - 命令执行（exec）
 * - 文件读写（cp）
 * - 资源限制（--cpus/--memory）
 * - 网络配置（--network）
 * - 超时终止
 * - 连接池复用机制
 */

import type {
  SandboxConfig,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  ResourceUsage,
  DockerRuntimeConfig,
  NetworkMode,
} from '../types';
import { BaseSandbox, TimeoutError } from '../base';

// ============================================================================
// Docker 相关类型
// ============================================================================

/**
 * Docker 命令执行结果
 */
interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Docker 容器信息
 */
interface DockerContainerInfo {
  containerId: string;
  status: 'created' | 'running' | 'paused' | 'exited' | 'dead';
  createdAt: number;
  startedAt?: number;
}

/**
 * Docker 沙盒默认配置
 */
const DOCKER_DEFAULTS = {
  /** 默认镜像 */
  image: 'node:20-slim',
  /** 默认工作目录 */
  workdir: '/workspace',
  /** 容器名称前缀 */
  containerPrefix: 'tachikoma-sandbox',
  /** Shell 路径 */
  shell: '/bin/sh',
  /** 用户 */
  user: 'root',
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 执行 Docker 命令
 *
 * @param args - Docker 命令参数
 * @param options - 执行选项
 * @returns 执行结果
 */
async function runDockerCommand(
  args: string[],
  options: { timeout?: number; stdin?: string } = {}
): Promise<DockerExecResult> {
  const { timeout = 30000, stdin } = options;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeout));
    }, timeout);

    // 根据是否有 stdin 配置不同的选项
    const spawnOptions = stdin
      ? { stdin: new Blob([stdin]), stdout: 'pipe' as const, stderr: 'pipe' as const }
      : { stdout: 'pipe' as const, stderr: 'pipe' as const };

    const proc = Bun.spawn(['docker', ...args], spawnOptions);

    proc.exited.then(async (exitCode) => {
      clearTimeout(timer);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      resolve({
        stdout,
        stderr,
        exitCode,
      });
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 解析内存限制字符串为字节数
 *
 * @param memory - 内存限制字符串（如 "512m", "2g"）
 * @returns 字节数
 */
function parseMemoryLimit(memory: string): number {
  const match = memory.match(/^(\d+(?:\.\d+)?)\s*(k|m|g|t)?b?$/i);
  if (!match || !match[1]) {
    return parseInt(memory, 10);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] ?? '').toLowerCase();

  const multipliers: Record<string, number> = {
    '': 1,
    'k': 1024,
    'm': 1024 * 1024,
    'g': 1024 * 1024 * 1024,
    't': 1024 * 1024 * 1024 * 1024,
  };

  return Math.floor(value * (multipliers[unit] || 1));
}

/**
 * 将网络模式映射到 Docker 网络配置
 *
 * @param mode - 网络模式
 * @returns Docker 网络名称
 *
 * TODO: restricted 模式目前仅使用 bridge 网络，尚未实现 allowlist 限制
 * 需要后续通过以下方式之一实现真正的网络限制：
 * - 使用 iptables 规则限制出站连接
 * - 创建自定义 Docker 网络并配置防火墙
 * - 使用网络策略插件（如 Calico）
 *
 * 当前 restricted 模式与 full 模式网络访问能力相同，请注意安全风险
 */
function mapNetworkMode(mode: NetworkMode): string {
  switch (mode) {
    case 'none':
      return 'none';
    case 'restricted':
      // TODO: 实现 allowlist 限制，当前与 full 模式相同
      return 'bridge';
    case 'full':
      return 'bridge';
    default:
      return 'none';
  }
}

/**
 * 转义 shell 命令中的特殊字符
 *
 * @param str - 要转义的字符串
 * @returns 转义后的字符串
 */
function escapeShellArg(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// DockerSandbox 类
// ============================================================================

/**
 * Docker 沙盒实现
 *
 * 基于 Docker 容器提供隔离的代码执行环境
 *
 * @example
 * ```ts
 * const sandbox = new DockerSandbox('sandbox-001', {
 *   runtime: 'docker',
 *   timeout: 30000,
 *   resources: { cpu: '1', memory: '512m', storage: '1g' },
 *   network: { mode: 'restricted', allowlist: [] },
 *   runtimeConfig: { image: 'node:20-slim' },
 * });
 *
 * await sandbox.initialize();
 * const result = await sandbox.runCommand('node --version');
 * console.log(result.stdout); // v20.x.x
 * await sandbox.destroy();
 * ```
 */
export class DockerSandbox extends BaseSandbox {
  /** Docker 容器 ID */
  private containerId: string | undefined;

  /** 容器名称 */
  private readonly containerName: string;

  /** Docker 运行时配置 */
  private readonly dockerConfig: DockerRuntimeConfig;

  /** 工作目录 */
  private readonly workdir: string;

  constructor(id: string | undefined, config: SandboxConfig) {
    super(id, config);

    // 解析 Docker 运行时配置
    this.dockerConfig = (config.runtimeConfig as DockerRuntimeConfig) || {
      image: DOCKER_DEFAULTS.image,
    };

    // 设置容器名称（基于沙盒 ID）
    this.containerName = `${DOCKER_DEFAULTS.containerPrefix}-${this.id}`;

    // 设置工作目录
    this.workdir = config.filesystem?.workdir || DOCKER_DEFAULTS.workdir;
  }

  // ==========================================================================
  // 初始化与销毁
  // ==========================================================================

  /**
   * 初始化 Docker 容器
   */
  protected async doInitialize(): Promise<void> {
    // 检查 Docker 是否可用
    await this.checkDockerAvailable();

    // 拉取镜像（如果需要）
    await this.pullImageIfNeeded();

    // 创建并启动容器
    await this.createContainer();
  }

  /**
   * 销毁 Docker 容器
   */
  protected async doDestroy(): Promise<void> {
    if (!this.containerId) {
      return;
    }

    try {
      // 强制停止并删除容器
      await runDockerCommand(['rm', '-f', this.containerId], {
        timeout: 10000,
      });
    } catch (error) {
      // 忽略删除错误（容器可能已经被删除）
      console.warn(`[DockerSandbox ${this.id}] Failed to remove container:`, error);
    } finally {
      this.containerId = undefined;
    }
  }

  // ==========================================================================
  // 代码执行
  // ==========================================================================

  /**
   * 在容器中执行代码
   *
   * @param code - 要执行的代码（JavaScript）
   * @param options - 执行选项
   * @returns 执行结果
   *
   * 执行环境说明：
   * - Docker 沙盒使用 Node.js 执行 JavaScript 代码
   * - 代码保存为 .js 文件，通过 `node` 命令执行
   * - 需要容器镜像包含 Node.js 运行时（默认使用 node:20-slim）
   *
   * 注意：LocalSandbox 使用 Bun 执行 TypeScript，两者执行环境不同
   * 如需统一，可在配置中指定解释器或根据代码特征自动选择
   */
  protected async doExecute(
    code: string,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    // 将代码写入临时文件（使用 .js 扩展名，由 Node.js 执行）
    const tempFile = `/tmp/code-${Date.now()}.js`;
    await this.doWriteFile(tempFile, code);

    try {
      // 执行代码文件
      const result = await this.execInContainer(
        `node ${tempFile}`,
        options
      );

      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: Date.now() - startTime,
      };
    } finally {
      // 清理临时文件
      try {
        await this.execInContainer(`rm -f ${tempFile}`);
      } catch {
        // 忽略清理错误
      }
    }
  }

  /**
   * 在容器中运行命令
   *
   * @param command - 要执行的命令
   * @param options - 执行选项
   * @returns 命令执行结果
   */
  protected async doRunCommand(
    command: string,
    options?: ExecutionOptions
  ): Promise<CommandResult> {
    const startTime = Date.now();

    const result = await this.execInContainer(command, options);

    return {
      command,
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: Date.now() - startTime,
    };
  }

  // ==========================================================================
  // 文件操作
  // ==========================================================================

  /**
   * 写入文件到容器
   *
   * @param path - 文件路径（相对于工作目录或绝对路径）
   * @param content - 文件内容
   *
   * 实现说明：使用 base64 编码通过 shell 写入文件
   *
   * TODO: 性能优化 - 大文件写入可考虑以下替代方案：
   * - 使用 docker cp 命令直接复制文件
   * - 使用 docker exec 配合 stdin 流式写入
   * - 挂载临时卷进行文件传输
   *
   * 当前方案适用于小文件（< 1MB），大文件可能受 shell 参数限制
   */
  protected async doWriteFile(path: string, content: string): Promise<void> {
    if (!this.containerId) {
      throw new Error('Container not initialized');
    }

    const fullPath = this.resolvePath(path);

    // 确保目录存在
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (dir) {
      await this.execInContainer(`mkdir -p ${escapeShellArg(dir)}`);
    }

    // 使用 base64 编码写入文件（避免特殊字符问题）
    const base64Content = Buffer.from(content).toString('base64');
    await this.execInContainer(
      `echo ${escapeShellArg(base64Content)} | base64 -d > ${escapeShellArg(fullPath)}`
    );
  }

  /**
   * 从容器读取文件
   *
   * @param path - 文件路径（相对于工作目录或绝对路径）
   * @returns 文件内容
   */
  protected async doReadFile(path: string): Promise<string> {
    if (!this.containerId) {
      throw new Error('Container not initialized');
    }

    const fullPath = this.resolvePath(path);

    // 使用 base64 编码读取文件（避免特殊字符问题）
    const result = await this.execInContainer(
      `cat ${escapeShellArg(fullPath)} | base64`
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file: ${result.stderr || 'File not found'}`);
    }

    return Buffer.from(result.stdout.trim(), 'base64').toString();
  }

  /**
   * 检查文件是否存在
   *
   * @param path - 文件路径
   * @returns 是否存在
   */
  protected async doFileExists(path: string): Promise<boolean> {
    if (!this.containerId) {
      throw new Error('Container not initialized');
    }

    const fullPath = this.resolvePath(path);

    const result = await this.execInContainer(
      `test -e ${escapeShellArg(fullPath)} && echo "exists"`
    );

    return result.stdout.trim() === 'exists';
  }

  /**
   * 列出目录内容
   *
   * @param path - 目录路径
   * @returns 文件/目录名列表
   */
  protected async doListDir(path: string): Promise<string[]> {
    if (!this.containerId) {
      throw new Error('Container not initialized');
    }

    const fullPath = this.resolvePath(path);

    const result = await this.execInContainer(
      `ls -1 ${escapeShellArg(fullPath)}`
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list directory: ${result.stderr || 'Directory not found'}`);
    }

    return result.stdout
      .trim()
      .split('\n')
      .filter((name) => name.length > 0);
  }

  // ==========================================================================
  // 资源使用情况
  // ==========================================================================

  /**
   * 获取容器资源使用情况
   *
   * @returns 资源使用统计
   */
  protected async getResourceUsage(): Promise<ResourceUsage | undefined> {
    if (!this.containerId) {
      return undefined;
    }

    try {
      // 使用 docker stats 获取资源使用情况
      const result = await runDockerCommand([
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        this.containerId,
      ], { timeout: 5000 });

      if (result.exitCode !== 0) {
        return undefined;
      }

      const stats = JSON.parse(result.stdout.trim());

      // 解析 CPU 使用率（去除百分号）
      const cpuPercent = parseFloat(stats.CPUPerc?.replace('%', '') || '0');

      // 解析内存使用量
      const memUsage = stats.MemUsage?.split('/')[0]?.trim() || '0';
      const memoryBytes = parseMemoryLimit(memUsage);

      // 解析网络 I/O
      const netIO = stats.NetIO?.split('/') || ['0', '0'];
      const networkRxBytes = parseMemoryLimit(netIO[0]?.trim() || '0');
      const networkTxBytes = parseMemoryLimit(netIO[1]?.trim() || '0');

      // 解析磁盘 I/O
      const blockIO = stats.BlockIO?.split('/') || ['0', '0'];
      const diskReadBytes = parseMemoryLimit(blockIO[0]?.trim() || '0');
      const diskWriteBytes = parseMemoryLimit(blockIO[1]?.trim() || '0');

      return {
        cpuPercent,
        memoryBytes,
        networkRxBytes,
        networkTxBytes,
        diskReadBytes,
        diskWriteBytes,
      };
    } catch {
      return undefined;
    }
  }

  // ==========================================================================
  // 私有辅助方法
  // ==========================================================================

  /**
   * 检查 Docker 是否可用
   *
   * 验证 Docker 守护进程是否运行并可访问
   */
  private async checkDockerAvailable(): Promise<void> {
    try {
      const result = await runDockerCommand(['version', '--format', '{{.Server.Version}}'], {
        timeout: 5000,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Docker daemon is not responding: ${result.stderr || 'Unknown error'}`
        );
      }
    } catch (error) {
      // 提供更友好的错误提示
      if (error instanceof TimeoutError) {
        throw new Error(
          'Docker is not available: Connection to Docker daemon timed out. ' +
          'Please ensure Docker is installed and running.'
        );
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // 检查是否是命令未找到错误
      if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
        throw new Error(
          'Docker is not available: The "docker" command was not found. ' +
          'Please install Docker and ensure it is in your PATH.'
        );
      }

      throw new Error(`Docker is not available: ${errorMessage}`);
    }
  }

  /**
   * 根据配置拉取镜像
   */
  private async pullImageIfNeeded(): Promise<void> {
    const { image, pullPolicy = 'if-not-present' } = this.dockerConfig;

    if (pullPolicy === 'never') {
      return;
    }

    if (pullPolicy === 'if-not-present') {
      // 检查镜像是否存在
      const result = await runDockerCommand(['image', 'inspect', image], {
        timeout: 5000,
      });

      if (result.exitCode === 0) {
        return;
      }
    }

    // 拉取镜像
    const pullResult = await runDockerCommand(['pull', image], {
      timeout: 300000, // 5 分钟超时
    });

    if (pullResult.exitCode !== 0) {
      throw new Error(`Failed to pull image ${image}: ${pullResult.stderr}`);
    }
  }

  /**
   * 创建并启动容器
   */
  private async createContainer(): Promise<void> {
    const { image, runArgs = [], tty = false, labels = {} } = this.dockerConfig;
    const { resources, network, env = {}, filesystem } = this.config;

    // 构建 docker run 参数
    const args: string[] = [
      'run',
      '-d', // 后台运行
      '--name', this.containerName,
      '--workdir', this.workdir,
    ];

    // 资源限制
    if (resources.cpu) {
      args.push('--cpus', resources.cpu);
    }
    if (resources.memory) {
      args.push('--memory', resources.memory);
    }
    if (resources.pidsLimit) {
      args.push('--pids-limit', resources.pidsLimit.toString());
    }

    // 网络配置
    args.push('--network', mapNetworkMode(network.mode));

    // DNS 配置
    if (network.dnsServers) {
      for (const dns of network.dnsServers) {
        args.push('--dns', dns);
      }
    }

    // 环境变量
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }

    // 挂载点
    if (filesystem?.mounts) {
      for (const mount of filesystem.mounts) {
        const mountOpt = mount.mode === 'ro' ? ':ro' : '';
        args.push('-v', `${mount.source}:${mount.target}${mountOpt}`);
      }
    }

    // TTY
    if (tty) {
      args.push('-t');
    }

    // 标签
    for (const [key, value] of Object.entries(labels)) {
      args.push('--label', `${key}=${value}`);
    }

    // 额外参数
    args.push(...runArgs);

    // 镜像和启动命令（保持容器运行）
    args.push(image, 'tail', '-f', '/dev/null');

    // 创建容器
    const result = await runDockerCommand(args, {
      timeout: 60000,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create container: ${result.stderr}`);
    }

    this.containerId = result.stdout.trim();

    // 等待容器启动
    await this.waitForContainerReady();

    // 创建工作目录
    await this.execInContainer(`mkdir -p ${escapeShellArg(this.workdir)}`);
  }

  /**
   * 等待容器就绪
   */
  private async waitForContainerReady(): Promise<void> {
    const maxAttempts = 10;
    const delay = 500;

    for (let i = 0; i < maxAttempts; i++) {
      const result = await runDockerCommand([
        'inspect',
        '--format',
        '{{.State.Running}}',
        this.containerId!,
      ], { timeout: 5000 });

      if (result.stdout.trim() === 'true') {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error('Container failed to start');
  }

  /**
   * 在容器中执行命令
   *
   * @param command - 要执行的命令
   * @param options - 执行选项
   * @returns 执行结果
   */
  private async execInContainer(
    command: string,
    options?: ExecutionOptions
  ): Promise<DockerExecResult> {
    if (!this.containerId) {
      throw new Error('Container not initialized');
    }

    const args: string[] = ['exec'];

    // 设置工作目录
    const cwd = options?.cwd || this.workdir;
    args.push('-w', cwd);

    // 设置环境变量
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // 容器 ID 和命令（containerId 在此时已经确保存在）
    args.push(this.containerId!, DOCKER_DEFAULTS.shell, '-c', command);

    const timeout = options?.timeout ?? this.config.timeout;

    // 构建选项对象，只在有 stdin 时才添加
    const execOptions: { timeout: number; stdin?: string } = { timeout };
    if (options?.stdin) {
      execOptions.stdin = options.stdin;
    }

    return runDockerCommand(args, execOptions);
  }

  /**
   * 解析文件路径（相对于工作目录）
   *
   * @param path - 文件路径
   * @returns 绝对路径
   */
  private resolvePath(path: string): string {
    if (path.startsWith('/')) {
      return path;
    }
    return `${this.workdir}/${path}`;
  }

  // ==========================================================================
  // 公共方法
  // ==========================================================================

  /**
   * 获取容器 ID
   */
  getContainerId(): string | undefined {
    return this.containerId;
  }

  /**
   * 获取容器名称
   */
  getContainerName(): string {
    return this.containerName;
  }

  /**
   * 获取容器信息
   */
  async getContainerInfo(): Promise<DockerContainerInfo | undefined> {
    if (!this.containerId) {
      return undefined;
    }

    try {
      const result = await runDockerCommand([
        'inspect',
        '--format',
        '{{json .}}',
        this.containerId,
      ], { timeout: 5000 });

      if (result.exitCode !== 0) {
        return undefined;
      }

      const info = JSON.parse(result.stdout.trim());

      const containerInfo: DockerContainerInfo = {
        containerId: this.containerId,
        status: info.State.Status as DockerContainerInfo['status'],
        createdAt: new Date(info.Created).getTime(),
      };

      // 只在有 startedAt 时才添加
      if (info.State.StartedAt) {
        containerInfo.startedAt = new Date(info.State.StartedAt).getTime();
      }

      return containerInfo;
    } catch {
      return undefined;
    }
  }
}

// ============================================================================
// Docker 沙盒池（连接池复用机制）
// ============================================================================

/**
 * Docker 沙盒池配置
 */
export interface DockerSandboxPoolConfig {
  /** 最小池大小 */
  minSize: number;
  /** 最大池大小 */
  maxSize: number;
  /** 空闲超时时间（毫秒） */
  idleTimeout: number;
  /** 预热沙盒配置 */
  sandboxConfig: SandboxConfig;
}

/**
 * 池化沙盒条目
 */
interface PooledSandbox {
  sandbox: DockerSandbox;
  inUse: boolean;
  lastUsedAt: number;
  createdAt: number;
}

/**
 * Docker 沙盒池
 *
 * 提供沙盒复用机制，减少容器创建开销
 *
 * @example
 * ```ts
 * const pool = new DockerSandboxPool({
 *   minSize: 1,
 *   maxSize: 5,
 *   idleTimeout: 300000,
 *   sandboxConfig: createSandboxConfig({ runtime: 'docker' }),
 * });
 *
 * await pool.initialize();
 *
 * // 获取沙盒
 * const sandbox = await pool.acquire();
 *
 * // 使用沙盒
 * await sandbox.runCommand('echo hello');
 *
 * // 释放沙盒（归还池中）
 * await pool.release(sandbox);
 *
 * // 关闭池
 * await pool.close();
 * ```
 */
export class DockerSandboxPool {
  private readonly config: DockerSandboxPoolConfig;
  private readonly pool = new Map<string, PooledSandbox>();
  private idleCheckTimer?: Timer;
  private closed = false;

  constructor(config: DockerSandboxPoolConfig) {
    this.config = config;
  }

  /**
   * 初始化池（预热最小数量的沙盒）
   */
  async initialize(): Promise<void> {
    // 预热最小数量的沙盒
    const warmupPromises: Promise<void>[] = [];

    for (let i = 0; i < this.config.minSize; i++) {
      warmupPromises.push(this.createAndAddSandbox());
    }

    await Promise.all(warmupPromises);

    // 启动空闲检查
    this.startIdleCheck();
  }

  /**
   * 获取一个可用的沙盒
   *
   * @returns 沙盒实例
   */
  async acquire(): Promise<DockerSandbox> {
    if (this.closed) {
      throw new Error('Pool is closed');
    }

    // 查找空闲沙盒
    for (const entry of this.pool.values()) {
      if (!entry.inUse && entry.sandbox.status === 'running') {
        entry.inUse = true;
        entry.lastUsedAt = Date.now();
        return entry.sandbox;
      }
    }

    // 如果池未满，创建新沙盒
    if (this.pool.size < this.config.maxSize) {
      await this.createAndAddSandbox();

      // 获取刚创建的沙盒
      for (const entry of this.pool.values()) {
        if (!entry.inUse && entry.sandbox.status === 'running') {
          entry.inUse = true;
          entry.lastUsedAt = Date.now();
          return entry.sandbox;
        }
      }
    }

    // 池已满，等待可用沙盒
    return this.waitForAvailableSandbox();
  }

  /**
   * 释放沙盒（归还池中）
   *
   * @param sandbox - 要释放的沙盒
   *
   * 安全说明：仅清理 /tmp 和工作目录下的临时文件，
   * 不清理挂载的宿主目录，避免意外删除重要数据
   */
  async release(sandbox: DockerSandbox): Promise<void> {
    const entry = this.pool.get(sandbox.id);
    if (!entry) {
      // 沙盒不属于此池，直接销毁
      await sandbox.destroy();
      return;
    }

    entry.inUse = false;
    entry.lastUsedAt = Date.now();

    // 安全地重置沙盒状态
    // 仅清理临时文件，保留挂载目录结构
    try {
      const workdir = this.config.sandboxConfig.filesystem?.workdir || '/workspace';
      // 清理临时代码文件（/tmp/code-*.js）
      await sandbox.runCommand('rm -f /tmp/code-*.js 2>/dev/null || true');
      // 清理工作目录下的非隐藏文件（保留 . 开头的配置文件）
      // 使用 find 更安全地清理，避免 rm -rf 的风险
      await sandbox.runCommand(
        `find ${workdir} -mindepth 1 -maxdepth 1 ! -name '.*' -exec rm -rf {} + 2>/dev/null || true`
      );
    } catch {
      // 重置失败，销毁沙盒以确保安全
      await this.removeSandbox(sandbox.id);
    }
  }

  /**
   * 关闭池（销毁所有沙盒）
   */
  async close(): Promise<void> {
    this.closed = true;

    // 停止空闲检查
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
    }

    // 销毁所有沙盒
    const destroyPromises: Promise<void>[] = [];
    for (const entry of this.pool.values()) {
      destroyPromises.push(entry.sandbox.destroy());
    }

    await Promise.all(destroyPromises);
    this.pool.clear();
  }

  /**
   * 获取池状态
   */
  getStats(): {
    total: number;
    available: number;
    inUse: number;
  } {
    let available = 0;
    let inUse = 0;

    for (const entry of this.pool.values()) {
      if (entry.inUse) {
        inUse++;
      } else if (entry.sandbox.status === 'running') {
        available++;
      }
    }

    return {
      total: this.pool.size,
      available,
      inUse,
    };
  }

  /**
   * 创建并添加沙盒到池
   */
  private async createAndAddSandbox(): Promise<void> {
    const sandbox = new DockerSandbox(undefined, this.config.sandboxConfig);
    await sandbox.initialize();

    this.pool.set(sandbox.id, {
      sandbox,
      inUse: false,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
    });
  }

  /**
   * 从池中移除沙盒
   */
  private async removeSandbox(id: string): Promise<void> {
    const entry = this.pool.get(id);
    if (entry) {
      await entry.sandbox.destroy();
      this.pool.delete(id);
    }
  }

  /**
   * 等待可用沙盒
   */
  private async waitForAvailableSandbox(): Promise<DockerSandbox> {
    const maxWait = 30000;
    const checkInterval = 100;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      for (const entry of this.pool.values()) {
        if (!entry.inUse && entry.sandbox.status === 'running') {
          entry.inUse = true;
          entry.lastUsedAt = Date.now();
          return entry.sandbox;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error('No available sandbox in pool');
  }

  /**
   * 启动空闲检查
   */
  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      this.cleanupIdleSandboxes();
    }, 30000); // 每 30 秒检查一次
  }

  /**
   * 清理空闲沙盒
   */
  private async cleanupIdleSandboxes(): Promise<void> {
    if (this.closed) {
      return;
    }

    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, entry] of this.pool.entries()) {
      // 保留最小数量的沙盒
      if (this.pool.size - toRemove.length <= this.config.minSize) {
        break;
      }

      // 检查是否超时
      if (!entry.inUse && now - entry.lastUsedAt > this.config.idleTimeout) {
        toRemove.push(id);
      }
    }

    // 移除超时的沙盒
    for (const id of toRemove) {
      await this.removeSandbox(id);
    }
  }
}

// ============================================================================
// 工具函数导出
// ============================================================================

/**
 * 检查 Docker 是否可用
 *
 * @returns 是否可用
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await runDockerCommand(['version'], { timeout: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * 获取 Docker 版本
 *
 * @returns Docker 版本号
 */
export async function getDockerVersion(): Promise<string | undefined> {
  try {
    const result = await runDockerCommand(['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000,
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}
