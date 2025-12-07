/**
 * Sandbox 模块类型定义
 *
 * 定义沙盒相关的所有类型、接口和枚举
 * 基于 PRD 6.3 和任务 5.1 设计
 */

// ============================================================================
// 运行时枚举
// ============================================================================

/**
 * 沙盒运行时类型
 *
 * - docker: Docker 容器隔离（生产环境推荐）
 * - firecracker: Firecracker microVM（高安全性场景）
 * - local: 本地进程执行（仅开发/测试使用）
 */
export type SandboxRuntime = 'docker' | 'firecracker' | 'local';

/**
 * 沙盒运行时配置映射
 * 用于运行时特定的配置参数
 */
export interface RuntimeConfig {
  docker: DockerRuntimeConfig;
  firecracker: FirecrackerRuntimeConfig;
  local: LocalRuntimeConfig;
}

/**
 * Docker 运行时配置
 */
export interface DockerRuntimeConfig {
  /** Docker 镜像名称 */
  image: string;
  /** 是否自动拉取镜像 */
  pullPolicy?: 'always' | 'if-not-present' | 'never';
  /** 额外的 Docker 运行参数 */
  runArgs?: string[];
  /** 是否启用 TTY */
  tty?: boolean;
  /** 容器标签 */
  labels?: Record<string, string>;
}

/**
 * Firecracker 运行时配置
 */
export interface FirecrackerRuntimeConfig {
  /** 内核镜像路径 */
  kernelImage: string;
  /** 根文件系统路径 */
  rootfs: string;
  /** vCPU 数量 */
  vcpuCount?: number;
  /** 内存大小（MB） */
  memSizeMib?: number;
}

/**
 * 本地运行时配置（仅开发/测试）
 */
export interface LocalRuntimeConfig {
  /** Shell 路径 */
  shell?: string;
  /** 是否继承环境变量 */
  inheritEnv?: boolean;
  /** 允许的命令白名单（安全限制） */
  allowedCommands?: string[];
}

// ============================================================================
// 网络配置
// ============================================================================

/**
 * 网络模式
 *
 * - none: 完全隔离，无网络访问
 * - restricted: 受限访问，仅允许 allowlist 中的域名
 * - full: 完全网络访问（不推荐用于生产）
 */
export type NetworkMode = 'none' | 'restricted' | 'full';

/**
 * 沙盒网络配置
 */
export interface SandboxNetworkConfig {
  /** 网络模式 */
  mode: NetworkMode;
  /** 允许访问的域名/IP 列表（restricted 模式使用） */
  allowlist: string[];
  /** DNS 服务器（可选） */
  dnsServers?: string[];
  /** 是否允许 IPv6 */
  enableIPv6?: boolean;
}

// ============================================================================
// 资源配置
// ============================================================================

/**
 * 沙盒资源配置
 */
export interface SandboxResources {
  /** CPU 核心数（如 "0.5", "2"） */
  cpu: string;
  /** 内存限制（如 "512m", "2g"） */
  memory: string;
  /** 存储限制（如 "1g", "10g"） */
  storage: string;
  /** 进程数限制（可选） */
  pidsLimit?: number;
  /** I/O 权重（1-1000，可选） */
  ioWeight?: number;
}

/**
 * 文件系统挂载配置
 */
export interface MountConfig {
  /** 主机路径 */
  source: string;
  /** 容器内路径 */
  target: string;
  /** 挂载模式 */
  mode: 'ro' | 'rw';
  /** 挂载类型（可选） */
  type?: 'bind' | 'volume' | 'tmpfs';
}

/**
 * 文件系统配置
 */
export interface FilesystemConfig {
  /** 工作目录 */
  workdir: string;
  /** 挂载点列表 */
  mounts: MountConfig[];
  /** 临时文件目录大小限制 */
  tmpSize?: string;
}

// ============================================================================
// 沙盒配置（主配置）
// ============================================================================

/**
 * 完整沙盒配置
 *
 * 包含运行时、资源、网络、文件系统等所有配置
 */
