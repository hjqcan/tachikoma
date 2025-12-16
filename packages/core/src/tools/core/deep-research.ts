/**
 * deep_research - Gemini Deep Research Agent 工具
 *
 * 调用 Gemini Interactions API 中的 Deep Research 代理，执行长时网络研究，
 * 返回带 citations 的报告。
 *
 * 需要配置（任一）：
 * - GEMINI_API_KEY
 * - GOOGLE_API_KEY
 *
 * @layer Atomic
 * @category Network
 * @permissions NetworkRead, NetworkWrite
 */

import type { Tool, ExecutionContext } from '../../types';
import type { ToolResult } from '../types';
import { ToolLayer, ToolCategory, ToolPermission } from '../types';

export const DEFAULT_AGENT = 'deep-research-pro-preview-12-2025';
export const INTERACTIONS_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/interactions';
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface DeepResearchInput {
  input: string;
  agent?: string;
  agentConfig?: Record<string, unknown>;
  previousInteractionId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface DeepResearchCitation {
  url?: string;
  title?: string;
  snippet?: string;
  [key: string]: unknown;
}

export interface DeepResearchOutput {
  interactionId: string;
  status: string;
  report?: string;
  citations?: DeepResearchCitation[];
  raw: unknown;
  latencyMs: number;
}

/**
 * Normalize interaction identifier into an ID segment suitable for
 * `${INTERACTIONS_BASE_URL}/{id}`.
 *
 * The Interactions API may return either:
 * - plain id: "123"
 * - resource name: "interactions/123"
 * - full resource path: "projects/.../locations/.../interactions/123"
 */
export function normalizeInteractionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  const idx = parts.lastIndexOf('interactions');
  if (idx !== -1 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return parts[parts.length - 1];
}

export function extractInteractionId(created: Record<string, unknown>): string | undefined {
  return (
    normalizeInteractionId(created.id) ||
    normalizeInteractionId(created.interaction_id) ||
    normalizeInteractionId(created.interactionId) ||
    normalizeInteractionId(created.name)
  );
}

export function validateInput(input: unknown): {
  valid: boolean;
  error?: string;
  data?: DeepResearchInput;
} {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.input !== 'string' || obj.input.trim().length === 0) {
    return { valid: false, error: '`input` is required and must be a non-empty string' };
  }

  if (obj.agent !== undefined && typeof obj.agent !== 'string') {
    return { valid: false, error: '`agent` must be a string' };
  }
  if (obj.agentConfig !== undefined && typeof obj.agentConfig !== 'object') {
    return { valid: false, error: '`agentConfig` must be an object' };
  }
  if (obj.previousInteractionId !== undefined && typeof obj.previousInteractionId !== 'string') {
    return { valid: false, error: '`previousInteractionId` must be a string' };
  }
  if (obj.timeoutMs !== undefined && typeof obj.timeoutMs !== 'number') {
    return { valid: false, error: '`timeoutMs` must be a number' };
  }
  if (obj.pollIntervalMs !== undefined && typeof obj.pollIntervalMs !== 'number') {
    return { valid: false, error: '`pollIntervalMs` must be a number' };
  }

  return {
    valid: true,
    data: {
      input: obj.input.trim(),
      ...(typeof obj.agent === 'string' && obj.agent.trim()
        ? { agent: obj.agent.trim() }
        : {}),
      ...(obj.agentConfig !== undefined
        ? { agentConfig: obj.agentConfig as Record<string, unknown> }
        : {}),
      ...(typeof obj.previousInteractionId === 'string' && obj.previousInteractionId.trim()
        ? { previousInteractionId: obj.previousInteractionId.trim() }
        : {}),
      ...(typeof obj.timeoutMs === 'number' ? { timeoutMs: obj.timeoutMs } : {}),
      ...(typeof obj.pollIntervalMs === 'number' ? { pollIntervalMs: obj.pollIntervalMs } : {}),
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractReport(raw: unknown): string | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r) return undefined;

  const direct = r.output;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') {
    const d = direct as Record<string, unknown>;
    if (typeof d.text === 'string') return d.text;
    if (typeof d.content === 'string') return d.content;
    if (typeof d.report === 'string') return d.report;
  }

  const response = r.response;
  if (response && typeof response === 'object') {
    const rr = response as Record<string, unknown>;
    if (typeof rr.text === 'string') return rr.text;
    if (typeof rr.content === 'string') return rr.content;
  }

  const candidates = ['result', 'final', 'answer'];
  for (const key of candidates) {
    const val = r[key];
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      const vv = val as Record<string, unknown>;
      if (typeof vv.text === 'string') return vv.text;
      if (typeof vv.content === 'string') return vv.content;
    }
  }

  return undefined;
}

export function extractCitations(raw: unknown): DeepResearchCitation[] | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r) return undefined;

  const direct = r.citations ?? (r.output as any)?.citations ?? (r.response as any)?.citations;
  if (Array.isArray(direct)) {
    return direct.filter((c) => c && typeof c === 'object') as DeepResearchCitation[];
  }
  return undefined;
}

