/**
 * Multi-Agent 协作协议模块
 *
 * 提供 P2P 通信、Request-Response、Pub-Sub、Blackboard 模式
 *
 * @module collaboration
 */

// 类型导出
export type {
  AgentType,
  AgentStatus,
  AgentRegistration,
  AgentChangeEvent,
  AgentChangeHandler,
  AgentFilter,
  CollaborationRequestType,
  CollaborationRequest,
  CollaborationResponse,
  RequestHandler,
  CollaborationEvent,
  EventHandler,
  BlackboardEntry,
  CollaborationBackendType,
  CollaborationConfig,
  IAgentRegistry,
  IMessageBroker,
  IPubSubHub,
  IBlackboard,
  ICollaborationManager,
} from './types';

export {
  BUILTIN_TOPICS,
  DEFAULT_COLLABORATION_CONFIG,
} from './types';

// 文件后端实现
export { FileAgentRegistry, createFileAgentRegistry } from './file-agent-registry';
export { FileMessageBroker, createFileMessageBroker } from './file-message-broker';
export { FilePubSubHub, createFilePubSubHub } from './file-pubsub-hub';
export { FileBlackboard, createFileBlackboard } from './file-blackboard';

// Redis 后端实现
// ⚠️ EXPERIMENTAL: Redis 后端需要外部注入 client，不通过 CollaborationManager 自动接线
// 使用方式：直接使用 createRedis*() 工厂函数并手动注入 Redis client
export type { RedisConfig, IRedisClient } from './redis-agent-registry';
export { RedisAgentRegistry, createRedisAgentRegistry } from './redis-agent-registry';
export type { IRedisStreamClient } from './redis-message-broker';
export { RedisMessageBroker, createRedisMessageBroker } from './redis-message-broker';
export { RedisPubSubHub, createRedisPubSubHub } from './redis-pubsub-hub';
export type { IRedisWatchClient, IRedisTransaction } from './redis-blackboard';
export { RedisBlackboard, createRedisBlackboard } from './redis-blackboard';

// 管理器
export { CollaborationManager, createCollaborationManager } from './collaboration-manager';

// 工具
export type { PeerAssistInput, PeerAssistOutput } from './peer-assist-tool';
export {
  peerAssistToolDefinition,
  createPeerAssistExecutor,
  createPeerAssistTool,
} from './peer-assist-tool';

// Protocol payloads (centralized schemas)
export type {
  PeerAssistRequestPayload,
  PeerAssistRoutedResultPayload,
} from './protocol';
