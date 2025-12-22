/**
 * Tool Execution Engine
 *
 * 工具执行引擎，支持并行和顺序执行模式。
 * 
 * 设计原则：
 * - 工具执行结果作为返回值，不直接 yield 消息
 * - 调用方负责消息发送和上下文管理
 * - 支持审批回调和中断信号
 */

import {
  type ParsedToolCall,
  createConcurrencyLimiter,
} from './tool-call-parser';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  call: ParsedToolCall;
  result: {
    success: boolean;
    output: unknown;
  };
  duration: number;
  approved?: boolean | undefined;
  skipped?: boolean | undefined;
  skipReason?: string | undefined;
}

/**
 * Tool Executor Event (for Generator mode)
 */
export type ToolExecutorEvent =
  | { type: 'tool_start'; call: ParsedToolCall }
  | { type: 'tool_result'; result: ToolExecutionResult }
  | { type: 'approval_required'; call: ParsedToolCall; reason: string }
  | { type: 'error'; error: Error; call?: ParsedToolCall };

/**
 * 并行执行配置
 */
export interface ParallelExecutionConfig {
  enabled: boolean;
  maxConcurrency: number;
  parallelizableTools?: string[];
  excludeTools?: string[];
}

/**
 * 工具执行器回调函数
 */
export interface ToolExecutorCallbacks {
  /**
   * 执行单个工具调用
   */
  executeTool: (call: ParsedToolCall) => Promise<{ success: boolean; output: unknown }>;
  
  /**
   * 检查工具是否需要审批
   */
  requiresApproval: (call: ParsedToolCall) => Promise<{
    required: boolean;
    reason?: string;
    category?: string;
    riskLevel?: string;
  }>;
  
  /**
   * 等待审批结果
   */
  waitForApproval: (call: ParsedToolCall, reason: string) => Promise<boolean>;
  
  /**
   * 检查是否已中断
   */
  isAborted: () => boolean;
  
  /**
   * 工具执行前回调（用于发送 tool_call 消息）
   */
  onToolStart?: (call: ParsedToolCall) => void;
  
  /**
   * 工具执行后回调（用于发送 tool_result 消息）
   */
  onToolComplete?: (result: ToolExecutionResult) => void;
}

// ============================================================================
// 并行执行器
// ============================================================================

/**
 * 并行执行安全的工具调用
 * 
 * @param calls - 已分类为可并行的工具调用
 * @param callbacks - 执行器回调
 * @param maxConcurrency - 最大并发数
 * @returns 执行结果列表
 */
export async function executeParallel(
  calls: ParsedToolCall[],
  callbacks: ToolExecutorCallbacks,
  maxConcurrency = 5
): Promise<ToolExecutionResult[]> {
  if (calls.length === 0) {
    return [];
  }

  // 先过滤掉需要审批的工具（这些应该转移到顺序队列）
  const safeCalls: ParsedToolCall[] = [];
  const needsApproval: ParsedToolCall[] = [];

  for (const call of calls) {
    const approvalCheck = await callbacks.requiresApproval(call);
    if (approvalCheck.required) {
      needsApproval.push(call);
    } else {
      safeCalls.push(call);
    }
  }

  if (needsApproval.length > 0) {
    console.debug(
      `[ToolExecutor] ${needsApproval.length} calls moved to sequential queue (requires approval)`
    );
  }

  // 通知工具执行开始
  for (const call of safeCalls) {
    callbacks.onToolStart?.(call);
  }

  // 创建并发限制器
  const limiter = createConcurrencyLimiter(maxConcurrency);

  // 构建并行执行 Promise
  const executions = safeCalls.map(async (call): Promise<ToolExecutionResult> => {
    await limiter.acquire();
    try {
      if (callbacks.isAborted()) {
        return {
          call,
          result: { success: false, output: 'Execution aborted' },
          duration: 0,
          skipped: true,
          skipReason: 'aborted',
        };
      }

      const startTime = Date.now();
      const result = await callbacks.executeTool(call);
      const duration = Date.now() - startTime;

      const execResult: ToolExecutionResult = {
        call,
        result,
        duration,
      };

      callbacks.onToolComplete?.(execResult);
      return execResult;
    } catch (error) {
      const execResult: ToolExecutionResult = {
        call,
        result: { success: false, output: String(error) },
        duration: 0,
      };
      callbacks.onToolComplete?.(execResult);
      return execResult;
    } finally {
      limiter.release();
    }
  });

  // 等待所有执行完成
  const settled = await Promise.allSettled(executions);
  
  const results: ToolExecutionResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      console.error('[ToolExecutor] Unexpected rejection:', s.reason);
    }
  }

  // 返回结果（包含需要转移到顺序队列的）
  return results;
}

