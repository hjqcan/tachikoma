/**
 * 统筹者智能体与规划默认配置
 *
 * 基于 PRD 3.3 Layer 2 配置
 */

import type {
  OrchestratorConfig,
  PlannerConfig,
  WorkerPoolConfig,
  DelegationDefaults,
  AggregationConfig,
  CheckpointConfig,
} from './types';
import type { RetryPolicy, AgentConfig, DelegationMode } from '../types';

// ============================================================================
// 默认重试策略
// ============================================================================

/**
 * 默认重试策略
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelay: 1000, // 1 秒
  backoffFactor: 2, // 指数退避
  maxDelay: 30000, // 最大 30 秒
};

/**
 * 保守重试策略（更少重试）
 */
export const CONSERVATIVE_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  baseDelay: 2000,
  backoffFactor: 2,
  maxDelay: 10000,
};

/**
 * 激进重试策略（更多重试）
 */
export const AGGRESSIVE_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelay: 500,
  backoffFactor: 1.5,
  maxDelay: 60000,
};

// ============================================================================
// Worker 池默认配置
// ============================================================================

/**
 * 默认 Worker 池配置
 */
export const DEFAULT_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  minWorkers: 1,
  maxWorkers: 5,
  idleTimeout: 300000, // 5 分钟
  healthCheckInterval: 30000, // 30 秒
  selectionStrategy: 'least-loaded',
};

/**
 * 高并发 Worker 池配置
 */
export const HIGH_CONCURRENCY_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  minWorkers: 3,
  maxWorkers: 10,
  idleTimeout: 600000, // 10 分钟
  healthCheckInterval: 15000, // 15 秒
  selectionStrategy: 'least-loaded',
};

// ============================================================================
// 委托默认配置
// ============================================================================

/**
 * 默认委托配置
 */
export const DEFAULT_DELEGATION_DEFAULTS: DelegationDefaults = {
  mode: 'communication',
  workerCount: 1,
  timeout: 300000, // 5 分钟
  retryPolicy: DEFAULT_RETRY_POLICY,
};

// ============================================================================
// 聚合默认配置
// ============================================================================

/**
 * 默认聚合配置
 */
export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  strategy: 'merge',
  allowPartialSuccess: true,
  partialSuccessThreshold: 0.5, // 50% 成功即为部分成功
};

// ============================================================================
// 检查点默认配置
// ============================================================================

/**
 * 默认检查点配置
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  storageDir: '.tachikoma/checkpoints',
  interval: 0, // 仅在关键节点创建
  maxCheckpoints: 10,
  gitIntegration: false,
};

/**
 * 启用 Git 集成的检查点配置
 */
export const GIT_ENABLED_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  storageDir: '.tachikoma/checkpoints',
  interval: 60000, // 每分钟
  maxCheckpoints: 20,
  gitIntegration: true,
};

// ============================================================================
// 规划器默认配置
// ============================================================================

/**
 * 默认规划器配置
 */
export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  agent: {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    maxTokens: 2048,
    temperature: 0.3, // 较低温度以保证稳定输出
  },
  defaultMaxSubtasks: 10,
  maxParseRetries: 3,
  enableReasoning: true,
};

// ============================================================================
// 完整 Orchestrator 默认配置
// ============================================================================

/**
 * 默认 Orchestrator 配置
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  agent: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
    temperature: 0.5,
  },
  planner: DEFAULT_PLANNER_CONFIG,
  workerPool: DEFAULT_WORKER_POOL_CONFIG,
  delegation: DEFAULT_DELEGATION_DEFAULTS,
  aggregation: DEFAULT_AGGREGATION_CONFIG,
  checkpoint: DEFAULT_CHECKPOINT_CONFIG,
};

// ============================================================================
// 配置构建器
// ============================================================================

/**
 * 深度部分配置类型
 */
interface PartialDelegationDefaults {
  mode?: DelegationMode;
  workerCount?: number;
  timeout?: number;
  retryPolicy?: Partial<RetryPolicy>;
}

/**
 * 深度部分规划器配置类型
 */
interface PartialPlannerConfig {
  agent?: Partial<AgentConfig>;
  defaultMaxSubtasks?: number;
  maxParseRetries?: number;
  enableReasoning?: boolean;
}

/**
 * 部分 Orchestrator 配置类型
 */
export interface PartialOrchestratorConfig {
  agent?: Partial<OrchestratorConfig['agent']>;
  planner?: PartialPlannerConfig;
  workerPool?: Partial<WorkerPoolConfig>;
  delegation?: PartialDelegationDefaults;
  aggregation?: Partial<AggregationConfig>;
  checkpoint?: Partial<CheckpointConfig>;
}

/**
 * 深拷贝配置对象
 */
function deepCloneConfig<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * 创建 Orchestrator 配置
 *
 * @param overrides - 覆盖默认配置的部分配置
 * @returns 完整的 Orchestrator 配置（深拷贝，不会影响默认配置）
 *
 * @example
 * ```ts
 * const config = createOrchestratorConfig({
 *   workerPool: { maxWorkers: 10 },
 *   checkpoint: { gitIntegration: true }
 * });
 * ```
 */
