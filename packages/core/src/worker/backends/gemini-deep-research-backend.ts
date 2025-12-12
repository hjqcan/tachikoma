/**
 * Gemini Deep Research Backend (TODO)
 *
 * 预留：将 Gemini Deep Research Agent 适配为 IWorkerBackend。
 *
 * ⚠️ 当前仅为占位符：
 * - 不在 backend-factory 中注册
 * - 不参与默认路由
 * - execute 逻辑未实现
 */

import type {
  IWorkerBackend,
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
} from '../types';
import type { Tool } from '../../types';

export interface GeminiDeepResearchBackendConfig {
  /** Gemini API key（优先使用 GEMINI_API_KEY） */
  apiKey?: string;
  /** Deep Research agent 名称 */
  agent?: string;
}

export class GeminiDeepResearchBackend implements IWorkerBackend {
  readonly provider = 'google';
  readonly backendType: WorkerBackendType = 'generic';

  constructor(_config: GeminiDeepResearchBackendConfig = {}) {
    // TODO: wire Interactions API client & config
  }

  async *execute(
    _task: WorkerTask,
    _tools: Tool[],
    _options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage> {
    // TODO: implement long-running Deep Research execution.
    throw new Error('TODO: GeminiDeepResearchBackend is not implemented');
  }

  getCapabilities(): WorkerCapability[] {
    // TODO: return accurate capabilities.
    return ['web-search'];
  }

  isAvailable(): boolean {
    // TODO: check key/config readiness.
    return false;
  }

  async interrupt(): Promise<void> {
    // TODO: support cancellation / abort.
  }

  async dispose(): Promise<void> {
    // TODO: cleanup resources.
  }
}

export default GeminiDeepResearchBackend;
