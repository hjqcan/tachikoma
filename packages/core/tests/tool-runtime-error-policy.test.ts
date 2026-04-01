import { describe, expect, test } from 'bun:test';
import type { ToolCallContext } from '../src/worker/tool-runtime';
import {
  ToolRuntimeKernel,
  createDefaultToolErrorPolicy,
  createResolvedToolsetSnapshot,
  createSyntheticToolFailureOutput,
} from '../src/worker/tool-runtime';

const EMPTY_TOOLSET = createResolvedToolsetSnapshot([]);

function createCall(toolName: string): ToolCallContext {
  return {
    taskId: 'task-1',
    callId: `${toolName}-call`,
    toolName,
    input: {},
    toolset: EMPTY_TOOLSET,
    metadata: {},
  };
}

describe('tool-runtime error policy', () => {
  test('createSyntheticToolFailureOutput should produce standard synthetic payload', () => {
    const output = createSyntheticToolFailureOutput({
      toolName: 'file_read',
      code: 'TOOL_NOT_FOUND',
      error: 'Tool not found: file_read',
      kind: 'functional',
    });

    expect(output.success).toBe(false);
    expect(output.isError).toBe(true);
    expect(output.synthetic).toBe(true);
    expect(output.errorType).toBe('functional_error');
    expect(output.code).toBe('TOOL_NOT_FOUND');
  });

  test('default policy should map thrown errors into recoverable synthetic result', () => {
    const policy = createDefaultToolErrorPolicy();
    const result = policy.toRecoverableResult({
      call: createCall('file_read'),
      error: new Error('Tool not found: file_read'),
      durationMs: 12,
    });

    const output = result.output as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(output.synthetic).toBe(true);
    expect(output.code).toBe('TOOL_NOT_FOUND');
    expect(output.errorType).toBe('execution_failure');
  });

  test('runtime kernel should honor provided errorCode when recovering unhandled errors', async () => {
    const kernel = new ToolRuntimeKernel();
    const result = await kernel.execute({
      taskId: 'task-1',
      toolName: 'shell_run',
      input: { command: 'echo hello' },
      toolset: EMPTY_TOOLSET,
      errorCode: 'TOOL_EXECUTION_ERROR',
      recoverUnhandledErrors: true,
      execute: async () => {
        throw new Error('command failed');
      },
    });

    const output = result.output as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(output.synthetic).toBe(true);
    expect(output.code).toBe('TOOL_EXECUTION_ERROR');
    expect(output.errorType).toBe('execution_failure');
  });
});
