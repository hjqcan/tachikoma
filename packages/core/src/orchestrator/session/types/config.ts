/**
 * Session 配置相关类型
 */

/**
 * 会话配置
 */
export interface SessionConfig {
  /** 会话根目录（默认 .tachikoma） */
  rootDir: string;
  /** 是否自动创建目录 */
  autoCreateDirs: boolean;
  /** 文件监控轮询间隔（毫秒） */
  watchPollInterval: number;
  /** 是否启用文件监控 */
  enableWatch: boolean;
  /**
   * Worker 心跳超时（毫秒）
   *
   * 当 Worker 的 lastHeartbeat 超过该阈值且近期无行动日志更新时，
   * SessionFileManager 可将其标记为 stale/error，避免状态永久卡住。
   */
  staleWorkerTimeoutMs: number;
  /**
   * 行动日志宽限期（毫秒）
   *
   * 若 actions.jsonl 在该时间窗口内仍有更新，则认为 Worker 仍在工作，
   * 即使 lastHeartbeat 未更新也不做 stale 标记。
   */
  staleWorkerActionGraceMs: number;
}

/**
 * 默认会话配置
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  rootDir: '.tachikoma',
  autoCreateDirs: true,
  watchPollInterval: 500,
  enableWatch: true,
  staleWorkerTimeoutMs: 3 * 60 * 1000,
  staleWorkerActionGraceMs: 30 * 1000,
};

/**
 * Peer 读取选项
 *
 * 用于读取其他 Worker 或 Orchestrator 数据时的重试配置
 */
export interface PeerReadOptions {
  /** 重试次数，默认 2 */
  retries?: number;
  /** 重试延迟（毫秒），默认 50 */
  backoffDelay?: number;
}

/**
 * 默认 Peer 读取选项
 */
export const DEFAULT_PEER_READ_OPTIONS: Required<PeerReadOptions> = {
  retries: 2,
  backoffDelay: 50,
};