export async function startInteraction(
  input: DeepResearchInput,
  apiKey: string
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    input: input.input,
    agent: input.agent ?? DEFAULT_AGENT,
    background: true,
    store: true,
  };

  if (input.agentConfig) {
    payload.agent_config = input.agentConfig;
  }
  if (input.previousInteractionId) {
    payload.previous_interaction_id = input.previousInteractionId;
  }

  const response = await fetch(INTERACTIONS_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Interactions create failed: ${response.status} ${response.statusText} ${text}`.trim()
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

export async function getInteraction(
  interactionId: string,
  apiKey: string
): Promise<Record<string, unknown>> {
  const normalized = normalizeInteractionId(interactionId);
  if (!normalized) {
    throw new Error('Invalid interactionId');
  }

  const response = await fetch(`${INTERACTIONS_BASE_URL}/${normalized}`, {
    method: 'GET',
    headers: {
      'x-goog-api-key': apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Interactions get failed: ${response.status} ${response.statusText} ${text}`.trim()
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

export const deepResearchTool: Tool = {
  name: 'deep_research',
  title: 'Deep Research (Gemini)',
  description: `调用 Gemini Deep Research Agent 执行长时网络研究任务并返回带引用的报告。

默认使用 agent: ${DEFAULT_AGENT}，后台执行并轮询直到 completed/failed。

需要在环境变量中配置 GEMINI_API_KEY（或 GOOGLE_API_KEY 作为兼容别名）。`,
  layer: ToolLayer.Atomic,
  category: ToolCategory.Network,
  permissions: [ToolPermission.NetworkRead, ToolPermission.NetworkWrite],
  annotations: {
    idempotent: false,
    cacheable: false,
    estimatedDuration: 60_000,
    priority: 4,
  },
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: '研究问题/任务描述',
      },
      agent: {
        type: 'string',
        description: `Deep Research agent 名称（默认 ${DEFAULT_AGENT}）`,
      },
      agentConfig: {
        type: 'object',
        description: 'agent_config 透传（如 { type: "deep-research", thinking_summaries: "auto" }）',
      },
      previousInteractionId: {
        type: 'string',
        description: '用于 follow-up 的 previous_interaction_id（可选）',
      },
      timeoutMs: {
        type: 'number',
        description: `最大等待时间（毫秒，默认 ${DEFAULT_TIMEOUT_MS}）`,
        default: DEFAULT_TIMEOUT_MS,
      },
      pollIntervalMs: {
        type: 'number',
        description: `轮询间隔（毫秒，默认 ${DEFAULT_POLL_INTERVAL_MS}）`,
        default: DEFAULT_POLL_INTERVAL_MS,
      },
    },
    required: ['input'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      interactionId: { type: 'string' },
      status: { type: 'string' },
      report: { type: 'string' },
      citations: { type: 'array', items: { type: 'object' } },
      raw: { type: 'object' },
      latencyMs: { type: 'number' },
    },
  },

  async execute(
    input: unknown,
    context: ExecutionContext
  ): Promise<ToolResult<DeepResearchOutput>> {
    const validation = validateInput(input);
    if (!validation.valid || !validation.data) {
      return { success: false, error: `Invalid input: ${validation.error}` };
    }

    const startTime = Date.now();
    const apiKey =
      context.env?.GEMINI_API_KEY ??
      context.env?.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error:
          'Missing API key: set GEMINI_API_KEY (preferred) or GOOGLE_API_KEY in env',
      };
    }

    const timeoutMs = validation.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs =
      validation.data.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + Math.max(5_000, timeoutMs);

    try {
      const created = await startInteraction(validation.data, apiKey);
      const interactionId = extractInteractionId(created);

      if (!interactionId) {
        return {
          success: false,
          error: 'Interactions API did not return an interaction id',
          data: {
            interactionId: '',
            status: 'unknown',
            raw: created,
            latencyMs: Date.now() - startTime,
          },
        };
      }

      let current = created;
      let status = (current.status as string | undefined) ?? 'unknown';

      // Poll until done or timeout
      while (Date.now() < deadline) {
        if (status === 'completed' || status === 'failed') {
          break;
        }
        await sleep(pollIntervalMs);
        current = await getInteraction(interactionId, apiKey);
        status = (current.status as string | undefined) ?? status;
      }

      const report = extractReport(current);
      const citations = extractCitations(current);
      const latencyMs = Date.now() - startTime;

      if (status === 'failed') {
        const errMsg =
          (current.error as string | undefined) ??
          'Deep research failed (unknown error)';
        const output: DeepResearchOutput = {
          interactionId,
          status,
          raw: current,
          latencyMs,
          ...(report !== undefined ? { report } : {}),
          ...(citations !== undefined ? { citations } : {}),
        };
        return {
          success: false,
          error: errMsg,
          data: output,
        };
      }

      if (status !== 'completed') {
        const output: DeepResearchOutput = {
          interactionId,
          status,
          raw: current,
          latencyMs,
          ...(report !== undefined ? { report } : {}),
          ...(citations !== undefined ? { citations } : {}),
        };
        return {
          success: false,
          error: `Deep research timed out (last status: ${status})`,
          data: output,
        };
      }

      const output: DeepResearchOutput = {
        interactionId,
        status,
        raw: current,
        latencyMs,
        ...(report !== undefined ? { report } : {}),
        ...(citations !== undefined ? { citations } : {}),
      };
      return {
        success: true,
        data: output,
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        error: `Deep research request failed: ${err.message}`,
      };
    }
  },
};

export default deepResearchTool;
