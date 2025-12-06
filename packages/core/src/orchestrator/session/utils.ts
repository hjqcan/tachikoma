/**
 * 共享文件系统工具函数
 *
 * 提供原子写入、JSONL 操作、路径处理等工具
 */

import { mkdir, writeFile, rename, readFile, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ============================================================================
// ID 生成
// ============================================================================

/**
 * 生成唯一 ID
 *
 * @param prefix - 可选前缀
 * @returns 唯一 ID
 */
export function generateId(prefix?: string): string {
  const uuid = randomUUID().replace(/-/g, '').slice(0, 12);
  return prefix ? `${prefix}-${uuid}` : uuid;
}

/**
 * 生成带时间戳的 ID
 *
 * @param prefix - 可选前缀
 * @returns 带时间戳的唯一 ID
 */
export function generateTimestampId(prefix?: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}

// ============================================================================
// 原子写入
// ============================================================================

/**
 * 原子写入文件
 *
 * 使用 write-to-temp-then-rename 策略确保写入的原子性
 * 防止写入过程中崩溃导致文件损坏
 *
 * @param filePath - 目标文件路径
 * @param content - 文件内容
 *
 * @example
 * ```ts
 * await atomicWriteFile('/path/to/file.json', JSON.stringify(data));
 * ```
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  // 确保目录存在
  const dir = dirname(filePath);
  await ensureDir(dir);

  // 生成临时文件路径
  const tempPath = `${filePath}.${generateId('tmp')}`;

  try {
    // 写入临时文件
    await writeFile(tempPath, content, 'utf-8');

    // 原子重命名
    await rename(tempPath, filePath);
  } catch (error) {
    // 清理临时文件（如果存在）
    try {
      if (existsSync(tempPath)) {
        await rm(tempPath);
      }
    } catch {
      // 忽略清理错误
    }
    throw error;
  }
}

/**
 * 原子写入 JSON 文件
 *
 * @param filePath - 目标文件路径
 * @param data - JSON 数据
 * @param pretty - 是否格式化输出（默认 true）
 */
export async function atomicWriteJson<T>(
  filePath: string,
  data: T,
  pretty = true
): Promise<void> {
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await atomicWriteFile(filePath, content);
}

// ============================================================================
// JSONL 文件操作
// ============================================================================

/**
 * 追加 JSONL 记录
 *
 * JSONL (JSON Lines) 格式：每行一个 JSON 对象
 * 适用于日志类数据的追加写入
 *
 * @param filePath - 目标文件路径
 * @param record - 要追加的记录
 */
export async function appendJsonlRecord<T>(filePath: string, record: T): Promise<void> {
  // 确保目录存在
  const dir = dirname(filePath);
  await ensureDir(dir);

  // 序列化记录（确保单行）
  const line = JSON.stringify(record) + '\n';

  // 追加写入（不使用原子写入，因为追加操作本身是安全的）
  await writeFile(filePath, line, { flag: 'a', encoding: 'utf-8' });
}

/**
 * 读取 JSONL 文件所有记录
 *
 * @param filePath - 文件路径
 * @returns 记录数组
 */
export async function readJsonlRecords<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    const records: T[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        // 跳过解析失败的行
        console.warn(`Failed to parse JSONL line: ${line.slice(0, 100)}...`);
      }
    }

    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * 读取 JSONL 文件尾部记录
 *
 * 从文件尾部读取指定数量的记录
 * 用于高效读取最新日志
 *
 * @param filePath - 文件路径
 * @param limit - 最大读取条数
 * @returns 记录数组（按时间顺序，最新的在最后）
 */
export async function readJsonlTail<T>(filePath: string, limit: number): Promise<T[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    // 从尾部取 limit 条
    const tailLines = lines.slice(-limit);

    const records: T[] = [];
    for (const line of tailLines) {
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        // 跳过解析失败的行
      }
    }

    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// ============================================================================
// JSON 文件操作
// ============================================================================

/**
 * 安全读取 JSON 文件
 *
 * @param filePath - 文件路径
 * @returns JSON 数据，文件不存在时返回 null
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// ============================================================================
// 目录操作
// ============================================================================

/**
 * 确保目录存在
 *
 * @param dirPath - 目录路径
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    // 如果目录已存在，忽略错误
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * 检查文件是否存在
 *
 * @param filePath - 文件路径
 * @returns 是否存在
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * 安全删除文件
 *
 * @param filePath - 文件路径
 * @returns 是否删除成功
 */
export async function safeDeleteFile(filePath: string): Promise<boolean> {
  try {
    await rm(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false; // 文件不存在，视为成功
    }
    throw error;
  }
}

/**
 * 递归删除目录
 *
 * @param dirPath - 目录路径
 */
export async function removeDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * 列出目录内容
 *
 * @param dirPath - 目录路径
 * @returns 文件/目录名列表
 */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * 获取文件/目录状态
 *
 * @param path - 路径
 * @returns 状态信息，不存在时返回 null
 */
