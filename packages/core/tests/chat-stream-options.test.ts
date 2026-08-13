/** withReasoningSummary 单元测试：请求级注入摘要详略，透传其余选项与返回值（离线）。 */

import { describe, expect, it } from 'bun:test';
import type { StreamFn } from '@earendil-works/pi-agent-core';

import { withReasoningSummary } from '../src/chat/chat-engine';

describe('withReasoningSummary', () => {
  it('注入 reasoningSummary，保留既有选项与返回值；不改 model/context', () => {
    const seen: unknown[] = [];
    const sentinel = Symbol('stream');
    const base = ((model: unknown, context: unknown, options?: unknown) => {
      seen.push(model, context, options);
      return sentinel as never;
    }) as unknown as StreamFn;

    const wrapped = withReasoningSummary(base, 'detailed');
    const model = { provider: 'p', id: 'm' };
    const context = { messages: [] };
    const result = wrapped(
      model as never,
      context as never,
      {
        apiKey: 'k',
        signal: undefined,
      } as never
    );

    expect(result).toBe(sentinel as never);
    expect(seen[0]).toBe(model);
    expect(seen[1]).toBe(context);
    expect(seen[2]).toMatchObject({ apiKey: 'k', reasoningSummary: 'detailed' });
  });

  it('options 缺省时也能注入', () => {
    let captured: unknown;
    const base = ((_m: unknown, _c: unknown, options?: unknown) => {
      captured = options;
      return undefined as never;
    }) as unknown as StreamFn;
    withReasoningSummary(base, 'concise')({} as never, {} as never);
    expect(captured).toMatchObject({ reasoningSummary: 'concise' });
  });
});
