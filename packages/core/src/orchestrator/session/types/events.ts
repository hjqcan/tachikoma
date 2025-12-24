/**
 * Session 文件事件类型
 */

/**
 * 文件监控事件类型
 */
export type SessionFileEventType =
  | 'pending_approval_created' // 新的审批请求
  | 'pending_approval_removed' // 审批请求已处理
  | 'worker_status_changed' // Worker 状态变化
  | 'thinking_updated' // 思考日志更新
  | 'action_completed' // 行动完成
  | 'intervention_created' // 干预指令创建
  | 'intervention_acknowledged' // 干预已确认
  | 'progress_updated'; // 进度更新

/**
 * 文件监控事件
 */
export interface SessionFileEvent<T = unknown> {
  /** 事件类型 */
  type: SessionFileEventType;
  /** 会话 ID */
  sessionId: string;
  /** Worker ID（如果适用） */
  workerId?: string;
  /** 文件路径 */
  filePath: string;
  /** 事件数据 */
  data: T;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 文件监控事件处理器
 */
export type SessionFileEventHandler<T = unknown> = (event: SessionFileEvent<T>) => void | Promise<void>;


