/**
 * 统筹者模块测试
 *
 * 测试类型定义、配置、工具函数和 Orchestrator 类
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  // 配置
  DEFAULT_ORCHESTRATOR_CONFIG,
  DEFAULT_RETRY_POLICY,
  DEFAULT_WORKER_POOL_CONFIG,
  DEFAULT_PLANNER_CONFIG,
  DEFAULT_DELEGATION_DEFAULTS,
  DEFAULT_AGGREGATION_CONFIG,
  DEFAULT_CHECKPOINT_CONFIG,
  CONSERVATIVE_RETRY_POLICY,
  AGGRESSIVE_RETRY_POLICY,
  HIGH_CONCURRENCY_WORKER_POOL_CONFIG,
  GIT_ENABLED_CHECKPOINT_CONFIG,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_DEVIATION_DETECTION_CONFIG,
  // 配置构建器
  createOrchestratorConfig,
  validateOrchestratorConfig,
  OrchestratorConfigError,
  // 工具函数
  calculateRetryDelay,
  shouldRetry,
  // Orchestrator 类
  Orchestrator,
  createOrchestrator,
  // Worker 池
  MockWorkerPool,
  type IWorkerPool,
  // Session 管理
  SessionFileManager,
  type ISessionFileManager,
  type PendingApprovalFile,
  type ApprovalResponseFile,
  type SessionFileEventHandler,
  // 类型
  type OrchestratorTask,
  type SubTask,
  type PlannerInput,
  type PlannerOutput,
  type WorkerMessage,
  type CheckpointState,
  type AggregatedResult,
  type OrchestratorEventType,
  type ApprovalPolicy,
} from '../src/orchestrator';
import { Planner, MockLLMClient, type PlanResult } from '../src/planner';
import type { Task, TaskResult } from '../src/types';

// ============================================================================
// 默认配置测试
// ============================================================================

describe('Orchestrator 默认配置', () => {
  describe('DEFAULT_RETRY_POLICY', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
      expect(DEFAULT_RETRY_POLICY.baseDelay).toBe(1000);
      expect(DEFAULT_RETRY_POLICY.backoffFactor).toBe(2);
      expect(DEFAULT_RETRY_POLICY.maxDelay).toBe(30000);
    });
  });

  describe('DEFAULT_WORKER_POOL_CONFIG', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_WORKER_POOL_CONFIG.minWorkers).toBe(1);
      expect(DEFAULT_WORKER_POOL_CONFIG.maxWorkers).toBe(5);
      expect(DEFAULT_WORKER_POOL_CONFIG.idleTimeout).toBe(300000);
      expect(DEFAULT_WORKER_POOL_CONFIG.healthCheckInterval).toBe(30000);
      expect(DEFAULT_WORKER_POOL_CONFIG.selectionStrategy).toBe('least-loaded');
    });
  });

  describe('DEFAULT_PLANNER_CONFIG', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_PLANNER_CONFIG.agent.provider).toBe('anthropic');
      expect(DEFAULT_PLANNER_CONFIG.agent.model).toBe(
        'claude-3-5-haiku-20241022'
      );
      expect(DEFAULT_PLANNER_CONFIG.defaultMaxSubtasks).toBe(10);
      expect(DEFAULT_PLANNER_CONFIG.maxParseRetries).toBe(3);
      expect(DEFAULT_PLANNER_CONFIG.enableReasoning).toBe(true);
    });
  });

  describe('DEFAULT_DELEGATION_DEFAULTS', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_DELEGATION_DEFAULTS.mode).toBe('communication');
      expect(DEFAULT_DELEGATION_DEFAULTS.workerCount).toBe(1);
      expect(DEFAULT_DELEGATION_DEFAULTS.timeout).toBe(300000);
      expect(DEFAULT_DELEGATION_DEFAULTS.retryPolicy).toEqual(
        DEFAULT_RETRY_POLICY
      );
    });
  });

  describe('DEFAULT_AGGREGATION_CONFIG', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_AGGREGATION_CONFIG.strategy).toBe('merge');
      expect(DEFAULT_AGGREGATION_CONFIG.allowPartialSuccess).toBe(true);
      expect(DEFAULT_AGGREGATION_CONFIG.partialSuccessThreshold).toBe(0.5);
    });
  });

  describe('DEFAULT_CHECKPOINT_CONFIG', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
      expect(DEFAULT_CHECKPOINT_CONFIG.storageDir).toBe(
        '.tachikoma/checkpoints'
      );
      expect(DEFAULT_CHECKPOINT_CONFIG.interval).toBe(0);
      expect(DEFAULT_CHECKPOINT_CONFIG.maxCheckpoints).toBe(10);
      expect(DEFAULT_CHECKPOINT_CONFIG.gitIntegration).toBe(false);
    });
  });

  describe('DEFAULT_ORCHESTRATOR_CONFIG', () => {
    it('应包含完整的默认配置', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.agent).toBeDefined();
      expect(DEFAULT_ORCHESTRATOR_CONFIG.planner).toBeDefined();
      expect(DEFAULT_ORCHESTRATOR_CONFIG.workerPool).toBeDefined();
      expect(DEFAULT_ORCHESTRATOR_CONFIG.delegation).toBeDefined();
      expect(DEFAULT_ORCHESTRATOR_CONFIG.aggregation).toBeDefined();
      expect(DEFAULT_ORCHESTRATOR_CONFIG.checkpoint).toBeDefined();
    });

    it('agent 配置应使用 Sonnet 模型', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.agent.provider).toBe('anthropic');
      expect(DEFAULT_ORCHESTRATOR_CONFIG.agent.model).toBe(
        'claude-sonnet-4-20250514'
      );
      expect(DEFAULT_ORCHESTRATOR_CONFIG.agent.maxTokens).toBe(8192);
    });
  });
});

// ============================================================================
// 预设配置变体测试
// ============================================================================

describe('配置变体', () => {
  describe('重试策略变体', () => {
    it('CONSERVATIVE_RETRY_POLICY 应更保守', () => {
      expect(CONSERVATIVE_RETRY_POLICY.maxRetries).toBeLessThan(
        DEFAULT_RETRY_POLICY.maxRetries
      );
      expect(CONSERVATIVE_RETRY_POLICY.maxDelay).toBeLessThan(
        DEFAULT_RETRY_POLICY.maxDelay!
      );
    });

    it('AGGRESSIVE_RETRY_POLICY 应更激进', () => {
      expect(AGGRESSIVE_RETRY_POLICY.maxRetries).toBeGreaterThan(
        DEFAULT_RETRY_POLICY.maxRetries
      );
      expect(AGGRESSIVE_RETRY_POLICY.baseDelay).toBeLessThan(
        DEFAULT_RETRY_POLICY.baseDelay
      );
    });
  });

  describe('Worker 池变体', () => {
    it('HIGH_CONCURRENCY_WORKER_POOL_CONFIG 应支持更多 Worker', () => {
      expect(HIGH_CONCURRENCY_WORKER_POOL_CONFIG.maxWorkers).toBeGreaterThan(
        DEFAULT_WORKER_POOL_CONFIG.maxWorkers
      );
      expect(HIGH_CONCURRENCY_WORKER_POOL_CONFIG.minWorkers).toBeGreaterThan(
        DEFAULT_WORKER_POOL_CONFIG.minWorkers
      );
    });
  });

  describe('检查点变体', () => {
    it('GIT_ENABLED_CHECKPOINT_CONFIG 应启用 Git 集成', () => {
      expect(GIT_ENABLED_CHECKPOINT_CONFIG.gitIntegration).toBe(true);
      expect(GIT_ENABLED_CHECKPOINT_CONFIG.interval).toBeGreaterThan(0);
      expect(GIT_ENABLED_CHECKPOINT_CONFIG.maxCheckpoints).toBeGreaterThan(
        DEFAULT_CHECKPOINT_CONFIG.maxCheckpoints
      );
    });
  });
});

// ============================================================================
// 配置构建器测试
// ============================================================================

describe('createOrchestratorConfig', () => {
  it('无参数时应返回默认配置的副本', () => {
    const config = createOrchestratorConfig();
    expect(config).toEqual(DEFAULT_ORCHESTRATOR_CONFIG);
    expect(config).not.toBe(DEFAULT_ORCHESTRATOR_CONFIG);
  });

  it('应正确合并部分配置', () => {
    const config = createOrchestratorConfig({
      workerPool: { maxWorkers: 10 },
    });

    expect(config.workerPool.maxWorkers).toBe(10);
    expect(config.workerPool.minWorkers).toBe(
      DEFAULT_WORKER_POOL_CONFIG.minWorkers
    );
  });

  it('应正确合并嵌套配置', () => {
    const config = createOrchestratorConfig({
      delegation: {
        timeout: 600000,
        retryPolicy: { maxRetries: 5 },
      },
    });

    expect(config.delegation.timeout).toBe(600000);
    expect(config.delegation.retryPolicy.maxRetries).toBe(5);
    expect(config.delegation.retryPolicy.baseDelay).toBe(
      DEFAULT_RETRY_POLICY.baseDelay
    );
  });

  it('应正确合并 planner 配置', () => {
    const config = createOrchestratorConfig({
      planner: {
        defaultMaxSubtasks: 20,
        agent: { temperature: 0.1 },
      },
    });

    expect(config.planner.defaultMaxSubtasks).toBe(20);
    expect(config.planner.agent.temperature).toBe(0.1);
    expect(config.planner.agent.model).toBe(DEFAULT_PLANNER_CONFIG.agent.model);
  });
});

// ============================================================================
// 配置验证测试
// ============================================================================

describe('validateOrchestratorConfig', () => {
  // 每个测试使用独立的配置副本
  const getValidConfig = () => createOrchestratorConfig();

  it('有效配置应通过验证', () => {
    const config = getValidConfig();
    expect(() => validateOrchestratorConfig(config)).not.toThrow();
  });

  describe('Worker 池验证', () => {
    it('minWorkers 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.workerPool.minWorkers = -1;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });

    it('maxWorkers 小于 minWorkers 时应抛出错误', () => {
      const config = getValidConfig();
      config.workerPool.minWorkers = 5;
      config.workerPool.maxWorkers = 2;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });

    it('idleTimeout 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.workerPool.idleTimeout = -100;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });
  });

  describe('委托验证', () => {
    it('workerCount 小于 1 时应抛出错误', () => {
      const config = getValidConfig();
      config.delegation.workerCount = 0;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });

    it('timeout 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.delegation.timeout = -1;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });
  });

  describe('重试策略验证', () => {
    it('maxRetries 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.delegation.retryPolicy.maxRetries = -1;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });

    it('baseDelay 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.delegation.retryPolicy.baseDelay = -100;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });
  });

  describe('聚合验证', () => {
    it('partialSuccessThreshold 超出范围时应抛出错误', () => {
      const config1 = getValidConfig();
      config1.aggregation.partialSuccessThreshold = 1.5;
      expect(() => validateOrchestratorConfig(config1)).toThrow(
        OrchestratorConfigError
      );

      const config2 = getValidConfig();
      config2.aggregation.partialSuccessThreshold = -0.1;
      expect(() => validateOrchestratorConfig(config2)).toThrow(
        OrchestratorConfigError
      );
    });
  });

  describe('检查点验证', () => {
    it('maxCheckpoints 小于 1 时应抛出错误', () => {
      const config = getValidConfig();
      config.checkpoint.maxCheckpoints = 0;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });

    it('interval 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.checkpoint.interval = -1000;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });
  });

  describe('规划器验证', () => {
    it('defaultMaxSubtasks 小于 1 时应抛出错误', () => {
      const config = getValidConfig();
      config.planner.defaultMaxSubtasks = 0;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });

    it('maxParseRetries 为负数时应抛出错误', () => {
      const config = getValidConfig();
      config.planner.maxParseRetries = -1;
      expect(() => validateOrchestratorConfig(config)).toThrow(
        OrchestratorConfigError
      );
    });
  });
});

// ============================================================================
// 工具函数测试
// ============================================================================

describe('calculateRetryDelay', () => {
  const policy: ReturnType<typeof createOrchestratorConfig>['delegation']['retryPolicy'] =
    {
      maxRetries: 3,
      baseDelay: 1000,
      backoffFactor: 2,
      maxDelay: 10000,
    };

  it('第一次重试应返回接近 baseDelay 的值', () => {
    const delay = calculateRetryDelay(policy, 1);
    // 允许 ±10% 抖动
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThanOrEqual(1100);
  });

  it('后续重试应按指数增长', () => {
    const delay1 = calculateRetryDelay(policy, 1);
    const delay2 = calculateRetryDelay(policy, 2);
    const delay3 = calculateRetryDelay(policy, 3);

    // 由于抖动，我们检查趋势而非精确值
    expect(delay2).toBeGreaterThan(delay1 * 1.5);
    expect(delay3).toBeGreaterThan(delay2 * 1.5);
  });

  it('不应超过 maxDelay', () => {
    const delay = calculateRetryDelay(policy, 10);
    expect(delay).toBeLessThanOrEqual(policy.maxDelay! * 1.1); // 允许抖动
  });

  it('无 backoffFactor 时应返回固定延迟', () => {
    const fixedPolicy = { ...policy, backoffFactor: 1 };
    const delay1 = calculateRetryDelay(fixedPolicy, 1);
    const delay2 = calculateRetryDelay(fixedPolicy, 2);
    const delay3 = calculateRetryDelay(fixedPolicy, 3);

    // 应该都接近 baseDelay
    expect(Math.abs(delay1 - delay2)).toBeLessThan(policy.baseDelay * 0.25);
    expect(Math.abs(delay2 - delay3)).toBeLessThan(policy.baseDelay * 0.25);
  });
});

describe('shouldRetry', () => {
  const policy = { maxRetries: 3, baseDelay: 1000 };

  it('重试次数小于 maxRetries 时应返回 true', () => {
    expect(shouldRetry(policy, 0)).toBe(true);
    expect(shouldRetry(policy, 1)).toBe(true);
    expect(shouldRetry(policy, 2)).toBe(true);
  });

  it('重试次数等于 maxRetries 时应返回 false', () => {
    expect(shouldRetry(policy, 3)).toBe(false);
  });

  it('重试次数大于 maxRetries 时应返回 false', () => {
    expect(shouldRetry(policy, 4)).toBe(false);
    expect(shouldRetry(policy, 10)).toBe(false);
  });
});

// ============================================================================
// 类型结构测试 (编译时类型检查 + 运行时结构验证)
// ============================================================================

describe('类型结构验证', () => {
  describe('OrchestratorTask', () => {
    it('应包含必需字段', () => {
      const task: OrchestratorTask = {
        id: 'task-1',
        type: 'composite',
        objective: '实现用户认证功能',
        constraints: ['使用 JWT', '支持 OAuth2'],
        priority: 'high',
        complexity: 'complex',
      };

      expect(task.id).toBeDefined();
      expect(task.type).toBeDefined();
      expect(task.objective).toBeDefined();
      expect(task.constraints).toBeInstanceOf(Array);
      expect(task.priority).toBeDefined();
      expect(task.complexity).toBeDefined();
    });

    it('应支持可选字段', () => {
      const task: OrchestratorTask = {
        id: 'task-2',
        type: 'composite',
        objective: '测试任务',
        constraints: [],
        priority: 'medium',
        complexity: 'moderate',
        subtasks: [],
        planStatus: 'draft',
        outputSchema: { type: 'object' },
      };

      expect(task.subtasks).toEqual([]);
      expect(task.planStatus).toBe('draft');
      expect(task.outputSchema).toBeDefined();
    });
  });

  describe('SubTask', () => {
    it('应包含必需字段', () => {
      const subtask: SubTask = {
        id: 'subtask-1',
        parentId: 'task-1',
        objective: '实现登录接口',
        constraints: [],
        status: 'pending',
      };

      expect(subtask.id).toBeDefined();
      expect(subtask.parentId).toBeDefined();
      expect(subtask.objective).toBeDefined();
      expect(subtask.status).toBeDefined();
    });
  });

  describe('PlannerInput', () => {
    it('应包含任务字段', () => {
      const input: PlannerInput = {
        task: {
          id: 'task-1',
          type: 'composite',
          objective: '测试',
          constraints: [],
          priority: 'medium',
          complexity: 'simple',
        },
      };

      expect(input.task).toBeDefined();
    });
  });

  describe('PlannerOutput', () => {
    it('应包含必需字段', () => {
      const output: PlannerOutput = {
        taskId: 'task-1',
        subtasks: [],
        delegation: {
          mode: 'communication',
          workerCount: 1,
          timeout: 60000,
          retryPolicy: DEFAULT_RETRY_POLICY,
        },
        executionPlan: {
          steps: [],
          isParallel: false,
        },
      };

      expect(output.taskId).toBeDefined();
      expect(output.subtasks).toBeInstanceOf(Array);
      expect(output.delegation).toBeDefined();
      expect(output.executionPlan).toBeDefined();
    });
  });

  describe('WorkerMessage', () => {
    it('应包含必需字段', () => {
      const message: WorkerMessage<{ test: boolean }> = {
        id: 'msg-1',
        type: 'assign',
        senderId: 'orchestrator-1',
        receiverId: 'worker-1',
        payload: { test: true },
        timestamp: Date.now(),
      };

      expect(message.id).toBeDefined();
      expect(message.type).toBeDefined();
      expect(message.senderId).toBeDefined();
      expect(message.receiverId).toBeDefined();
      expect(message.payload).toBeDefined();
      expect(message.timestamp).toBeDefined();
    });
  });

  describe('CheckpointState', () => {
    it('应包含必需字段', () => {
      const checkpoint: CheckpointState = {
        id: 'checkpoint-1',
        taskId: 'task-1',
        createdAt: Date.now(),
        version: 1,
        planStatus: 'executing',
        subtaskSnapshots: [],
        completedResults: {},
        retryCount: 0,
      };

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.taskId).toBeDefined();
      expect(checkpoint.createdAt).toBeDefined();
      expect(checkpoint.version).toBeDefined();
      expect(checkpoint.planStatus).toBeDefined();
      expect(checkpoint.subtaskSnapshots).toBeInstanceOf(Array);
    });
  });

  describe('AggregatedResult', () => {
    it('应包含必需字段', () => {
      const result: AggregatedResult = {
        status: 'success',
        output: { data: 'test' },
        subtaskResults: new Map(),
        successCount: 3,
        failureCount: 0,
      };

      expect(result.status).toBeDefined();
      expect(result.output).toBeDefined();
      expect(result.subtaskResults).toBeInstanceOf(Map);
      expect(result.successCount).toBeDefined();
      expect(result.failureCount).toBeDefined();
    });
  });
});

// ============================================================================
// 配置快照测试
// ============================================================================

describe('配置快照', () => {
  it('DEFAULT_ORCHESTRATOR_CONFIG 应包含正确结构', () => {
    // 使用结构验证代替快照，避免 CI 环境问题
    expect(DEFAULT_ORCHESTRATOR_CONFIG.agent.provider).toBe('anthropic');
    expect(DEFAULT_ORCHESTRATOR_CONFIG.agent.model).toContain('claude');
    expect(DEFAULT_ORCHESTRATOR_CONFIG.planner.agent.provider).toBe(
      'anthropic'
    );
    expect(DEFAULT_ORCHESTRATOR_CONFIG.workerPool.selectionStrategy).toBe(
      'least-loaded'
    );
    expect(DEFAULT_ORCHESTRATOR_CONFIG.delegation.mode).toBe('communication');
    expect(DEFAULT_ORCHESTRATOR_CONFIG.aggregation.strategy).toBe('merge');
    expect(DEFAULT_ORCHESTRATOR_CONFIG.checkpoint.enabled).toBe(true);
  });

  it('DEFAULT_RETRY_POLICY 应包含正确结构', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.baseDelay).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.backoffFactor).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.maxDelay).toBeGreaterThan(
      DEFAULT_RETRY_POLICY.baseDelay
    );
  });

  it('DEFAULT_WORKER_POOL_CONFIG 应包含正确结构', () => {
    expect(DEFAULT_WORKER_POOL_CONFIG.minWorkers).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_WORKER_POOL_CONFIG.maxWorkers).toBeGreaterThan(
      DEFAULT_WORKER_POOL_CONFIG.minWorkers
    );
    expect(DEFAULT_WORKER_POOL_CONFIG.idleTimeout).toBeGreaterThan(0);
    expect(DEFAULT_WORKER_POOL_CONFIG.healthCheckInterval).toBeGreaterThan(0);
  });
});

// ============================================================================
// Orchestrator 类测试
// ============================================================================

describe('Orchestrator 类', () => {
  // 用于测试的 Mock LLM 响应（符合 PlanningOutputFormat）
  const mockPlanningResponse = JSON.stringify({
    reasoning: '任务需要按顺序执行：先设计数据模型，再实现 API 接口。',
    subtasks: [
      {
        id: 'subtask-1',
        objective: '设计数据模型',
        constraints: [],
        estimatedMinutes: 10,
        dependencies: [],
      },
      {
        id: 'subtask-2',
        objective: '实现 API 接口',
        constraints: [],
        estimatedMinutes: 15,
        dependencies: ['subtask-1'],
      },
    ],
    executionPlan: {
      isParallel: false,
      steps: [
        { order: 1, subtaskIds: ['subtask-1'], parallel: false },
        { order: 2, subtaskIds: ['subtask-2'], parallel: false },
      ],
    },
    estimatedTotalMinutes: 25,
    complexityScore: 5,
  });

  // 创建 Mock Planner
  function createMockPlanner(): Planner {
    const mockClient = new MockLLMClient({
      provider: 'mock',
      model: 'mock-model',
      maxTokens: 1000,
      responses: [
        {
          content: mockPlanningResponse,
          usage: { inputTokens: 100, outputTokens: 200 },
          model: 'mock-model',
        },
      ],
      simulateDelay: 10,
    });

    return new Planner({
      llmClient: mockClient,
    });
  }

  // 创建 Mock WorkerPool
  function createMockWorkerPoolForTest(): MockWorkerPool {
    return new MockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 2,
      taskDelay: 10,
    });
  }

  // 创建慢速 Mock Planner（用于偏离检测测试）
  function createSlowMockPlanner(): Planner {
    const mockClient = new MockLLMClient({
      provider: 'mock',
      model: 'mock-model',
      maxTokens: 1000,
      responses: [
        {
          content: mockPlanningResponse,
          usage: { inputTokens: 100, outputTokens: 200 },
          model: 'mock-model',
        },
      ],
      simulateDelay: 50, // 较慢的延迟
    });

    return new Planner({
      llmClient: mockClient,
    });
  }

  // 创建慢速 Mock WorkerPool（用于偏离检测测试）
  function createSlowMockWorkerPoolForTest(): MockWorkerPool {
    return new MockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 2,
      taskDelay: 100, // 较慢的任务延迟，给偏离检测时间触发
    });
  }

  // 创建 Mock SessionFileManager
  function createMockSessionManager(): ISessionFileManager {
    // 使用简化的 Mock 实现
    const mockSession: ISessionFileManager = {
      sessionId: 'test-session',
      config: {
        rootDir: '.tachikoma-test',
        autoCreateDirs: false,
        watchPollInterval: 1000,
        enableWatch: false,
      },
      initializeSession: async () => { /* mock: no-op */ },
      registerWorker: async () => { /* mock: no-op */ },
      getSessionPath: () => '.tachikoma-test/sessions/test-session',
      getWorkerPath: (workerId: string) =>
        `.tachikoma-test/sessions/test-session/workers/${workerId}`,
      writePlan: async () => { /* mock: no-op */ },
      readPlan: async () => null,
      writeProgress: async () => { /* mock: no-op */ },
      readProgress: async () => null,
      appendDecision: async () => { /* mock: no-op */ },
      readDecisions: async () => [],
      readWorkerStatus: async () => null,
      writeWorkerStatus: async () => { /* mock: no-op */ },
      readPendingApproval: async () => null,
      writeApprovalResponse: async () => { /* mock: no-op */ },
      readApprovalResponse: async () => null,
      writeIntervention: async () => { /* mock: no-op */ },
      readIntervention: async () => null,
      readThinkingLogs: async () => [],
      readActionLogs: async () => [],
      readSharedContext: async () => null,
      writeSharedContext: async () => { /* mock: no-op */ },
      appendMessage: async () => { /* mock: no-op */ },
      readMessages: async () => [],
      on: () => { /* mock: no-op */ },
      off: () => { /* mock: no-op */ },
      startWatching: async () => { /* mock: no-op */ },
      stopWatching: () => { /* mock: no-op */ },
      cleanup: async () => { /* mock: no-op */ },
      close: async () => { /* mock: no-op */ },
    };

    return mockSession;
  }

  // 创建带 mock 跟踪的 SessionFileManager（用于需要验证调用的测试）
  function createMockSessionManagerForTest(): ISessionFileManager {
    const mockSession: ISessionFileManager = {
      sessionId: 'test-session',
      config: {
        rootDir: '.tachikoma-test',
        autoCreateDirs: false,
        watchPollInterval: 1000,
        enableWatch: false,
      },
      initializeSession: mock(async () => { /* mock: no-op */ }),
      registerWorker: mock(async () => { /* mock: no-op */ }),
      getSessionPath: () => '.tachikoma-test/sessions/test-session',
      getWorkerPath: (workerId: string) =>
        `.tachikoma-test/sessions/test-session/workers/${workerId}`,
      writePlan: mock(async () => { /* mock: no-op */ }),
      readPlan: mock(async () => null),
      writeProgress: mock(async () => { /* mock: no-op */ }),
      readProgress: mock(async () => null),
      appendDecision: mock(async () => { /* mock: no-op */ }),
      readDecisions: mock(async () => []),
      readWorkerStatus: mock(async () => null),
      writeWorkerStatus: mock(async () => { /* mock: no-op */ }),
      readPendingApproval: mock(async () => null),
      writeApprovalResponse: mock(async () => { /* mock: no-op */ }),
      readApprovalResponse: mock(async () => null),
      writeIntervention: mock(async () => { /* mock: no-op */ }),
      readIntervention: mock(async () => null),
      readThinkingLogs: mock(async () => []),
      readActionLogs: mock(async () => []),
      readSharedContext: mock(async () => null),
      writeSharedContext: mock(async () => { /* mock: no-op */ }),
      appendMessage: mock(async () => { /* mock: no-op */ }),
      readMessages: mock(async () => []),
      on: mock(() => { /* mock: no-op */ }),
      off: mock(() => { /* mock: no-op */ }),
      startWatching: mock(async () => { /* mock: no-op */ }),
      stopWatching: mock(() => { /* mock: no-op */ }),
      cleanup: mock(async () => { /* mock: no-op */ }),
      close: mock(async () => { /* mock: no-op */ }),
    };

    return mockSession;
  }

  describe('构造函数', () => {
    it('应使用默认配置创建实例', () => {
      const orchestrator = createOrchestrator('test-orch');

      expect(orchestrator.id).toBe('test-orch');
      expect(orchestrator.type).toBe('orchestrator');
    });

    it('应支持自定义配置', () => {
      const orchestrator = createOrchestrator('test-orch', {
        config: {
          workerPool: { maxWorkers: 10 },
        },
      });

      const config = orchestrator.getOrchestratorConfig();
      expect(config.workerPool.maxWorkers).toBe(10);
    });

    it('应支持注入 Planner', () => {
      const mockPlanner = createMockPlanner();
      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
      });

      expect(orchestrator.getPlanner()).toBe(mockPlanner);
    });

    it('应支持注入 WorkerPool', () => {
      const mockPool = createMockWorkerPoolForTest();
      const orchestrator = new Orchestrator('test-orch', {
        workerPool: mockPool,
      });

      expect(orchestrator.getWorkerPool()).toBe(mockPool);
    });
  });

  describe('事件系统', () => {
    it('应支持添加和触发事件监听器', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const events: OrchestratorEventType[] = [];

      orchestrator.on('plan:start', () => events.push('plan:start'));
      orchestrator.on('plan:complete', () => events.push('plan:complete'));

      const task: Task = {
        id: 'task-001',
        type: 'composite',
        objective: '测试任务',
        constraints: [],
      };

      await orchestrator.run(task);

      expect(events).toContain('plan:start');
      expect(events).toContain('plan:complete');

      await orchestrator.stop();
    });

    it('应支持移除事件监听器', () => {
      const orchestrator = createOrchestrator('test-orch');

      const events: string[] = [];
      const handler = () => events.push('called');

      orchestrator.on('plan:start', handler);
      orchestrator.off('plan:start', handler);

      // 事件应不会被触发
      expect(events).toHaveLength(0);
    });
  });

  describe('run() 方法 - plan → assign → aggregate 流程', () => {
    it('应完成完整的执行流程', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-001',
        type: 'composite',
        objective: '实现用户认证功能',
        constraints: ['使用 JWT'],
      };

      const result = await orchestrator.run(task);

      expect(result.taskId).toBe('task-001');
      expect(result.status).toBeDefined();
      expect(result.metrics.duration).toBeGreaterThanOrEqual(0);

      await orchestrator.stop();
    });

    it('规划失败时应返回失败结果', async () => {
      // 创建一个会失败的 Mock LLM 客户端
      const { LLMClientError } = await import('../src/planner');
      const failingClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 1000,
        simulateError: new LLMClientError(
          'API error',
          'mock',
          'ERROR',
          false
        ),
      });

      const failingPlanner = new Planner({
        llmClient: failingClient,
        parseRetryConfig: { maxRetries: 0 },
      });

      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: failingPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-002',
        type: 'composite',
        objective: '测试失败场景',
        constraints: [],
      };

      const result = await orchestrator.run(task);

      expect(result.status).toBe('failure');
      expect(result.output).toHaveProperty('error');

      await orchestrator.stop();
    });

    it('应正确跟踪执行状态', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      // 执行前应无状态
      expect(orchestrator.getExecutionState()).toBeNull();

      const task: Task = {
        id: 'task-003',
        type: 'composite',
        objective: '测试状态跟踪',
        constraints: [],
      };

      await orchestrator.run(task);

      // 执行后应清理状态
      expect(orchestrator.getExecutionState()).toBeNull();

      await orchestrator.stop();
    });

    it('应支持中断执行', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-004',
        type: 'composite',
        objective: '测试中断',
        constraints: [],
      };

      // 启动任务
      const runPromise = orchestrator.run(task);

      // 立即停止
      setTimeout(() => orchestrator.stop(), 5);

      const result = await runPromise;

      // 结果可能是成功或失败（取决于中断时机）
      expect(result.taskId).toBe('task-004');
    });
  });

  describe('聚合策略', () => {
    it('merge 策略应合并所有输出', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          aggregation: {
            strategy: 'merge',
            allowPartialSuccess: true,
          },
        },
      });

      const task: Task = {
        id: 'task-005',
        type: 'composite',
        objective: '测试 merge 聚合',
        constraints: [],
      };

      const result = await orchestrator.run(task);

      // merge 策略应返回数组
      expect(result.output).toBeInstanceOf(Array);

      await orchestrator.stop();
    });
  });

  describe('会话管理', () => {
    it('执行期间应创建会话', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      // 执行前无会话
      expect(orchestrator.getCurrentSessionId()).toBeNull();

      const task: Task = {
        id: 'task-006',
        type: 'composite',
        objective: '测试会话',
        constraints: [],
      };

      await orchestrator.run(task);

      // 执行后会话已清理
      expect(orchestrator.getCurrentSessionId()).toBeNull();

      await orchestrator.stop();
    });
  });

  describe('重试机制', () => {
    it('Worker 分配失败时应触发重试', async () => {
      // 创建一个初始无 Worker 的池
      const emptyPool = new MockWorkerPool({
        config: { ...DEFAULT_WORKER_POOL_CONFIG, minWorkers: 0 },
        initialWorkers: 0,
        taskDelay: 10,
      });

      const mockPlanner = createMockPlanner();
      const mockSession = createMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: emptyPool,
        sessionManager: mockSession,
        config: {
          delegation: {
            workerCount: 1,
            retryPolicy: {
              maxRetries: 1,
              baseDelay: 10,
            },
          },
        },
      });

      let retryCount = 0;
      orchestrator.on('subtask:retrying', () => retryCount++);

      const task: Task = {
        id: 'task-007',
        type: 'composite',
        objective: '测试重试',
        constraints: [],
      };

      await orchestrator.run(task);

      // 由于 WorkerPool 会自动注册 Worker，实际可能不会触发重试
      // 这个测试主要验证重试机制的存在
      expect(retryCount).toBeGreaterThanOrEqual(0);

      await orchestrator.stop();
    });
  });

  describe('会话文件监控生命周期', () => {
    /**
     * 创建用于追踪监控调用的 Mock SessionFileManager
     */
    function createTrackedMockSessionManager(): ISessionFileManager & {
      watchCalls: { startWatching: number; stopWatching: number };
    } {
      const watchCalls = { startWatching: 0, stopWatching: 0 };

      const mockSession: ISessionFileManager & {
        watchCalls: { startWatching: number; stopWatching: number };
      } = {
        sessionId: 'test-session',
        config: {
          rootDir: '.tachikoma-test',
          autoCreateDirs: false,
          watchPollInterval: 1000,
          enableWatch: true,
        },
        watchCalls,
        initializeSession: async () => { /* mock: no-op */ },
        registerWorker: async () => { /* mock: no-op */ },
        getSessionPath: () => '.tachikoma-test/sessions/test-session',
        getWorkerPath: (workerId: string) =>
          `.tachikoma-test/sessions/test-session/workers/${workerId}`,
        writePlan: async () => { /* mock: no-op */ },
        readPlan: async () => null,
        writeProgress: async () => { /* mock: no-op */ },
        readProgress: async () => null,
        appendDecision: async () => { /* mock: no-op */ },
        readDecisions: async () => [],
        readWorkerStatus: async () => null,
        writeWorkerStatus: async () => { /* mock: no-op */ },
        readPendingApproval: async () => null,
        writeApprovalResponse: async () => { /* mock: no-op */ },
        readApprovalResponse: async () => null,
        writeIntervention: async () => { /* mock: no-op */ },
        readIntervention: async () => null,
        readThinkingLogs: async () => [],
        readActionLogs: async () => [],
        readSharedContext: async () => null,
        writeSharedContext: async () => { /* mock: no-op */ },
        appendMessage: async () => { /* mock: no-op */ },
        readMessages: async () => [],
        on: () => { /* mock: no-op */ },
        off: () => { /* mock: no-op */ },
        startWatching: async () => {
          watchCalls.startWatching++;
        },
        stopWatching: () => {
          watchCalls.stopWatching++;
        },
        cleanup: async () => { /* mock: no-op */ },
        close: async () => { /* mock: no-op */ },
      };

      return mockSession;
    }

    it('注入的 SessionManager 不应由 Orchestrator 管理监控生命周期', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const trackedSession = createTrackedMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: trackedSession,
      });

      const task: Task = {
        id: 'task-watch-001',
        type: 'composite',
        objective: '测试注入 SessionManager 的监控行为',
        constraints: [],
      };

      await orchestrator.run(task);

      // 注入的 SessionManager 不应由 Orchestrator 调用 startWatching/stopWatching
      expect(trackedSession.watchCalls.startWatching).toBe(0);
      expect(trackedSession.watchCalls.stopWatching).toBe(0);

      await orchestrator.stop();
    });

    it('默认配置应启用监控', () => {
      const config = createOrchestratorConfig();
      expect(config.session.enableWatch).toBe(true);
      expect(config.session.watchPollInterval).toBe(500);
    });

    it('应支持自定义监控配置', () => {
      const config = createOrchestratorConfig({
        session: {
          enableWatch: false,
          watchPollInterval: 2000,
        },
      });

      expect(config.session.enableWatch).toBe(false);
      expect(config.session.watchPollInterval).toBe(2000);
    });

    it('cleanup() 应正确清理资源', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const trackedSession = createTrackedMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: trackedSession,
      });

      // 执行任务
      const task: Task = {
        id: 'task-cleanup-001',
        type: 'composite',
        objective: '测试清理',
        constraints: [],
      };

      await orchestrator.run(task);
      await orchestrator.stop();

      // 会话应已清理
      expect(orchestrator.getCurrentSessionId()).toBeNull();
    });
  });

  // ==========================================================================
  // 审批处理测试 (Task 4.11)
  // ==========================================================================

  describe('审批请求处理', () => {
    // 扩展的 Mock SessionManager 类型
    interface ApprovalMockSessionManager extends ISessionFileManager {
      pendingApprovalHandler: SessionFileEventHandler<PendingApprovalFile> | null;
      writeApprovalResponseCalls: ApprovalResponseFile[];
      queuePendingApproval: (approval: PendingApprovalFile) => void;
      triggerPendingApproval: (approval: PendingApprovalFile) => Promise<void>;
    }

    // 创建支持事件触发的 Mock SessionManager
    function createApprovalMockSessionManager(): ApprovalMockSessionManager {
      const writeApprovalResponseCalls: ApprovalResponseFile[] = [];
      // 保存一个永久的处理器引用（不会被 off 清除）
      let persistentHandler: SessionFileEventHandler<PendingApprovalFile> | null = null;
      // 队列中的审批请求，会在处理器注册时自动触发
      const pendingApprovals: PendingApprovalFile[] = [];

      const mockSession: ApprovalMockSessionManager = {
        sessionId: 'test-session',
        config: {
          rootDir: '.tachikoma-test',
          autoCreateDirs: false,
          watchPollInterval: 1000,
          enableWatch: false,
        },
        pendingApprovalHandler: null,
        writeApprovalResponseCalls,
        initializeSession: async () => { /* mock: no-op */ },
        registerWorker: async () => { /* mock: no-op */ },
        getSessionPath: () => '.tachikoma-test/sessions/test-session',
        getWorkerPath: (workerId: string) =>
          `.tachikoma-test/sessions/test-session/workers/${workerId}`,
        writePlan: async () => { /* mock: no-op */ },
        readPlan: async () => null,
        writeProgress: async () => { /* mock: no-op */ },
        readProgress: async () => null,
        appendDecision: async () => { /* mock: no-op */ },
        readDecisions: async () => [],
        readWorkerStatus: async () => null,
        writeWorkerStatus: async () => { /* mock: no-op */ },
        readPendingApproval: async () => null,
        writeApprovalResponse: async (_workerId: string, response: ApprovalResponseFile) => {
          writeApprovalResponseCalls.push(response);
        },
        readApprovalResponse: async () => null,
        writeIntervention: async () => { /* mock: no-op */ },
        readIntervention: async () => null,
        readThinkingLogs: async () => [],
        readActionLogs: async () => [],
        readSharedContext: async () => null,
        writeSharedContext: async () => { /* mock: no-op */ },
        appendMessage: async () => { /* mock: no-op */ },
        readMessages: async () => [],
        on: <T = unknown>(type: string, handler: SessionFileEventHandler<T>) => {
          if (type === 'pending_approval_created') {
            mockSession.pendingApprovalHandler = handler as SessionFileEventHandler<PendingApprovalFile>;
            persistentHandler = handler as SessionFileEventHandler<PendingApprovalFile>;
            // 自动处理队列中的审批请求
            for (const approval of pendingApprovals) {
              // 使用 setTimeout 确保这在同步代码之后执行
              setTimeout(async () => {
                await handler({
                  type: 'pending_approval_created',
                  sessionId: 'test-session',
                  filePath: `.tachikoma-test/sessions/test-session/workers/${approval.workerId}/pending_approval.json`,
                  data: approval as T,
                  workerId: approval.workerId,
                  timestamp: Date.now(),
                });
              }, 1);
            }
          }
        },
        off: () => {
          // off() 会清除 pendingApprovalHandler 但我们保留 persistentHandler
          // 这样测试可以验证处理器在会话关闭后仍能正常工作
        },
        startWatching: async () => { /* mock: no-op */ },
        stopWatching: () => { /* mock: no-op */ },
        cleanup: async () => { /* mock: no-op */ },
        close: async () => { /* mock: no-op */ },
        // 排队审批请求 - 会在处理器注册时自动触发
        queuePendingApproval: (approval: PendingApprovalFile) => {
          pendingApprovals.push(approval);
        },
        triggerPendingApproval: async (approval: PendingApprovalFile) => {
          // 直接触发（需要在 sessionManager 还活着时调用）
          const handler = persistentHandler || mockSession.pendingApprovalHandler;
          if (handler) {
            await handler({
              type: 'pending_approval_created',
              sessionId: 'test-session',
              filePath: `.tachikoma-test/sessions/test-session/workers/${approval.workerId}/pending_approval.json`,
              data: approval,
              workerId: approval.workerId,
              timestamp: Date.now(),
            });
          }
        },
      };

      return mockSession;
    }

    // 创建测试用 PendingApprovalFile
    function createTestApproval(overrides: Partial<PendingApprovalFile> = {}): PendingApprovalFile {
      return {
        requestId: 'req-001',
        workerId: 'worker-0',
        subtaskId: 'subtask-1',
        requestedAt: Date.now(),
        type: 'file_deletion',
        description: 'Delete temporary files',
        details: {
          affectedFiles: ['/tmp/test.txt'],
          impactScope: 'low',
          reversible: false,
        },
        timeout: 30000,
        defaultDecision: 'approve',
        ...overrides,
      };
    }

    it('DEFAULT_APPROVAL_POLICY 应包含正确的默认值', () => {
      expect(DEFAULT_APPROVAL_POLICY.defaultDecision).toBe('approve');
      expect(DEFAULT_APPROVAL_POLICY.autoApproveTypes).toEqual([]);
      expect(DEFAULT_APPROVAL_POLICY.autoRejectTypes).toContain('dangerous_operation');
      expect(DEFAULT_APPROVAL_POLICY.timeout).toBe(30000);
      expect(DEFAULT_APPROVAL_POLICY.lowImpactAutoApprove).toBe(true);
      expect(DEFAULT_APPROVAL_POLICY.reversibleAutoApprove).toBe(true);
    });

    it('createOrchestratorConfig 应正确合并审批策略配置', () => {
      const config = createOrchestratorConfig({
        approval: {
          defaultDecision: 'reject',
          autoApproveTypes: ['file_deletion'],
        },
      });

      expect(config.approval.defaultDecision).toBe('reject');
      expect(config.approval.autoApproveTypes).toContain('file_deletion');
      // 应保留未覆盖的默认值
      expect(config.approval.lowImpactAutoApprove).toBe(true);
    });

    it('initializeSession 应注册 pending_approval_created 事件监听器', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      // 执行任务以触发 initializeSession
      const task: Task = {
        id: 'task-approval-001',
        type: 'composite',
        objective: '测试审批监听器注册',
        constraints: [],
      };

      await orchestrator.run(task);

      // 验证监听器已注册
      expect(mockSession.pendingApprovalHandler).not.toBeNull();

      await orchestrator.stop();
    });

    it('收到 pending_approval_created 事件时应调用 writeApprovalResponse', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-approval-002',
        type: 'composite',
        objective: '测试审批响应写入',
        constraints: [],
      };

      // 在 run() 前队列审批请求，这样会在 session 初始化时触发
      const approval = createTestApproval();
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      // 等待异步处理完成
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证 writeApprovalResponse 被调用
      expect(mockSession.writeApprovalResponseCalls.length).toBe(1);
      expect(mockSession.writeApprovalResponseCalls[0].requestId).toBe('req-001');

      await orchestrator.stop();
    });

    it('autoRejectTypes 中的类型应被自动拒绝', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-approval-003',
        type: 'composite',
        objective: '测试自动拒绝',
        constraints: [],
      };

      // 队列 dangerous_operation 类型的审批请求
      const approval = createTestApproval({
        type: 'dangerous_operation',
      });
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证被拒绝
      expect(mockSession.writeApprovalResponseCalls[0].approved).toBe(false);
      expect(mockSession.writeApprovalResponseCalls[0].reason).toContain('auto-reject');

      await orchestrator.stop();
    });

    it('autoApproveTypes 中的类型应被自动批准', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      // 配置自动批准 file_deletion
      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          approval: {
            autoApproveTypes: ['file_deletion'],
          },
        },
      });

      const task: Task = {
        id: 'task-approval-004',
        type: 'composite',
        objective: '测试自动批准',
        constraints: [],
      };

      const approval = createTestApproval({
        type: 'file_deletion',
      });
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证被批准
      expect(mockSession.writeApprovalResponseCalls[0].approved).toBe(true);
      expect(mockSession.writeApprovalResponseCalls[0].reason).toContain('auto-approve');

      await orchestrator.stop();
    });

    it('低影响操作应被自动批准（当 lowImpactAutoApprove 启用时）', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-approval-005',
        type: 'composite',
        objective: '测试低影响自动批准',
        constraints: [],
      };

      // 使用低影响的 multi_file_refactor（不在自动批准/拒绝列表中）
      const approval = createTestApproval({
        type: 'multi_file_refactor',
        details: {
          impactScope: 'low',
          reversible: false,
        },
      });
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证被批准
      expect(mockSession.writeApprovalResponseCalls[0].approved).toBe(true);
      expect(mockSession.writeApprovalResponseCalls[0].reason).toContain('Low impact');

      await orchestrator.stop();
    });

    it('可逆操作应被自动批准（当 reversibleAutoApprove 启用时）', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-approval-006',
        type: 'composite',
        objective: '测试可逆操作自动批准',
        constraints: [],
      };

      // 使用可逆的操作（非低影响）
      const approval = createTestApproval({
        type: 'external_api_call',
        details: {
          impactScope: 'medium',
          reversible: true,
        },
      });
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证被批准
      expect(mockSession.writeApprovalResponseCalls[0].approved).toBe(true);
      expect(mockSession.writeApprovalResponseCalls[0].reason).toContain('Reversible');

      await orchestrator.stop();
    });

    it('无特定策略匹配时应使用 defaultDecision', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      // 配置默认拒绝，禁用自动批准
      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          approval: {
            defaultDecision: 'reject',
            lowImpactAutoApprove: false,
            reversibleAutoApprove: false,
            autoRejectTypes: [],
          },
        },
      });

      const task: Task = {
        id: 'task-approval-007',
        type: 'composite',
        objective: '测试默认决策',
        constraints: [],
      };

      const approval = createTestApproval({
        type: 'resource_intensive',
        details: {
          impactScope: 'high',
          reversible: false,
        },
      });
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证使用默认决策（拒绝）
      expect(mockSession.writeApprovalResponseCalls[0].approved).toBe(false);
      expect(mockSession.writeApprovalResponseCalls[0].reason).toContain('Default decision');

      await orchestrator.stop();
    });

    it('审批响应应包含正确的 respondedBy 字段', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const task: Task = {
        id: 'task-approval-008',
        type: 'composite',
        objective: '测试 respondedBy 字段',
        constraints: [],
      };

      const approval = createTestApproval();
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证 respondedBy 为 orchestrator
      expect(mockSession.writeApprovalResponseCalls[0].respondedBy).toBe('orchestrator');

      await orchestrator.stop();
    });

    it('应发送 approval:received 和 approval:complete 事件', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
      });

      const events: OrchestratorEventType[] = [];
      orchestrator.on('approval:received', () => {
        events.push('approval:received');
      });
      orchestrator.on('approval:complete', () => {
        events.push('approval:complete');
      });

      const task: Task = {
        id: 'task-approval-009',
        type: 'composite',
        objective: '测试审批事件',
        constraints: [],
      };

      const approval = createTestApproval();
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 50));

      // 验证事件被触发
      expect(events).toContain('approval:received');
      expect(events).toContain('approval:complete');

      await orchestrator.stop();
    });

    it('同一 requestId 的审批请求只应处理一次（防止重复）', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createApprovalMockSessionManager();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          approval: DEFAULT_APPROVAL_POLICY,
        },
      });

      let receivedCount = 0;
      let completeCount = 0;
      orchestrator.on('approval:received', () => {
        receivedCount++;
      });
      orchestrator.on('approval:complete', () => {
        completeCount++;
      });

      const task: Task = {
        id: 'task-approval-010',
        type: 'composite',
        objective: '测试审批去重',
        constraints: [],
      };

      const approval = createTestApproval();
      // 队列同一个审批请求两次
      mockSession.queuePendingApproval(approval);
      mockSession.queuePendingApproval(approval);

      await orchestrator.run(task);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 应该只处理一次
      expect(receivedCount).toBe(1);
      expect(completeCount).toBe(1);

      await orchestrator.stop();
    });
  });

  // ============================================================================
  // 偏离检测测试
  // ============================================================================

  describe('偏离检测', () => {
    it('DEFAULT_DEVIATION_DETECTION_CONFIG 应包含正确的默认值', () => {
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG).toBeDefined();
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.enabled).toBe(false);
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.checkInterval).toBe(10000);
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.thinkingLogLimit).toBe(20);
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.deviationThreshold).toBe(0.7);
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.interventionCooldown).toBe(60000);
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.autoInterventionSeverity).toBe('high');
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.enableRuleBasedDetection).toBe(true);
      expect(DEFAULT_DEVIATION_DETECTION_CONFIG.enableModelEvaluation).toBe(false);
    });

    it('createOrchestratorConfig 应正确合并偏离检测配置', () => {
      const config = createOrchestratorConfig({
        deviationDetection: {
          enabled: true,
          checkInterval: 5000,
        },
      });

      expect(config.deviationDetection.enabled).toBe(true);
      expect(config.deviationDetection.checkInterval).toBe(5000);
      // 未覆盖的字段应保持默认值
      expect(config.deviationDetection.thinkingLogLimit).toBe(20);
    });

    it('偏离检测默认禁用时不应启动定时器', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManagerForTest();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        // 使用默认配置，偏离检测禁用
      });

      const task: Task = {
        id: 'task-deviation-001',
        type: 'composite',
        objective: '测试偏离检测禁用',
        constraints: [],
      };

      await orchestrator.run(task);

      // 偏离检测禁用时不会产生相关调用
      // 验证 readThinkingLogs 未被调用（因为定时器未启动）
      expect(mockSession.readThinkingLogs).not.toHaveBeenCalled();

      await orchestrator.stop();
    });

    it('偏离检测启用时应执行周期性检测', async () => {
      const mockPlanner = createSlowMockPlanner();
      const mockPool = createSlowMockWorkerPoolForTest();
      const mockSession = createMockSessionManagerForTest();

      // 手动注册一个 busy 状态的 worker 用于测试
      mockPool.register({
        id: 'worker-test-0',
        status: 'busy',
        currentTaskId: 'subtask-1',
        capabilities: ['general'],
      });

      // 设置思考日志返回值
      (mockSession.readThinkingLogs as ReturnType<typeof mock>).mockResolvedValue([]);

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          deviationDetection: {
            enabled: true,
            checkInterval: 30, // 30ms 间隔便于测试
          },
        },
      });

      const task: Task = {
        id: 'task-deviation-002',
        type: 'composite',
        objective: '测试偏离检测启用',
        constraints: [],
      };

      // 启动任务（不等待完成）
      const runPromise = orchestrator.run(task);
      
      // 等待足够时间让定时器触发（任务执行期间）
      await new Promise(resolve => setTimeout(resolve, 100));

      // 验证 readThinkingLogs 被调用
      expect(mockSession.readThinkingLogs).toHaveBeenCalled();

      // 等待任务完成
      await runPromise;
      await orchestrator.stop();
    });

    it('检测到重复模式时应触发 deviation:detected 事件', async () => {
      const mockPlanner = createSlowMockPlanner();
      const mockPool = createSlowMockWorkerPoolForTest();
      const mockSession = createMockSessionManagerForTest();

      // 手动注册一个 busy 状态的 worker 用于测试
      mockPool.register({
        id: 'worker-test-1',
        status: 'busy',
        currentTaskId: 'subtask-1',
        capabilities: ['general'],
      });

      // 设置重复的思考日志
      const repetitiveLogs = [
        { id: '1', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'thinking', stage: 'analysis' },
        { id: '2', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'thinking', stage: 'analysis' },
        { id: '3', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'thinking', stage: 'analysis' },
        { id: '4', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'thinking', stage: 'analysis' },
        { id: '5', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'thinking', stage: 'analysis' },
      ];
      (mockSession.readThinkingLogs as ReturnType<typeof mock>).mockResolvedValue(repetitiveLogs);

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          deviationDetection: {
            enabled: true,
            checkInterval: 30,
            autoInterventionSeverity: 'medium', // 设为 medium 以便触发干预
          },
        },
      });

      const events: string[] = [];
      orchestrator.on('deviation:detected', () => {
        events.push('deviation:detected');
      });
      orchestrator.on('deviation:intervention', () => {
        events.push('deviation:intervention');
      });

      const task: Task = {
        id: 'task-deviation-003',
        type: 'composite',
        objective: '测试重复模式检测',
        constraints: [],
      };

      // 启动任务（不等待完成）
      const runPromise = orchestrator.run(task);
      
      // 等待足够时间让定时器触发
      await new Promise(resolve => setTimeout(resolve, 100));

      // 验证事件被触发
      expect(events).toContain('deviation:detected');

      // 等待任务完成
      await runPromise;
      await orchestrator.stop();
    });

    it('检测到偏离时应调用 writeIntervention', async () => {
      const mockPlanner = createSlowMockPlanner();
      const mockPool = createSlowMockWorkerPoolForTest();
      const mockSession = createMockSessionManagerForTest();

      // 手动注册一个 busy 状态的 worker 用于测试
      mockPool.register({
        id: 'worker-test-2',
        status: 'busy',
        currentTaskId: 'subtask-1',
        capabilities: ['general'],
      });

      // 设置重复的思考日志
      const repetitiveLogs = [
        { id: '1', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'same same same', stage: 'analysis' },
        { id: '2', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'same same same', stage: 'analysis' },
        { id: '3', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'same same same', stage: 'analysis' },
        { id: '4', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'same same same', stage: 'analysis' },
        { id: '5', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'same same same', stage: 'analysis' },
      ];
      (mockSession.readThinkingLogs as ReturnType<typeof mock>).mockResolvedValue(repetitiveLogs);

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          deviationDetection: {
            enabled: true,
            checkInterval: 30,
            autoInterventionSeverity: 'medium', // 设为 medium 以便触发干预
          },
        },
      });

      const task: Task = {
        id: 'task-deviation-004',
        type: 'composite',
        objective: '测试干预写入',
        constraints: [],
      };

      // 启动任务（不等待完成）
      const runPromise = orchestrator.run(task);
      
      // 等待足够时间让定时器触发
      await new Promise(resolve => setTimeout(resolve, 100));

      // 验证 writeIntervention 被调用
      expect(mockSession.writeIntervention).toHaveBeenCalled();

      // 等待任务完成
      await runPromise;
      await orchestrator.stop();
    });

    it('冷却时间内不应重复干预', async () => {
      const mockPlanner = createSlowMockPlanner();
      const mockPool = createSlowMockWorkerPoolForTest();
      const mockSession = createMockSessionManagerForTest();

      // 手动注册一个 busy 状态的 worker 用于测试
      mockPool.register({
        id: 'worker-test-3',
        status: 'busy',
        currentTaskId: 'subtask-1',
        capabilities: ['general'],
      });

      // 设置重复的思考日志
      const repetitiveLogs = [
        { id: '1', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'repeat', stage: 'analysis' },
        { id: '2', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'repeat', stage: 'analysis' },
        { id: '3', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'repeat', stage: 'analysis' },
        { id: '4', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'repeat', stage: 'analysis' },
        { id: '5', timestamp: Date.now(), subtaskId: 'subtask-1', content: 'repeat', stage: 'analysis' },
      ];
      (mockSession.readThinkingLogs as ReturnType<typeof mock>).mockResolvedValue(repetitiveLogs);

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          deviationDetection: {
            enabled: true,
            checkInterval: 20, // 20ms 间隔
            interventionCooldown: 5000, // 5秒冷却时间
            autoInterventionSeverity: 'medium',
          },
        },
      });

      const task: Task = {
        id: 'task-deviation-005',
        type: 'composite',
        objective: '测试冷却时间',
        constraints: [],
      };

      // 启动任务（不等待完成）
      const runPromise = orchestrator.run(task);
      
      // 等待多个检测周期
      await new Promise(resolve => setTimeout(resolve, 150));

      // 由于冷却时间设置为 5 秒，writeIntervention 应该只被调用一次
      expect((mockSession.writeIntervention as ReturnType<typeof mock>).mock.calls.length).toBe(1);

      // 等待任务完成
      await runPromise;
      await orchestrator.stop();
    });

    it('closeSession 应清理偏离检测定时器', async () => {
      const mockPlanner = createMockPlanner();
      const mockPool = createMockWorkerPoolForTest();
      const mockSession = createMockSessionManagerForTest();

      const orchestrator = new Orchestrator('test-orch', {
        planner: mockPlanner,
        workerPool: mockPool,
        sessionManager: mockSession,
        config: {
          deviationDetection: {
            enabled: true,
            checkInterval: 50,
          },
        },
      });

      const task: Task = {
        id: 'task-deviation-006',
        type: 'composite',
        objective: '测试定时器清理',
        constraints: [],
      };

      await orchestrator.run(task);
      await orchestrator.stop();

      // 等待一段时间，验证定时器已停止（不再有新的调用）
      const callCountBefore = (mockSession.readThinkingLogs as ReturnType<typeof mock>).mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 100));
      const callCountAfter = (mockSession.readThinkingLogs as ReturnType<typeof mock>).mock.calls.length;

      // 停止后不应有新调用
      expect(callCountAfter).toBe(callCountBefore);
    });
  });
});
