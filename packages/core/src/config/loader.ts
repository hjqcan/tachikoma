/**
 * 配置加载器
 *
 * 支持从默认配置、环境变量和运行时覆盖进行深度合并
 */

import type {
  Config,
  ModelConfig,
  ContextThresholds,
  SandboxConfig,
  AgentOpsConfig,
  LogLevel,
  LogFormat,
  NetworkMode,
} from '../types';
import { DEFAULT_CONFIG } from './default';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 配置覆盖选项（所有字段可选）
 */
export type ConfigOverrides = DeepPartial<Config>;

/**
 * 深度可选类型
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * 环境变量映射
 */
interface EnvMapping {
  key: string;
  path: string[];
  transform?: (value: string) => unknown;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 深度合并两个对象
 * @param target - 目标对象
 * @param source - 源对象
 * @returns 合并后的对象
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: DeepPartial<T>
): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === undefined) {
      continue;
    }

    // 如果两个值都是对象且不是数组，递归合并
    if (
      isPlainObject(targetValue) &&
      isPlainObject(sourceValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      ) as T[keyof T];
    } else {
      // 否则直接覆盖
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * 检查是否为普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 根据路径设置对象的嵌套属性
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  if (path.length === 0) return;

  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string;
    if (!(key in current) || !isPlainObject(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}

/**
 * 解析布尔值
 */
function parseBoolean(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * 解析整数
 */
function parseInt(value: string): number {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) {
    throw new ConfigValidationError(`Invalid integer value: ${value}`);
  }
  return num;
}

/**
 * 解析字符串数组（逗号分隔）
 */
function parseStringArray(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// ============================================================================
// 环境变量映射
// ============================================================================

/**
 * 环境变量到配置路径的映射
 */
const ENV_MAPPINGS: EnvMapping[] = [
  // 模型配置 - 统筹者
  { key: 'TACHIKOMA_ORCHESTRATOR_PROVIDER', path: ['models', 'orchestrator', 'provider'] },
  { key: 'TACHIKOMA_ORCHESTRATOR_MODEL', path: ['models', 'orchestrator', 'model'] },
  { key: 'TACHIKOMA_ORCHESTRATOR_MAX_TOKENS', path: ['models', 'orchestrator', 'maxTokens'], transform: parseInt },

  // 模型配置 - 工作者
  { key: 'TACHIKOMA_WORKER_PROVIDER', path: ['models', 'worker', 'provider'] },
  { key: 'TACHIKOMA_WORKER_MODEL', path: ['models', 'worker', 'model'] },
  { key: 'TACHIKOMA_WORKER_MAX_TOKENS', path: ['models', 'worker', 'maxTokens'], transform: parseInt },

  // 模型配置 - 规划者
  { key: 'TACHIKOMA_PLANNER_PROVIDER', path: ['models', 'planner', 'provider'] },
  { key: 'TACHIKOMA_PLANNER_MODEL', path: ['models', 'planner', 'model'] },
  { key: 'TACHIKOMA_PLANNER_MAX_TOKENS', path: ['models', 'planner', 'maxTokens'], transform: parseInt },

  // 上下文配置
  { key: 'TACHIKOMA_CONTEXT_HARD_LIMIT', path: ['context', 'hardLimit'], transform: parseInt },
  { key: 'TACHIKOMA_CONTEXT_ROT_THRESHOLD', path: ['context', 'rotThreshold'], transform: parseInt },
  { key: 'TACHIKOMA_CONTEXT_COMPACTION_TRIGGER', path: ['context', 'compactionTrigger'], transform: parseInt },
  { key: 'TACHIKOMA_CONTEXT_SUMMARIZATION_TRIGGER', path: ['context', 'summarizationTrigger'], transform: parseInt },
  { key: 'TACHIKOMA_CONTEXT_PRESERVE_RECENT_TOOL_CALLS', path: ['context', 'preserveRecentToolCalls'], transform: parseInt },

  // 沙盒配置
  { key: 'TACHIKOMA_SANDBOX_RUNTIME', path: ['sandbox', 'runtime'] },
  { key: 'TACHIKOMA_SANDBOX_TIMEOUT', path: ['sandbox', 'timeout'], transform: parseInt },
  { key: 'TACHIKOMA_SANDBOX_CPU', path: ['sandbox', 'resources', 'cpu'] },
  { key: 'TACHIKOMA_SANDBOX_MEMORY', path: ['sandbox', 'resources', 'memory'] },
  { key: 'TACHIKOMA_SANDBOX_STORAGE', path: ['sandbox', 'resources', 'storage'] },
  { key: 'TACHIKOMA_SANDBOX_NETWORK_MODE', path: ['sandbox', 'network', 'mode'], transform: (v) => v as NetworkMode },
  { key: 'TACHIKOMA_SANDBOX_NETWORK_ALLOWLIST', path: ['sandbox', 'network', 'allowlist'], transform: parseStringArray },

  // AgentOps 配置
  { key: 'TACHIKOMA_TRACING_ENABLED', path: ['agentops', 'tracing', 'enabled'], transform: parseBoolean },
  { key: 'TACHIKOMA_TRACING_ENDPOINT', path: ['agentops', 'tracing', 'endpoint'] },
  { key: 'TACHIKOMA_TRACING_SERVICE_NAME', path: ['agentops', 'tracing', 'serviceName'] },
  { key: 'TACHIKOMA_LOGGING_LEVEL', path: ['agentops', 'logging', 'level'], transform: (v) => v as LogLevel },
  { key: 'TACHIKOMA_LOGGING_FORMAT', path: ['agentops', 'logging', 'format'], transform: (v) => v as LogFormat },
  { key: 'TACHIKOMA_METRICS_ENABLED', path: ['agentops', 'metrics', 'enabled'], transform: parseBoolean },
  { key: 'TACHIKOMA_METRICS_ENDPOINT', path: ['agentops', 'metrics', 'endpoint'] },
];

// ============================================================================
// 错误类型
// ============================================================================

/**
 * 配置验证错误
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

// ============================================================================
// 验证函数
// ============================================================================

/**
 * 验证模型配置
 */
function validateModelConfig(config: ModelConfig, name: string): void {
  if (!config.provider || typeof config.provider !== 'string') {
    throw new ConfigValidationError(`${name}.provider must be a non-empty string`);
  }
  if (!config.model || typeof config.model !== 'string') {
    throw new ConfigValidationError(`${name}.model must be a non-empty string`);
  }
  if (typeof config.maxTokens !== 'number' || config.maxTokens <= 0) {
    throw new ConfigValidationError(`${name}.maxTokens must be a positive number`);
  }
}

/**
 * 验证上下文阈值配置
 */
function validateContextThresholds(config: ContextThresholds): void {
  const fields = [
    'hardLimit',
    'rotThreshold',
    'compactionTrigger',
    'summarizationTrigger',
    'preserveRecentToolCalls',
  ] as const;

  for (const field of fields) {
    if (typeof config[field] !== 'number' || config[field] < 0) {
      throw new ConfigValidationError(`context.${field} must be a non-negative number`);
    }
  }

  // 验证阈值逻辑关系
  if (config.compactionTrigger > config.rotThreshold) {
    throw new ConfigValidationError(
      'context.compactionTrigger should not exceed rotThreshold'
    );
  }
  if (config.summarizationTrigger > config.hardLimit) {
    throw new ConfigValidationError(
      'context.summarizationTrigger should not exceed hardLimit'
    );
  }
}

/**
 * 验证沙盒配置
 */
function validateSandboxConfig(config: SandboxConfig): void {
  if (!config.runtime || typeof config.runtime !== 'string') {
    throw new ConfigValidationError('sandbox.runtime must be a non-empty string');
  }
  if (typeof config.timeout !== 'number' || config.timeout <= 0) {
    throw new ConfigValidationError('sandbox.timeout must be a positive number');
  }

  const validModes: NetworkMode[] = ['none', 'restricted', 'full'];
  if (!validModes.includes(config.network.mode)) {
    throw new ConfigValidationError(
      `sandbox.network.mode must be one of: ${validModes.join(', ')}`
    );
  }

  if (!Array.isArray(config.network.allowlist)) {
    throw new ConfigValidationError('sandbox.network.allowlist must be an array');
  }
}

/**
 * 验证 AgentOps 配置
 */
function validateAgentOpsConfig(config: AgentOpsConfig): void {
  // 验证日志级别
  const validLogLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  if (!validLogLevels.includes(config.logging.level)) {
    throw new ConfigValidationError(
      `agentops.logging.level must be one of: ${validLogLevels.join(', ')}`
    );
  }

  // 验证日志格式
  const validLogFormats: LogFormat[] = ['json', 'text'];
  if (!validLogFormats.includes(config.logging.format)) {
    throw new ConfigValidationError(
      `agentops.logging.format must be one of: ${validLogFormats.join(', ')}`
    );
  }
}

/**
 * 验证完整配置
 */
export function validateConfig(config: Config): void {
  // 验证模型配置
  validateModelConfig(config.models.orchestrator, 'models.orchestrator');
  validateModelConfig(config.models.worker, 'models.worker');
  validateModelConfig(config.models.planner, 'models.planner');

  // 验证上下文配置
  validateContextThresholds(config.context);

  // 验证沙盒配置
  validateSandboxConfig(config.sandbox);

  // 验证 AgentOps 配置
  validateAgentOpsConfig(config.agentops);
}

// ============================================================================
// 配置加载
// ============================================================================

/**
 * 从环境变量加载配置覆盖
 * @param env - 环境变量对象（默认使用 process.env）
 * @returns 配置覆盖对象
 */
export function loadFromEnv(env: Record<string, string | undefined> = process.env): ConfigOverrides {
  const overrides: Record<string, unknown> = {};

  for (const mapping of ENV_MAPPINGS) {
    const value = env[mapping.key];
    if (value !== undefined && value !== '') {
      try {
        const transformedValue = mapping.transform ? mapping.transform(value) : value;
        setNestedValue(overrides, mapping.path, transformedValue);
      } catch (error) {
        throw new ConfigValidationError(
          `Failed to parse environment variable ${mapping.key}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return overrides as ConfigOverrides;
}

/**
 * 加载并合并配置
 *
 * 优先级（从低到高）：
 * 1. 默认配置
 * 2. 环境变量覆盖
 * 3. 运行时覆盖
 *
 * @param overrides - 运行时配置覆盖
 * @param options - 加载选项
 * @returns 合并后的完整配置
 */
export function loadConfig(
  overrides?: ConfigOverrides,
  options: {
    /** 是否从环境变量加载（默认 true） */
    loadFromEnvironment?: boolean;
    /** 自定义环境变量对象 */
    env?: Record<string, string | undefined>;
    /** 是否跳过验证（默认 false） */
    skipValidation?: boolean;
  } = {}
): Config {
  const {
    loadFromEnvironment = true,
    env = process.env,
    skipValidation = false,
  } = options;

  // 从默认配置开始
  let config: Config = structuredClone(DEFAULT_CONFIG);

  // 应用环境变量覆盖
  if (loadFromEnvironment) {
    const envOverrides = loadFromEnv(env);
    config = mergeConfig(config, envOverrides);
  }

  // 应用运行时覆盖
  if (overrides) {
    config = mergeConfig(config, overrides);
  }

  // 验证配置
  if (!skipValidation) {
    validateConfig(config);
  }

  return config;
}

/**
 * 合并配置（类型安全版本）
 */
function mergeConfig(target: Config, source: ConfigOverrides): Config {
  // 处理网络允许列表，确保不会有 undefined 值
  const networkAllowlist = source.sandbox?.network?.allowlist
    ? source.sandbox.network.allowlist.filter((v): v is string => v !== undefined)
    : target.sandbox.network.allowlist;

  return {
    models: {
      orchestrator: { ...target.models.orchestrator, ...source.models?.orchestrator },
      worker: { ...target.models.worker, ...source.models?.worker },
      planner: { ...target.models.planner, ...source.models?.planner },
    },
    context: { ...target.context, ...source.context },
    sandbox: {
      ...target.sandbox,
      ...source.sandbox,
      resources: { ...target.sandbox.resources, ...source.sandbox?.resources },
      network: {
        mode: source.sandbox?.network?.mode ?? target.sandbox.network.mode,
        allowlist: networkAllowlist,
      },
    },
    agentops: {
      ...target.agentops,
      ...source.agentops,
      tracing: { ...target.agentops.tracing, ...source.agentops?.tracing },
      logging: { ...target.agentops.logging, ...source.agentops?.logging },
      metrics: { ...target.agentops.metrics, ...source.agentops?.metrics },
    },
  };
}

/**
 * 创建配置构建器（链式 API）
 */
export function createConfigBuilder(): ConfigBuilder {
  return new ConfigBuilder();
}

/**
 * 配置构建器类
 */
export class ConfigBuilder {
  private overrides: ConfigOverrides = {};
  private envOptions: {
    loadFromEnvironment: boolean;
    env?: Record<string, string | undefined>;
  } = { loadFromEnvironment: true };

  /**
   * 设置统筹者模型
   */
  orchestratorModel(config: Partial<ModelConfig>): this {
    this.overrides.models = {
      ...this.overrides.models,
      orchestrator: {
        ...this.overrides.models?.orchestrator,
        ...config,
      } as ModelConfig,
    };
    return this;
  }

  /**
   * 设置工作者模型
   */
  workerModel(config: Partial<ModelConfig>): this {
    this.overrides.models = {
      ...this.overrides.models,
      worker: {
        ...this.overrides.models?.worker,
        ...config,
      } as ModelConfig,
    };
    return this;
  }

  /**
   * 设置规划者模型
   */
  plannerModel(config: Partial<ModelConfig>): this {
    this.overrides.models = {
      ...this.overrides.models,
      planner: {
        ...this.overrides.models?.planner,
        ...config,
      } as ModelConfig,
    };
    return this;
  }

  /**
   * 设置上下文阈值
   */
  contextThresholds(config: Partial<ContextThresholds>): this {
    this.overrides.context = {
      ...this.overrides.context,
      ...config,
    };
    return this;
  }

  /**
   * 设置沙盒配置
   */
  sandbox(config: DeepPartial<SandboxConfig>): this {
    this.overrides.sandbox = deepMerge(
      this.overrides.sandbox || {},
      config
    ) as SandboxConfig;
    return this;
  }

  /**
   * 设置 AgentOps 配置
   */
  agentOps(config: DeepPartial<AgentOpsConfig>): this {
    this.overrides.agentops = deepMerge(
      this.overrides.agentops || {},
      config
    ) as AgentOpsConfig;
    return this;
  }

  /**
   * 禁用环境变量加载
   */
  withoutEnv(): this {
    this.envOptions.loadFromEnvironment = false;
    return this;
  }

  /**
   * 使用自定义环境变量
   */
  withEnv(env: Record<string, string | undefined>): this {
    this.envOptions.env = env;
    return this;
  }

  /**
   * 构建最终配置
   */
  build(skipValidation = false): Config {
    return loadConfig(this.overrides, {
      ...this.envOptions,
      skipValidation,
    });
  }
}

