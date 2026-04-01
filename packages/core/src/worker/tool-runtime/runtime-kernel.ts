import { createResolvedToolsetSnapshot } from './resolved-toolset';
import type {
  ToolCallContext,
  ToolErrorContext,
  ToolMiddleware,
  ToolResultContext,
  ToolRuntimeEvent,
  ToolRuntimeExecuteParams,
} from './types';
import { createDefaultToolErrorPolicy, type ToolErrorPolicy } from './error-policy';

export interface ToolRuntimeKernelConfig {
  middlewares?: ToolMiddleware[];
  onEvent?: (event: ToolRuntimeEvent) => void | Promise<void>;
  errorPolicy?: ToolErrorPolicy;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function generateCallId(toolName: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${toolName}-${Date.now()}-${suffix}`;
}

export class ToolRuntimeKernel {
  private readonly middlewares: ToolMiddleware[];
  private readonly onEvent?: ToolRuntimeKernelConfig['onEvent'];
  private readonly errorPolicy: ToolErrorPolicy;

  constructor(config: ToolRuntimeKernelConfig = {}) {
    this.middlewares = config.middlewares ?? [];
    this.onEvent = config.onEvent;
    this.errorPolicy = config.errorPolicy ?? createDefaultToolErrorPolicy();
  }

  private async emitEvent(event: ToolRuntimeEvent): Promise<void> {
    if (!this.onEvent) return;
    await this.onEvent(event);
  }

  async execute(params: ToolRuntimeExecuteParams): Promise<ToolResultContext> {
    const startedAt = Date.now();
    let call: ToolCallContext = {
      taskId: params.taskId,
      callId: params.callId ?? generateCallId(params.toolName),
      toolName: params.toolName,
      input: params.input,
      toolset: params.toolset ?? createResolvedToolsetSnapshot([]),
      metadata: params.metadata ?? {},
    };

    await this.emitEvent({
      type: 'tool_call_started',
      timestamp: startedAt,
      call,
    });

    for (const middleware of this.middlewares) {
      if (typeof middleware.beforeToolCall === 'function') {
        call = await middleware.beforeToolCall(call);
      }
    }

    try {
      const rawResult = await params.execute(call);
      let result: ToolResultContext = {
        call,
        success: rawResult.success,
        isError: rawResult.isError ?? !rawResult.success,
        output: rawResult.output,
        durationMs: Date.now() - startedAt,
      };

      for (const middleware of this.middlewares) {
        if (typeof middleware.afterToolResult === 'function') {
          result = await middleware.afterToolResult(result);
        }
      }

      await this.emitEvent({
        type: result.success ? 'tool_call_finished' : 'tool_call_failed',
        timestamp: Date.now(),
        call,
        result,
      });

      return result;
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const errorContext: ToolErrorContext = {
        call,
        error,
        ...(params.errorCode !== undefined && { errorCode: params.errorCode }),
      };

      await this.emitEvent({
        type: 'tool_call_failed',
        timestamp: Date.now(),
        call,
        errorMessage,
        ...(params.errorCode !== undefined && { errorCode: params.errorCode }),
      });

      for (const middleware of this.middlewares) {
        if (typeof middleware.onToolError !== 'function') continue;
        const recovered = await middleware.onToolError(errorContext);
        if (!recovered) continue;

        let recoveredResult = recovered;
        for (const afterMiddleware of this.middlewares) {
          if (typeof afterMiddleware.afterToolResult === 'function') {
            recoveredResult = await afterMiddleware.afterToolResult(recoveredResult);
          }
        }

        await this.emitEvent({
          type: 'tool_call_recovered',
          timestamp: Date.now(),
          call,
          result: recoveredResult,
          errorMessage,
          ...(params.errorCode !== undefined && { errorCode: params.errorCode }),
        });

        return recoveredResult;
      }

      if (params.recoverUnhandledErrors) {
        let recoveredResult = this.errorPolicy.toRecoverableResult({
          call,
          error,
          durationMs: Date.now() - startedAt,
          ...(params.errorCode !== undefined && { errorCode: params.errorCode }),
        });

        for (const middleware of this.middlewares) {
          if (typeof middleware.afterToolResult === 'function') {
            recoveredResult = await middleware.afterToolResult(recoveredResult);
          }
        }

        await this.emitEvent({
          type: 'tool_call_recovered',
          timestamp: Date.now(),
          call,
          result: recoveredResult,
          errorMessage,
          ...(params.errorCode !== undefined && { errorCode: params.errorCode }),
        });

        return recoveredResult;
      }

      throw error;
    }
  }
}
