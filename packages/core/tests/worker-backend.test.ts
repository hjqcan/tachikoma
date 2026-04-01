/**
 * Worker Backend 单元测试
 *
 * 测试 Worker Backend 模块：
 * - 类型定义和辅助函数
 * - 后端工厂逻辑
 * - GenericAgentBackend 执行流程
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type {
  WorkerBackendConfig,
  WorkerMessage,
  WorkerTask,
  IWorkerBackend,
} from '../src/worker';
import {
  createWorkerMessage,
  isClaudeProvider,
  shouldUseAgentSDK,
  getBackendInfo,
  GenericAgentBackend,
} from '../src/worker';
import type { LLMClient, LLMRequest, LLMResponse } from '../src/planner/types';
import type { Tool } from '../src/types';

// ============================================================================
// Mock LLM Client
// ============================================================================

/**
 * 创建 Mock LLM Client
 */
function createMockLLMClient(responses: string[]): LLMClient {
  let callIndex = 0;

  return {
    provider: 'mock',
    complete: async (request: LLMRequest): Promise<LLMResponse> => {
      const response = responses[callIndex % responses.length] || 'Done.';
      callIndex++;
      return {
        content: response,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
        stopReason: 'stop',
      };
    },
    isAvailable: () => true,
  };
}

/**
 * 创建简单的工具
 */
function createMockTool(name: string, handler: (input: unknown) => unknown): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { properties: {}, type: 'object' },
    execute: async (input) => handler(input),
  };
}

// ============================================================================
// 类型辅助函数测试
// ============================================================================

describe('Worker Backend 类型辅助函数', () => {
  describe('createWorkerMessage', () => {
    it('应创建带时间戳的思考消息', () => {
      const msg = createWorkerMessage('thinking', { content: 'I am thinking...' });

      expect(msg.type).toBe('thinking');
      expect(msg.content).toBe('I am thinking...');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('应创建工具调用消息', () => {
      const msg = createWorkerMessage('tool_call', {
        tool: 'read_file',
        input: { path: '/test.txt' },
        callId: 'call-123',
      });

      expect(msg.type).toBe('tool_call');
      expect(msg.tool).toBe('read_file');
      expect(msg.input).toEqual({ path: '/test.txt' });
      expect(msg.callId).toBe('call-123');
    });

    it('应创建状态消息', () => {
      const msg = createWorkerMessage('status', {
        status: 'thinking',
        progress: 50,
      });

      expect(msg.type).toBe('status');
      expect(msg.status).toBe('thinking');
      expect(msg.progress).toBe(50);
    });
  });

  describe('isClaudeProvider', () => {
    it('应识别 Anthropic 提供商', () => {
      const config: WorkerBackendConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
      };

      expect(isClaudeProvider(config)).toBe(true);
    });

    it('应识别非 Claude 提供商', () => {
      const config: WorkerBackendConfig = {
        provider: 'openai',
        model: 'gpt-4o',
      };

      expect(isClaudeProvider(config)).toBe(false);
    });
  });

  describe('shouldUseAgentSDK', () => {
    it('Claude 提供商默认使用 Agent SDK', () => {
      const config: WorkerBackendConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
      };

      expect(shouldUseAgentSDK(config)).toBe(true);
    });

    it('可以强制禁用 Agent SDK', () => {
      const config: WorkerBackendConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        useAgentSDK: false,
      };

      expect(shouldUseAgentSDK(config)).toBe(false);
    });

    it('非 Claude 提供商不使用 Agent SDK', () => {
      const config: WorkerBackendConfig = {
        provider: 'openai',
        model: 'gpt-4o',
      };

      expect(shouldUseAgentSDK(config)).toBe(false);
    });
  });
});

// ============================================================================
// 后端工厂测试
// ============================================================================

describe('getBackendInfo', () => {
  it('返回 Claude Agent SDK 后端信息', () => {
    const config: WorkerBackendConfig = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    };

    const info = getBackendInfo(config);

    expect(info.type).toBe('agent-sdk');
    expect(info.provider).toBe('anthropic');
    expect(info.requiresExtraDependency).toBe(true);
    expect(info.dependencyPackage).toBe('@anthropic-ai/claude-agent-sdk');
  });

  it('返回 OpenAI Agents SDK 后端信息', () => {
    const config: WorkerBackendConfig = {
      provider: 'openai',
      model: 'gpt-4o',
    };

    const info = getBackendInfo(config);

    expect(info.type).toBe('agent-sdk');
    expect(info.provider).toBe('openai');
    expect(info.requiresExtraDependency).toBe(true);
    expect(info.dependencyPackage).toBe('@openai/agents');
  });

  it('OpenAI 强制使用 generic 后端时返回通用后端信息', () => {
    const config: WorkerBackendConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      backend: 'generic',
    };

    const info = getBackendInfo(config);

    expect(info.type).toBe('generic');
    expect(info.provider).toBe('openai');
    expect(info.requiresExtraDependency).toBe(false);
  });

  it('强制禁用 Agent SDK 时返回通用后端信息', () => {
    const config: WorkerBackendConfig = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      useAgentSDK: false,
    };

    const info = getBackendInfo(config);

    expect(info.type).toBe('generic');
    expect(info.provider).toBe('anthropic');
    expect(info.requiresExtraDependency).toBe(false);
  });
});

