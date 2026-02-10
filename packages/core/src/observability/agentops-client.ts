/**
 * AgentOps Client
 *
 * Handles HTTP communication with the AgentOps server.
 */

export interface AgentOpsConfig {
  endpoint: string;
  batchSize?: number;
  flushInterval?: number;
  enabled?: boolean;
}

export const DEFAULT_AGENTOPS_CONFIG: Required<AgentOpsConfig> = {
  endpoint: 'http://localhost:3002',
  batchSize: 10,
  flushInterval: 5000,
  enabled: true,
};

export class AgentOpsClient {
  private readonly config: Required<AgentOpsConfig>;
  private queue: any[] = [];
  private timer: Timer | null = null;
  private readonly type: 'traces' | 'metrics';

  constructor(type: 'traces' | 'metrics', config?: AgentOpsConfig) {
    this.type = type;
    this.config = { ...DEFAULT_AGENTOPS_CONFIG, ...config };
  }

  push(item: any): void {
    if (!this.config.enabled) return;

    this.queue.push(item);

    if (this.queue.length >= this.config.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.config.flushInterval);
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = [...this.queue];
    this.queue = [];

    try {
      // Use global fetch (available in Bun/Node 18+)
      await fetch(`${this.config.endpoint}/api/ingest/${this.type}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
      });
    } catch (error) {
      console.error(`[AgentOps] Failed to flush ${this.type}:`, error);
      // Optionally re-queue failed items, but avoiding infinite loops
    }
  }
}
