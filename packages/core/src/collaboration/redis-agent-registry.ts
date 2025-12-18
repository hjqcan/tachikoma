/**
 * Redis Agent Registry 实现
 *
 * 基于 Redis 的 Agent 发现与注册服务
 * 支持跨 Session 协作
 *
 * @module collaboration/redis-agent-registry
 */

import type {
  AgentRegistration,
  AgentFilter,
  AgentStatus,
  AgentChangeHandler,
  IAgentRegistry,
} from './types';

/**
 * Redis 连接配置
 */
export interface RedisConfig {
  /** Redis URL (e.g., redis://localhost:6379) */
  url: string;
  /** 键名前缀 */
  prefix?: string;
}

/**
 * Redis 客户端接口（兼容 ioredis/redis 等库）
 */
export interface IRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, field: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  quit(): Promise<void>;
}

/**
 * Redis Agent Registry
 */
export class RedisAgentRegistry implements IAgentRegistry {
  private readonly prefix: string;
  private readonly registryKey: string;
  private readonly changeChannel: string;
  private readonly changeHandlers = new Set<AgentChangeHandler>();
  private client: IRedisClient | null = null;
  private subscribeClient: IRedisClient | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly offlineThreshold: number;

  constructor(
    private readonly config: RedisConfig,
    private readonly createClient: (url: string) => Promise<IRedisClient>,
    options: { offlineThreshold?: number } = {}
  ) {
    this.prefix = config.prefix ?? 'tachikoma:collab';
    this.registryKey = `${this.prefix}:agents`;
    this.changeChannel = `${this.prefix}:agent_changes`;
    this.offlineThreshold = options.offlineThreshold ?? 15000;
  }

  /**
   * 初始化连接
   */
  private async ensureConnected(): Promise<IRedisClient> {
    if (!this.client) {
      this.client = await this.createClient(this.config.url);
    }
    return this.client;
  }

  /**
   * 获取 Agent 键名
   */
  private getAgentKey(agentId: string): string {
    return `${this.prefix}:agent:${agentId}`;
  }

  /**
   * 注册 Agent
   */
  async register(agent: Omit<AgentRegistration, 'lastHeartbeat'>): Promise<void> {
    const client = await this.ensureConnected();

    const registration: AgentRegistration = {
      ...agent,
      lastHeartbeat: Date.now(),
    };

    // 存储到 Hash
    await client.set(
      this.getAgentKey(agent.agentId),
      JSON.stringify(registration),
      { EX: Math.ceil(this.offlineThreshold / 1000) * 2 }
    );

    // 添加到注册表
    await client.hset(this.registryKey, agent.agentId, '1');

    // 发布变更通知
    await client.publish(this.changeChannel, JSON.stringify({
      event: 'joined',
      agent: registration,
    }));

    // 启动订阅
    await this.startSubscription();
  }

  /**
   * 注销 Agent
   */
  async unregister(agentId: string): Promise<void> {
    const client = await this.ensureConnected();

    const agent = await this.getAgent(agentId);

    await client.del(this.getAgentKey(agentId));
    await client.hdel(this.registryKey, agentId);

    if (agent) {
      await client.publish(this.changeChannel, JSON.stringify({
        event: 'left',
        agent,
      }));
    }
  }

  /**
   * 获取 Agent 信息
   */
  async getAgent(agentId: string): Promise<AgentRegistration | null> {
    const client = await this.ensureConnected();
    const data = await client.get(this.getAgentKey(agentId));
    if (!data) return null;

    try {
      const agent = JSON.parse(data) as AgentRegistration;
      // 检查是否离线
      if (Date.now() - agent.lastHeartbeat > this.offlineThreshold) {
        agent.status = 'offline';
      }
      return agent;
    } catch {
      return null;
    }
  }

