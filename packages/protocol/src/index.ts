export { CAPABILITIES, PROTOCOL_VERSION } from './version';
export type { Capability } from './version';

export {
  compactionResultSchema,
  memorySnapshotSchema,
  memoryStatusSchema,
  modelListingSchema,
  modelRefSchema,
  sessionSummarySchema,
  thinkingLevelSchema,
  toolsetSchema,
  usageSchema,
  workspaceStateSchema,
} from './dto';
export type {
  CompactionResult,
  MemorySnapshot,
  MemoryStatus,
  ModelListing,
  ModelRef,
  SessionSummary,
  ThinkingLevel,
  Toolset,
  Usage,
  WorkspaceState,
} from './dto';

export {
  chatEventWireSchema,
  FRAME_VERSION,
  parseSessionEventFrame,
  sessionEventFrameSchema,
} from './events';
export type {
  ChatEventWire,
  ParsedSessionEventFrame,
  SessionEventFrame,
  UnknownEventFrame,
} from './events';

export {
  helloRequestSchema,
  helloResponseSchema,
  isRpcMethod,
  RPC_METHODS,
  rpcErrorCodeSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  subscribeRequestSchema,
} from './rpc';
export type {
  HelloRequest,
  HelloResponse,
  RpcErrorCode,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  SubscribeRequest,
} from './rpc';
