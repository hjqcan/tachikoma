/**
 * Sandbox 工具执行器
 *
 * 提供通过 Sandbox 隔离执行工具的能力
 */

import type { Tool, ExecutionContext } from '../types';
import type { Sandbox, CommandResult } from './types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 工具执行选项
 */
export interface ToolExecutionOptions {
  /** 工作目录 */
  workDir: string;
  /** 真实执行上下文（可选） */
  executionContext?: ExecutionContext | undefined;
  /** 环境变量 */
  env?: Record<string, string> | undefined;
  /** 超时时间（毫秒） */
  timeout?: number | undefined;
  /** 安全策略 */
  securityPolicy?: SandboxSecurityPolicy | undefined;
}

/**
 * Sandbox 安全策略
 */
export interface SandboxSecurityPolicy {
  /**
   * 严格 Sandbox 模式
   *
   * 开启后禁用所有直接 execute()，要求所有工具通过 sandbox 命令执行
   * 适用于高安全场景
   */
  strictSandbox?: boolean;

  /**
   * 高风险工具名称列表
   *
   * 这些工具必须是命令型（无 execute 方法）并通过 sandbox.runCommand() 执行
   * 如果高风险工具有 execute 方法，将直接拒绝执行
   */
  highRiskTools?: string[];
}

/**
 * 默认高风险工具列表
 *
 * 这些工具必须通过 sandbox 隔离执行
 */
export const DEFAULT_HIGH_RISK_TOOLS = [
  'delete',
  'rm',
  'remove',
  'execute_shell',
  'run_command',
  'shell',
  'exec',
  'spawn',
  'system',
  'file_write',
  'create_file',
  'modify_file',
];

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  result: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  duration: number;
}

/**
 * Sandbox 工具执行器接口
 */
export interface ISandboxToolExecutor {
  /**
   * 执行工具
   *
   * @param tool - 工具定义
   * @param input - 工具输入
   * @param options - 执行选项
   * @returns 执行结果
   */
  execute(
    tool: Tool,
    input: unknown,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult>;

  /**
   * 检查是否支持隔离执行
   */
  isIsolated(): boolean;
}

// ============================================================================
// 默认实现
// ============================================================================

/**
 * 默认 Sandbox 工具执行器
 *
 * 支持两种模式：
 * 1. 隔离模式：通过 Sandbox 执行命令
 * 2. 直接模式：直接调用 tool.execute()（无隔离）
 *
 * @example
 * ```ts
 * // 隔离模式
 * const executor = new DefaultSandboxToolExecutor(sandbox);
 *
 * // 直接模式（无隔离，发出警告）
 * const executor = new DefaultSandboxToolExecutor(null);
 * ```
 */
export class DefaultSandboxToolExecutor implements ISandboxToolExecutor {
  private readonly sandbox: Sandbox | null;
  private warnedNoIsolation = false;

  constructor(sandbox: Sandbox | null) {
    this.sandbox = sandbox;
  }

  /**
   * 检查是否支持隔离执行
   */
  isIsolated(): boolean {
    return this.sandbox !== null && this.sandbox.status === 'running';
  }

