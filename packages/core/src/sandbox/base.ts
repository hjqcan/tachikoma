/**
 * Sandbox 基类
 *
 * 提供 Sandbox 接口的抽象实现，处理通用字段和生命周期管理
 * 子类需要实现具体的 runtime 逻辑（Docker、Local 等）
 */

import type {
  Sandbox,
  SandboxStatus,
  SandboxConfig,
  SandboxStateInfo,
  SandboxLifecycleHooks,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  ResourceUsage,
} from './types';

// ============================================================================
// 自定义错误类型
// ============================================================================

/**
 * 超时错误
 *
 * 用于区分超时导致的错误，上层可通过 instanceof TimeoutError 判断
 */
export class TimeoutError extends Error {
  /** 超时时间（毫秒） */
  readonly timeout: number;

  constructor(timeout: number) {
    super(`Operation timed out after ${timeout}ms`);
    this.name = 'TimeoutError';
    this.timeout = timeout;
  }
}

// ============================================================================
// 日志上下文
// ============================================================================

/**
 * Sandbox 日志上下文
 */
export interface SandboxLogContext {
  sandboxId: string;
  status: SandboxStatus;
  runtime: string;
  [key: string]: unknown;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成唯一 ID
 */
function generateSandboxId(): string {
  return `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================================
// 抽象基类
// ============================================================================

/**
 * Sandbox 抽象基类
 *
 * 提供通用的生命周期管理和状态跟踪
 *
 * @example
 * ```ts
 * class DockerSandbox extends BaseSandbox {
 *   constructor(id: string, config: SandboxConfig) {
 *     super(id, config);
 *   }
 *
 *   protected async doInitialize(): Promise<void> {
 *     // Docker 特定的初始化逻辑
 *   }
 *
 *   protected async doExecute(code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
 *     // Docker 特定的代码执行逻辑
 *   }
 *
 *   protected async doRunCommand(command: string, options?: ExecutionOptions): Promise<CommandResult> {
 *     // Docker 特定的命令执行逻辑
 *   }
 *
 *   protected async doWriteFile(path: string, content: string): Promise<void> {
 *     // Docker 特定的文件写入逻辑
 *   }
 *
 *   protected async doReadFile(path: string): Promise<string> {
 *     // Docker 特定的文件读取逻辑
 *   }
 *
 *   protected async doDestroy(): Promise<void> {
 *     // Docker 特定的销毁逻辑
 *   }
 * }
 * ```
 */
export abstract class BaseSandbox implements Sandbox {
  readonly id: string;

  /** 沙盒配置 */
  protected readonly config: SandboxConfig;

  /** 当前状态 */
  protected _status: SandboxStatus = 'creating';

  /** 生命周期钩子 */
  protected hooks: SandboxLifecycleHooks = {};

  /** 创建时间 */
  protected readonly createdAt: number;

  /** 最后活动时间 */
  protected lastActivityAt: number;

  /** 错误信息 */
  protected errorMessage?: string;

  constructor(id: string | undefined, config: SandboxConfig) {
    this.id = id || generateSandboxId();
    this.config = config;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
  }

  // ==========================================================================
  // 公共属性
  // ==========================================================================

  /**
   * 获取当前状态
   */
  get status(): SandboxStatus {
    return this._status;
  }

  // ==========================================================================
  // 公共方法
  // ==========================================================================

  /**
   * 初始化沙盒
   * 在沙盒可用之前调用此方法
   */
  async initialize(): Promise<void> {
    if (this._status !== 'creating') {
      throw new Error(`Cannot initialize sandbox in status: ${this._status}`);
    }

    try {
      await this.doInitialize();
      this._status = 'running';
      this.updateLastActivity();
      await this.safeCallHook('onCreate');
    } catch (error) {
      this._status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * 执行代码
   */
  async execute(code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    this.ensureRunning();
    this.updateLastActivity();

    try {
      await this.safeCallHook('onBeforeExecute', code);
      const result = await this.withTimeout(
        () => this.doExecute(code, options),
        options?.timeout ?? this.config.timeout
      );
      await this.safeCallHook('onAfterExecute', code, result);
      return result;
    } catch (error) {
      // 如果是超时错误，返回带 timedOut 标记的结果
      if (error instanceof TimeoutError) {
        return {
          success: false,
          stdout: '',
          stderr: error.message,
          exitCode: -1,
          duration: error.timeout,
          timedOut: true,
        };
      }
      const err = error instanceof Error ? error : new Error(String(error));
      await this.safeCallHook('onError', err);
      throw err;
    }
  }

  /**
   * 运行命令
   */
  async runCommand(command: string, options?: ExecutionOptions): Promise<CommandResult> {
    this.ensureRunning();
    this.updateLastActivity();

    try {
      await this.safeCallHook('onBeforeCommand', command);
      const result = await this.withTimeout(
        () => this.doRunCommand(command, options),
        options?.timeout ?? this.config.timeout
      );
      await this.safeCallHook('onAfterCommand', command, result);
      return result;
    } catch (error) {
      // 如果是超时错误，返回带 timedOut 标记的结果
      if (error instanceof TimeoutError) {
        return {
          command,
          success: false,
          stdout: '',
          stderr: error.message,
          exitCode: -1,
          duration: error.timeout,
          timedOut: true,
        };
      }
      const err = error instanceof Error ? error : new Error(String(error));
      await this.safeCallHook('onError', err);
      throw err;
    }
  }

  /**
   * 写入文件
   */
  async writeFile(path: string, content: string): Promise<void> {
    this.ensureRunning();
    this.updateLastActivity();

    try {
      await this.doWriteFile(path, content);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.safeCallHook('onError', err);
      throw err;
    }
  }

  /**
   * 读取文件
   */
  async readFile(path: string): Promise<string> {
    this.ensureRunning();
    this.updateLastActivity();

    try {
      return await this.doReadFile(path);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.safeCallHook('onError', err);
      throw err;
    }
  }

  /**
   * 检查文件是否存在
   */
  async fileExists(path: string): Promise<boolean> {
    this.ensureRunning();
    this.updateLastActivity();

    try {
      return await this.doFileExists(path);
    } catch (_error) {
      // 文件不存在不应该抛出错误，返回 false
      return false;
    }
  }

  /**
   * 列出目录内容
   */
  async listDir(path: string): Promise<string[]> {
    this.ensureRunning();
    this.updateLastActivity();

    try {
      return await this.doListDir(path);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.safeCallHook('onError', err);
      throw err;
    }
  }

  /**
   * 获取状态信息
   */
  async getStateInfo(): Promise<SandboxStateInfo> {
    const resourceUsage = await this.getResourceUsage();

    const info: SandboxStateInfo = {
      status: this._status,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };

    // 仅在有值时设置可选属性
    if (this.errorMessage !== undefined) {
      info.error = this.errorMessage;
    }
    if (resourceUsage !== undefined) {
      info.resourceUsage = resourceUsage;
    }

    return info;
  }

  /**
   * 销毁沙盒
   */
  async destroy(): Promise<void> {
    if (this._status === 'stopped') {
      return;
    }

    try {
      await this.safeCallHook('onBeforeDestroy');
      await this.doDestroy();
    } finally {
      this._status = 'stopped';
    }
  }

  // ==========================================================================
  // 状态和上下文方法
  // ==========================================================================

  /**
   * 获取日志上下文
   */
  getLogContext(): SandboxLogContext {
    return {
      sandboxId: this.id,
      status: this._status,
      runtime: this.config.runtime,
    };
  }

  /**
   * 设置生命周期钩子
   */
  setHooks(hooks: SandboxLifecycleHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /**
   * 获取配置副本
   */
  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  // ==========================================================================
  // 保护方法
  // ==========================================================================

  /**
   * 确保沙盒处于运行状态
   */
  protected ensureRunning(): void {
    if (this._status !== 'running') {
      throw new Error(`Sandbox ${this.id} is not running (status: ${this._status})`);
    }
  }

  /**
   * 更新最后活动时间
   */
  protected updateLastActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * 带超时的执行
   */
  protected async withTimeout<T>(
    fn: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(timeout));
      }, timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * 安全调用生命周期钩子
   *
   * 捕获钩子异常，记录警告但不中断主流程
   */
  protected async safeCallHook<K extends keyof SandboxLifecycleHooks>(
    hookName: K,
    ...args: Parameters<NonNullable<SandboxLifecycleHooks[K]>>
  ): Promise<void> {
    const hook = this.hooks[hookName];
    if (!hook) {
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (hook as (...args: any[]) => Promise<void>)(...args);
    } catch (error) {
      console.warn(
        `[Sandbox ${this.id}] Hook '${hookName}' threw an error:`,
        error
      );
      // 不重新抛出，避免中断主流程
    }
  }

  /**
   * 获取资源使用情况（子类可覆盖）
   */
  protected async getResourceUsage(): Promise<ResourceUsage | undefined> {
    // 默认实现不提供资源使用信息
    return undefined;
  }

  // ==========================================================================
  // 抽象方法（子类必须实现）
  // ==========================================================================

  /**
   * 初始化沙盒的具体逻辑
   */
  protected abstract doInitialize(): Promise<void>;

  /**
   * 执行代码的具体逻辑
   */
  protected abstract doExecute(code: string, options?: ExecutionOptions): Promise<ExecutionResult>;

  /**
   * 运行命令的具体逻辑
   */
  protected abstract doRunCommand(command: string, options?: ExecutionOptions): Promise<CommandResult>;

  /**
   * 写入文件的具体逻辑
   */
  protected abstract doWriteFile(path: string, content: string): Promise<void>;

  /**
   * 读取文件的具体逻辑
   */
  protected abstract doReadFile(path: string): Promise<string>;

  /**
   * 检查文件是否存在的具体逻辑
   */
  protected abstract doFileExists(path: string): Promise<boolean>;

  /**
   * 列出目录内容的具体逻辑
   */
  protected abstract doListDir(path: string): Promise<string[]>;

  /**
   * 销毁沙盒的具体逻辑
   */
  protected abstract doDestroy(): Promise<void>;
}
