/**
 * ChatEvent 流的归一化投影 —— 快照回放 diff 与 WAL⟷history 一致性测试共用。
 *
 * 归一化目标：同一行为在两次运行（录制/回放、live/history）间产生**逐字节相同**的
 * 投影。抹掉一切运行随机性：id 序数化、时间戳/usage 丢弃、delta 合并为整段文本、
 * 路径与模型名 token 化。投影是测试基础设施，不是产品面。
 */

import type { ChatEvent } from '../src';

export interface ProjectionRoot {
  /** 替换后的字面 token（如 '{{workspace}}'） */
  token: string;
  /** 运行期真实路径（会先做 realpath 由调用方保证；此处仅做字符串替换） */
  path: string;
}

export interface ProjectionOptions {
  /** 路径 → token 替换表（长路径优先替换，避免前缀遮蔽） */
  roots?: readonly ProjectionRoot[];
  /**
   * history() 可比子集模式：再丢弃 history 明文不重建的事件
   * （reasoning、审批、retry、compaction），complete.content 保留。
   */
  historyComparable?: boolean;
}

export type ProjectedEvent =
  | { type: 'user'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: string; tool: string; input: unknown }
  | { type: 'tool_result'; call: string; tool: string; output: string; isError: boolean }
  | { type: 'approval_request'; call: string; tool: string }
  | { type: 'approval_resolved'; call: string; approved: boolean; reason: string; scope?: string }
  | { type: 'retry'; attempt: number }
  | { type: 'compaction'; phase: string }
  | { type: 'complete'; status: string; stopReason: string; content: string };

/** 深度遍历替换字符串字段中的根路径；根按长度降序，长路径先替换 */
function tokenizeValue(value: unknown, roots: readonly ProjectionRoot[]): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const root of [...roots].sort((a, b) => b.path.length - a.path.length)) {
      result = result.replaceAll(root.path, root.token);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => tokenizeValue(item, roots));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        tokenizeValue(item, roots),
      ])
    );
  }
  return value;
}

export function projectEvents(
  events: readonly ChatEvent[],
  options: ProjectionOptions = {}
): ProjectedEvent[] {
  const roots = options.roots ?? [];
  const projected: ProjectedEvent[] = [];
  let turn = 0;
  let callOrdinal = 0;
  const callIds = new Map<string, string>();
  const callOf = (callId: string): string => {
    let assigned = callIds.get(callId);
    if (!assigned) {
      callOrdinal += 1;
      assigned = `t${turn}.c${callOrdinal}`;
      callIds.set(callId, assigned);
    }
    return assigned;
  };

  let buffer: { type: 'reasoning' | 'text'; text: string } | null = null;
  const flush = (): void => {
    if (buffer) {
      // reasoning 只保 trim 后文本：faux 回放 thinking 流会丢尾部空白（live 流保留），
      // 这是过程可见性不是行为契约，不让它制造假差异。text 保持逐字节精确。
      const text = buffer.type === 'reasoning' ? buffer.text.trim() : buffer.text;
      if (text.length > 0) {
        projected.push({ type: buffer.type, text });
      }
    }
    buffer = null;
  };
  const accumulate = (type: 'reasoning' | 'text', text: string): void => {
    if (buffer && buffer.type !== type) {
      flush();
    }
    buffer = { type, text: (buffer?.text ?? '') + text };
  };

  for (const event of events) {
    switch (event.type) {
      case 'user_message':
        flush();
        turn += 1;
        callOrdinal = 0;
        projected.push({ type: 'user', text: event.text });
        break;
      case 'message_start':
        break;
      case 'message_delta':
        accumulate('text', event.text);
        break;
      case 'reasoning_delta':
        if (!options.historyComparable) {
          accumulate('reasoning', event.text);
        }
        break;
      case 'tool_call':
        flush();
        projected.push({
          type: 'tool_call',
          call: callOf(event.callId),
          tool: event.tool,
          input: event.input,
        });
        break;
      case 'tool_update':
        break;
      case 'tool_result':
        flush();
        projected.push({
          type: 'tool_result',
          call: callOf(event.callId),
          tool: event.tool,
          output: event.output,
          isError: event.isError,
        });
        break;
      case 'tool_approval_request':
        if (!options.historyComparable) {
          flush();
          projected.push({
            type: 'approval_request',
            call: callOf(event.callId),
            tool: event.tool,
          });
        }
        break;
      case 'tool_approval_resolved':
        if (!options.historyComparable) {
          flush();
          projected.push({
            type: 'approval_resolved',
            call: callOf(event.callId),
            approved: event.approved,
            reason: event.reason,
            ...(event.scope ? { scope: event.scope } : {}),
          });
        }
        break;
      case 'retry':
        if (!options.historyComparable) {
          flush();
          projected.push({ type: 'retry', attempt: event.attempt });
        }
        break;
      case 'compaction':
        if (!options.historyComparable) {
          flush();
          projected.push({ type: 'compaction', phase: event.phase });
        }
        break;
      case 'memory_status':
        break;
      case 'message_complete':
        flush();
        projected.push({
          type: 'complete',
          status: event.status,
          stopReason: event.stopReason,
          content: event.content,
        });
        break;
    }
  }
  flush();
  return roots.length > 0 ? (tokenizeValue(projected, roots) as ProjectedEvent[]) : projected;
}
