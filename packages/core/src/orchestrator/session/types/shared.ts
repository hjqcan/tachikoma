/**
 * 共享文件类型：shared/context.json 与 shared/messages.jsonl 等
 */

// ============================================================================
// 共享文件类型
// ============================================================================

/**
 * selective sync 写入 sharedKnowledge 的单条记录
 */
export interface SyncLogEntry {
  subtaskId: string;
  workerId: string;
  objective: string;
  updatedAt: number;
  modifiedFiles?: string[];
  decisions?: { type: string; reason: string; approved?: boolean }[];
  output?: string;
}

/**
 * API 端点定义 (由 backend worker 产出)
 */
export interface ApiEndpoint {
  /** API 路径 (例如 /api/users) */
  path: string;
  /** HTTP 方法 (GET, POST, PUT, DELETE 等) */
  method: string;
  /** 端点描述 */
  description: string;
  /** 请求参数 (可选) */
  requestParams?: Record<string, string>;
  /** 响应格式说明 (可选) */
  responseFormat?: string;
}

/**
 * API 接口定义 (用于跨 Worker 共享)
 */
export interface ApiSpec {
  /** API 端点列表 */
  endpoints: ApiEndpoint[];
  /** API 基础 URL (例如 http://localhost:8000) */
  baseUrl?: string;
  /** 更新时间 */
  updatedAt: number;
  /** 产出者 Worker ID */
  producedBy: string;
}

/**
 * Todo 快照条目（用于 session 级执行状态共享）
 */
export interface SharedTodoItem {
  id: string;
  content: string;
  status: string;
  priority?: string;
}

/**
 * Todo 快照（用于 P1-1: resume/replan 幂等基座）
 */
export interface SharedTodoSnapshot {
  revision: number;
  pendingCount: number;
  counts: Record<string, number>;
  hash: string;
  updatedAt: number;
  updatedByWorkerId: string;
  subtaskId: string;
  sourceTool: 'todowrite' | 'todoread';
  todos: SharedTodoItem[];
}

/**
 * Compaction 摘要状态（用于 P1-3: Session Compaction）
 */
export interface SharedSummaryState {
  /** 摘要文本（用于恢复上下文） */
  summary: string;
  /** 摘要内容 hash */
  summaryHash: string;
  /** 摘要对应的 todo hash（用于冲突检测） */
  todoSnapshotHash: string;
  /** 摘要对应的 todo revision */
  todoRevision: number;
  /** 本次压缩掉的约束条目数 */
  compactedConstraintCount: number;
  /** 本次保留的最近约束条目数 */
  retainedConstraintCount: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 执行态契约（用于 P1-4: Todo x Compaction 冲突裁决）
 */
export interface SharedExecutionStateContract {
  /** 权威 todo 状态 */
  todoState?: SharedTodoSnapshot;
  /** compaction 摘要状态 */
  summaryState?: SharedSummaryState;
  /** 冲突裁决策略（当前固定为 todo_wins） */
  conflictPolicy: 'todo_wins';
  /** 契约更新时间 */
  updatedAt: number;
}

/**
 * Todo replay 事件（用于 resume/replan 幂等去重）
 */
export interface SharedTodoReplayEvent {
  eventId: string;
  subtaskId: string;
  objectiveHash: string;
  todoHash: string;
  todoRevision: number;
  recordedAt: number;
}

/**
 * Todo replay 去重索引
 */
export interface SharedTodoReplayGuard {
  events: SharedTodoReplayEvent[];
  updatedAt: number;
}

/**
 * 共享知识数据（允许扩展字段）
 */
export interface SharedKnowledgeData {
  syncLog?: SyncLogEntry[];
  /** API 接口定义 (由 backend worker 产出) */
  apiSpec?: ApiSpec;
  /** 生成的文件清单 (按 worker ID 分组) */
  generatedFiles?: Record<string, string[]>;
  /** todo 状态快照 (session 级) */
  todoState?: SharedTodoSnapshot;
  /** 执行态契约（todo + summary，冲突策略） */
  executionStateContract?: SharedExecutionStateContract;
  /** todo replay 去重状态 */
  todoReplayGuard?: SharedTodoReplayGuard;
  [key: string]: unknown;
}

/**
 * 共享上下文文件内容 (context.json)
 */
export interface SharedContextFile {
  /** 会话 ID */
  sessionId: string;
  /** 任务目标 */
  objective: string;
  /** 全局约束 */
  constraints: string[];
  /** 共享知识 */
  sharedKnowledge: {
    /** 键值对存储 */
    data: SharedKnowledgeData;
    /** 最后更新时间 */
    updatedAt: number;
  };
  /** 工作区信息 */
  workspace?: {
    /** 根目录 */
    rootPath: string;
    /** 关键文件列表 */
    keyFiles: string[];
  };
}

/**
 * 消息方向
 */
export type MessageDirection = 'orchestrator_to_worker' | 'worker_to_orchestrator' | 'worker_to_worker';

/**
 * 消息记录 (messages.jsonl 中的单条记录)
 */
export interface MessageRecord {
  /** 消息 ID */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 发送者 ID */
  senderId: string;
  /** 接收者 ID */
  receiverId: string;
  /** 消息方向 */
  direction: MessageDirection;
  /** 消息类型 */
  type: 'task_assignment' | 'progress_update' | 'result' | 'query' | 'response';
  /** 消息内容 */
  content: unknown;
  /** 相关子任务 ID */
  subtaskId?: string;
}