// ============================================================================
// GenericAgentBackend 测试
// ============================================================================

describe('GenericAgentBackend', () => {
  let backend: GenericAgentBackend;

  afterEach(async () => {
    if (backend) {
      await backend.dispose();
    }
  });

  describe('基本属性', () => {
    it('应正确初始化后端', () => {
      const mockClient = createMockLLMClient(['Done.']);
      backend = new GenericAgentBackend({
        provider: 'mock',
        model: 'mock-model',
        llmClient: mockClient,
      });

      expect(backend.provider).toBe('mock');
      expect(backend.backendType).toBe('generic');
      expect(backend.isAvailable()).toBe(true);
    });

    it('应返回基本能力', () => {
      const mockClient = createMockLLMClient(['Done.']);
      backend = new GenericAgentBackend({
        provider: 'mock',
        model: 'mock-model',
        llmClient: mockClient,
      });

      const capabilities = backend.getCapabilities();

      expect(capabilities).toContain('code-execution');
    });
  });

  describe('执行流程', () => {
    it('应执行简单任务并返回消息流', async () => {
      const mockClient = createMockLLMClient([
        'I will complete this task. Done.',
      ]);

      backend = new GenericAgentBackend({
        provider: 'mock',
        model: 'mock-model',
        llmClient: mockClient,
      });

      const task: WorkerTask = {
        id: 'test-task-1',
        type: 'atomic',
        objective: 'Say hello',
        // @ts-expect-error status field legacy
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const messages: WorkerMessage[] = [];
      for await (const msg of backend.execute(task, [], {})) {
        messages.push(msg);
      }

      // 验证消息流
      const statusMessages = messages.filter((m) => m.type === 'status');
      const thinkingMessages = messages.filter((m) => m.type === 'thinking');
      const outputMessages = messages.filter((m) => m.type === 'output');

      expect(statusMessages.length).toBeGreaterThan(0);
      expect(thinkingMessages.length).toBeGreaterThan(0);
      expect(outputMessages.length).toBeGreaterThan(0);

      // 验证状态转换
      expect(statusMessages[0]?.type === 'status' && statusMessages[0].status).toBe('initializing');
      expect(statusMessages.some((m) => m.type === 'status' && m.status === 'completed')).toBe(true);
    });

    it('应处理工具调用', async () => {
      const mockClient = createMockLLMClient([
        'I need to use a tool.\n<tool_use>\n<name>test_tool</name>\n<input>{"value": 42}</input>\n</tool_use>',
        'The tool returned a result. Task complete.',
      ]);

      const toolExecuted = { called: false, input: null as unknown };
      const mockTool = createMockTool('test_tool', (input) => {
        toolExecuted.called = true;
        toolExecuted.input = input;
        return { result: 'success' };
      });

      backend = new GenericAgentBackend({
        provider: 'mock',
        model: 'mock-model',
        llmClient: mockClient,
      });

      const task: WorkerTask = {
        id: 'test-task-2',
        type: 'atomic',
        objective: 'Use a tool',
        // @ts-expect-error status field legacy
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const messages: WorkerMessage[] = [];
      for await (const msg of backend.execute(task, [mockTool], {})) {
        messages.push(msg);
      }

      // 验证工具调用
      expect(toolExecuted.called).toBe(true);
      expect(toolExecuted.input).toEqual({ value: 42 });

      // 验证消息流包含工具调用和结果
      const toolCallMessages = messages.filter((m) => m.type === 'tool_call');
      const toolResultMessages = messages.filter((m) => m.type === 'tool_result');

      expect(toolCallMessages.length).toBeGreaterThan(0);
      expect(toolResultMessages.length).toBeGreaterThan(0);
    });

    it('应将 ToolResult.success=false 视为 functional error 并下沉为失败 tool_result', async () => {
      const mockClient = createMockLLMClient([
        'Call a tool.\n<tool_use>\n<name>failing_tool</name>\n<input>{"path":"missing.txt"}</input>\n</tool_use>',
        'Done.',
      ]);

      const failingTool = createMockTool('failing_tool', () => ({
        success: false,
        error: 'File missing',
      }));

      backend = new GenericAgentBackend({
        provider: 'mock',
        model: 'mock-model',
        llmClient: mockClient,
      });

      const task: WorkerTask = {
        id: 'test-task-functional-failure',
        type: 'atomic',
        objective: 'Handle functional tool failure',
        // @ts-expect-error status field legacy
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const messages: WorkerMessage[] = [];
      for await (const msg of backend.execute(task, [failingTool], {})) {
        messages.push(msg);
      }

      const toolResults = messages.filter((m): m is Extract<WorkerMessage, { type: 'tool_result' }> => m.type === 'tool_result');
      expect(toolResults.length).toBeGreaterThan(0);
      expect(toolResults[0]?.success).toBe(false);

      const payload = toolResults[0]?.result;
      const parsed =
        typeof payload === 'string'
          ? (JSON.parse(payload) as Record<string, unknown>)
          : (payload as Record<string, unknown>);
      expect(parsed.code).toBe('TOOL_FUNCTIONAL_ERROR');
      expect(parsed.isError).toBe(true);
    });

    it('应支持中断执行', async () => {
      // 创建一个会多次回复的客户端
      const mockClient = createMockLLMClient([
        'Thinking...',
        'Still thinking...',
        'More thinking...',
        'Done.',
      ]);

      backend = new GenericAgentBackend({
        provider: 'mock',
        model: 'mock-model',
        llmClient: mockClient,
      });

      const task: WorkerTask = {
        id: 'test-task-3',
        type: 'atomic',
        objective: 'Long task',
        // @ts-expect-error status field legacy
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const messages: WorkerMessage[] = [];
      let interrupted = false;

      // 在短时间后中断
      setTimeout(() => {
        backend.interrupt();
        interrupted = true;
      }, 50);

      for await (const msg of backend.execute(task, [], {})) {
        messages.push(msg);
        if (interrupted) break;
      }

      // 执行应该已被中断
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('错误处理', () => {
    it('应处理 LLM 错误', async () => {
      // Mock console.error
      const originalConsoleError = console.error;
      console.error = () => {};

      try {
        const errorClient: LLMClient = {
          provider: 'mock',
          complete: async () => {
            throw new Error('Rate limit exceeded');
          },
          isAvailable: () => true,
        };

        backend = new GenericAgentBackend({
          provider: 'mock',
          model: 'mock-model',
          llmClient: errorClient,
        });

        const task: WorkerTask = {
          id: 'test-task-4',
          type: 'atomic',
          objective: 'Fail task',
          // @ts-expect-error status field legacy
        status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const messages: WorkerMessage[] = [];
        for await (const msg of backend.execute(task, [], {})) {
          messages.push(msg);
        }

        // 验证错误消息
        const errorMessages = messages.filter((m) => m.type === 'error');
        expect(errorMessages.length).toBeGreaterThan(0);
        expect(errorMessages[0]?.type === 'error' && errorMessages[0].error).toContain('Rate limit');
        expect(errorMessages[0]?.type === 'error' && errorMessages[0].retryable).toBe(true);

        // 验证最终状态为失败
        const statusMessages = messages.filter((m) => m.type === 'status');
        expect(statusMessages.some((m) => m.type === 'status' && m.status === 'failed')).toBe(true);
      } finally {
        console.error = originalConsoleError;
      }
    });
  });
});

// ============================================================================
// 快照测试
// ============================================================================

describe('Worker Backend 快照', () => {
  it('WorkerMessage 类型结构', () => {
    const thinkingMsg = createWorkerMessage('thinking', { content: 'test' });
    const toolCallMsg = createWorkerMessage('tool_call', {
      tool: 'test',
      input: {},
      callId: 'id-1',
    });
    const statusMsg = createWorkerMessage('status', { status: 'idle' });

    expect({
      thinking: { ...thinkingMsg, timestamp: 0 },
      tool_call: { ...toolCallMsg, timestamp: 0 },
      status: { ...statusMsg, timestamp: 0 },
    }).toMatchSnapshot();
  });

  it('Backend 能力列表', () => {
    const mockClient = createMockLLMClient([]);
    const backend = new GenericAgentBackend({
      provider: 'mock',
      model: 'mock-model',
      llmClient: mockClient,
    });

    expect(backend.getCapabilities()).toMatchSnapshot();
  });
});
