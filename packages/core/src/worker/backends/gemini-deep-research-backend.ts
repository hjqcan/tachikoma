import type {
  WorkerBackendType,
  WorkerCapability,
  WorkerMessage,
  WorkerTask,
  WorkerExecutionOptions,
} from '../types';
import type { Tool } from '../../types';
import { BaseWorkerBackend } from './base-backend';
import {
  startInteraction,
  getInteraction,
  extractReport,
  extractCitations,
  sleep,
  validateInput,
  extractInteractionId,
  DEFAULT_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type DeepResearchInput,
} from '../../tools/core/deep-research';

export interface GeminiDeepResearchBackendConfig {
  /** Gemini API key（优先使用 GEMINI_API_KEY） */
  apiKey?: string;
  /** Deep Research agent 名称 */
  agent?: string;
}

export class GeminiDeepResearchBackend extends BaseWorkerBackend {
  readonly provider = 'google';
  readonly backendType: WorkerBackendType = 'generic';
  private config: GeminiDeepResearchBackendConfig;

  constructor(config: GeminiDeepResearchBackendConfig = {}) {
    super(undefined, 'GeminiDeepResearchBackend'); // 无 Memory
    this.config = config;
  }

  async *execute(
    task: WorkerTask,
    _tools: Tool[],
    options: WorkerExecutionOptions
  ): AsyncIterable<WorkerMessage> {
    // 1. Resolve API Key
    const apiKey =
      this.config.apiKey ??
      options.env?.GEMINI_API_KEY ??
      options.env?.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      yield {
        type: 'error',
        error: 'Missing API key: set GEMINI_API_KEY or GOOGLE_API_KEY',
        retryable: false,
        timestamp: Date.now(),
      };
      yield {
        type: 'status',
        status: 'failed',
        timestamp: Date.now(),
      };
      return;
    }

    // 启动生命周期控制器
    this.executionController.start();

    try {
      // 集成外部 abortSignal
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          yield { type: 'status', status: 'interrupted', timestamp: Date.now() };
          return;
        }
        options.abortSignal.addEventListener('abort', () => {
          this.executionController.abort();
        }, { once: true });
      }

    // 1. Initial Status
    yield {
      type: 'status',
      status: 'initializing',
      timestamp: Date.now(),
    };

    // 2. Prepare Input
    const inputData: DeepResearchInput = {
      input: task.objective, // Use task objective as prompt
      agent: this.config.agent ?? DEFAULT_AGENT,
      timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
    };

    const validation = validateInput(inputData);
    if (!validation.valid || !validation.data) {
       yield {
        type: 'error',
        error: `Invalid task input: ${validation.error}`,
        retryable: false,
        timestamp: Date.now(),
      };
      yield {
        type: 'status',
        status: 'failed',
        timestamp: Date.now(),
      };
      return;
    }

    // 3. Start Interaction
    let interactionId: string;
    try {
      yield {
        type: 'status',
        status: 'initializing',
        timestamp: Date.now(),
      };
      
      const created = await startInteraction(validation.data, apiKey);
      interactionId = extractInteractionId(created) ?? '';

      if (!interactionId) {
        throw new Error('Interactions API did not return an interaction id');
      }

      yield {
        type: 'thinking',
        content: `Deep Research started (ID: ${interactionId}). polling for results...`,
        timestamp: Date.now(),
      };
    } catch (error) {
       const err = error as Error;
       yield {
        type: 'error',
        error: `Failed to start Deep Research: ${err.message}`,
        retryable: true,
        timestamp: Date.now(),
      };
      yield {
        type: 'status',
        status: 'failed',
        timestamp: Date.now(),
      };
      return;
    }

    // 4. Poll Loop
    const deadline = Date.now() + (validation.data.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pollInterval = validation.data.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let lastStatus = 'unknown';
    let consecutivePollFailures = 0;

    while (Date.now() < deadline) {
      if (options.abortSignal?.aborted || this.executionController.isAborted) {
        yield {
          type: 'status',
          status: 'interrupted',
          timestamp: Date.now(),
        };
        return;
      }

      try {
        const current = await getInteraction(interactionId, apiKey);
        const status = (current.status as string | undefined) ?? 'unknown';
        consecutivePollFailures = 0;

        if (status !== lastStatus) {
           yield {
            type: 'status',
            status: 'thinking', // Still thinking/working
            timestamp: Date.now(),
          };
          yield {
            type: 'thinking',
            content: `Deep Research status: ${status}`,
            timestamp: Date.now(),
          };
          lastStatus = status;
        }

        if (status === 'completed') {
            const report = extractReport(current);
            const citations = extractCitations(current);
            
            let outputContent = report ?? 'No report content returned.';
            if (citations && citations.length > 0) {
                outputContent += '\n\nCitations:\n';
                citations.forEach((c, i) => {
                    outputContent += `[${i+1}] ${c.title || c.url || 'Source'} - ${c.url}\n`;
                });
            }

            yield {
                type: 'output',
                content: outputContent,
                timestamp: Date.now(),
            };
            yield {
                type: 'status',
                status: 'completed',
                timestamp: Date.now(),
            };
            return;
        }

        if (status === 'failed') {
            const errMsg = (current.error as string | undefined) ?? 'Unknown error from Deep Research Agent';
            throw new Error(errMsg);
        }

        await sleep(pollInterval);
      } catch (error) {
        const err = error as Error;
        consecutivePollFailures += 1;

        // Best-effort retry on transient polling errors.
        yield {
          type: 'thinking',
          content: `Deep Research polling error (${consecutivePollFailures}): ${err.message}`,
          timestamp: Date.now(),
        };

        if (consecutivePollFailures >= 3) {
          yield {
            type: 'error',
            error: `Deep Research polling failed: ${err.message}`,
            retryable: true,
            timestamp: Date.now(),
          };
          yield {
            type: 'status',
            status: 'failed',
            timestamp: Date.now(),
          };
          return;
        }

        // Backoff a bit before retrying.
        await sleep(Math.min(pollInterval * consecutivePollFailures, 30_000));
      }
    }

    // Timeout
    yield {
        type: 'error',
        error: 'Deep Research timed out',
        retryable: true,
        timestamp: Date.now(),
    };
    yield {
        type: 'status',
        status: 'failed',
        timestamp: Date.now(),
    };

    } finally {
      // 结束执行周期
      this.executionController.end();
    }
  }

  getCapabilities(): WorkerCapability[] {
    return ['web-search'];
  }

  isAvailable(): boolean {
    const key = this.config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    return !!key;
  }

  // interrupt() 和 dispose() 继承自 BaseWorkerBackend
}

export default GeminiDeepResearchBackend;
