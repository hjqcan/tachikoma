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
  OpenAIAgentsBackendConfig,
} from './types';
import { shouldUseAgentSDK, shouldUseOpenAIAgents } from './types';

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

/**
 * OpenAI Agents SDK 未安装错误
 */
export class OpenAIAgentsSDKNotInstalledError extends WorkerBackendError {
  constructor() {
    super(
      'OpenAI Agents SDK is not installed. Run: bun add @openai/agents',
      'SDK_NOT_INSTALLED',
      'openai'
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
 * 延迟加载 OpenAI Agents SDK Backend
 *
 * 使用动态 import 避免在不使用时报错
 */
async function loadOpenAIAgentsBackend(): Promise<
  new (config: OpenAIAgentsBackendConfig) => IWorkerBackend
> {
  try {
    const module = await import('./backends/openai-agent-backend');
    return module.OpenAIAgentsBackend;
  } catch (error) {
    // 检查是否是模块未找到错误
    if (error instanceof Error && error.message.includes('Cannot find module')) {
      throw new OpenAIAgentsSDKNotInstalledError();
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
 * - Claude 模型默认使用 Claude Agent SDK（除非明确禁用）
 * - OpenAI 模型默认使用 OpenAI Agents SDK（可通过 backend='generic' 禁用）
 * - 其他模型使用通用后端
 *
 * @param config - 后端配置
 * @returns Worker Backend 实例
 *
 * @example
 * ```ts
 * // Claude 模型 - 自动使用 Claude Agent SDK
 * const claudeBackend = await createWorkerBackend({
 *   provider: 'anthropic',
 *   model: 'claude-3-5-sonnet-20241022',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * // OpenAI 模型 - 自动使用 OpenAI Agents SDK
 * const openaiBackend = await createWorkerBackend({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * // OpenAI 模型 - 强制使用通用后端
 * const genericOpenAIBackend = await createWorkerBackend({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   backend: 'generic',
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

  // 1. 检查 Claude Agent SDK
  if (shouldUseAgentSDK(config)) {
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
  }

  // 2. 检查 OpenAI Agents SDK
  if (shouldUseOpenAIAgents(config)) {
    try {
      const BackendClass = await loadOpenAIAgentsBackend();
      return new BackendClass(config as OpenAIAgentsBackendConfig);
    } catch (error) {
      // SDK 加载失败，自动降级到通用后端
      console.warn(
        '[createWorkerBackend] OpenAI Agents SDK load failed, falling back to GenericAgentBackend. ' +
        `Reason: ${error instanceof Error ? error.message : 'Unknown error'}. ` +
        'Install SDK with: bun add @openai/agents'
      );
      const BackendClass = await loadGenericBackend();
      return new BackendClass(config as GenericBackendConfig);
    }
  }

  // 3. 其他模型或强制使用通用后端
  const BackendClass = await loadGenericBackend();
  return new BackendClass(config as GenericBackendConfig);
}

/**
 * 同步创建 Worker Backend（使用默认通用后端）
 *
 * 适用于不需要 Agent SDK 的场景
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

  if (shouldUseOpenAIAgents(config)) {
    return {
      type: 'agent-sdk',
      provider: 'openai',
      requiresExtraDependency: true,
      dependencyPackage: '@openai/agents',
    };
  }

  return {
    type: 'generic',
    provider: config.provider,
    requiresExtraDependency: false,
  };
}

/**
 * 检查 Claude Agent SDK 是否已安装
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

/**
 * 检查 OpenAI Agents SDK 是否已安装
 */
export async function isOpenAIAgentsSDKInstalled(): Promise<boolean> {
  try {
    await import('./backends/openai-agent-backend');
    return true;
  } catch {
    return false;
  }
}

