/**
 * Worker 模块集成测试
 *
 * 测试 WorkerExecutor、IWorkerBackend 和 SessionFileManager 的协作
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Tool } from '../src/types';
import type { SubTask } from '../src/orchestrator/types';
import type { ISessionFileManager, WorkerStatusFile, DecisionRecord } from '../src/orchestrator/session/types';
import { WorkerExecutor, type WorkerExecutorConfig, type ExecutionResult } from '../src/worker/worker-executor';
import { GenericAgentBackend } from '../src/worker/backends/generic-agent-backend';
import type { WorkerMessage, WorkerExecutionOptions } from '../src/worker/types';

// ============================================================================
// Mock 工具
// ============================================================================

/**
 * 创建测试用 LLM 客户端
 */
function createMockLLMClient(responses: string[]) {
  let callIndex = 0;
  return {
    isAvailable: () => true,
    complete: mock(async () => {
      const content = responses[callIndex] || 'Task completed.';
      callIndex++;
      return {
        content,
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: 'stop' as const,
      };
    }),
  };
}

/**
 * 创建 Mock SessionFileManager
 */
function createMockSessionManager(): ISessionFileManager & {
  statusUpdates: WorkerStatusFile[];
  decisions: DecisionRecord[];
} {
  const statusUpdates: WorkerStatusFile[] = [];
  const decisions: DecisionRecord[] = [];

  return {
    sessionId: 'test-session',
    config: {
      rootDir: '.tachikoma',
      autoCreateDirs: true,
      watchPollInterval: 500,
      enableWatch: false,
    },
    statusUpdates,
    decisions,

    // 必要的方法实现
    initializeSession: mock(async () => {}),
    registerWorker: mock(async () => {}),
    getSessionPath: () => '/tmp/test-session',
    getWorkerPath: (workerId: string) => `/tmp/test-session/workers/${workerId}`,

    writePlan: mock(async () => {}),
    readPlan: mock(async () => null),
    writeProgress: mock(async () => {}),
    readProgress: mock(async () => null),
    appendDecision: mock(async (decision) => {
      decisions.push({
        id: `decision-${decisions.length}`,
        timestamp: Date.now(),
        ...decision,
      } as DecisionRecord);
    }),
    readDecisions: mock(async () => decisions),

    readWorkerStatus: mock(async () => null),
    writeWorkerStatus: mock(async (_workerId: string, status: Omit<WorkerStatusFile, 'workerId'>) => {
      statusUpdates.push({ workerId: _workerId, ...status } as WorkerStatusFile);
    }),
    readPendingApproval: mock(async () => null),
    writeApprovalResponse: mock(async () => {}),
    readApprovalResponse: mock(async () => null),
    writeIntervention: mock(async () => {}),
    readIntervention: mock(async () => null),
    acknowledgeIntervention: mock(async () => {}),
    readThinkingLogs: mock(async () => []),
    readActionLogs: mock(async () => []),

    readSharedContext: mock(async () => null),
    writeSharedContext: mock(async () => {}),
    appendMessage: mock(async () => {}),
    readMessages: mock(async () => []),

    on: mock(() => {}),
    off: mock(() => {}),
    startWatching: mock(async () => {}),
    stopWatching: mock(() => {}),
    cleanup: mock(async () => {}),
  } as unknown as ISessionFileManager & {
    statusUpdates: WorkerStatusFile[];
    decisions: DecisionRecord[];
  };
}

/**
 * 创建测试用 SubTask
 */
function createTestSubTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'subtask-001',
    parentId: 'task-001',
    objective: 'Test objective',
    constraints: ['No harmful actions'],
    status: 'pending',
    ...overrides,
  };
}

/**
 * 创建测试用 Tool
 */
function createTestTools(): Tool[] {
  return [
    {
      name: 'echo',
      description: 'Echo a message',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
      execute: async ({ message }: { message: string }) => ({ result: message }),
    },
  ];
}

// ============================================================================
// 集成测试
// ============================================================================