export interface SandboxConfig {
  /** 运行时类型 */
  runtime: SandboxRuntime;
  /** 超时时间（毫秒） */
  timeout: number;
  /** 资源配置 */
  resources: SandboxResources;
  /** 网络配置 */
  network: SandboxNetworkConfig;
  /** 文件系统配置（可选） */
  filesystem?: FilesystemConfig;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 运行时特定配置（可选） */
  runtimeConfig?: RuntimeConfig[SandboxRuntime];
}

/**
 * 沙盒配置选项（用于创建沙盒时的部分配置）
 */
export type SandboxConfigOptions = Partial<Omit<SandboxConfig, 'runtime'>> & {
  runtime?: SandboxRuntime;
};

// ============================================================================
// 沙盒状态
// ============================================================================

/**
 * 沙盒状态
 *
 * - creating: 正在创建
 * - running: 运行中
 * - paused: 已暂停
 * - stopped: 已停止
 * - error: 错误状态
 */
export type SandboxStatus = 'creating' | 'running' | 'paused' | 'stopped' | 'error';

/**
 * 沙盒状态信息
 */
export interface SandboxStateInfo {
  /** 当前状态 */
  status: SandboxStatus;
  /** 创建时间 */
  createdAt: number;
  /** 最后活动时间 */
  lastActivityAt: number;
  /** 错误信息（如果有） */
  error?: string;
  /** 资源使用情况 */
  resourceUsage?: ResourceUsage;
}

/**
 * 资源使用统计
 */
export interface ResourceUsage {
  /** CPU 使用率（0-100） */
  cpuPercent: number;
  /** 内存使用量（字节） */
  memoryBytes: number;
  /** 网络接收字节数 */
  networkRxBytes: number;
  /** 网络发送字节数 */
  networkTxBytes: number;
  /** 磁盘读取字节数 */
  diskReadBytes: number;
  /** 磁盘写入字节数 */
  diskWriteBytes: number;
}

// ============================================================================
// 执行相关类型
// ============================================================================

/**
 * 执行选项
 */
export interface ExecutionOptions {
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 标准输入 */
  stdin?: string;
  /** 是否捕获输出 */
  captureOutput?: boolean;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 执行时间（毫秒） */
  duration: number;
  /** 是否超时 */
  timedOut?: boolean;
  /** 是否被信号终止 */
  signal?: string;
}

/**
 * 命令执行结果
 */
export interface CommandResult extends ExecutionResult {
  /** 执行的命令 */
  command: string;
}

/**
 * 代码执行结果
 */
export interface CodeExecutionResult extends ExecutionResult {
  /** 执行的代码（可能被截断） */
  code: string;
  /** 返回值（如果有） */
  returnValue?: unknown;
}

// ============================================================================
// 沙盒接口
// ============================================================================

/**
 * 沙盒接口
 *
 * 定义沙盒的核心操作方法
 */
export interface Sandbox {
  /** 沙盒 ID */
  readonly id: string;
  /** 当前状态 */
  readonly status: SandboxStatus;

  /**
   * 初始化沙盒
   * 在沙盒可用之前必须调用此方法
   */
  initialize(): Promise<void>;

  /**
   * 执行代码
   * @param code - 要执行的代码
   * @param options - 执行选项
   * @returns 执行结果
   */
  execute(code: string, options?: ExecutionOptions): Promise<ExecutionResult>;

  /**
   * 运行命令
   * @param command - 要执行的命令
   * @param options - 执行选项
   * @returns 命令执行结果
   */
  runCommand(command: string, options?: ExecutionOptions): Promise<CommandResult>;

  /**
   * 写入文件
   * @param path - 文件路径（相对于工作目录）
   * @param content - 文件内容
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * 读取文件
   * @param path - 文件路径（相对于工作目录）
   * @returns 文件内容
   */
  readFile(path: string): Promise<string>;

