/**
 * 统筹者模块测试
 *
 * 测试类型定义、配置和工具函数
 */

import { describe, it, expect } from 'bun:test';
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
  // 配置构建器
  createOrchestratorConfig,
  validateOrchestratorConfig,
  OrchestratorConfigError,
  // 工具函数
  calculateRetryDelay,
  shouldRetry,
  // 类型
  type OrchestratorTask,
  type SubTask,
  type PlannerInput,
  type PlannerOutput,
  type WorkerMessage,
  type CheckpointState,
  type AggregatedResult,
} from '../src/orchestrator';

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