export async function getFileStats(path: string): Promise<{
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: Date;
} | null> {
  try {
    const stats = await stat(path);
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtime: stats.mtime,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// ============================================================================
// 路径构建
// ============================================================================

/**
 * 会话目录路径构建器
 */
export class SessionPathBuilder {
  constructor(
    private readonly rootDir: string,
    private readonly sessionId: string
  ) {}

  /** 获取会话根路径 */
  get sessionRoot(): string {
    return join(this.rootDir, 'sessions', this.sessionId);
  }

  /** 获取 orchestrator 目录路径 */
  get orchestratorDir(): string {
    return join(this.sessionRoot, 'orchestrator');
  }

  /** 获取 workers 目录路径 */
  get workersDir(): string {
    return join(this.sessionRoot, 'workers');
  }

  /** 获取 shared 目录路径 */
  get sharedDir(): string {
    return join(this.sessionRoot, 'shared');
  }

  /** 获取计划文件路径 */
  get planFile(): string {
    return join(this.orchestratorDir, 'plan.json');
  }

  /** 获取进度文件路径 */
  get progressFile(): string {
    return join(this.orchestratorDir, 'progress.json');
  }

  /** 获取决策日志路径 */
  get decisionsFile(): string {
    return join(this.orchestratorDir, 'decisions.jsonl');
  }

  /** 获取共享上下文文件路径 */
  get sharedContextFile(): string {
    return join(this.sharedDir, 'context.json');
  }

  /** 获取消息日志路径 */
  get messagesFile(): string {
    return join(this.sharedDir, 'messages.jsonl');
  }

  /**
   * 获取 Worker 目录路径
   * @param workerId - Worker ID
   */
  workerDir(workerId: string): string {
    return join(this.workersDir, workerId);
  }

  /**
   * 获取 Worker 文件路径
   * @param workerId - Worker ID
   * @param fileName - 文件名
   */
  workerFile(workerId: string, fileName: string): string {
    return join(this.workerDir(workerId), fileName);
  }

  /**
   * 获取 Worker 状态文件路径
   * @param workerId - Worker ID
   */
  workerStatusFile(workerId: string): string {
    return this.workerFile(workerId, 'status.json');
  }

  /**
   * 获取 Worker 思考日志路径
   * @param workerId - Worker ID
   */
  workerThinkingFile(workerId: string): string {
    return this.workerFile(workerId, 'thinking.jsonl');
  }

  /**
   * 获取 Worker 行动日志路径
   * @param workerId - Worker ID
   */
  workerActionsFile(workerId: string): string {
    return this.workerFile(workerId, 'actions.jsonl');
  }

  /**
   * 获取 Worker 待审批请求文件路径
   * @param workerId - Worker ID
   */
  workerPendingApprovalFile(workerId: string): string {
    return this.workerFile(workerId, 'pending_approval.json');
  }

  /**
   * 获取 Worker 审批响应文件路径
   * @param workerId - Worker ID
   */
  workerApprovalResponseFile(workerId: string): string {
    return this.workerFile(workerId, 'approval_response.json');
  }

  /**
   * 获取 Worker 干预指令文件路径
   * @param workerId - Worker ID
   */
  workerInterventionFile(workerId: string): string {
    return this.workerFile(workerId, 'intervention.json');
  }

  /**
   * 获取 Worker artifacts 目录路径
   * @param workerId - Worker ID
   */
  workerArtifactsDir(workerId: string): string {
    return join(this.workerDir(workerId), 'artifacts');
  }

  /**
   * 获取所有需要创建的目录列表
   */
  getAllDirs(): string[] {
    return [
      this.sessionRoot,
      this.orchestratorDir,
      this.workersDir,
      this.sharedDir,
    ];
  }

  /**
   * 获取 Worker 需要创建的目录列表
   * @param workerId - Worker ID
   */
  getWorkerDirs(workerId: string): string[] {
    return [
      this.workerDir(workerId),
      this.workerArtifactsDir(workerId),
    ];
  }
}

// ============================================================================
// 文件锁（简单实现）
// ============================================================================

/**
 * 简单的文件锁实现
 *
 * 使用 .lock 文件实现互斥
 * 注意：这是一个简单实现，不适用于多进程高并发场景
 */
export class FileLock {
  private readonly lockPath: string;
  private locked = false;

  constructor(filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  /**
   * 获取锁
   * @param timeout - 超时时间（毫秒）
   * @returns 是否获取成功
   */
  async acquire(timeout = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // 尝试创建锁文件（排他性）
        await writeFile(this.lockPath, String(Date.now()), { flag: 'wx' });
        this.locked = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // 锁文件已存在，等待后重试
          await sleep(50);
          continue;
        }
        throw error;
      }
    }

    return false;
  }

  /**
   * 释放锁
   */
  async release(): Promise<void> {
    if (this.locked) {
      await safeDeleteFile(this.lockPath);
      this.locked = false;
    }
  }

  /**
   * 检查是否已锁定
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * 使用文件锁执行操作
 *
 * @param filePath - 文件路径
 * @param fn - 要执行的操作
 * @param timeout - 锁超时时间
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  timeout = 5000
): Promise<T> {
  const lock = new FileLock(filePath);

  const acquired = await lock.acquire(timeout);
  if (!acquired) {
    throw new Error(`Failed to acquire lock for ${filePath} within ${timeout}ms`);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 等待指定时间
 *
 * @param ms - 毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 当前时间戳
 */
export function now(): number {
  return Date.now();
}