/**
 * 获取需要转移到顺序队列的工具调用
 */
export async function filterApprovalRequired(
  calls: ParsedToolCall[],
  callbacks: Pick<ToolExecutorCallbacks, 'requiresApproval'>
): Promise<{ safe: ParsedToolCall[]; needsApproval: ParsedToolCall[] }> {
  const safe: ParsedToolCall[] = [];
  const needsApproval: ParsedToolCall[] = [];

  for (const call of calls) {
    const check = await callbacks.requiresApproval(call);
    if (check.required) {
      needsApproval.push(call);
    } else {
      safe.push(call);
    }
  }

  return { safe, needsApproval };
}

// ============================================================================
// 顺序执行器
// ============================================================================

/**
 * 顺序执行工具调用（支持审批）
 * 
 * @param calls - 需要顺序执行的工具调用
 * @param callbacks - 执行器回调
 * @param options - 执行选项
 * @returns 执行结果列表
 */
export async function executeSequential(
  calls: ParsedToolCall[],
  callbacks: ToolExecutorCallbacks,
  options: {
    /** 达到工具调用上限时停止 */
    maxToolCalls?: number;
    currentToolCount?: number;
  } = {}
): Promise<{
  results: ToolExecutionResult[];
  terminated: boolean;
  terminateReason?: string | undefined;
}> {
  const results: ToolExecutionResult[] = [];
  let toolCount = options.currentToolCount ?? 0;
  let terminated = false;
  let terminateReason: string | undefined;

  for (const call of calls) {
    // 检查中断
    if (callbacks.isAborted()) {
      terminated = true;
      terminateReason = 'aborted';
      break;
    }

    // 检查工具调用上限
    if (options.maxToolCalls !== undefined && toolCount >= options.maxToolCalls) {
      terminated = true;
      terminateReason = 'max_tool_calls_exceeded';
      break;
    }

    // 通知工具执行开始
    callbacks.onToolStart?.(call);

    // 检查审批
    const approvalCheck = await callbacks.requiresApproval(call);
    if (approvalCheck.required) {
      const approved = await callbacks.waitForApproval(
        call,
        approvalCheck.reason || 'Approval required'
      );

      if (!approved) {
        const result: ToolExecutionResult = {
          call,
          result: {
            success: false,
            output: `Tool call ${call.name} was rejected by approval process (${approvalCheck.reason}).`,
          },
          duration: 0,
          approved: false,
          skipped: true,
          skipReason: 'rejected',
        };
        results.push(result);
        callbacks.onToolComplete?.(result);
        continue;
      }
    }

    // 执行工具
    const startTime = Date.now();
    try {
      const execResult = await callbacks.executeTool(call);
      const duration = Date.now() - startTime;
      toolCount++;

      const result: ToolExecutionResult = {
        call,
        result: execResult,
        duration,
        approved: approvalCheck.required ? true : undefined,
      };
      results.push(result);
      callbacks.onToolComplete?.(result);

      // 检查 terminateSubtask 标志
      const output = execResult.output as Record<string, unknown> | undefined;
      if (
        output?.terminateSubtask === true ||
        (output?.data as Record<string, unknown> | undefined)?.terminateSubtask === true
      ) {
        terminated = true;
        terminateReason = 'terminate_subtask';
        break;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const result: ToolExecutionResult = {
        call,
        result: { success: false, output: String(error) },
        duration,
      };
      results.push(result);
      callbacks.onToolComplete?.(result);
    }
  }

  return { results, terminated, terminateReason };
}

/**
 * 顺序执行器 (Generator 模式)
 * 支持通过 yield 返回事件，并通过 next() 接收审批结果
 */
export async function* executeSequentialGenerator(
  calls: ParsedToolCall[],
  callbacks: Omit<ToolExecutorCallbacks, 'waitForApproval'>,
  options: {
    maxToolCalls?: number;
    currentToolCount?: number;
  } = {}
): AsyncGenerator<ToolExecutorEvent, { results: ToolExecutionResult[]; terminated: boolean; terminateReason?: string }, boolean | undefined> {
  const results: ToolExecutionResult[] = [];
  let toolCount = options.currentToolCount ?? 0;
  let terminated = false;
  let terminateReason: string | undefined;

  for (const call of calls) {
    if (callbacks.isAborted()) {
      terminated = true;
      terminateReason = 'aborted';
      break;
    }

    if (options.maxToolCalls !== undefined && toolCount >= options.maxToolCalls) {
      terminated = true;
      terminateReason = 'max_tool_calls_exceeded';
      break;
    }

    yield { type: 'tool_start', call };

    const approvalCheck = await callbacks.requiresApproval(call);
    if (approvalCheck.required) {
      // Yield approval required event and wait for input
      // Consumer should call next(true/false)
      const approved = yield { 
        type: 'approval_required', 
        call, 
        reason: approvalCheck.reason || 'Approval required' 
      };

      if (!approved) {
        const result: ToolExecutionResult = {
          call,
          result: {
            success: false,
            output: `Tool call ${call.name} was rejected by approval process (${approvalCheck.reason}).`,
          },
          duration: 0,
          approved: false,
          skipped: true,
          skipReason: 'rejected',
        };
        results.push(result);
        yield { type: 'tool_result', result };
        callbacks.onToolComplete?.(result);
        continue;
      }
    }

    const startTime = Date.now();
    try {
      const execResult = await callbacks.executeTool(call);
      const duration = Date.now() - startTime;
      toolCount++;

      const result: ToolExecutionResult = {
        call,
        result: execResult,
        duration,
        approved: approvalCheck.required ? true : undefined,
      };
      
      const output = execResult.output as Record<string, unknown> | undefined;
      // Check for terminateSubtask
      if (
        output?.terminateSubtask === true ||
        (output?.data as Record<string, unknown> | undefined)?.terminateSubtask === true
      ) {
        terminated = true;
        terminateReason = 'terminate_subtask';
      }

      results.push(result);
      yield { type: 'tool_result', result };
      callbacks.onToolComplete?.(result);

      if (terminated) break;

    } catch (error) {
      const duration = Date.now() - startTime;
      const result: ToolExecutionResult = {
        call,
        result: { success: false, output: String(error) },
        duration,
      };
      results.push(result);
      yield { type: 'tool_result', result };
      callbacks.onToolComplete?.(result);
    }
  }

  return { 
    results, 
    terminated, 
    ...(terminateReason !== undefined ? { terminateReason } : {})
  };
}

// ============================================================================
// 执行统计
// ============================================================================

/**
 * 从执行结果中计算统计数据
 */
export function computeExecutionStats(results: ToolExecutionResult[]): {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalDuration: number;
} {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let totalDuration = 0;

  for (const r of results) {
    if (r.skipped) {
      skipped++;
    } else if (r.result.success) {
      succeeded++;
    } else {
      failed++;
    }
    totalDuration += r.duration;
  }

  return {
    total: results.length,
    succeeded,
    failed,
    skipped,
    totalDuration,
  };
}
