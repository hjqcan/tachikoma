export { CAPABILITIES, PROTOCOL_VERSION } from './version.ts';
export type { Capability } from './version.ts';

export {
  compactionResultSchema,
  memoryRecordSchema,
  memorySnapshotSchema,
  memoryStatusSchema,
  modelListingSchema,
  modelRefSchema,
  sessionSummarySchema,
  skillInfoSchema,
  thinkingLevelSchema,
  toolsetSchema,
  usageSchema,
  workspaceStateSchema,
} from './dto.ts';
export type {
  CompactionResult,
  MemoryRecord,
  MemorySnapshot,
  MemoryStatus,
  ModelListing,
  ModelRef,
  SessionSummary,
  SkillInfo,
  ThinkingLevel,
  Toolset,
  Usage,
  WorkspaceState,
} from './dto.ts';

export {
  chatEventWireSchema,
  FRAME_VERSION,
  parseSessionEventFrame,
  sessionEventFrameSchema,
} from './events.ts';
export type {
  ChatEventWire,
  ParsedSessionEventFrame,
  SessionEventFrame,
  UnknownEventFrame,
} from './events.ts';

export {
  helloRequestSchema,
  helloResponseSchema,
  isRpcMethod,
  RPC_METHODS,
  rpcErrorCodeSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  subscribeRequestSchema,
} from './rpc.ts';
export type {
  HelloRequest,
  HelloResponse,
  RpcErrorCode,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  SubscribeRequest,
} from './rpc.ts';
