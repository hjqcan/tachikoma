/**
 * SessionFileManager 接口类型
 */

import type { SubTask } from '../../types';
import type { SessionConfig, PeerReadOptions } from './config';
import type {
  RuntimeFile,
  ProgressFile,
  DecisionRecord,
  DistributiveOmit,
} from './runtime';
import type {
  WorkerStatusFile,
  PendingApprovalFile,
  ApprovalResponseFile,
  InterventionFile,
  ThinkingRecord,
  ActionRecord,
} from './worker';
import type {
  SharedContextFile,
  MessageRecord,
} from './shared';
import type {
  SessionFileEventType,
  SessionFileEventHandler,
} from './events';

/**
 * SessionFileManager 接口
 *
 * 管理会话目录结构，提供文件读写和监控功能
 */
export interface ISessionFileManager {
  /** 会话 ID */
  readonly sessionId: string;

  /** 配置 */
  readonly config: SessionConfig;

  // ============================================================================
  // 目录管理
  // ============================================================================

  /** 获取会话根目录路径 */
  getSessionPath(): string;

  /** 获取 Worker 目录路径 */
  getWorkerPath(workerId: string): string;

  /** 初始化会话目录结构 */
  initializeSession(): Promise<void>;

  /** 注册 Worker 目录 */
  registerWorker(workerId: string): Promise<void>;

  // ============================================================================
  // Orchestrator 文件操作
  // ============================================================================

  /** 写入运行时文件 */
  writeRuntime(runtime: DistributiveOmit<RuntimeFile, 'sessionId' | 'updatedAt'>): Promise<void>;

  /** 读取运行时文件 */
  readRuntime(): Promise<RuntimeFile | null>;

  /** 追加细分子任务到计划文件 */
  appendRefinedSubtasks(params: { parentId: string; refinedSubtasks: SubTask[] }): Promise<void>;

  /** 更新子任务状态 */
  updateSubtaskStatus(
    subtaskId: string,
    status: 'pending' | 'running' | 'success' | 'failure',
    result?: unknown
  ): Promise<void>;

  /** 更新进度文件 */
  writeProgress(progress: Omit<ProgressFile, 'sessionId' | 'updatedAt'>): Promise<void>;

  /** 读取进度文件 */
  readProgress(): Promise<ProgressFile | null>;

  /** 追加决策记录 */
  appendDecision(decision: Omit<DecisionRecord, 'id' | 'timestamp'>): Promise<void>;

  /** 读取决策日志 */
  readDecisions(limit?: number): Promise<DecisionRecord[]>;

  // ============================================================================
  // Worker 文件操作
  // ============================================================================

  /** 读取 Worker 状态 */
  readWorkerStatus(workerId: string): Promise<WorkerStatusFile | null>;

  /** 写入 Worker 状态 */
  writeWorkerStatus(workerId: string, status: Omit<WorkerStatusFile, 'workerId'>): Promise<void>;

  /** 读取待审批请求 */
  readPendingApproval(workerId: string): Promise<PendingApprovalFile | null>;

  /** 写入审批响应 */
  writeApprovalResponse(workerId: string, response: ApprovalResponseFile): Promise<void>;

  /** 读取审批响应 */
  readApprovalResponse(workerId: string): Promise<ApprovalResponseFile | null>;

  /** 写入干预指令 */
  writeIntervention(
    workerId: string,
    intervention: Omit<InterventionFile, 'interventionId' | 'createdAt' | 'acknowledged'>
  ): Promise<void>;

  /** 读取干预指令 */
  readIntervention(workerId: string): Promise<InterventionFile | null>;

  /** 确认干预指令 */
  acknowledgeIntervention(workerId: string): Promise<void>;

  /** 读取 Worker 思考日志 */
  readThinkingLogs(workerId: string, limit?: number): Promise<ThinkingRecord[]>;

  /** 读取 Worker 行动日志 */
  readActionLogs(workerId: string, limit?: number): Promise<ActionRecord[]>;

  /** 追加 Worker 思考记录 */
  appendThinking(workerId: string, record: Omit<ThinkingRecord, 'id'>): Promise<void>;

  /** 追加 Worker 行动记录 */
  appendAction(workerId: string, record: Omit<ActionRecord, 'id'>): Promise<void>;

  /** 写入待审批请求文件 */
  writePendingApproval(workerId: string, approval: PendingApprovalFile): Promise<void>;

  // ============================================================================
  // 共享文件操作
  // ============================================================================

  /** 读取共享上下文 */
  readSharedContext(): Promise<SharedContextFile | null>;

  /** 更新共享上下文 */
  writeSharedContext(context: Omit<SharedContextFile, 'sessionId'>): Promise<void>;

  /** 追加消息记录 */
  appendMessage(message: Omit<MessageRecord, 'id' | 'timestamp'>): Promise<void>;

  /** 读取消息日志 */
  readMessages(limit?: number): Promise<MessageRecord[]>;

  // ============================================================================
  // Peer 读取方法
  // ============================================================================

  /** 列出所有已注册的 Worker ID */
  listPeerWorkers(): Promise<string[]>;

  /** 读取 Peer Worker 状态 */
  readPeerStatus(workerId: string, options?: PeerReadOptions): Promise<WorkerStatusFile | null>;

  /** 读取 Peer 思考日志 */
  readPeerThinking(workerId: string, limit?: number, options?: PeerReadOptions): Promise<ThinkingRecord[]>;

  /** 读取 Peer 行动日志 */
  readPeerActions(workerId: string, limit?: number, options?: PeerReadOptions): Promise<ActionRecord[]>;

  // ============================================================================
  // 事件监听
  // ============================================================================

  /** 添加事件监听器 */
  on<T = unknown>(eventType: SessionFileEventType, handler: SessionFileEventHandler<T>): void;

  /** 移除事件监听器 */
  off<T = unknown>(eventType: SessionFileEventType, handler: SessionFileEventHandler<T>): void;

  // ============================================================================
  // 文件监控
  // ============================================================================

  /** 开始文件监控 */
  startWatching(): Promise<void>;

  /** 停止文件监控 */
  stopWatching(): void;

  // ============================================================================
  // 清理
  // ============================================================================

  /** 清理会话目录 */
  cleanup(): Promise<void>;

  /** 关闭管理器（停止监控） */
  close(): Promise<void>;
}
