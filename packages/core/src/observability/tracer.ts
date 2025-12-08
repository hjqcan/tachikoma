/**
 * Tracer 实现
 *
 * 提供 No-op 和 Console 两种实现
 */

import type {
  Tracer,
  TracerConfig,
  Span,
  SpanOptions,
  SpanStatus,
  SpanEvent,
  SpanSnapshot,
} from './types';

// ============================================================================
// ID 生成
// ============================================================================

/**
 * 生成随机 ID (16 字符十六进制)
 */
function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成 Trace ID (32 字符十六进制)
 */
function generateTraceId(): string {
  return generateId() + generateId();
}

// ============================================================================
// Base Span 实现
// ============================================================================

/**
 * 基础 Span 实现
 */
class BaseSpan implements Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly name: string;
  readonly startTime: number;

  protected endTime?: number;
  protected status: SpanStatus = 'unset';
  protected statusMessage?: string;
  protected attributes: Record<string, string | number | boolean> = {};
  protected events: SpanEvent[] = [];
  protected parentSpanId?: string;

  constructor(name: string, options?: SpanOptions) {
    this.spanId = generateId();
    this.traceId = options?.traceId ?? generateTraceId();
    this.name = name;
    this.startTime = Date.now();
    if (options?.parentSpanId !== undefined) {
      this.parentSpanId = options.parentSpanId;
    }

    if (options?.attributes) {
      this.attributes = { ...options.attributes };
    }
  }

  addTag(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    const event: SpanEvent = {
      name,
      timestamp: Date.now(),
    };
    if (attributes !== undefined) {
      event.attributes = attributes;
    }
    this.events.push(event);
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.status = status;
    if (message !== undefined) {
      this.statusMessage = message;
    }
  }

  end(): void {
    if (this.endTime === undefined) {
      this.endTime = Date.now();
    }
  }

  getDuration(): number | undefined {
    if (this.endTime === undefined) return undefined;
    return this.endTime - this.startTime;
  }

  /**
   * 导出快照
   */
  toSnapshot(): SpanSnapshot {
    const snapshot: SpanSnapshot = {
      spanId: this.spanId,
      traceId: this.traceId,
      name: this.name,
      startTime: this.startTime,
      status: this.status,
      attributes: { ...this.attributes },
      events: [...this.events],
    };
    if (this.parentSpanId !== undefined) {
      snapshot.parentSpanId = this.parentSpanId;
    }
    if (this.endTime !== undefined) {
      snapshot.endTime = this.endTime;
    }
    const duration = this.getDuration();
    if (duration !== undefined) {
      snapshot.duration = duration;
    }
    if (this.statusMessage !== undefined) {
      snapshot.statusMessage = this.statusMessage;
    }
    return snapshot;
  }
}

// ============================================================================
// No-op Tracer
// ============================================================================

/**
 * No-op Span
 *
 * 不产生任何输出，但保留 spanId/traceId 用于日志关联
 */
class NoopSpan extends BaseSpan {
  // 继承基类实现即可
}

/**
 * No-op Tracer 实现
 *
 * 不产生任何 I/O，但生成有效的 traceId/spanId
 */
export class NoopTracer implements Tracer {
  private currentTraceId?: string;

  startSpan(name: string, options?: SpanOptions): Span {
    const traceId = options?.traceId ?? this.currentTraceId;
    const spanOptions: SpanOptions = { ...options };
    if (traceId !== undefined) {
      spanOptions.traceId = traceId;
    }
    return new NoopSpan(name, spanOptions);
  }

  getCurrentTraceId(): string | undefined {
    return this.currentTraceId;
  }

  setCurrentTraceId(traceId: string): void {
    this.currentTraceId = traceId;
  }
}

// ============================================================================
// Console Tracer
// ============================================================================

/**
 * Console Span
 *
 * 根据 outputLevel 控制输出管理
 */
class ConsoleSpan extends BaseSpan {
  private readonly outputLevel: 'full' | 'end-only' | 'none';

  constructor(name: string, options: SpanOptions | undefined, outputLevel: 'full' | 'end-only' | 'none') {
    super(name, options);
    this.outputLevel = outputLevel;
    
    if (outputLevel === 'full') {
      console.log(
        JSON.stringify({
          type: 'span_start',
          spanId: this.spanId,
          traceId: this.traceId,
          parentSpanId: this.parentSpanId,
          name: this.name,
          ts: new Date(this.startTime).toISOString(),
          attributes: this.attributes,
        })
      );
    }
  }

  override addEvent(name: string, attributes?: Record<string, unknown>): void {
    super.addEvent(name, attributes);
    if (this.outputLevel === 'full') {
      console.log(
        JSON.stringify({
          type: 'span_event',
          spanId: this.spanId,
          traceId: this.traceId,
          event: name,
          ts: new Date().toISOString(),
          attributes,
        })
      );
    }
  }

  override end(): void {
    super.end();
    if (this.outputLevel !== 'none') {
      console.log(
        JSON.stringify({
          type: 'span_end',
          spanId: this.spanId,
          traceId: this.traceId,
          name: this.name,
          duration: this.getDuration(),
          status: this.status,
          statusMessage: this.statusMessage,
          ts: new Date(this.endTime ?? Date.now()).toISOString(),
        })
      );
    }
  }
}

/**
 * Console Tracer 实现
 *
 * 在 span 开始、事件、结束时输出 JSON 到 console
 * 通过 outputLevel 控制输出级别
 */
export class ConsoleTracer implements Tracer {
  private currentTraceId?: string;
  private readonly outputLevel: 'full' | 'end-only' | 'none';

  constructor(config?: TracerConfig) {
    this.outputLevel = config?.outputLevel ?? 'end-only';
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const traceId = options?.traceId ?? this.currentTraceId;
    const spanOptions: SpanOptions = { ...options };
    if (traceId !== undefined) {
      spanOptions.traceId = traceId;
    }
    return new ConsoleSpan(name, spanOptions, this.outputLevel);
  }

  getCurrentTraceId(): string | undefined {
    return this.currentTraceId;
  }

  setCurrentTraceId(traceId: string): void {
    this.currentTraceId = traceId;
  }
}

// ============================================================================
// 默认实例与工厂
// ============================================================================

/**
 * 默认 Tracer 配置
 */
export const DEFAULT_TRACER_CONFIG: Required<TracerConfig> = {
  enabled: true,
  serviceName: 'tachikoma',
  outputLevel: 'end-only',
};

/**
 * 默认 Tracer 实例 (no-op)
 */
export const defaultTracer: Tracer = new NoopTracer();

/**
 * 创建 Tracer
 *
 * @param config 配置
 * @param useConsole 是否使用 Console 输出（默认 false，使用 no-op）
 *
 * 扩展说明：未来可根据 config.exporter 创建 OTEL Tracer
 */
export function createTracer(config?: TracerConfig, useConsole = false): Tracer {
  if (config?.enabled === false) {
    return new NoopTracer();
  }
  return useConsole ? new ConsoleTracer(config) : new NoopTracer();
}
