/**
 * 追踪中间件
 *
 * 生成 TraceID 和 SpanID，支持 OpenTelemetry 集成
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';

// ============================================================================
// ID 生成器
// ============================================================================

/**
 * 生成随机十六进制字符串
 */
function generateHexId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成 Trace ID (32 字符十六进制)
 * 符合 W3C Trace Context 规范
 */
export function generateTraceId(): string {
  return generateHexId(32);
}

/**
 * 生成 Span ID (16 字符十六进制)
 * 符合 W3C Trace Context 规范
 */
export function generateSpanId(): string {
  return generateHexId(16);
}

/**
 * 生成请求 ID (更短的唯一标识)
 */
export function generateRequestId(): string {
  return `req_${generateHexId(16)}`;
}

// ============================================================================
// W3C Trace Context 解析
// ============================================================================

/**
 * 解析 traceparent 头
 * 格式: {version}-{trace-id}-{parent-id}-{trace-flags}
 * 示例: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 */
export function parseTraceparent(
  header: string | undefined
): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  if (!header) return null;

  const parts = header.split('-');
  if (parts.length !== 4) return null;

  const version = parts[0];
  const traceId = parts[1];
  const parentSpanId = parts[2];
  const flags = parts[3];

  // 检查版本（目前只支持 00）
  if (version !== '00' || !traceId || !parentSpanId || !flags) return null;

  // 检查 trace-id 和 parent-id 格式
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/.test(parentSpanId)) return null;

  // 解析 flags
  const flagsByte = parseInt(flags, 16);
  const sampled = (flagsByte & 0x01) === 1;

  return { traceId, parentSpanId, sampled };
}

/**
 * 生成 traceparent 头
 */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  const flags = sampled ? '01' : '00';
  return `00-${traceId}-${spanId}-${flags}`;
}

// ============================================================================
// 追踪中间件
// ============================================================================

/**
 * 追踪中间件配置
 */
export interface TraceMiddlewareOptions {
  /** 是否从传入请求继承 trace ID */
  propagateFromRequest?: boolean;
  /** 自定义请求头名称 */
  headerName?: string;
  /** 是否在响应中返回追踪头 */
  includeInResponse?: boolean;
}

/**
 * 创建追踪中间件
 *
 * 功能:
 * - 生成或继承 Trace ID
 * - 生成 Span ID
 * - 生成 Request ID
 * - 记录请求开始时间
 * - 在响应头中返回追踪信息
 */
export function traceMiddleware(options: TraceMiddlewareOptions = {}) {
  const {
    propagateFromRequest = true,
    headerName = 'traceparent',
    includeInResponse = true,
  } = options;

  return createMiddleware<AppEnv>(async (c, next) => {
    // 1. 尝试从请求头继承追踪信息
    let traceId: string;
    let parentSpanId: string | undefined;

    if (propagateFromRequest) {
      const traceparent = c.req.header(headerName);
      const parsed = parseTraceparent(traceparent);

      if (parsed) {
        traceId = parsed.traceId;
        parentSpanId = parsed.parentSpanId;
      } else {
        traceId = generateTraceId();
      }
    } else {
      traceId = generateTraceId();
    }

    // 2. 生成当前 Span ID
    const spanId = generateSpanId();

    // 3. 生成 Request ID
    const requestId = generateRequestId();

    // 4. 记录请求开始时间
    const requestStart = Date.now();

    // 5. 设置上下文变量
    c.set('traceId', traceId);
    c.set('spanId', spanId);
    c.set('requestId', requestId);
    c.set('requestStart', requestStart);

    // 6. 执行下一个中间件
    await next();

    // 7. 在响应头中添加追踪信息
    if (includeInResponse) {
      c.header('X-Trace-Id', traceId);
      c.header('X-Span-Id', spanId);
      c.header('X-Request-Id', requestId);
      c.header(headerName, formatTraceparent(traceId, spanId));

      // 如果有父 span，也返回
      if (parentSpanId) {
        c.header('X-Parent-Span-Id', parentSpanId);
      }
    }
  });
}

// ============================================================================
// Span 上下文（用于 OTEL 集成）
// ============================================================================

/**
 * Span 状态
 */
export type SpanStatus = 'unset' | 'ok' | 'error';

/**
 * Span 上下文
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  operation: string;
  startTime: number;
  endTime?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: {
    name: string;
    timestamp: number;
    attributes?: Record<string, unknown> | undefined;
  }[];
}

/**
 * 创建 Span 上下文
 */
export function createSpanContext(
  traceId: string,
  spanId: string,
  operation: string,
  parentSpanId?: string
): SpanContext {
  return {
    traceId,
    spanId,
    parentSpanId,
    operation,
    startTime: Date.now(),
    status: 'unset',
    attributes: {},
    events: [],
  };
}

/**
 * 添加 Span 属性
 */
export function setSpanAttribute(span: SpanContext, key: string, value: unknown): void {
  span.attributes[key] = value;
}

/**
 * 添加 Span 事件
 */
export function addSpanEvent(
  span: SpanContext,
  name: string,
  attributes?: Record<string, unknown>
): void {
  span.events.push({
    name,
    timestamp: Date.now(),
    ...(attributes && { attributes }),
  });
}

/**
 * 结束 Span
 */
export function endSpan(span: SpanContext, status: SpanStatus = 'ok'): void {
  span.endTime = Date.now();
  span.status = status;
}
