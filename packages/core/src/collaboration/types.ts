/**
 * Multi-Agent 协作协议类型定义
 *
 * 支持 P2P 通信、Request-Response、Pub-Sub、Blackboard 模式
 *
 * @module collaboration/types
 */

// ============================================================================
// Agent 注册与发现
// ============================================================================

/**
 * Agent 类型
 */
export type AgentType = 'orchestrator' | 'worker';

/**
 * Agent 在线状态
 */
export type AgentStatus = 'online' | 'busy' | 'offline';

/**
 * Agent 注册信息
 */
export interface AgentRegistration {
  /** Agent ID */
  agentId: string;
  /** 所属 Session ID */
  sessionId: string;
  /** Agent 类型 */
  type: AgentType;
  /** 能力标签 */
  capabilities: string[];
  /** 当前状态 */
  status: AgentStatus;
  /** 最后心跳时间戳 */
  lastHeartbeat: number;
  /** 优先级（数值越大越高，默认 0） */
  priority: number;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Agent 变更事件
 */
export type AgentChangeEvent = 'joined' | 'left' | 'status_changed';

/**
 * Agent 变更处理器
 */
export type AgentChangeHandler = (
  agent: AgentRegistration,
  event: AgentChangeEvent
) => void | Promise<void>;

/**
 * Agent 过滤条件
 */
export interface AgentFilter {
  /** 按 Session ID 过滤 */
  sessionId?: string;
  /** 按类型过滤 */
  type?: AgentType;
  /** 按能力过滤（必须包含所有指定能力） */
  capabilities?: string[];
  /** 按状态过滤 */
  status?: AgentStatus;
}

// ============================================================================
// Request-Response 消息传递
// ============================================================================

/**
 * 协作请求类型
 */
export type CollaborationRequestType = 'task' | 'query' | 'assist' | 'broadcast';

/**
 * 协作请求
 */
export interface CollaborationRequest {
  /** 请求 ID */
  id: string;
  /** 发送方 Agent ID */
  fromAgentId: string;
  /** 接收方 Agent ID（'*' 表示广播） */
  toAgentId: string;
  /** 请求类型 */
  type: CollaborationRequestType;
  /** 请求负载 */
  payload: unknown;
  /** 超时时间（毫秒） */
  timeout: number;
  /** 优先级（数值越大越高，默认 0，可插队但不打断） */
  priority: number;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 协作响应
 */
export interface CollaborationResponse {
  /** 对应的请求 ID */
  requestId: string;
  /** 发送方 Agent ID */
  fromAgentId: string;
  /** 是否成功 */
  success: boolean;
  /** 响应负载 */
  payload?: unknown;
  /** 错误信息 */
  error?: string;
  /** 响应时间戳 */
  respondedAt: number;
}

/**
 * 请求处理器
 */
export type RequestHandler = (
  request: CollaborationRequest
) => Promise<Omit<CollaborationResponse, 'requestId' | 'fromAgentId' | 'respondedAt'>>;

// ============================================================================
// Publish-Subscribe 事件系统
// ============================================================================

/**
 * 协作事件
 */
export interface CollaborationEvent {
  /** 事件 ID */
  id: string;
  /** 事件主题 */
  topic: string;
  /** 发布者 Agent ID */
  publisherId: string;
  /** 事件负载 */
  payload: unknown;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 事件处理器
 */
export type EventHandler = (event: CollaborationEvent) => void | Promise<void>;

/**
 * 内置事件主题
 */
export const BUILTIN_TOPICS = {
  /** 任务分配 */
  TASK_ASSIGNED: 'task:assigned',
  /** 任务完成 */
  TASK_COMPLETED: 'task:completed',
  /** 产出物创建 */
  ARTIFACT_CREATED: 'artifact:created',
  /** Agent 上线 */
  AGENT_JOINED: 'agent:joined',
  /** Agent 下线 */
  AGENT_LEFT: 'agent:left',
  /** Agent 状态变更 */
  AGENT_STATUS_CHANGED: 'agent:status_changed',
} as const;

// ============================================================================
// Blackboard 共享状态
// ============================================================================

/**
 * 黑板条目
 */
export interface BlackboardEntry<T = unknown> {
  /** 键名 */
  key: string;
  /** 值 */
  value: T;
  /** 写入者 Agent ID */
  writtenBy: string;
  /** 版本号（用于 CAS） */
  version: number;
  /** 更新时间戳 */
  updatedAt: number;
  /** 过期时间（秒，可选） */
  ttl?: number;
}

// ============================================================================
// 接口定义
// ============================================================================

/**
 * Agent Registry 接口
 */
export interface IAgentRegistry {
  /**
   * 注册 Agent
   */
  register(agent: Omit<AgentRegistration, 'lastHeartbeat'>): Promise<void>;

  /**
   * 注销 Agent
   */
  unregister(agentId: string): Promise<void>;

  /**
   * 获取 Agent 信息
   */
  getAgent(agentId: string): Promise<AgentRegistration | null>;

  /**
   * 列出 Agents
   */
  listAgents(filter?: AgentFilter): Promise<AgentRegistration[]>;

  /**
   * 更新心跳
   */
  heartbeat(agentId: string): Promise<void>;

