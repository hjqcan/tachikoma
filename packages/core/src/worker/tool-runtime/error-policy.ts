import type { ToolCallContext, ToolResultContext } from './types';

export interface ToolErrorPolicyInput {
  call: ToolCallContext;
  error: unknown;
  errorCode?: string;
  durationMs: number;
}

export interface ToolErrorPolicy {
  toRecoverableResult(input: ToolErrorPolicyInput): ToolResultContext;
}

export interface SyntheticToolFailureOutputOptions {
  toolName: string;
  code: string;
  error: string;
  kind?: 'functional' | 'execution';
  hint?: string;
  recoveryActions?: string[];
  details?: Record<string, unknown>;
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

function inferErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('not found')) return 'TOOL_NOT_FOUND';
  if (normalized.includes('timeout')) return 'TOOL_TIMEOUT';
  if (normalized.includes('permission') || normalized.includes('denied')) {
    return 'TOOL_PERMISSION_DENIED';
  }
  if (normalized.includes('invalid') || normalized.includes('schema')) {
    return 'TOOL_VALIDATION_ERROR';
  }
  return 'TOOL_RUNTIME_ERROR';
}

function buildHint(code: string): string {
  switch (code) {
    case 'TOOL_NOT_FOUND':
      return 'Call a tool listed in Available tools and verify the exact tool name.';
    case 'TOOL_TIMEOUT':
      return 'Retry with smaller input scope or a shorter command.';
    case 'TOOL_PERMISSION_DENIED':
      return 'Use an allowed tool/operation or request approval when needed.';
    case 'TOOL_VALIDATION_ERROR':
      return 'Fix tool arguments to match the schema and required fields.';
    default:
      return 'Inspect tool input/output and retry with a minimal reproducible call.';
  }
}

export function createSyntheticToolFailureOutput(
  options: SyntheticToolFailureOutputOptions
): Record<string, unknown> {
  const hint = options.hint ?? buildHint(options.code);
  const recoveryActions =
    options.recoveryActions ??
    [
      'Check available tool names and call schema.',
      'Retry with narrower input and explicit parameters.',
    ];

  return {
    success: false,
    isError: true,
    synthetic: true,
    errorType: options.kind === 'execution' ? 'execution_failure' : 'functional_error',
    tool: options.toolName,
    code: options.code,
    error: options.error,
    hint,
    recoveryActions,
    ...(options.details ? { details: options.details } : {}),
  };
}

export function createDefaultToolErrorPolicy(): ToolErrorPolicy {
  return {
    toRecoverableResult(input) {
      const message = toErrorMessage(input.error);
      const code = input.errorCode ?? inferErrorCode(message);
      const output = createSyntheticToolFailureOutput({
        toolName: input.call.toolName,
        code,
        error: message,
        kind: 'execution',
      });

      return {
        call: input.call,
        success: false,
        isError: true,
        output,
        durationMs: input.durationMs,
      };
    },
  };
}
