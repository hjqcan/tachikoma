/**
 * 可观测性模块入口
 *
 * 导出 Logger、Tracer、MetricsCollector 接口和实现
 *
 * @packageDocumentation
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // Logger 类型
  LogLevel,
  LogContext,
  LogEntry,
  Logger,
  LoggerConfig,
  // Tracer 类型
  SpanStatus,
  SpanOptions,
  SpanEvent,
  Span,
  SpanSnapshot,
  Tracer,
  TracerConfig,
  // Metrics 类型
  MetricType,
  MetricTags,
  CounterValue,
  GaugeValue,
  HistogramValue,
  MetricValue,
  MetricsSnapshot,
  MetricsCollector,
  MetricsCollectorConfig,
  // 组合类型
  ObservabilityConfig,
  Observability,
} from './types';

// 预定义指标名称
export { WORKER_METRICS, SANDBOX_METRICS } from './types';

// ============================================================================
// Logger 导出
// ============================================================================

export {
  ConsoleLogger,
  NoopLogger,
  DEFAULT_LOGGER_CONFIG,
  defaultLogger,
  noopLogger,
  createLogger,
} from './console-logger';

// ============================================================================
// Tracer 导出
// ============================================================================

export {
  NoopTracer,
  ConsoleTracer,
  DEFAULT_TRACER_CONFIG,
  defaultTracer,
  createTracer,
} from './tracer';

// ============================================================================
// Metrics 导出
// ============================================================================

export {
  MemoryMetrics,
  NoopMetrics,
  DEFAULT_METRICS_CONFIG,
  defaultMetrics,
  noopMetrics,
  createMetrics,
} from './memory-metrics';

// ============================================================================
// 便捷工厂
// ============================================================================

import type { Observability, ObservabilityConfig } from './types';
import { createLogger, noopLogger } from './console-logger';
import { createTracer } from './tracer';
import { createMetrics, noopMetrics } from './memory-metrics';

/**
 * 创建完整的可观测性实例
 */
export function createObservability(config?: ObservabilityConfig): Observability {
  return {
    logger: createLogger(config?.logger),
    tracer: createTracer(config?.tracer),
    metrics: createMetrics(config?.metrics),
  };
}

/**
 * No-op 可观测性实例
 */
export const noopObservability: Observability = {
  logger: noopLogger,
  tracer: createTracer({ enabled: false }),
  metrics: noopMetrics,
};