export function createOrchestratorConfig(
  overrides?: PartialOrchestratorConfig
): OrchestratorConfig {
  // 首先深拷贝默认配置，确保修改不会影响原始配置
  const baseConfig = deepCloneConfig(DEFAULT_ORCHESTRATOR_CONFIG);

  if (!overrides) {
    return baseConfig;
  }

  // 深度合并嵌套对象，确保正确处理 retryPolicy 和 agent
  const { retryPolicy: overrideRetryPolicy, ...restDelegation } =
    overrides.delegation || {};
  const { agent: overridePlannerAgent, ...restPlanner } =
    overrides.planner || {};

  return {
    agent: {
      ...baseConfig.agent,
      ...overrides.agent,
    },
    planner: {
      ...baseConfig.planner,
      ...restPlanner,
      agent: {
        ...baseConfig.planner.agent,
        ...overridePlannerAgent,
      },
    },
    workerPool: {
      ...baseConfig.workerPool,
      ...overrides.workerPool,
    },
    delegation: {
      ...baseConfig.delegation,
      ...restDelegation,
      retryPolicy: {
        ...baseConfig.delegation.retryPolicy,
        ...overrideRetryPolicy,
      },
    },
    aggregation: {
      ...baseConfig.aggregation,
      ...overrides.aggregation,
    },
    checkpoint: {
      ...baseConfig.checkpoint,
      ...overrides.checkpoint,
    },
  };
}

// ============================================================================
// 配置验证
// ============================================================================

/**
 * 配置验证错误
 */
export class OrchestratorConfigError extends Error {
  constructor(
    message: string,
    public field: string
  ) {
    super(`Orchestrator config error [${field}]: ${message}`);
    this.name = 'OrchestratorConfigError';
  }
}

/**
 * 验证 Orchestrator 配置
 *
 * @param config - 要验证的配置
 * @throws {OrchestratorConfigError} 如果配置无效
 */
export function validateOrchestratorConfig(config: OrchestratorConfig): void {
  // 验证 Worker 池配置
  if (config.workerPool.minWorkers < 0) {
    throw new OrchestratorConfigError(
      'minWorkers must be non-negative',
      'workerPool.minWorkers'
    );
  }
  if (config.workerPool.maxWorkers < config.workerPool.minWorkers) {
    throw new OrchestratorConfigError(
      'maxWorkers must be >= minWorkers',
      'workerPool.maxWorkers'
    );
  }
  if (config.workerPool.idleTimeout < 0) {
    throw new OrchestratorConfigError(
      'idleTimeout must be non-negative',
      'workerPool.idleTimeout'
    );
  }

  // 验证委托配置
  if (config.delegation.workerCount < 1) {
    throw new OrchestratorConfigError(
      'workerCount must be at least 1',
      'delegation.workerCount'
    );
  }
  if (config.delegation.timeout < 0) {
    throw new OrchestratorConfigError(
      'timeout must be non-negative',
      'delegation.timeout'
    );
  }

  // 验证重试策略
  if (config.delegation.retryPolicy.maxRetries < 0) {
    throw new OrchestratorConfigError(
      'maxRetries must be non-negative',
      'delegation.retryPolicy.maxRetries'
    );
  }
  if (config.delegation.retryPolicy.baseDelay < 0) {
    throw new OrchestratorConfigError(
      'baseDelay must be non-negative',
      'delegation.retryPolicy.baseDelay'
    );
  }

  // 验证聚合配置
  if (config.aggregation.partialSuccessThreshold !== undefined) {
    if (
      config.aggregation.partialSuccessThreshold < 0 ||
      config.aggregation.partialSuccessThreshold > 1
    ) {
      throw new OrchestratorConfigError(
        'partialSuccessThreshold must be between 0 and 1',
        'aggregation.partialSuccessThreshold'
      );
    }
  }

  // 验证检查点配置
  if (config.checkpoint.maxCheckpoints < 1) {
    throw new OrchestratorConfigError(
      'maxCheckpoints must be at least 1',
      'checkpoint.maxCheckpoints'
    );
  }
  if (config.checkpoint.interval < 0) {
    throw new OrchestratorConfigError(
      'interval must be non-negative',
      'checkpoint.interval'
    );
  }

  // 验证规划器配置
  if (config.planner.defaultMaxSubtasks < 1) {
    throw new OrchestratorConfigError(
      'defaultMaxSubtasks must be at least 1',
      'planner.defaultMaxSubtasks'
    );
  }
  if (config.planner.maxParseRetries < 0) {
    throw new OrchestratorConfigError(
      'maxParseRetries must be non-negative',
      'planner.maxParseRetries'
    );
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算重试延迟
 *
 * @param retryPolicy - 重试策略
 * @param attemptNumber - 当前尝试次数（从 1 开始）
 * @returns 延迟时间（毫秒）
 */
export function calculateRetryDelay(
  retryPolicy: RetryPolicy,
  attemptNumber: number
): number {
  const { baseDelay, backoffFactor = 1, maxDelay } = retryPolicy;

  // 指数退避计算
  const delay = baseDelay * Math.pow(backoffFactor, attemptNumber - 1);

  // 添加随机抖动（±10%）
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  const finalDelay = Math.round(delay + jitter);

  // 限制最大延迟
  return maxDelay ? Math.min(finalDelay, maxDelay) : finalDelay;
}

/**
 * 检查是否应该重试
 *
 * @param retryPolicy - 重试策略
 * @param currentRetries - 当前已重试次数
 * @returns 是否应该重试
 */
export function shouldRetry(
  retryPolicy: RetryPolicy,
  currentRetries: number
): boolean {
  return currentRetries < retryPolicy.maxRetries;
}
