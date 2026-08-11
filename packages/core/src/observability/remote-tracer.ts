/**
 * Remote Tracer Implementation
 *
 * Sends traces to the AgentOps server.
 */

import type { Tracer, Span, SpanOptions, TracerConfig, SpanStatus, SpanEvent, SpanSnapshot } from './types';
import { AgentOpsClient, type AgentOpsConfig } from './agentops-client';

// Generate ID helpers (same as tracer.ts)
function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateTraceId(): string {
  return generateId() + generateId();
}

class RemoteSpan implements Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly name: string;
  readonly startTime: number;

  private endTime?: number;
  private status: SpanStatus = 'unset';
  private statusMessage?: string;
  private attributes: Record<string, string | number | boolean> = {};
  private events: SpanEvent[] = [];
  private parentSpanId?: string;
  private client: AgentOpsClient;

  constructor(name: string, client: AgentOpsClient, options?: SpanOptions) {
    this.name = name;
    this.client = client;
    this.spanId = generateId();
    this.traceId = options?.traceId ?? generateTraceId();
    this.startTime = Date.now();

    if (options?.parentSpanId) {
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
    this.events.push({
      name,
      timestamp: Date.now(),
      ...(attributes && { attributes }),
    });
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.status = status;
    if (message) {
      this.statusMessage = message;
    }
  }

  end(): void {
    if (this.endTime) return;
    this.endTime = Date.now();

    // Send to AgentOps
    this.client.push(this.toSnapshot());
  }

  getDuration(): number | undefined {
    if (!this.endTime) return undefined;
    return this.endTime - this.startTime;
  }

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
    if (this.parentSpanId) snapshot.parentSpanId = this.parentSpanId;
    if (this.endTime) snapshot.endTime = this.endTime;
    const duration = this.getDuration();
    if (duration !== undefined) snapshot.duration = duration;
    if (this.statusMessage) snapshot.statusMessage = this.statusMessage;

    return snapshot;
  }
}

export interface RemoteTracerConfig extends TracerConfig {
  agentOps?: AgentOpsConfig;
}

export class RemoteTracer implements Tracer {
  private currentTraceId?: string;
  private client: AgentOpsClient;

  constructor(config?: RemoteTracerConfig) {
    this.client = new AgentOpsClient('traces', config?.agentOps);
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const traceId = options?.traceId ?? this.currentTraceId;
    const spanOptions: SpanOptions = { ...options };
    if (traceId) {
      spanOptions.traceId = traceId;
    }
    return new RemoteSpan(name, this.client, spanOptions);
  }

  getCurrentTraceId(): string | undefined {
    return this.currentTraceId;
  }

  setCurrentTraceId(traceId: string): void {
    this.currentTraceId = traceId;
  }
}