  /**
   * 检查文件是否存在
   * @param path - 文件路径
   * @returns 是否存在
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * 列出目录内容
   * @param path - 目录路径
   * @returns 文件/目录名列表
   */
  listDir(path: string): Promise<string[]>;

  /**
   * 获取状态信息
   * @returns 沙盒状态信息
   */
  getStateInfo(): Promise<SandboxStateInfo>;

  /**
   * 销毁沙盒
   * 释放所有资源
   */
  destroy(): Promise<void>;
}

// ============================================================================
// 沙盒工厂
// ============================================================================

/**
 * 沙盒创建选项
 */
export interface SandboxCreateOptions {
  /** 沙盒 ID（可选，自动生成） */
  id?: string;
  /** 配置 */
  config: SandboxConfig;
  /** 生命周期钩子 */
  hooks?: SandboxLifecycleHooks;
}

/**
 * 沙盒生命周期钩子
 */
export interface SandboxLifecycleHooks {
  /** 沙盒创建后调用 */
  onCreate?(): Promise<void>;
  /** 代码执行前调用 */
  onBeforeExecute?(code: string): Promise<void>;
  /** 代码执行后调用 */
  onAfterExecute?(code: string, result: ExecutionResult): Promise<void>;
  /** 命令执行前调用 */
  onBeforeCommand?(command: string): Promise<void>;
  /** 命令执行后调用 */
  onAfterCommand?(command: string, result: CommandResult): Promise<void>;
  /** 沙盒销毁前调用 */
  onBeforeDestroy?(): Promise<void>;
  /** 发生错误时调用 */
  onError?(error: Error): Promise<void>;
}

/**
 * 沙盒工厂接口
 */
export interface SandboxFactory {
  /**
   * 创建沙盒实例
   * @param options - 创建选项
   * @returns 沙盒实例
   */
  create(options: SandboxCreateOptions): Promise<Sandbox>;

  /**
   * 获取支持的运行时列表
   */
  getSupportedRuntimes(): SandboxRuntime[];

  /**
   * 检查运行时是否可用
   * @param runtime - 运行时类型
   */
  isRuntimeAvailable(runtime: SandboxRuntime): Promise<boolean>;
}

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认沙盒资源配置
 */
export const DEFAULT_SANDBOX_RESOURCES: SandboxResources = {
  cpu: '1',
  memory: '512m',
  storage: '1g',
  pidsLimit: 100,
};

/**
 * 默认沙盒网络配置
 */
export const DEFAULT_SANDBOX_NETWORK: SandboxNetworkConfig = {
  mode: 'restricted',
  allowlist: [
    'api.anthropic.com',
    'api.openai.com',
    'api.github.com',
  ],
};

/**
 * 默认沙盒配置
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  runtime: 'docker',
  timeout: 30000, // 30 秒
  resources: DEFAULT_SANDBOX_RESOURCES,
  network: DEFAULT_SANDBOX_NETWORK,
  env: {},
};

/**
 * 创建沙盒配置（合并默认值）
 *
 * @param options - 配置选项
 * @returns 完整配置
 */
export function createSandboxConfig(options: SandboxConfigOptions = {}): SandboxConfig {
  const config: SandboxConfig = {
    runtime: options.runtime ?? DEFAULT_SANDBOX_CONFIG.runtime,
    timeout: options.timeout ?? DEFAULT_SANDBOX_CONFIG.timeout,
    resources: {
      ...DEFAULT_SANDBOX_RESOURCES,
      ...options.resources,
    },
    network: {
      ...DEFAULT_SANDBOX_NETWORK,
      ...options.network,
      allowlist: options.network?.allowlist ?? DEFAULT_SANDBOX_NETWORK.allowlist,
    },
    env: options.env ?? {},
  };

  // 仅在提供时设置可选属性
  if (options.filesystem !== undefined) {
    config.filesystem = options.filesystem;
  }
  if (options.runtimeConfig !== undefined) {
    config.runtimeConfig = options.runtimeConfig;
  }

  return config;
}
