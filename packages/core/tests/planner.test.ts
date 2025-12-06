/**
 * Planner 模块测试
 *
 * 测试 LLM 客户端、Prompt 模板、解析器功能
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  // LLM 客户端
  createLLMClient,
  MockLLMClient,
  AnthropicLLMClient,
  OpenAILLMClient,
  LLMClientError,
  type LLMResponse,
  type LLMRequest,
  type MockLLMConfig,
  // Prompt
  PLANNING_SYSTEM_PROMPT,
  generatePlanningUserPrompt,
  generateErrorFeedbackPrompt,
  extractJsonFromResponse,
  convertToSubTasks,
  convertToExecutionPlan,
  type PlanningOutputFormat,
  // 解析器
  parsePlanningOutput,
  PlanningParser,
  ParseError,
  DEFAULT_PARSE_RETRY_CONFIG,
} from '../src/planner';

// ============================================================================
// 测试数据
// ============================================================================

const validPlanningOutput: PlanningOutputFormat = {
  reasoning: '分析任务后，我决定将其分解为三个子任务...',
  subtasks: [
    {
      id: 'subtask-1',
      objective: '设计数据库 Schema',
      constraints: ['使用 PostgreSQL', '支持事务'],
      estimatedMinutes: 30,
      dependencies: [],
    },
    {
      id: 'subtask-2',
      objective: '实现 API 接口',
      constraints: ['RESTful 风格', '包含认证'],
      estimatedMinutes: 60,
      dependencies: ['subtask-1'],
    },
    {
      id: 'subtask-3',
      objective: '编写单元测试',
      constraints: ['覆盖率 > 80%'],
      estimatedMinutes: 45,
      dependencies: ['subtask-2'],
    },
  ],
  executionPlan: {
    isParallel: false,
    steps: [
      { order: 1, subtaskIds: ['subtask-1'], parallel: false },
      { order: 2, subtaskIds: ['subtask-2'], parallel: false },
      { order: 3, subtaskIds: ['subtask-3'], parallel: false },
    ],
  },
  estimatedTotalMinutes: 135,
  complexityScore: 6,
};

const validPlanningOutputJson = JSON.stringify(validPlanningOutput);

// ============================================================================
// LLM 客户端测试
// ============================================================================

describe('LLM 客户端', () => {
  describe('createLLMClient', () => {
    it('应创建 Anthropic 客户端', () => {
      const client = createLLMClient({
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        maxTokens: 2048,
        apiKey: 'test-key',
      });
      expect(client).toBeInstanceOf(AnthropicLLMClient);
      expect(client.provider).toBe('anthropic');
    });

    it('应创建 OpenAI 客户端', () => {
      const client = createLLMClient({
        provider: 'openai',
        model: 'gpt-4',
        maxTokens: 2048,
        apiKey: 'test-key',
      });
      expect(client).toBeInstanceOf(OpenAILLMClient);
      expect(client.provider).toBe('openai');
    });

    it('应创建 Mock 客户端', () => {
      const client = createLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      });
      expect(client).toBeInstanceOf(MockLLMClient);
      expect(client.provider).toBe('mock');
    });

    it('不支持的提供商应抛出错误', () => {
      expect(() =>
        createLLMClient({
          provider: 'unknown',
          model: 'unknown-model',
          maxTokens: 2048,
        })
      ).toThrow('Unsupported LLM provider: unknown');
    });
  });

  describe('MockLLMClient', () => {
    it('应返回预设响应', async () => {
      const mockResponse: LLMResponse = {
        content: 'Mock response',
        usage: { inputTokens: 10, outputTokens: 20 },
        model: 'mock-model',
      };

      const client = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [mockResponse],
      } as MockLLMConfig);

      const response = await client.complete({
        systemPrompt: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('Mock response');
      expect(response.usage.inputTokens).toBe(10);
    });

    it('应记录调用历史', async () => {
      const client = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);

      const request: LLMRequest = {
        systemPrompt: 'Test system',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      await client.complete(request);

      const history = client.getCallHistory();
      expect(history).toHaveLength(1);
      expect(history[0].systemPrompt).toBe('Test system');
    });

    it('应模拟延迟', async () => {
      const client = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        simulateDelay: 50,
      } as MockLLMConfig);

      const start = Date.now();
      await client.complete({
        systemPrompt: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(40);
    });

    it('应模拟错误', async () => {
      const mockError = new LLMClientError('Simulated error', 'mock', 'TEST_ERROR', false);
      const client = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        simulateError: mockError,
      } as MockLLMConfig);

      await expect(
        client.complete({
          systemPrompt: 'Test',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow(LLMClientError);
    });

    it('始终显示为可用', () => {
      const client = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);

      expect(client.isAvailable()).toBe(true);
    });

    it('reset 应清空状态', async () => {
      const client = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);

      await client.complete({
        systemPrompt: 'Test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(client.getCallHistory()).toHaveLength(1);

      client.reset();

      expect(client.getCallHistory()).toHaveLength(0);
    });
  });

  describe('AnthropicLLMClient', () => {
    it('无 API 密钥时 isAvailable 返回 false', () => {
      const client = new AnthropicLLMClient({
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        maxTokens: 2048,
      });
      expect(client.isAvailable()).toBe(false);
    });

    it('有 API 密钥时 isAvailable 返回 true', () => {
      const client = new AnthropicLLMClient({
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        maxTokens: 2048,
        apiKey: 'test-key',
      });
      expect(client.isAvailable()).toBe(true);
    });

    it('无 API 密钥时 complete 应抛出错误', async () => {
      const client = new AnthropicLLMClient({
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        maxTokens: 2048,
      });

      await expect(
        client.complete({
          systemPrompt: 'Test',
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('API key is required');
    });
  });

  describe('OpenAILLMClient', () => {
    it('无 API 密钥时 isAvailable 返回 false', () => {
      const client = new OpenAILLMClient({
        provider: 'openai',
        model: 'gpt-4',
        maxTokens: 2048,
      });
      expect(client.isAvailable()).toBe(false);
    });

    it('有 API 密钥时 isAvailable 返回 true', () => {
      const client = new OpenAILLMClient({
        provider: 'openai',
        model: 'gpt-4',
        maxTokens: 2048,
        apiKey: 'test-key',
      });
      expect(client.isAvailable()).toBe(true);
    });
  });

  describe('LLMClientError', () => {
    it('应包含正确的属性', () => {
      const error = new LLMClientError('Test error', 'anthropic', 'TEST_CODE', true);
      expect(error.message).toBe('[anthropic] Test error');
      expect(error.provider).toBe('anthropic');
      expect(error.code).toBe('TEST_CODE');
      expect(error.retryable).toBe(true);
      expect(error.name).toBe('LLMClientError');
    });
  });
});

// ============================================================================
// Prompt 模板测试
// ============================================================================

describe('Prompt 模板', () => {
  describe('PLANNING_SYSTEM_PROMPT', () => {
    it('应包含关键指导内容', () => {
      expect(PLANNING_SYSTEM_PROMPT).toContain('任务规划专家');
      expect(PLANNING_SYSTEM_PROMPT).toContain('JSON 格式');
      expect(PLANNING_SYSTEM_PROMPT).toContain('subtasks');
      expect(PLANNING_SYSTEM_PROMPT).toContain('executionPlan');
    });
  });

  describe('generatePlanningUserPrompt', () => {
    it('应生成包含目标的 prompt', () => {
      const prompt = generatePlanningUserPrompt({
        objective: '实现用户认证系统',
        constraints: ['使用 JWT', '支持 OAuth'],
      });

      expect(prompt).toContain('实现用户认证系统');
      expect(prompt).toContain('使用 JWT');
      expect(prompt).toContain('支持 OAuth');
    });

    it('应处理空约束', () => {
      const prompt = generatePlanningUserPrompt({
        objective: '测试任务',
        constraints: [],
      });

      expect(prompt).toContain('测试任务');
      expect(prompt).toContain('无特殊约束');
    });

    it('应包含可用工具列表', () => {
      const prompt = generatePlanningUserPrompt({
        objective: '测试任务',
        constraints: [],
        availableTools: ['git', 'npm', 'docker'],
      });

      expect(prompt).toContain('可用工具');
      expect(prompt).toContain('git');
      expect(prompt).toContain('npm');
      expect(prompt).toContain('docker');
    });

    it('应包含子任务数量限制', () => {
      const prompt = generatePlanningUserPrompt({
        objective: '测试任务',
        constraints: [],
        maxSubtasks: 5,
      });

      expect(prompt).toContain('最多生成 5 个子任务');
    });

    it('应包含额外上下文', () => {
      const prompt = generatePlanningUserPrompt({
        objective: '测试任务',
        constraints: [],
        additionalContext: '这是一个紧急任务',
      });

      expect(prompt).toContain('额外上下文');
      expect(prompt).toContain('这是一个紧急任务');
    });
  });

  describe('generateErrorFeedbackPrompt', () => {
    it('应生成包含错误信息的 prompt', () => {
      const prompt = generateErrorFeedbackPrompt({
        originalResponse: 'Invalid JSON...',
        parseError: 'Unexpected token',
        retryCount: 1,
      });

      expect(prompt).toContain('无法正确解析');
      expect(prompt).toContain('Unexpected token');
      expect(prompt).toContain('Invalid JSON...');
      expect(prompt).toContain('第 1 次重试');
    });

    it('应截断过长的原始响应', () => {
      const longResponse = 'A'.repeat(2000);
      const prompt = generateErrorFeedbackPrompt({
        originalResponse: longResponse,
        parseError: 'Error',
        retryCount: 1,
      });

      expect(prompt).toContain('...(已截断)');
      expect(prompt.length).toBeLessThan(2500);
    });
  });

  describe('extractJsonFromResponse', () => {
    it('应提取纯 JSON', () => {
      const json = extractJsonFromResponse('{"key": "value"}');
      expect(json).toBe('{"key": "value"}');
    });

    it('应从 Markdown 代码块提取 JSON', () => {
      const response = '这是一些文本\n```json\n{"key": "value"}\n```\n更多文本';
      const json = extractJsonFromResponse(response);
      expect(json).toBe('{"key": "value"}');
    });

    it('应从无语言标记的代码块提取 JSON', () => {
      const response = '```\n{"key": "value"}\n```';
      const json = extractJsonFromResponse(response);
      expect(json).toBe('{"key": "value"}');
    });

    it('应从带有前后文本的响应中提取 JSON', () => {
      const response = '这是分析结果：{"key": "value"} 以上就是输出';
      const json = extractJsonFromResponse(response);
      expect(json).toBe('{"key": "value"}');
    });

    it('无 JSON 时应返回原始响应', () => {
      const response = '这是纯文本，没有 JSON';
      const json = extractJsonFromResponse(response);
      expect(json).toBe('这是纯文本，没有 JSON');
    });
  });

  describe('convertToSubTasks', () => {
    it('应正确转换子任务列表', () => {
      const subtasks = convertToSubTasks(validPlanningOutput, 'parent-1');

      expect(subtasks).toHaveLength(3);
      expect(subtasks[0].id).toBe('subtask-1');
      expect(subtasks[0].parentId).toBe('parent-1');
      expect(subtasks[0].objective).toBe('设计数据库 Schema');
      expect(subtasks[0].status).toBe('pending');
      expect(subtasks[0].estimatedDuration).toBe(30 * 60 * 1000); // 毫秒
    });
  });

  describe('convertToExecutionPlan', () => {
    it('应正确转换执行计划', () => {
      const plan = convertToExecutionPlan(validPlanningOutput);

      expect(plan.isParallel).toBe(false);
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0].order).toBe(1);
      expect(plan.steps[0].subtaskIds).toEqual(['subtask-1']);
    });
  });
});

// ============================================================================
// 解析器测试
// ============================================================================

describe('解析器', () => {
  describe('parsePlanningOutput', () => {
    it('应成功解析有效的 JSON', () => {
      const result = parsePlanningOutput(validPlanningOutputJson);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.subtasks).toHaveLength(3);
      expect(result.data?.complexityScore).toBe(6);
    });

    it('应从 Markdown 代码块解析', () => {
      const response = `这是分析结果：
\`\`\`json
${validPlanningOutputJson}
\`\`\`
以上就是规划`;

      const result = parsePlanningOutput(response);

      expect(result.success).toBe(true);
      expect(result.data?.subtasks).toHaveLength(3);
    });

    it('无效 JSON 应返回失败', () => {
      const result = parsePlanningOutput('{ invalid json }');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('缺少必需字段应返回失败', () => {
      const result = parsePlanningOutput('{"reasoning": "test"}');

      expect(result.success).toBe(false);
      expect(result.error).toContain('subtasks');
    });

    it('子任务缺少必需字段应返回失败', () => {
      const invalid = {
        ...validPlanningOutput,
        subtasks: [{ id: 'subtask-1' }], // 缺少 objective
      };
      const result = parsePlanningOutput(JSON.stringify(invalid));

      expect(result.success).toBe(false);
      expect(result.error).toContain('objective');
    });

    it('complexityScore 超出范围应返回失败', () => {
      const invalid = { ...validPlanningOutput, complexityScore: 15 };
      const result = parsePlanningOutput(JSON.stringify(invalid));

      expect(result.success).toBe(false);
      expect(result.error).toContain('complexityScore');
    });

    it('引用不存在的子任务 ID 应返回失败', () => {
      const invalid = {
        ...validPlanningOutput,
        executionPlan: {
          isParallel: false,
          steps: [{ order: 1, subtaskIds: ['nonexistent'], parallel: false }],
        },
      };
      const result = parsePlanningOutput(JSON.stringify(invalid));

      expect(result.success).toBe(false);
      expect(result.error).toContain('unknown subtask ID');
    });

    it('循环依赖应返回失败', () => {
      const invalid = {
        ...validPlanningOutput,
        subtasks: [
          {
            id: 'subtask-1',
            objective: 'Test',
            constraints: [],
            estimatedMinutes: 10,
            dependencies: ['subtask-1'], // 自引用
          },
        ],
        executionPlan: {
          isParallel: false,
          steps: [{ order: 1, subtaskIds: ['subtask-1'], parallel: false }],
        },
      };
      const result = parsePlanningOutput(JSON.stringify(invalid));

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot depend on itself');
    });

    it('依赖不存在的子任务应返回失败', () => {
      const invalid = {
        ...validPlanningOutput,
        subtasks: [
          {
            id: 'subtask-1',
            objective: 'Test',
            constraints: [],
            estimatedMinutes: 10,
            dependencies: ['nonexistent'],
          },
        ],
        executionPlan: {
          isParallel: false,
          steps: [{ order: 1, subtaskIds: ['subtask-1'], parallel: false }],
        },
      };
      const result = parsePlanningOutput(JSON.stringify(invalid));

      expect(result.success).toBe(false);
      expect(result.error).toContain('unknown subtask ID');
    });
  });

  describe('PlanningParser', () => {
    let mockClient: MockLLMClient;

    beforeEach(() => {
      mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);
    });

    it('首次解析成功时不应重试', async () => {
      const parser = new PlanningParser(mockClient);

      const { result, retryCount } = await parser.parseWithRetry(validPlanningOutputJson);

      expect(result.success).toBe(true);
      expect(retryCount).toBe(0);
      expect(mockClient.getCallHistory()).toHaveLength(0);
    });

    it('首次解析失败时应重试', async () => {
      // 第一次返回无效 JSON，第二次返回有效 JSON
      mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          {
            content: validPlanningOutputJson,
            usage: { inputTokens: 100, outputTokens: 200 },
            model: 'mock-model',
          },
        ],
      } as MockLLMConfig);

      const parser = new PlanningParser(mockClient);

      const { result, retryCount, totalTokens } = await parser.parseWithRetry('{ invalid }');

      expect(result.success).toBe(true);
      expect(retryCount).toBe(1);
      expect(totalTokens.input).toBe(100);
      expect(totalTokens.output).toBe(200);
    });

    it('达到最大重试次数后应返回失败', async () => {
      // 始终返回无效 JSON
      mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          { content: '{ still invalid }', usage: { inputTokens: 10, outputTokens: 10 }, model: 'mock' },
          { content: '{ still invalid }', usage: { inputTokens: 10, outputTokens: 10 }, model: 'mock' },
          { content: '{ still invalid }', usage: { inputTokens: 10, outputTokens: 10 }, model: 'mock' },
        ],
      } as MockLLMConfig);

      const parser = new PlanningParser(mockClient, { maxRetries: 3, includeErrorFeedback: true });

      const { result, retryCount } = await parser.parseWithRetry('{ invalid }');

      expect(result.success).toBe(false);
      expect(retryCount).toBe(3);
    });

    it('禁用错误反馈时不应重试', async () => {
      const parser = new PlanningParser(mockClient, {
        maxRetries: 3,
        includeErrorFeedback: false,
      });

      const { result, retryCount } = await parser.parseWithRetry('{ invalid }');

      expect(result.success).toBe(false);
      expect(retryCount).toBe(0);
      expect(mockClient.getCallHistory()).toHaveLength(0);
    });
  });

  describe('ParseError', () => {
    it('应包含正确的属性', () => {
      const error = new ParseError('Test error', 'testField', '{ raw }');

      expect(error.message).toBe('Test error');
      expect(error.field).toBe('testField');
      expect(error.rawContent).toBe('{ raw }');
      expect(error.name).toBe('ParseError');
    });
  });

  describe('DEFAULT_PARSE_RETRY_CONFIG', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_PARSE_RETRY_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_PARSE_RETRY_CONFIG.includeErrorFeedback).toBe(true);
    });
  });
});

// ============================================================================
// Planner 类测试
// ============================================================================

import { Planner, createPlanner, type PlannerOptions } from '../src/planner';
import type { OrchestratorTask, PlannerInput } from '../src/orchestrator';

describe('Planner 类', () => {
  const mockTask: OrchestratorTask = {
    id: 'task-1',
    type: 'composite',
    objective: '实现用户认证系统',
    constraints: ['使用 JWT', '支持 OAuth2'],
    priority: 'high',
    complexity: 'complex',
  };

  describe('构造函数', () => {
    it('应使用默认配置创建实例', () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      expect(planner.getConfig().defaultMaxSubtasks).toBe(10);
      expect(planner.getConfig().maxParseRetries).toBe(3);
    });

    it('应合并自定义配置', () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);

      const planner = new Planner({
        llmClient: mockClient,
        config: {
          defaultMaxSubtasks: 5,
          maxParseRetries: 2,
        },
      });

      expect(planner.getConfig().defaultMaxSubtasks).toBe(5);
      expect(planner.getConfig().maxParseRetries).toBe(2);
    });
  });

  describe('isAvailable', () => {
    it('Mock 客户端应始终可用', () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });
      expect(planner.isAvailable()).toBe(true);
    });
  });

  describe('plan', () => {
    it('应成功生成规划输出', async () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          {
            content: validPlanningOutputJson,
            usage: { inputTokens: 500, outputTokens: 300 },
            model: 'mock-model',
          },
        ],
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      const result = await planner.plan({ task: mockTask });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      expect(result.output?.taskId).toBe('task-1');
      expect(result.output?.subtasks).toHaveLength(3);
      expect(result.output?.delegation).toBeDefined();
      expect(result.output?.executionPlan).toBeDefined();
      expect(result.tokensUsed.input).toBeGreaterThan(0);
      expect(result.tokensUsed.output).toBeGreaterThan(0);
    });

    it('应正确计算委托配置', async () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          {
            content: validPlanningOutputJson,
            usage: { inputTokens: 500, outputTokens: 300 },
            model: 'mock-model',
          },
        ],
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      const result = await planner.plan({ task: mockTask });

      expect(result.output?.delegation.mode).toBe('communication');
      expect(result.output?.delegation.workerCount).toBeGreaterThanOrEqual(1);
      expect(result.output?.delegation.timeout).toBeGreaterThan(0);
      expect(result.output?.delegation.retryPolicy).toBeDefined();
    });

    it('应处理解析失败并重试', async () => {
      // 第一次返回无效 JSON，第二次返回有效 JSON
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          {
            content: '{ invalid json }',
            usage: { inputTokens: 100, outputTokens: 50 },
            model: 'mock-model',
          },
          {
            content: validPlanningOutputJson,
            usage: { inputTokens: 500, outputTokens: 300 },
            model: 'mock-model',
          },
        ],
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      const result = await planner.plan({ task: mockTask });

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(1);
    });

    it('应在解析失败后返回错误', async () => {
      // 始终返回无效 JSON
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          { content: '{ invalid }', usage: { inputTokens: 100, outputTokens: 50 }, model: 'mock' },
          { content: '{ invalid }', usage: { inputTokens: 100, outputTokens: 50 }, model: 'mock' },
          { content: '{ invalid }', usage: { inputTokens: 100, outputTokens: 50 }, model: 'mock' },
          { content: '{ invalid }', usage: { inputTokens: 100, outputTokens: 50 }, model: 'mock' },
        ],
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      const result = await planner.plan({ task: mockTask });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('应应用上下文约束', async () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          {
            content: validPlanningOutputJson,
            usage: { inputTokens: 500, outputTokens: 300 },
            model: 'mock-model',
          },
        ],
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      const result = await planner.plan({
        task: mockTask,
        contextConstraints: {
          maxExecutionTime: 60000, // 1 分钟
        },
      });

      expect(result.success).toBe(true);
      // 超时应该被限制
      expect(result.output?.delegation.timeout).toBeLessThanOrEqual(60000);
    });

    it('应支持可用工具列表', async () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        responses: [
          {
            content: validPlanningOutputJson,
            usage: { inputTokens: 500, outputTokens: 300 },
            model: 'mock-model',
          },
        ],
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      await planner.plan({
        task: mockTask,
        availableTools: ['git', 'npm', 'docker'],
      });

      // 验证 LLM 被调用且包含工具信息
      const callHistory = mockClient.getCallHistory();
      expect(callHistory).toHaveLength(1);
      expect(callHistory[0].messages[0].content).toContain('git');
      expect(callHistory[0].messages[0].content).toContain('npm');
    });

    it('应处理 LLM 错误', async () => {
      const mockClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 2048,
        simulateError: new LLMClientError('Service unavailable', 'mock', 'SERVICE_ERROR', false),
      } as MockLLMConfig);

      const planner = new Planner({ llmClient: mockClient });

      const result = await planner.plan({ task: mockTask });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Service unavailable');
    });
  });
});

describe('createPlanner 工厂函数', () => {
  it('应创建 Planner 实例', () => {
    const mockClient = new MockLLMClient({
      provider: 'mock',
      model: 'mock-model',
      maxTokens: 2048,
    } as MockLLMConfig);

    const planner = createPlanner({ llmClient: mockClient });

    expect(planner).toBeInstanceOf(Planner);
  });
});

// ============================================================================
// 集成测试
// ============================================================================

describe('Planner 模块集成测试', () => {
  it('完整流程：生成 prompt -> 模拟响应 -> 解析结果', async () => {
    // 1. 生成 prompt
    const userPrompt = generatePlanningUserPrompt({
      objective: '实现一个待办事项 API',
      constraints: ['使用 TypeScript', 'RESTful 风格'],
      maxSubtasks: 5,
    });

    expect(userPrompt).toContain('待办事项 API');

    // 2. 创建 Mock 客户端并获取响应
    const mockClient = new MockLLMClient({
      provider: 'mock',
      model: 'mock-model',
      maxTokens: 2048,
      responses: [
        {
          content: validPlanningOutputJson,
          usage: { inputTokens: 500, outputTokens: 300 },
          model: 'mock-model',
        },
      ],
    } as MockLLMConfig);

    const response = await mockClient.complete({
      systemPrompt: PLANNING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // 3. 解析响应
    const parser = new PlanningParser(mockClient);
    const { result } = await parser.parseWithRetry(response.content);

    expect(result.success).toBe(true);
    expect(result.data?.subtasks).toHaveLength(3);

    // 4. 转换为内部类型
    if (result.data) {
      const subtasks = convertToSubTasks(result.data, 'task-1');
      const executionPlan = convertToExecutionPlan(result.data);

      expect(subtasks[0].parentId).toBe('task-1');
      expect(executionPlan.steps).toHaveLength(3);
    }
  });

  it('端到端 Planner 流程', async () => {
    const mockClient = new MockLLMClient({
      provider: 'mock',
      model: 'mock-model',
      maxTokens: 2048,
      responses: [
        {
          content: validPlanningOutputJson,
          usage: { inputTokens: 500, outputTokens: 300 },
          model: 'mock-model',
        },
      ],
    } as MockLLMConfig);

    const planner = createPlanner({ llmClient: mockClient });

    const task: OrchestratorTask = {
      id: 'task-e2e',
      type: 'composite',
      objective: '构建一个博客系统',
      constraints: ['使用 Next.js', '支持 Markdown'],
      priority: 'medium',
      complexity: 'moderate',
    };

    const result = await planner.plan({
      task,
      maxSubtasks: 5,
      preferences: { preferParallel: true },
    });

    expect(result.success).toBe(true);
    expect(result.output?.taskId).toBe('task-e2e');
    expect(result.output?.subtasks.length).toBeGreaterThan(0);
    expect(result.output?.delegation.mode).toBe('communication');
    expect(result.degraded).toBe(false);
  });
});
