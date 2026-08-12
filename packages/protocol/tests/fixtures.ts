import type { ChatEventWire, SessionEventFrame } from '../src/events';
import type { CompactionResult, MemorySnapshot, SessionSummary, Usage } from '../src/dto';

const base = { sessionId: 'session-1', turnId: 'turn-1', timestamp: 1_700_000_000_000 };

export const usageFixture: Usage = {
  input: 12,
  output: 34,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 5,
  totalTokens: 46,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const eventFixtures: ChatEventWire[] = [
  { ...base, type: 'message_start', messageId: 'message-1' },
  { ...base, type: 'message_delta', messageId: 'message-1', text: '你好' },
  { ...base, type: 'reasoning_delta', messageId: 'message-1', text: '思考中' },
  { ...base, type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 200, error: 'rate limited' },
  { ...base, type: 'compaction', phase: 'start', reason: 'threshold' },
  {
    ...base,
    type: 'compaction',
    phase: 'complete',
    reason: 'manual',
    aborted: false,
    willRetry: false,
  },
  { ...base, type: 'memory_status', phase: 'session_start', status: 'ready' },
  {
    ...base,
    type: 'memory_status',
    phase: 'recall',
    status: 'recalled',
    hasContext: true,
    estimatedTokens: 128,
  },
  {
    ...base,
    type: 'memory_status',
    phase: 'writeback',
    status: 'write-failed',
    error: 'database unavailable',
  },
  { ...base, type: 'tool_call', callId: 'call-1', tool: 'read', input: { path: 'hello.txt' } },
  { ...base, type: 'tool_update', callId: 'call-1', tool: 'read', output: 'partial' },
  {
    ...base,
    type: 'tool_result',
    callId: 'call-1',
    tool: 'read',
    output: 'content',
    isError: false,
  },
  {
    ...base,
    type: 'tool_approval_request',
    callId: 'call-2',
    tool: 'bash',
    input: { command: 'ls -la' },
    timeoutMs: 120_000,
  },
  { ...base, type: 'tool_approval_resolved', callId: 'call-2', approved: false, reason: 'timeout' },
  {
    ...base,
    type: 'message_complete',
    messageId: 'message-1',
    status: 'success',
    content: '完成',
    model: { provider: 'gurkiai', model: 'gpt-5.6-terra' },
    stopReason: 'stop',
    usage: usageFixture,
  },
  {
    ...base,
    type: 'message_complete',
    messageId: 'message-2',
    status: 'failed',
    content: '',
    model: { provider: 'gurkiai', model: 'gpt-5.6-terra' },
    stopReason: 'error',
    usage: usageFixture,
    error: 'engine restarted',
  },
];

export const frameFixture: SessionEventFrame = {
  v: 1,
  sessionId: 'session-1',
  seq: 7,
  event: eventFixtures[0] as ChatEventWire,
};

export const sessionSummaryFixtures: SessionSummary[] = [
  {
    sessionId: 'session-1',
    title: '第一个会话',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 4,
    model: { provider: 'gurkiai', model: 'gpt-5.6-terra' },
    thinkingLevel: 'low',
    status: 'ready',
  },
  {
    sessionId: 'session-2',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    model: null,
    thinkingLevel: null,
    status: 'corrupt',
    error: 'pi SessionManager could not read this JSONL session.',
  },
];

export const compactionResultFixture: CompactionResult = {
  summary: '压缩摘要',
  firstKeptEntryId: 'entry-9',
  tokensBefore: 120_000,
  estimatedTokensAfter: 8_000,
  usage: usageFixture,
};

export const memorySnapshotFixture: MemorySnapshot = {
  enabled: true,
  status: 'ready',
  databasePath: '/home/user/.tachikoma/memory/goodmemory.sqlite',
};
