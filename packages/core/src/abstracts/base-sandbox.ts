/**
 * Sandbox 抽象基类
 *
 * 提供 Sandbox 接口的基础实现，处理通用字段和生命周期管理
 */

import type {
  Sandbox,
  SandboxStatus,
  SandboxConfig,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
} from '../types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Sandbox 生命周期钩子
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
 * Sandbox 日志上下文
 */
export interface SandboxLogContext {
  sandboxId: string;
  status: SandboxStatus;
  runtime: string;
  [key: string]: unknown;
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
 *   protected async doExecute(code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
 *     // Docker 特定的代码执行逻辑
 *   }
 *
 *   protected async doRunCommand(command: string): Promise<CommandResult> {
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

  constructor(id: string, config: SandboxConfig) {
    this.id = id;
    this.config = config;
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
      await this.hooks.onCreate?.();
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  /**
   * 执行代码
   */
  async execute(code: string, options?: ExecutionOptions): Promise<ExecutionResult> {
    this.ensureRunning();

    try {
      await this.hooks.onBeforeExecute?.(code);
      const result = await this.doExecute(code, options);
      await this.hooks.onAfterExecute?.(code, result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.hooks.onError?.(err);
      throw err;
    }
  }

  /**
   * 写入文件
   */
  async writeFile(path: string, content: string): Promise<void> {
    this.ensureRunning();

    try {
      await this.doWriteFile(path, content);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.hooks.onError?.(err);
      throw err;
    }
  }

  /**
   * 读取文件
   */
  async readFile(path: string): Promise<string> {
    this.ensureRunning();

    try {
      return await this.doReadFile(path);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.hooks.onError?.(err);
      throw err;
    }
  }

  /**
   * 运行命令
   */
  async runCommand(command: string): Promise<CommandResult> {
    this.ensureRunning();

    try {
      await this.hooks.onBeforeCommand?.(command);
      const result = await this.doRunCommand(command);
      await this.hooks.onAfterCommand?.(command, result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.hooks.onError?.(err);
      throw err;
    }
  }

  /**
   * 销毁沙盒
   */
  async destroy(): Promise<void> {
    if (this._status === 'stopped') {
      return;
    }

    try {
      await this.hooks.onBeforeDestroy?.();
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
   * 写入文件的具体逻辑
   */
  protected abstract doWriteFile(path: string, content: string): Promise<void>;

  /**
   * 读取文件的具体逻辑
   */
  protected abstract doReadFile(path: string): Promise<string>;

  /**
   * 运行命令的具体逻辑
   */
  protected abstract doRunCommand(command: string): Promise<CommandResult>;

  /**
   * 销毁沙盒的具体逻辑
   */
  protected abstract doDestroy(): Promise<void>;
}