  /**
   * 更新状态
   */
  updateStatus(agentId: string, status: AgentStatus): Promise<void>;

  /**
   * 监听 Agent 变更
   */
  onAgentChange(handler: AgentChangeHandler): void;

  /**
   * 移除变更监听
   */
  offAgentChange(handler: AgentChangeHandler): void;

  /**
   * 关闭 Registry
   */
  close(): Promise<void>;
}

/**
 * Message Broker 接口
 */
export interface IMessageBroker {
  /**
   * 发送请求并等待响应
   */
  request(
    req: Omit<CollaborationRequest, 'id' | 'createdAt'>
  ): Promise<CollaborationResponse>;

  /**
   * 发送请求不等待响应（fire-and-forget）
   */
  send(
    req: Omit<CollaborationRequest, 'id' | 'createdAt'>
  ): Promise<void>;

  /**
   * 监听请求
   */
  onRequest(handler: RequestHandler): void;

  /**
   * 移除请求监听
   */
  offRequest(handler: RequestHandler): void;

  /**
   * 获取待处理请求（按优先级排序）
   */
  getPendingRequests(): Promise<CollaborationRequest[]>;

  /**
   * 关闭 Broker
   */
  close(): Promise<void>;
}

/**
 * Pub-Sub Hub 接口
 */
export interface IPubSubHub {
  /**
   * 发布事件
   */
  publish(topic: string, payload: unknown): Promise<void>;

  /**
   * 订阅主题
   */
  subscribe(topic: string, handler: EventHandler): void;

  /**
   * 取消订阅
   */
  unsubscribe(topic: string, handler: EventHandler): void;

  /**
   * 通配符订阅（如 'task:*'）
   */
  subscribePattern(pattern: string, handler: EventHandler): void;

  /**
   * 取消通配符订阅
   */
  unsubscribePattern(pattern: string, handler: EventHandler): void;

  /**
   * 关闭 Hub
   */
  close(): Promise<void>;
}

/**
 * Blackboard 接口
 */
export interface IBlackboard {
  /**
   * 获取值
   */
  get<T = unknown>(key: string): Promise<T | null>;

  /**
   * 设置值
   */
  set(key: string, value: unknown, ttl?: number): Promise<void>;

  /**
   * 删除键
   */
  delete(key: string): Promise<boolean>;

  /**
   * 原子比较并设置（CAS）
   */
  compareAndSet(key: string, expectedVersion: number, newValue: unknown): Promise<boolean>;

  /**
   * 批量获取
   */
  mget(keys: string[]): Promise<(unknown | null)[]>;

  /**
   * 监听键变更
   */
  watch(key: string, handler: (entry: BlackboardEntry) => void): void;

  /**
   * 取消监听
   */
  unwatch(key: string, handler: (entry: BlackboardEntry) => void): void;

  /**
   * 列出所有键
   */
  keys(pattern?: string): Promise<string[]>;

  /**
   * 关闭 Blackboard
   */
  close(): Promise<void>;
}

// ============================================================================
// Collaboration Manager
// ============================================================================

/**
 * 后端类型
 */
export type CollaborationBackendType = 'file' | 'redis' | 'auto';

/**
 * 协作配置
 */
export interface CollaborationConfig {
  /** 后端类型（auto = 优先 redis，降级 file） */
  backend: CollaborationBackendType;
  /** 文件后端根目录 */
  rootDir: string;
  /** Redis 配置（可选） */
  redis?: {
    url: string;
    prefix?: string;
  };
  /** 心跳间隔（毫秒，默认 5000） */
  heartbeatInterval: number;
  /** 请求超时（毫秒，默认 30000） */
  requestTimeout: number;
  /** Agent 离线判定时间（毫秒，默认 15000） */
  offlineThreshold: number;
}

/**
 * 默认配置
 */
export const DEFAULT_COLLABORATION_CONFIG: CollaborationConfig = {
  backend: 'file',
  rootDir: '.tachikoma',
  heartbeatInterval: 5000,
  requestTimeout: 30000,
  offlineThreshold: 15000,
};

/**
 * Collaboration Manager 接口
 */
export interface ICollaborationManager {
  /** Agent Registry */
  readonly registry: IAgentRegistry;
  /** Message Broker */
  readonly broker: IMessageBroker;
  /** Pub-Sub Hub */
  readonly pubsub: IPubSubHub;
  /** Blackboard */
  readonly blackboard: IBlackboard;

  /**
   * 启动协作管理器
   */
  start(
    agentId: string,
    registration: Omit<AgentRegistration, 'agentId' | 'lastHeartbeat'>
  ): Promise<void>;

  /**
   * 停止协作管理器
   */
  stop(): Promise<void>;

  /**
   * 发现具有指定能力的 Peers
   *
   * @param capabilities - 可选的能力过滤
   * @param includeBusy - 是否包含 busy 状态的 Agent（默认 false）
   */
  discoverPeers(capabilities?: string[], includeBusy?: boolean): Promise<AgentRegistration[]>;

  /**
   * 请求 Peer 协助
   */
  requestAssist(
    targetAgentId: string,
    task: unknown,
    priority?: number
  ): Promise<CollaborationResponse>;
}
