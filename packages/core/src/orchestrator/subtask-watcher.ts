/**
 * Subtask Watcher - 子任务目录监控器
 *
 * 监控 subtasks/ 目录，发现新子任务并通知 Orchestrator 调度
 *
 * 使用方式：
 * ```typescript
 * const watcher = new SubtaskWatcher(workDir);
 * watcher.on('subtask', (subtask) => orchestrator.scheduleSubtask(subtask));
 * await watcher.start();
 * ```
 */

import { readdir, readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * 子任务定义（与 spawn_subagent 输出一致）
 */
export interface SubtaskDefinition {
  /** 子任务ID */
  id: string;
  /** 父任务ID */
  parentTaskId: string;
  /** 父AgentID */
  parentAgentId: string;
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 目标 */
  objective: string;
  /** 描述 */
  description?: string;
  /** 约束 */
  constraints: string[];
  /** 可用工具 */
  tools?: string[];
  /** 依赖 */
  dependencies: string[];
  /** 优先级 */
  priority: number;
  /** 超时 */
  timeout: number;
  /** 上下文数据 */
  context?: Record<string, unknown>;
  /** 创建时间（用于排序） */
  createdAt: number;
  /** 创建者 */
  createdBy: string;
}

/**
 * 子任务事件类型
 */
export interface SubtaskWatcherEvents {
  /** 发现新子任务 */
  subtask: (subtask: SubtaskDefinition, filePath: string) => void;
  /** 子任务状态变化 */
  statusChange: (subtaskId: string, oldStatus: string, newStatus: string) => void;
  /** 错误 */
  error: (error: Error) => void;
}

/**
 * SubtaskWatcher 配置
 */
export interface SubtaskWatcherConfig {
  /** 轮询间隔（毫秒，默认1000） */
  pollInterval?: number;
  /** 是否自动删除已完成的子任务文件（默认false） */
  autoCleanup?: boolean;
  /** 是否处理已存在的pending任务（默认true） */
  processExisting?: boolean;
  /** 额外监控路径（除默认 workDir/.tachikoma/subtasks/ 外） */
  additionalPaths?: string[];
  /** Session ID（自动添加 session subtasks 路径） */
  sessionId?: string;
  /** Worker ID（与 sessionId 配合，自动添加 worker subtasks 路径） */
  workerId?: string;
  /** 是否持久化已处理ID列表（跨重启去重，默认true） */
  persistProcessedIds?: boolean;
}

/**
 * 子任务目录监控器
 *
 * 监控多个 subtasks 目录：
 * - 默认：{workDir}/.tachikoma/subtasks/
 * - Session 模式：{workDir}/.tachikoma/sessions/{sessionId}/orchestrator/subtasks/
 * - Worker 模式：{workDir}/.tachikoma/sessions/{sessionId}/workers/{workerId}/subtasks/
 * - 自定义：additionalPaths
 */
export class SubtaskWatcher extends EventEmitter {
  private readonly watchPaths: string[];
  private readonly workDir: string;
  private readonly config: Required<Omit<SubtaskWatcherConfig, 'additionalPaths' | 'sessionId' | 'workerId'>>;
  private readonly processedIdsFile: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 已发出事件的任务ID（避免重复触发事件） */
  private processedIds = new Set<string>();
  /** 已完成的任务ID（用于依赖判断） */
  private completedIds = new Set<string>();
  private running = false;

  constructor(workDir: string, config: SubtaskWatcherConfig = {}) {
    super();
    this.workDir = workDir;
    
    // 持久化文件路径
    this.processedIdsFile = join(workDir, '.tachikoma', '.subtask-watcher-state.json');
    
    // 构建监控路径列表
    const paths: string[] = [
      // 默认全局路径
      join(workDir, '.tachikoma', 'subtasks'),
    ];
    
    // 添加 session 路径
    if (config.sessionId) {
      // Orchestrator 级别
      paths.push(
        join(workDir, '.tachikoma', 'sessions', config.sessionId, 'orchestrator', 'subtasks')
      );
      
      // Worker 级别（如果同时提供了 workerId）
      if (config.workerId) {
        paths.push(
          join(workDir, '.tachikoma', 'sessions', config.sessionId, 'workers', config.workerId, 'subtasks')
        );
      }
    }
    
    // 添加自定义路径
    if (config.additionalPaths) {
      paths.push(...config.additionalPaths);
    }
    
    this.watchPaths = [...new Set(paths)]; // 去重
    this.config = {
      pollInterval: config.pollInterval ?? 1000,
      autoCleanup: config.autoCleanup ?? false,
      processExisting: config.processExisting ?? true,
      persistProcessedIds: config.persistProcessedIds ?? true,
    };
  }

  /**
   * 获取所有监控路径
   */
  getWatchPaths(): string[] {
    return [...this.watchPaths];
  }

  /**
   * 启动监控
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 加载持久化的已处理ID
    if (this.config.persistProcessedIds) {
      await this.loadProcessedIds();
    }

    // 首次扫描（处理已存在的任务）
    if (this.config.processExisting) {
      await this.scanSubtasks();
    }

    // 启动轮询
    this.pollTimer = setInterval(() => {
      this.scanSubtasks().catch((error) => {
        this.emit('error', error);
      });
    }, this.config.pollInterval);
  }

  /**
   * 停止监控
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    
    // 保存已处理ID
    if (this.config.persistProcessedIds) {
      await this.saveProcessedIds();
    }
  }

  /**
   * 加载持久化的已处理ID
   */
  private async loadProcessedIds(): Promise<void> {
    try {
      const content = await readFile(this.processedIdsFile, 'utf-8');
      const data = JSON.parse(content) as { processedIds: string[]; completedIds?: string[] };
      if (Array.isArray(data.processedIds)) {
        this.processedIds = new Set(data.processedIds);
      }
      if (Array.isArray(data.completedIds)) {
        this.completedIds = new Set(data.completedIds);
      }
    } catch {
      // 文件不存在或解析失败，使用空集合
    }
  }

  /**
   * 保存已处理ID到文件
   */
  private async saveProcessedIds(): Promise<void> {
    try {
      await mkdir(dirname(this.processedIdsFile), { recursive: true });
      const data = {
        processedIds: [...this.processedIds],
        completedIds: [...this.completedIds],
        savedAt: new Date().toISOString(),
      };
      await writeFile(this.processedIdsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // 忽略保存错误
    }
  }

  /**
   * 扫描所有 subtasks 目录
   */
  private async scanSubtasks(): Promise<void> {
    for (const subtasksDir of this.watchPaths) {
      await this.scanDirectory(subtasksDir);
    }
  }

  /**
   * 扫描单个目录
   */
  private async scanDirectory(subtasksDir: string): Promise<void> {
    try {
      // 检查目录是否存在
      const dirStat = await stat(subtasksDir).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) {
        return; // 目录不存在，跳过
      }

      const files = await readdir(subtasksDir);
      const subtaskFiles = files.filter(
        (f) => f.startsWith('subtask-') && f.endsWith('.json')
      );

      // 按文件名排序（包含时间戳）
      subtaskFiles.sort();

      for (const file of subtaskFiles) {
        const filePath = join(subtasksDir, file);
        await this.processSubtaskFile(filePath, file);
      }
    } catch (error) {
      // 忽略目录不存在错误
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        this.emit('error', error);
      }
    }
  }

  /**
   * 处理子任务文件
   */
  private async processSubtaskFile(filePath: string, _filename: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const subtask = JSON.parse(content) as SubtaskDefinition;

      // 跳过已处理或非 pending 状态的任务
      if (this.processedIds.has(subtask.id)) {
        // 检查状态变化
        return;
      }

      if (subtask.status !== 'pending') {
        // 非 pending 状态，标记已处理
        this.processedIds.add(subtask.id);
        
        // 如果是 completed/failed，加入已完成集合（用于依赖判断）
        if (subtask.status === 'completed' || subtask.status === 'failed') {
          this.completedIds.add(subtask.id);
        }

        // 如果已完成且启用自动清理
        if (this.config.autoCleanup && subtask.status === 'completed') {
          await unlink(filePath).catch(() => { /* ignore */ });
        }
        return;
      }

      // 检查依赖是否满足
      if (!this.areDependenciesMet(subtask)) {
        return; // 依赖未满足，稍后重试
      }

      // 标记已处理并发出事件
      this.processedIds.add(subtask.id);
      this.emit('subtask', subtask, filePath);
    } catch (error) {
      // 忽略解析错误（可能文件正在写入）
      const err = error as Error;
      if (!err.message.includes('JSON')) {
        this.emit('error', error);
      }
    }
  }

  /**
   * 检查依赖是否满足
   */
  private areDependenciesMet(subtask: SubtaskDefinition): boolean {
    if (!subtask.dependencies || subtask.dependencies.length === 0) {
      return true;
    }

    // 所有依赖都必须已完成（不是已处理）
    return subtask.dependencies.every((dep) => this.completedIds.has(dep));
  }

  /**
   * 手动标记子任务完成（用于依赖解锁）
   */
  markCompleted(subtaskId: string): void {
    this.processedIds.add(subtaskId);
    this.completedIds.add(subtaskId);
  }

  /**
   * 获取待处理子任务（按优先级和时间排序）
   */
  async getPendingSubtasks(): Promise<SubtaskDefinition[]> {
    const pending: SubtaskDefinition[] = [];

    for (const subtasksDir of this.watchPaths) {
      try {
        const dirStat = await stat(subtasksDir).catch(() => null);
        if (!dirStat || !dirStat.isDirectory()) {
          continue;
        }

        const files = await readdir(subtasksDir);
        const subtaskFiles = files.filter(
          (f) => f.startsWith('subtask-') && f.endsWith('.json')
        );

        for (const file of subtaskFiles) {
          const filePath = join(subtasksDir, file);
          try {
            const content = await readFile(filePath, 'utf-8');
            const subtask = JSON.parse(content) as SubtaskDefinition;
            if (subtask.status === 'pending') {
              pending.push(subtask);
            }
          } catch {
            // 忽略解析错误
          }
        }
      } catch {
        // 忽略错误
      }
    }

    // 按优先级（降序）和创建时间（升序）排序
    pending.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // 高优先级在前
      }
      return a.createdAt - b.createdAt; // 早创建的在前
    });

    return pending;
  }

  /**
   * 获取主 subtasks 目录路径（第一个监控路径）
   * @deprecated 使用 getWatchPaths() 获取所有路径
   */
  getSubtasksDir(): string {
    return this.watchPaths[0] ?? '';
  }
}

export default SubtaskWatcher;

