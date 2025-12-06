/**
 * 共享文件系统协调机制模块
 *
 * 提供会话目录管理、文件读写、监控等功能
 *
 * @packageDocumentation
 */

// 类型导出
export type {
  // 配置类型
  SessionConfig,
  // Orchestrator 文件类型
  PlanFile,
  ProgressFile,
  DecisionType,
  DecisionRecord,
  // Worker 文件类型
  WorkerStatusFile,
  ThinkingRecord,
  ActionType,
  ActionRecord,
  ApprovalRequestType,
  PendingApprovalFile,
  ApprovalResponseFile,
  InterventionType,
  InterventionFile,
  // 共享文件类型
  SharedContextFile,
  MessageDirection,
  MessageRecord,
  // 事件类型
  SessionFileEventType,
  SessionFileEvent,
  SessionFileEventHandler,
  // 接口
  ISessionFileManager,
} from './types';

// 常量导出
export { DEFAULT_SESSION_CONFIG } from './types';

// SessionFileManager 导出
export {
  SessionFileManager,
  createSessionFileManager,
  createAndInitializeSessionFileManager,
} from './session-file-manager';

// 工具函数导出
export {
  // ID 生成
  generateId,
  generateTimestampId,
  // 原子写入
  atomicWriteFile,
  atomicWriteJson,
  // JSONL 操作
  appendJsonlRecord,
  readJsonlRecords,
  readJsonlTail,
  // JSON 操作
  readJsonFile,
  // 目录操作
  ensureDir,
  fileExists,
  safeDeleteFile,
  removeDir,
  listDir,
  getFileStats,
  // 路径构建
  SessionPathBuilder,
  // 文件锁
  FileLock,
  withFileLock,
  // 辅助函数
  sleep,
  now,
} from './utils';