  /**
   * 列出 Agents
   */
  async listAgents(filter?: AgentFilter): Promise<AgentRegistration[]> {
    const client = await this.ensureConnected();

    const agentIds = await client.hgetall(this.registryKey);
    const agents: AgentRegistration[] = [];

    for (const agentId of Object.keys(agentIds)) {
      const agent = await this.getAgent(agentId);
      if (!agent) continue;

      // 应用过滤
      if (filter) {
        if (filter.sessionId && agent.sessionId !== filter.sessionId) continue;
        if (filter.type && agent.type !== filter.type) continue;
        if (filter.status && agent.status !== filter.status) continue;
        if (filter.capabilities) {
          const hasAll = filter.capabilities.every(cap =>
            agent.capabilities.includes(cap)
          );
          if (!hasAll) continue;
        }
      }

      agents.push(agent);
    }

    return agents;
  }

  /**
   * 更新心跳
   */
  async heartbeat(agentId: string): Promise<void> {
    const client = await this.ensureConnected();
    const agent = await this.getAgent(agentId);
    if (!agent) return;

    agent.lastHeartbeat = Date.now();
    if (agent.status === 'offline') {
      agent.status = 'online';
    }

    await client.set(
      this.getAgentKey(agentId),
      JSON.stringify(agent),
      { EX: Math.ceil(this.offlineThreshold / 1000) * 2 }
    );
  }

  /**
   * 更新状态
   */
  async updateStatus(agentId: string, status: AgentStatus): Promise<void> {
    const client = await this.ensureConnected();
    const agent = await this.getAgent(agentId);
    if (!agent) return;

    const oldStatus = agent.status;
    agent.status = status;
    agent.lastHeartbeat = Date.now();

    await client.set(
      this.getAgentKey(agentId),
      JSON.stringify(agent),
      { EX: Math.ceil(this.offlineThreshold / 1000) * 2 }
    );

    if (oldStatus !== status) {
      await client.publish(this.changeChannel, JSON.stringify({
        event: 'status_changed',
        agent,
      }));
    }
  }

  /**
   * 监听 Agent 变更
   */
  onAgentChange(handler: AgentChangeHandler): void {
    this.changeHandlers.add(handler);
  }

  /**
   * 移除变更监听
   */
  offAgentChange(handler: AgentChangeHandler): void {
    this.changeHandlers.delete(handler);
  }

  /**
   * 关闭 Registry
   */
  async close(): Promise<void> {
    this.stopHeartbeat();

    if (this.subscribeClient) {
      try {
        await this.subscribeClient.unsubscribe(this.changeChannel);
        await this.subscribeClient.quit();
      } catch {
        // Ignore
      }
      this.subscribeClient = null;
    }

    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // Ignore
      }
      this.client = null;
    }

    this.changeHandlers.clear();
  }

  /**
   * 启动 Pub/Sub 订阅
   */
  private async startSubscription(): Promise<void> {
    if (this.subscribeClient) return;

    this.subscribeClient = await this.createClient(this.config.url);
    await this.subscribeClient.subscribe(this.changeChannel, (message) => {
      try {
        const data = JSON.parse(message) as {
          event: 'joined' | 'left' | 'status_changed';
          agent: AgentRegistration;
        };
        this.notifyHandlers(data.agent, data.event);
      } catch {
        // Ignore parse errors
      }
    });
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 通知处理器
   */
  private notifyHandlers(
    agent: AgentRegistration,
    event: 'joined' | 'left' | 'status_changed'
  ): void {
    for (const handler of this.changeHandlers) {
      try {
        void handler(agent, event);
      } catch (error) {
        console.error('[RedisAgentRegistry] Handler error:', error);
      }
    }
  }
}

/**
 * 创建 Redis Agent Registry
 */
export function createRedisAgentRegistry(
  config: RedisConfig,
  createClient: (url: string) => Promise<IRedisClient>,
  options?: { offlineThreshold?: number }
): RedisAgentRegistry {
  return new RedisAgentRegistry(config, createClient, options);
}
