import type {
  ToolErrorContext,
  ToolMiddleware,
  ToolResultContext,
} from './types';

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface ToolRuntimeLogMiddlewareOptions {
  backend: string;
  logger?: Pick<Console, 'debug' | 'warn'>;
}

export function createToolRuntimeLogMiddleware(
  options: ToolRuntimeLogMiddlewareOptions
): ToolMiddleware {
  const logger = options.logger ?? console;

  const logToolResult = (ctx: ToolResultContext): void => {
    const outcome = ctx.success ? 'success' : 'failed';
    logger.debug(
      `[${options.backend}] tool_result ${ctx.call.toolName} (${ctx.call.callId}) ` +
        `outcome=${outcome} isError=${String(ctx.isError)} durationMs=${ctx.durationMs}`
    );
  };

  const logToolError = (ctx: ToolErrorContext): void => {
    const message = stringifyUnknown(ctx.error);
    const suffix = ctx.errorCode ? ` code=${ctx.errorCode}` : '';
    logger.warn(
      `[${options.backend}] tool_error ${ctx.call.toolName} (${ctx.call.callId})${suffix}: ${message}`
    );
  };

  return {
    beforeToolCall(ctx) {
      logger.debug(
        `[${options.backend}] tool_call ${ctx.toolName} (${ctx.callId})`
      );
      return ctx;
    },
    afterToolResult(ctx) {
      logToolResult(ctx);
      return ctx;
    },
    onToolError(ctx) {
      logToolError(ctx);
      return null;
    },
  };
}
