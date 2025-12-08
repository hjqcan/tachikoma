/**
 * Memory Metrics 收集器
 *
 * 在内存中收集 counter/gauge/histogram 指标
 */

import type {
  MetricsCollector,
  MetricsCollectorConfig,
  MetricTags,
  MetricsSnapshot,
  MetricValue,
  CounterValue,
  GaugeValue,
  HistogramValue,
} from './types';

// ============================================================================
// 内部数据结构
// ============================================================================

interface HistogramData {
  count: number;
  sum: number;
  min: number;
  max: number;
  values: number[]; // 保留用于计算百分位数
}

/**
 * 构建 metric key（包含 tags）
 */
function buildMetricKey(name: string, tags?: MetricTags): string {
  if (!tags || Object.keys(tags).length === 0) {
    return name;
  }
  const tagStr = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${name}{${tagStr}}`;
}

/**
 * 合并 tags
 */
function mergeTags(defaultTags?: MetricTags, tags?: MetricTags): MetricTags | undefined {
  if (!defaultTags && !tags) return undefined;
  return { ...defaultTags, ...tags };
}

/**
 * 计算百分位数
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  const safeIndex = Math.max(0, Math.min(index, sortedValues.length - 1));
  return sortedValues[safeIndex] ?? 0;
}

// ============================================================================
// Memory Metrics 实现
// ============================================================================

/**
 * 默认 Metrics 配置
 */
export const DEFAULT_METRICS_CONFIG: Required<MetricsCollectorConfig> = {
  enabled: true,
  defaultTags: {},
};

/**
 * 内存 Metrics 收集器
 *
 * 在内存中累积指标数据，通过 getMetrics() 获取快照
 */
export class MemoryMetrics implements MetricsCollector {
  private readonly config: Required<MetricsCollectorConfig>;
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, HistogramData>();

  constructor(config: MetricsCollectorConfig = {}) {
    this.config = { ...DEFAULT_METRICS_CONFIG, ...config };
  }

  increment(name: string, value = 1, tags?: MetricTags): void {
    if (!this.config.enabled) return;

    const key = buildMetricKey(name, mergeTags(this.config.defaultTags, tags));
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);
  }

  timing(name: string, duration: number, tags?: MetricTags): void {
    if (!this.config.enabled) return;

    const key = buildMetricKey(name, mergeTags(this.config.defaultTags, tags));
    const data = this.histograms.get(key) ?? {
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      values: [],
    };

    data.count++;
    data.sum += duration;
    data.min = Math.min(data.min, duration);
    data.max = Math.max(data.max, duration);
    data.values.push(duration);

    // 限制保留的值数量，防止内存膨胀
    if (data.values.length > 1000) {
      data.values = data.values.slice(-1000);
    }

    this.histograms.set(key, data);
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    if (!this.config.enabled) return;

    const key = buildMetricKey(name, mergeTags(this.config.defaultTags, tags));
    this.gauges.set(key, value);
  }

  getMetrics(): MetricsSnapshot {
    const metrics: Record<string, MetricValue> = {};

    // Counters
    for (const [key, value] of this.counters) {
      const counterValue: CounterValue = { type: 'counter', value };
      metrics[key] = counterValue;
    }

    // Gauges
    for (const [key, value] of this.gauges) {
      const gaugeValue: GaugeValue = { type: 'gauge', value };
      metrics[key] = gaugeValue;
    }

    // Histograms
    for (const [key, data] of this.histograms) {
      const sortedValues = [...data.values].sort((a, b) => a - b);
      const histogramValue: HistogramValue = {
        type: 'histogram',
        count: data.count,
        sum: data.sum,
        min: data.min === Infinity ? 0 : data.min,
        max: data.max === -Infinity ? 0 : data.max,
        avg: data.count > 0 ? data.sum / data.count : 0,
        percentiles: {
          p50: percentile(sortedValues, 50),
          p90: percentile(sortedValues, 90),
          p99: percentile(sortedValues, 99),
        },
      };
      metrics[key] = histogramValue;
    }

    return {
      timestamp: Date.now(),
      metrics,
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

/**
 * No-op Metrics 收集器
 */
export class NoopMetrics implements MetricsCollector {
  increment(_name: string, _value?: number, _tags?: MetricTags): void {
    // no-op
  }

  timing(_name: string, _duration: number, _tags?: MetricTags): void {
    // no-op
  }

  gauge(_name: string, _value: number, _tags?: MetricTags): void {
    // no-op
  }

  getMetrics(): MetricsSnapshot {
    return { timestamp: Date.now(), metrics: {} };
  }

  reset(): void {
    // no-op
  }
}

/**
 * 默认 Metrics 实例
 */
export const defaultMetrics: MetricsCollector = new MemoryMetrics();

/**
 * No-op Metrics 实例
 */
export const noopMetrics: MetricsCollector = new NoopMetrics();

/**
 * 创建 Metrics 收集器
 */
export function createMetrics(config?: MetricsCollectorConfig): MetricsCollector {
  if (config?.enabled === false) {
    return noopMetrics;
  }
  return new MemoryMetrics(config);
}