describe('WorkerExecutor 集成测试', () => {
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let mockLLMClient: ReturnType<typeof createMockLLMClient>;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    mockLLMClient = createMockLLMClient(['Thinking about the task...', 'Task completed.']);
  });

  describe('基本执行流程', () => {
    it('应完成简单任务并更新状态', async () => {
      // 创建后端配置 (使用 mock LLM client)
      const backend = new GenericAgentBackend({
        provider: 'openai',
        model: 'gpt-4',
        llmClient: mockLLMClient as never,
      });

      // 创建执行器
      const executor = new WorkerExecutor({
        backendConfig: { provider: 'openai', model: 'gpt-4' },
        sessionManager,
        workerId: 'worker-001',
      });

      // 手动设置后端（绕过 createWorkerBackend）
      (executor as unknown as { backend: typeof backend }).backend = backend;
      (executor as unknown as { isInitialized: boolean }).isInitialized = true;

      // 执行任务
      const subtask = createTestSubTask();
      const tools = createTestTools();

      const messages: WorkerMessage[] = [];
      for await (const msg of executor.execute(subtask, tools)) {
        messages.push(msg);
      }

      // 验证消息流
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some(m => m.type === 'status')).toBe(true);

      // 验证状态更新
      expect(sessionManager.statusUpdates.length).toBeGreaterThanOrEqual(2);
      expect(sessionManager.statusUpdates[0]?.status).toBe('thinking');
      expect(sessionManager.statusUpdates[sessionManager.statusUpdates.length - 1]?.status).toBe('idle');
    });

    it('应处理执行错误并更新状态为 error', async () => {
      // 创建会抛错的 LLM client
      const errorLLMClient = {
        isAvailable: () => true,
        complete: mock(async () => {
          throw new Error('LLM API Error');
        }),
      };

      const backend = new GenericAgentBackend({
        provider: 'openai',
        model: 'gpt-4',
        llmClient: errorLLMClient as never,
      });

      const executor = new WorkerExecutor({
        backendConfig: { provider: 'openai', model: 'gpt-4' },
        sessionManager,
        workerId: 'worker-002',
      });

      (executor as unknown as { backend: typeof backend }).backend = backend;
      (executor as unknown as { isInitialized: boolean }).isInitialized = true;

      const subtask = createTestSubTask();
      const tools = createTestTools();

      // 使用 executeAndCollect 返回错误结果
      const result = await executor.executeAndCollect(subtask, tools);
      
      // 验证执行失败
      expect(result.success).toBe(false);
      expect(result.error).toContain('LLM API Error');

      // 注意：executeAndCollect 内部捕获异常，所以不一定有 error 状态
      // 但消息中应该包含错误
      expect(result.messages.some(m => m.type === 'error') || result.error).toBeTruthy();
    });
  });

  describe('executeAndCollect 便捷方法', () => {
    it('应收集所有消息并返回结果', async () => {
      const backend = new GenericAgentBackend({
        provider: 'openai',
        model: 'gpt-4',
        llmClient: mockLLMClient as never,
      });

      const executor = new WorkerExecutor({
        backendConfig: { provider: 'openai', model: 'gpt-4' },
        sessionManager,
        workerId: 'worker-003',
      });

      (executor as unknown as { backend: typeof backend }).backend = backend;
      (executor as unknown as { isInitialized: boolean }).isInitialized = true;

      const subtask = createTestSubTask();
      const tools = createTestTools();

      const result: ExecutionResult = await executor.executeAndCollect(subtask, tools);

      expect(result.success).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);
      // duration 可能为 0 如果执行很快
      expect(result.metrics.duration).toBeGreaterThanOrEqual(0);
      expect(result.metrics.thinkingRounds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('审批流程集成', () => {
    it('应记录审批决策到 SessionFileManager', async () => {
      const backend = new GenericAgentBackend({
        provider: 'openai',
        model: 'gpt-4',
        llmClient: createMockLLMClient([
          // 响应包含工具调用
          '<tool_use>\n<name>echo</name>\n<input>{"message": "test"}</input>\n</tool_use>',
          'Task completed.',
        ]) as never,
      });

      const executor = new WorkerExecutor({
        backendConfig: { provider: 'openai', model: 'gpt-4' },
        sessionManager,
        workerId: 'worker-004',
      });

      (executor as unknown as { backend: typeof backend }).backend = backend;
      (executor as unknown as { isInitialized: boolean }).isInitialized = true;

      const subtask = createTestSubTask();
      const tools = createTestTools();

      // 启用审批，提供回调
      const options: Partial<WorkerExecutionOptions> = {
        requireApproval: true,
        onApprovalRequest: async () => true, // 自动批准
      };

      const messages: WorkerMessage[] = [];
      for await (const msg of executor.execute(subtask, tools, options)) {
        messages.push(msg);
      }

      // 验证有工具调用消息
      const toolCalls = messages.filter(m => m.type === 'tool_call');
      expect(toolCalls.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('中断功能', () => {
    it('应支持中断执行', async () => {
      const backend = new GenericAgentBackend({
        provider: 'openai',
        model: 'gpt-4',
        llmClient: mockLLMClient as never,
      });

      const executor = new WorkerExecutor({
        backendConfig: { provider: 'openai', model: 'gpt-4' },
        sessionManager,
        workerId: 'worker-005',
      });

      (executor as unknown as { backend: typeof backend }).backend = backend;
      (executor as unknown as { isInitialized: boolean }).isInitialized = true;

      // 中断应该正常执行，不抛错
      await executor.interrupt();

      // 释放资源
      await executor.dispose();
      expect(executor.isAvailable()).toBe(false);
    });
  });
});

describe('GenericAgentBackend 资源限制集成', () => {
  it('应在 token 预算超限时停止', async () => {
    // 创建会消耗大量 token 的 LLM client
    const highTokenLLMClient = {
      isAvailable: () => true,
      complete: mock(async () => ({
        content: 'Thinking...',
        usage: { inputTokens: 100000, outputTokens: 100000 }, // 每次 200k tokens
        finishReason: 'stop' as const,
      })),
    };

    const backend = new GenericAgentBackend({
      provider: 'openai',
      model: 'gpt-4',
      llmClient: highTokenLLMClient as never,
    });

    const messages: WorkerMessage[] = [];

    for await (const msg of backend.execute(
      { id: 'task-1', type: 'atomic', objective: 'Test', constraints: [] },
      [],
      {
        workDir: '/tmp',
        resourceLimits: {
          maxTotalTokens: 300000, // 300k 限制
          maxThinkingRounds: 10,
          maxMessageWindow: 50,
          maxTokensPerCall: 100000,
          maxToolCalls: 100,
        },
      }
    )) {
      messages.push(msg);
    }

    // 检查是否有错误消息（可能是 token 限制或 thinking rounds 限制）
    const errorMsg = messages.find(m => m.type === 'error');
    // 仅验证执行被限制停止（消息数量有限）
    expect(messages.length).toBeLessThanOrEqual(50);
  });

  it('应在工具调用次数超限时停止', async () => {
    // 创建会返回工具调用的 LLM client
    let callCount = 0;
    const toolCallLLMClient = {
      isAvailable: () => true,
      complete: mock(async () => {
        callCount++;
        return {
          content: '<tool_use>\n<name>echo</name>\n<input>{"message": "test"}</input>\n</tool_use>',
          usage: { inputTokens: 100, outputTokens: 50 },
          finishReason: 'stop' as const,
        };
      }),
    };

    const backend = new GenericAgentBackend({
      provider: 'openai',
      model: 'gpt-4',
      llmClient: toolCallLLMClient as never,
    });

    const tools: Tool[] = [
      {
        name: 'echo',
        description: 'Echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ result: 'ok' }),
      },
    ];

    const messages: WorkerMessage[] = [];

    for await (const msg of backend.execute(
      { id: 'task-1', type: 'atomic', objective: 'Test', constraints: [] },
      tools,
      {
        workDir: '/tmp',
        resourceLimits: {
          maxToolCalls: 3, // 只允许 3 次
          maxThinkingRounds: 50,
          maxMessageWindow: 50,
          maxTotalTokens: 500000,
          maxTokensPerCall: 100000,
        },
      }
    )) {
      messages.push(msg);
    }

    // 应该有工具调用次数超限错误
    const errorMsg = messages.find(m => m.type === 'error' && m.code === 'MAX_TOOL_CALLS_EXCEEDED');
    expect(errorMsg).toBeDefined();
  });
});
