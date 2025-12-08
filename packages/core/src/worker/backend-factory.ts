/**
 * Worker Backend 工厂
 *
 * 根据配置自动选择合适的后端实现
 */

import type {
  IWorkerBackend,
  WorkerBackendConfig,
  ClaudeAgentSDKBackendConfig,
  GenericBackendConfig,
} from './types';
import { shouldUseAgentSDK } from './types';

// ============================================================================
// 错误类型
// ============================================================================

/**
 * Worker Backend 错误
 */
export class WorkerBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly provider?: string
  ) {
    super(message);
    this.name = 'WorkerBackendError';
  }
}

/**
 * Agent SDK 未安装错误
 */
export class AgentSDKNotInstalledError extends WorkerBackendError {
  constructor() {
    super(
      'Claude Agent SDK is not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
      'SDK_NOT_INSTALLED',
      'anthropic'
    );
  }
}

// ============================================================================
// 后端加载器
// ============================================================================

/**
 * 延迟加载 Claude Agent SDK Backend
 *
 * 使用动态 import 避免在不使用时报错
 */
async function loadClaudeAgentSDKBackend(): Promise<
  new (config: ClaudeAgentSDKBackendConfig) => IWorkerBackend
> {
  try {
    const module = await import('./backends/claude-agent-backend');
    return module.ClaudeAgentSDKBackend;
  } catch (error) {
    // 检查是否是模块未找到错误
    if (error instanceof Error && error.message.includes('Cannot find module')) {
      throw new AgentSDKNotInstalledError();
    }
    throw error;
  }
}

/**
 * 加载通用后端
 */
async function loadGenericBackend(): Promise<
  new (config: GenericBackendConfig) => IWorkerBackend
> {
  const module = await import('./backends/generic-agent-backend');
  return module.GenericAgentBackend;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 Worker Backend
 *
 * 根据配置自动选择后端：
 * - Claude 模型默认使用 Agent SDK（除非明确禁用）
 * - 其他模型使用通用后端
 *
 * @param config - 后端配置
 * @returns Worker Backend 实例
 *
 * @example
 * ```ts
 * // Claude 模型 - 自动使用 Agent SDK
 * const claudeBackend = await createWorkerBackend({
 *   provider: 'anthropic',
 *   model: 'claude-3-5-sonnet-20241022',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * // OpenAI 模型 - 使用通用后端
 * const openaiBackend = await createWorkerBackend({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * // 强制 Claude 使用通用后端
 * const genericClaudeBackend = await createWorkerBackend({
 *   provider: 'anthropic',
 *   model: 'claude-3-5-sonnet-20241022',
 *   useAgentSDK: false,
 * });
 * ```
 */
export async function createWorkerBackend(config: WorkerBackendConfig): Promise<IWorkerBackend> {
  // 验证必要配置
  if (!config.provider) {
    throw new WorkerBackendError('Provider is required', 'MISSING_PROVIDER');
  }
  if (!config.model) {
    throw new WorkerBackendError('Model is required', 'MISSING_MODEL');
  }

  // 根据配置选择后端
  if (shouldUseAgentSDK(config)) {
    // Claude 模型 + 使用 Agent SDK
    try {
      const BackendClass = await loadClaudeAgentSDKBackend();
      return new BackendClass(config as ClaudeAgentSDKBackendConfig);
    } catch (error) {
      // SDK 加载失败，自动降级到通用后端
      console.warn(
        '[createWorkerBackend] Claude Agent SDK load failed, falling back to GenericAgentBackend. ' +
        `Reason: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        'Install SDK with: npm install @anthropic-ai/claude-agent-sdk'
      );
      const BackendClass = await loadGenericBackend();
      return new BackendClass(config as GenericBackendConfig);
    }
  } else {
    // 其他模型或强制使用通用后端
    const BackendClass = await loadGenericBackend();
    return new BackendClass(config as GenericBackendConfig);
  }
}

/**
 * 同步创建 Worker Backend（使用默认通用后端）
 *
 * 适用于不需要 Claude Agent SDK 的场景
 */
export function createWorkerBackendSync(config: GenericBackendConfig): IWorkerBackend {
  // 同步导入通用后端
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GenericAgentBackend } = require('./backends/generic-agent-backend');
  return new GenericAgentBackend(config);
}

// ============================================================================
// 后端信息
// ============================================================================

/**
 * 后端信息
 */
export interface WorkerBackendInfo {
  /** 后端类型 */
  type: 'agent-sdk' | 'generic';
  /** 提供商 */
  provider: string;
  /** 是否需要额外依赖 */
  requiresExtraDependency: boolean;
  /** 依赖包名（如果需要） */
  dependencyPackage?: string;
}

/**
 * 获取后端信息
 */
export function getBackendInfo(config: WorkerBackendConfig): WorkerBackendInfo {
  if (shouldUseAgentSDK(config)) {
    return {
      type: 'agent-sdk',
      provider: 'anthropic',
      requiresExtraDependency: true,
      dependencyPackage: '@anthropic-ai/claude-agent-sdk',
    };
  }

  return {
    type: 'generic',
    provider: config.provider,
    requiresExtraDependency: false,
  };
}

/**
 * 检查 Agent SDK 是否已安装
 */
export async function isAgentSDKInstalled(): Promise<boolean> {
  try {
    // 使用动态 import 检查模块是否存在
    await import('./backends/claude-agent-backend');
    return true;
  } catch {
    return false;
  }
}