  /**
   * 执行工具
   *
   * ⚠️ 安全注意事项：
   * - 高风险工具（如 delete, exec）如果有 execute 方法将被拒绝执行
   * - 开启 strictSandbox 后，所有工具都必须通过 sandbox 命令执行
   * - 有 execute 方法的 JS 工具会共享宿主进程上下文（非隔离）
   */
  async execute(
    tool: Tool,
    input: unknown,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const policy = options.securityPolicy;
    const highRiskTools = policy?.highRiskTools ?? DEFAULT_HIGH_RISK_TOOLS;

    // ========================================
    // 安全策略检查
    // ========================================

    // 检查高风险工具：必须是命令型（设置 isCommandBased）
    const isHighRisk = highRiskTools.some(
      (name) => tool.name.toLowerCase().includes(name.toLowerCase())
    );

    if (isHighRisk && !tool.isCommandBased) {
      return {
        success: false,
        result: null,
        error: `Security Policy Violation: High-risk tool "${tool.name}" must be command-based. ` +
          `Set isCommandBased: true and implement execution via sandbox.runCommand() for isolation.`,
        duration: Date.now() - startTime,
      };
    }

    // 严格 Sandbox 模式：禁用所有非命令型工具
    if (policy?.strictSandbox && !tool.isCommandBased) {
      return {
        success: false,
        result: null,
        error: `Strict Sandbox Mode: Tool "${tool.name}" is not command-based. ` +
          `All tools must have isCommandBased: true when strictSandbox is enabled.`,
        duration: Date.now() - startTime,
      };
    }

    // ========================================
    // 执行工具
    // ========================================

    try {
      let result: unknown;

      if (this.sandbox && this.sandbox.status === 'running') {
        // 隔离模式：通过 Sandbox 执行
        result = await this.executeInSandbox(tool, input, options);
      } else {
        // 直接模式：无隔离
        if (!this.warnedNoIsolation) {
          // TODO:测试阶段不显示
          // console.warn(
          //   '[SandboxToolExecutor] ⚠️ No sandbox available, executing tools without isolation.\n' +
          //     '  - Tools with execute() method will share host process context.\n' +
          //     '  - This may pose security risks for untrusted operations.\n' +
          //     '  - Consider providing a sandbox instance or using command-based tools.'
          // );
          this.warnedNoIsolation = true;
        }
        result = await this.executeDirect(tool, input, options);
      }

      return {
        success: true,
        result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 通过 Sandbox 执行工具
   */
  private async executeInSandbox(
    tool: Tool,
    input: unknown,
    options: ToolExecutionOptions
  ): Promise<unknown> {
    if (!this.sandbox) {
      throw new Error('Sandbox not available');
    }

    // 如果工具有 execute 方法，直接调用
    if (tool.execute) {
      // 创建执行上下文
      const context = {
        taskId: 'sandbox-task',
        agentId: 'sandbox',
        traceId: `trace-${Date.now()}`,
        workDir: options.workDir,
        env: options.env || {},
      };
      return await tool.execute(input, options.executionContext ?? context);
    }

    // 回退到命令执行（适用于 shell 命令类工具）
    const command = this.buildToolCommand(tool, input);
    const cmdResult: CommandResult = await this.sandbox.runCommand(command, {
      ...(options.timeout !== undefined && { timeout: options.timeout }),
    });

    if (!cmdResult.success) {
      throw new Error(cmdResult.stderr || `Tool ${tool.name} failed with exit code ${cmdResult.exitCode}`);
    }

    // 尝试解析 JSON 结果
    try {
      return JSON.parse(cmdResult.stdout);
    } catch {
      return cmdResult.stdout;
    }
  }

  /**
   * 直接执行工具（无隔离）
   */
  private async executeDirect(
    tool: Tool,
    input: unknown,
    options: ToolExecutionOptions
  ): Promise<unknown> {
    if (!tool.execute) {
      throw new Error(`Tool ${tool.name} does not have an execute method`);
    }

    // 创建执行上下文
    const context = {
      taskId: 'direct-task',
      agentId: 'direct',
      traceId: `trace-${Date.now()}`,
      workDir: options.workDir,
      env: options.env || {},
    };

    return await tool.execute(input, options.executionContext ?? context);
  }

  /**
   * 构建工具命令（用于 shell 类工具）
   *
   * ⚠️ 安全注意事项：
   * - 所有输入都经过 shell 转义处理
   * - 使用单引号包裹防止注入
   * - 命令型工具应实现自己的 commandBuilder 以获得更好的控制
   */
  private buildToolCommand(tool: Tool, input: unknown): string {
    // 将输入转换为字符串
    const inputStr = typeof input === 'string'
      ? input
      : JSON.stringify(input);

    // 转义 shell 特殊字符（防止命令注入）
    const escapedInput = this.escapeShellArg(inputStr);

    return `${tool.name} ${escapedInput}`;
  }

  /**
   * 转义 Shell 参数
   *
   * 使用单引号包裹并转义内部单引号
   * 这是最安全的 shell 参数转义方法
   */
  private escapeShellArg(arg: string): string {
    // 将单引号替换为 '\'' （结束单引号，添加转义单引号，开始新单引号）
    const escaped = arg.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Sandbox 工具执行器
 *
 * @param sandbox - Sandbox 实例（可选）
 * @returns 工具执行器
 */
export function createSandboxToolExecutor(sandbox?: Sandbox | null): ISandboxToolExecutor {
  return new DefaultSandboxToolExecutor(sandbox ?? null);
}
