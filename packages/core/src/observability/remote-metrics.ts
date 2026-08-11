/**
 * Remote Metrics Implementation
 *
 * Sends metrics to the AgentOps server.
 */

import type { MetricsCollectorConfig, MetricTags } from './types';
import { MemoryMetrics } from './memory-metrics';
import { AgentOpsClient, type AgentOpsConfig } from './agentops-client';

export interface RemoteMetricsConfig extends MetricsCollectorConfig {
  agentOps?: AgentOpsConfig;
}

export class RemoteMetrics extends MemoryMetrics {
  private client: AgentOpsClient;

  constructor(config?: RemoteMetricsConfig) {
    super(config);
    this.client = new AgentOpsClient('metrics', config?.agentOps);

    // Override methods to push immediately or periodically
    // For simplicity, we'll just push the snapshot periodically in real implementation
    // But here we hook into the updates.
    // Actually, MemoryMetrics accumulates state.
    // RemoteMetrics should probably just push "events" (deltas) or periodic snapshots.
    // Let's implement delta pushing for counters/gauges/timings.
  }

  override increment(name: string, value = 1, tags?: MetricTags): void {
    super.increment(name, value, tags);
    this.client.push({
      type: 'counter',
      name,
      value,
      tags,
      timestamp: Date.now()
    });
  }

  override timing(name: string, duration: number, tags?: MetricTags): void {
    super.timing(name, duration, tags);
    this.client.push({
      type: 'histogram',
      name,
      value: duration,
      tags,
      timestamp: Date.now()
    });
  }

  override gauge(name: string, value: number, tags?: MetricTags): void {
    super.gauge(name, value, tags);
    this.client.push({
      type: 'gauge',
      name,
      value,
      tags,
      timestamp: Date.now()
    });
  }
}
