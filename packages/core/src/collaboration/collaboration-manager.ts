/**
 * Collaboration Manager - 协作管理器
 *
 * 统一入口，整合 Registry、Broker、PubSub、Blackboard
 *
 * @module collaboration/collaboration-manager
 */

import type {
  AgentRegistration,
  AgentStatus,
  AgentFilter,
  CollaborationConfig,
  CollaborationResponse,
  IAgentRegistry,
  IMessageBroker,
  IPubSubHub,
  IBlackboard,
  ICollaborationManager,
  RequestHandler,
} from './types';
import { DEFAULT_COLLABORATION_CONFIG, BUILTIN_TOPICS } from './types';
import { FileAgentRegistry } from './file-agent-registry';
import { FileMessageBroker } from './file-message-broker';
import { FilePubSubHub } from './file-pubsub-hub';
import { FileBlackboard } from './file-blackboard';

/**
 * Collaboration Manager 实现
 */
export class CollaborationManager implements ICollaborationManager {
  readonly registry: IAgentRegistry;
  readonly broker: IMessageBroker;
  readonly pubsub: IPubSubHub;
  readonly blackboard: IBlackboard;

  private readonly config: CollaborationConfig;
  private agentId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(config: Partial<CollaborationConfig> = {}) {
    this.config = { ...DEFAULT_COLLABORATION_CONFIG, ...config };

    // 根据后端类型创建实例
    // Redis 后端需要外部提供 client，当前仅 file 后端完整实现
    if (this.config.backend === 'redis') {
      // Redis 实现已存在但需要外部注入 client
      // 用户应该使用 createRedis*() 工厂函数直接创建
      console.warn(
        '[CollaborationManager] Redis backend requires external client injection. ' +
        'Use createRedisAgentRegistry/createRedisMessageBroker etc. directly, or falling back to file backend.'
      );
    }

    // 使用文件后端
    const rootDir = this.config.rootDir;
    this.registry = new FileAgentRegistry(rootDir, {
      offlineThreshold: this.config.offlineThreshold,
    });
    // broker 和 pubsub 需要 agentId，延迟初始化
    this.broker = null as unknown as IMessageBroker;
    this.pubsub = null as unknown as IPubSubHub;
    this.blackboard = new FileBlackboard(rootDir, 'pending');
  }

  /**
   * 清理 agentId，防止路径逃逸攻击
   */
  private sanitizeAgentId(agentId: string): string {
    return agentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }

  /**
   * 启动协作管理器
   * 
   * 使用原子性保证：失败时回滚已初始化的组件
   */
  async start(
    agentId: string,
    registration: Omit<AgentRegistration, 'agentId' | 'lastHeartbeat'>
  ): Promise<void> {
    if (this.started) {
      throw new Error('CollaborationManager already started');
    }

    const sanitizedId = this.sanitizeAgentId(agentId);
    
    // 初始化需要 agentId 的组件
    const rootDir = this.config.rootDir;
    const broker = new FileMessageBroker(
      rootDir,
      sanitizedId,
      { defaultTimeout: this.config.requestTimeout }
    );
    const pubsub = new FilePubSubHub(rootDir, sanitizedId);
    const blackboard = new FileBlackboard(rootDir, sanitizedId);

    try {
      // 注册 Agent
      await this.registry.register({
        agentId: sanitizedId,
        ...registration,
      });

      // 设置状态
      this.agentId = sanitizedId;
      (this as { broker: IMessageBroker }).broker = broker;
      (this as { pubsub: IPubSubHub }).pubsub = pubsub;
      (this as { blackboard: IBlackboard }).blackboard = blackboard;
      this.started = true;

      // 发布上线事件（非关键，失败不回滚）
      try {
        await pubsub.publish(BUILTIN_TOPICS.AGENT_JOINED, {
          agentId: sanitizedId,
          type: registration.type,
          capabilities: registration.capabilities,
        });
      } catch (error) {
        console.warn('[CollaborationManager] Failed to publish join event:', error);
      }

      // 启动心跳
      this.startHeartbeat();
    } catch (error) {
      // 回滚：关闭已创建的组件
      await Promise.allSettled([
        broker.close(),
        pubsub.close(),
        blackboard.close(),
      ]);
      throw error;
    }
  }

  /**
   * 停止协作管理器
   */
  async stop(): Promise<void> {
    if (!this.started || !this.agentId) return;

    this.stopHeartbeat();

    // 发布下线事件（best-effort，不阻塞）
    try {
      await this.pubsub.publish(BUILTIN_TOPICS.AGENT_LEFT, {
        agentId: this.agentId,
      });
    } catch {
      // 忽略
    }

    // 注销 Agent
    try {
      await this.registry.unregister(this.agentId);
    } catch {
      // 忽略
    }

    // 关闭所有组件
    await Promise.allSettled([
      this.registry.close(),
      this.broker.close(),
      this.pubsub.close(),
      this.blackboard.close(),
    ]);

    this.started = false;
    this.agentId = null;
  }

  /**
   * 发现 Peers
   * 
   * @param capabilities - 可选的能力过滤
   * @param includeBusy - 是否包含 busy 状态的 Agent（默认 false）
   */
  async discoverPeers(
    capabilities?: string[],
    includeBusy = false
  ): Promise<AgentRegistration[]> {
    // 构建过滤器
    const filter: AgentFilter = {};
    
    if (capabilities && capabilities.length > 0) {
      filter.capabilities = capabilities;
    }

    // 获取所有匹配的 agents
    const agents = await this.registry.listAgents(filter);

    // 过滤状态
    if (includeBusy) {
      return agents.filter(a => a.status === 'online' || a.status === 'busy');
    } else {
      return agents.filter(a => a.status === 'online');
    }
  }

  /**
   * 请求 Peer 协助
   */
  async requestAssist(
    targetAgentId: string,
    task: unknown,
    priority = 0
  ): Promise<CollaborationResponse> {
    if (!this.agentId) {
      throw new Error('CollaborationManager not started');
    }

    return this.broker.request({
      fromAgentId: this.agentId,
      toAgentId: targetAgentId,
      type: 'assist',
      payload: task,
      timeout: this.config.requestTimeout,
      priority,
    });
  }

  /**
   * 更新自身状态
   */
  async updateStatus(status: AgentStatus): Promise<void> {
    if (!this.agentId) return;

    await this.registry.updateStatus(this.agentId, status);

    // 发布状态变更事件
    await this.pubsub.publish(BUILTIN_TOPICS.AGENT_STATUS_CHANGED, {
      agentId: this.agentId,
      status,
    });
  }

  /**
   * 注册请求处理器
   * 
   * 这是端到端协作的关键：没有 handler，收到的请求无人响应
   */
  onRequest(handler: RequestHandler): void {
    this.broker.onRequest(handler);
  }

  /**
   * 获取当前 Agent ID
   */
  getAgentId(): string | null {
    return this.agentId;
  }

  /**
   * 是否已启动
   */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.agentId) {
        this.registry.heartbeat(this.agentId).catch(error => {
          console.error('[CollaborationManager] Heartbeat error:', error);
        });
      }
    }, this.config.heartbeatInterval);
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
}

/**
 * 创建 Collaboration Manager
 */
export function createCollaborationManager(
  config?: Partial<CollaborationConfig>
): CollaborationManager {
  return new CollaborationManager(config);
}
