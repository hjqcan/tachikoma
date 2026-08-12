/** 协议版本：只增不改；破坏性变更必须 +1（预期整个 0.x 不发生）。 */
export const PROTOCOL_VERSION = 1;

/**
 * 能力集：字符串集合，只增不改，一经发布永不复用于不同语义。
 * 客户端按能力渲染（无 'tools' 则不渲染工具面板）。
 */
export const CAPABILITIES = [
  'chat',
  'reasoning',
  'tools',
  'approvals',
  'memory',
  'compaction',
  'session-replay',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
