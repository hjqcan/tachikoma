/**
 * SessionFileManager: Peer 读取相关实现（拆分自 session-file-manager.ts）
 */

import type { PeerReadOptions, RuntimeFile, ThinkingRecord, ActionRecord, WorkerStatusFile } from './types';
import { DEFAULT_PEER_READ_OPTIONS } from './types';
import {
  SessionPathBuilder,
  getFileStats,
  listDir,
  safeReadJsonFileWithRetry,
  safeReadJsonlTailWithRetry,
} from './utils';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class SessionPeerReader {
  constructor(private readonly paths: SessionPathBuilder) {}

  /**
   * 列出所有已注册的 Worker ID
   *
   * 基于 sessions/{sessionId}/workers 目录
   */
  async listPeerWorkers(): Promise<string[]> {
    const workersDir = this.paths.workersDir;
    const entries = await listDir(workersDir);
    // 过滤出目录（排除文件）
    const workers: string[] = [];
    for (const entry of entries) {
      const stats = await getFileStats(join(workersDir, entry));
      if (stats?.isDirectory) {
        workers.push(entry);
      }
    }
    return workers;
  }

  /**
   * 读取其他 Worker 的状态
   *
   * @param workerId - Worker ID
   * @param opts - 重试选项
   */
  async readPeerStatus(workerId: string, opts?: PeerReadOptions): Promise<WorkerStatusFile | null> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonFileWithRetry<WorkerStatusFile>(this.paths.workerStatusFile(workerId), {
      retries: options.retries,
      delay: options.backoffDelay,
    });
  }

  /**
   * 读取其他 Worker 的思考日志
   *
   * @param workerId - Worker ID
   * @param limit - 最大条数（默认 20）
   * @param opts - 重试选项
   */
  async readPeerThinking(workerId: string, limit = 20, opts?: PeerReadOptions): Promise<ThinkingRecord[]> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonlTailWithRetry<ThinkingRecord>(this.paths.workerThinkingFile(workerId), limit, {
      retries: options.retries,
      delay: options.backoffDelay,
    });
  }

  /**
   * 读取其他 Worker 的行动日志
   *
   * @param workerId - Worker ID
   * @param limit - 最大条数（默认 20）
   * @param opts - 重试选项
   */
  async readPeerActions(workerId: string, limit = 20, opts?: PeerReadOptions): Promise<ActionRecord[]> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonlTailWithRetry<ActionRecord>(this.paths.workerActionsFile(workerId), limit, {
      retries: options.retries,
      delay: options.backoffDelay,
    });
  }

  /**
   * 列出 Worker 的 artifacts 文件名
   *
   * @param workerId - Worker ID
   */
  async listPeerArtifacts(workerId: string): Promise<string[]> {
    const artifactsDir = this.paths.workerArtifactsDir(workerId);
    const entries = await listDir(artifactsDir);
    // 返回文件名列表（排除目录）
    const files: string[] = [];
    for (const entry of entries) {
      const stats = await getFileStats(join(artifactsDir, entry));
      if (stats?.isFile) {
        files.push(entry);
      }
    }
    return files;
  }

  /**
   * 读取 Worker 的单个 artifact 文件内容
   *
   * @param workerId - Worker ID
   * @param filename - 文件名
   */
  async readPeerArtifact(workerId: string, filename: string): Promise<string | null> {
    const filePath = join(this.paths.workerArtifactsDir(workerId), filename);
    try {
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 读取 Orchestrator 运行时快照（别名方法）
   *
   * 用于 Worker 读取当前执行顺序/运行信息
   *
   * @param opts - 重试选项
   */
  async readOrchestratorRuntime(opts?: PeerReadOptions): Promise<RuntimeFile | null> {
    const options = { ...DEFAULT_PEER_READ_OPTIONS, ...opts };
    return safeReadJsonFileWithRetry<RuntimeFile>(this.paths.runtimeFile, {
      retries: options.retries,
      delay: options.backoffDelay,
    });
  }
}


