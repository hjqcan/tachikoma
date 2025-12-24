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
 * 共享知识数据（允许扩展字段）
 */
export interface SharedKnowledgeData {
  syncLog?: SyncLogEntry[];
  /** API 接口定义 (由 backend worker 产出) */
  apiSpec?: ApiSpec;
  /** 生成的文件清单 (按 worker ID 分组) */
  generatedFiles?: Record<string, string[]>;
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


