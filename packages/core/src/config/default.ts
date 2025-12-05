/**
 * Tachikoma 默认配置
 *
 * 基于 PRD 6.4 配置管理定义
 */

import type { Config, ModelConfig, ContextThresholds, SandboxConfig, AgentOpsConfig } from '../types';

/**
 * 默认模型配置 - 统筹者
 */
export const DEFAULT_ORCHESTRATOR_MODEL: ModelConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4',
  maxTokens: 8192,
};

/**
 * 默认模型配置 - 工作者
 */
export const DEFAULT_WORKER_MODEL: ModelConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  maxTokens: 4096,
};

/**
 * 默认模型配置 - 规划者
 */
export const DEFAULT_PLANNER_MODEL: ModelConfig = {
  provider: 'anthropic',
  model: 'claude-haiku-3.5',
  maxTokens: 2048,
};

/**
 * 默认上下文阈值配置
 */
export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = {
  // 硬性上限 (模型限制) - 1M tokens
  hardLimit: 1_000_000,
  // "腐烂前"阈值 (性能下降点) - 200k tokens
  rotThreshold: 200_000,
  // 压缩触发阈值 - 128k tokens
  compactionTrigger: 128_000,
  // 摘要触发阈值 (压缩后仍超过) - 150k tokens
  summarizationTrigger: 150_000,
  // 保留的最近工具调用数
  preserveRecentToolCalls: 5,
};

/**
 * 默认沙盒配置
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  // 运行时
  runtime: 'bun',
  // 超时时间 - 30 分钟
  timeout: 1800_000,
  // 资源配置
  resources: {
    cpu: '2',
    memory: '4G',
    storage: '10G',
  },
  // 网络配置
  network: {
    mode: 'restricted',
    allowlist: [
      'api.anthropic.com',
      'api.openai.com',
    ],
  },
};

/**
 * 默认 AgentOps 配置
 */
export const DEFAULT_AGENTOPS_CONFIG: AgentOpsConfig = {
  // 追踪配置
  tracing: {
    enabled: true,
    endpoint: 'http://localhost:4317',
    serviceName: 'tachikoma',
  },
  // 日志配置
  logging: {
    level: 'info',
    format: 'json',
  },
  // 指标配置
  metrics: {
    enabled: true,
    endpoint: '/metrics',
  },
};

/**
 * 默认完整配置
 */
export const DEFAULT_CONFIG: Config = {
  models: {
    orchestrator: DEFAULT_ORCHESTRATOR_MODEL,
    worker: DEFAULT_WORKER_MODEL,
    planner: DEFAULT_PLANNER_MODEL,
  },
  context: DEFAULT_CONTEXT_THRESHOLDS,
  sandbox: DEFAULT_SANDBOX_CONFIG,
  agentops: DEFAULT_AGENTOPS_CONFIG,
};

