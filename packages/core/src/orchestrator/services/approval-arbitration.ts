/**
 * 审批仲裁服务
 *
 * 负责处理 Worker 的审批请求，包括文件写入仲裁和展开提交仲裁
 * 从 Orchestrator 类中提取
 */

import type {
  PendingApprovalFile,
  ApprovalResponseFile,
  ISessionFileManager,
  SessionFileEvent,
} from '../session';
import type { ApprovalPolicy } from '../types';
import type { IEventService } from '../interfaces';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 文件写入仲裁参数
 */
export interface FileWriteArbitrationParams {
  workerId: string;
  approval: PendingApprovalFile;
  action: 'apply_patch' | 'file_write';
  affectedFiles: string[];
}

/**
 * 展开提交仲裁参数
 */
export interface ExpandCommitArbitrationParams {
  workerId: string;
  approval: PendingApprovalFile;
  input: Record<string, unknown> | undefined;
}

/**
 * 延迟审批信息
 */
export interface DelayedApproval {
  workerId: string;
  approval: PendingApprovalFile;
  reason: string;
}

/**
 * Task Master 回调接口
 */
export interface TaskMasterCallbacks {
  getRefForCurrentTask(): { projectRoot: string; file: string; tag: string } | null;
  addDependency(subtaskId: string, predecessor: string): Promise<void>;
  expandSubtask(
    targetId: string,
    subtasks: { title: string; description: string; details: string; testStrategy: string }[],
    options: { projectRoot: string; file: string; tag: string; force?: boolean; strategy: 'serial' | 'parallel' }
  ): Promise<void>;
  markPendingReplan(): void;
  addExpandedSubtask(subtaskId: string): void;
  getRoleAssignment(targetId: string): { roleId?: string; requiredCapabilities?: string[] } | null;
  writeRoleAssignment(tag: string, subtaskId: string, roleId: string, caps: string[]): Promise<void>;
  recordOriginalStatus(subtaskId: string, status: string): void;
}

/**
 * 审批仲裁服务配置
 */
export interface ApprovalArbitrationConfig {
  policy: ApprovalPolicy;
  requestCacheTTL: number;
}

// ============================================================================
// ApprovalArbitrationService 实现
// ============================================================================

/**
 * 审批仲裁服务
 *
 * 负责处理 Worker 发起的审批请求，实现：
 * 1. 文件写入串行化（防止并发写入冲突）
 * 2. 展开提交处理（支持 Task Master 子任务扩展）
 * 3. 策略驱动的自动审批/拒绝
 *
 * @example
 * ```ts
 * const service = new ApprovalArbitrationService({
 *   sessionManager,
 *   eventService,
 *   policy: DEFAULT_APPROVAL_POLICY,
 * });
 *
 * await service.handlePendingApproval(event);
 * ```
 */
export class ApprovalArbitrationService {
  private readonly sessionManager: ISessionFileManager;
  private readonly eventService: IEventService;
  private readonly policy: ApprovalPolicy;
  private readonly requestCacheTTL: number;

  // Task Master 回调（可选）
  private taskMasterCallbacks?: TaskMasterCallbacks;

  // 文件锁管理
  private readonly fileLocks = new Map<string, string>(); // filePath -> subtaskId
  private readonly fileWaitQueues = new Map<string, string[]>(); // filePath -> waiting subtaskIds
  private readonly subtaskWriteFiles = new Map<string, Set<string>>(); // subtaskId -> filePaths

  // 延迟审批
  private readonly delayedApprovalsBySubtaskId = new Map<string, DelayedApproval>();

  // 已处理请求缓存（防止重复处理）
  private readonly processedApprovalRequests = new Map<string, number>();

  constructor(options: {
    sessionManager: ISessionFileManager;
    eventService: IEventService;
    policy: ApprovalPolicy;
    requestCacheTTL?: number;
    taskMasterCallbacks?: TaskMasterCallbacks;
  }) {
    this.sessionManager = options.sessionManager;
    this.eventService = options.eventService;
    this.policy = options.policy;
    this.requestCacheTTL = options.requestCacheTTL ?? 5 * 60 * 1000; // 5 分钟
    if (options.taskMasterCallbacks) {
      this.taskMasterCallbacks = options.taskMasterCallbacks;
    }
  }

  /**
   * 设置 Task Master 回调
   */
  setTaskMasterCallbacks(callbacks: TaskMasterCallbacks): void {
    this.taskMasterCallbacks = callbacks;
  }

  /**
   * 处理 Worker 审批请求
   */
  async handlePendingApproval(
    event: SessionFileEvent<PendingApprovalFile>
  ): Promise<void> {
    const approval = event.data;
    const workerId = event.workerId || approval.workerId;
    const now = Date.now();

    // 检查是否已处理过此请求
    if (this.processedApprovalRequests.has(approval.requestId)) {
      return;
    }

    // 清理过期的请求缓存
    for (const [requestId, timestamp] of this.processedApprovalRequests) {
      if (now - timestamp > this.requestCacheTTL) {
        this.processedApprovalRequests.delete(requestId);
      }
    }

    // 标记为已处理
    this.processedApprovalRequests.set(approval.requestId, now);

    // 检查是否已超时
    const requestTimeout = approval.timeout || this.policy.timeout;
    const isTimedOut = now - approval.requestedAt > requestTimeout;

    // 发送收到审批请求事件
    this.eventService.emit('approval:received', approval.subtaskId, {
      requestId: approval.requestId,
      workerId,
      type: approval.type,
      description: approval.description,
      isTimedOut,
    });

    // 提取动作和输入
    const extracted = this.extractApprovalActionAndInput(approval);

    // 处理文件写入仲裁
    if (extracted.action === 'apply_patch' || extracted.action === 'file_write') {
      await this.handleFileWriteArbitration({
        workerId,
        approval,
        action: extracted.action,
        affectedFiles: extracted.affectedFiles,
      });
      return;
    }

    // 处理展开提交仲裁
    if (extracted.action === 'expand_commit') {
      await this.handleExpandCommitArbitration({
        workerId,
        approval,
        input: extracted.input,
      });
      return;
    }

    // 根据策略决定是否批准
    let approved: boolean;
    let reason: string;

    if (isTimedOut) {
      const timeoutDecision = approval.defaultDecision || this.policy.defaultDecision;
      approved = timeoutDecision === 'approve';
      reason = `Request timed out after ${Math.round(requestTimeout / 1000)}s, using default decision: ${timeoutDecision}`;
    } else if (this.policy.autoRejectTypes.includes(approval.type)) {
      approved = false;
      reason = `Request type "${approval.type}" is in auto-reject list`;
    } else if (this.policy.autoApproveTypes.includes(approval.type)) {
      approved = true;
      reason = `Request type "${approval.type}" is in auto-approve list`;
    } else if (this.policy.lowImpactAutoApprove && approval.details.impactScope === 'low') {
      approved = true;
      reason = 'Low impact operation auto-approved';
    } else if (this.policy.reversibleAutoApprove && approval.details.reversible) {
      approved = true;
      reason = 'Reversible operation auto-approved';
    } else {
      approved = this.policy.defaultDecision === 'approve';
      reason = `Default decision: ${this.policy.defaultDecision}`;
    }

    await this.approvePendingApproval(workerId, approval, approved, reason);
  }

  /**
   * 处理文件写入仲裁
   */
  async handleFileWriteArbitration(
    params: FileWriteArbitrationParams
  ): Promise<boolean> {
    const { workerId, approval, action, affectedFiles } = params;
    const subtaskId = approval.subtaskId;

    if (!affectedFiles || affectedFiles.length === 0) {
      await this.approvePendingApproval(
        workerId,
        approval,
        true,
        `Auto-approved ${action} (no affectedFiles provided)`
      );
      return true;
    }

    // P1-2: 多文件锁支持
    // 1. 规范化顺序以避免死锁
    const sortedFiles = Array.from(new Set(affectedFiles)).sort();

    // 2. 检查所有文件锁状态
    let blockingFile: string | null = null;
    let holder: string | null = null;

    for (const file of sortedFiles) {
      const h = this.fileLocks.get(file);
      if (h && h !== subtaskId) {
        blockingFile = file;
        holder = h;
        break;
      }
    }

    // 3. 如果被阻塞，进入等待队列
    if (blockingFile) {
      const queue = this.fileWaitQueues.get(blockingFile) ?? [];
      
      // 写回依赖 (如果被其他子任务阻塞)
      if (holder && holder !== subtaskId && this.taskMasterCallbacks) {
        const ref = this.taskMasterCallbacks.getRefForCurrentTask();
        if (ref) {
          await this.taskMasterCallbacks
            .addDependency(subtaskId, holder)
            .catch(() => undefined);
        }
      }

      // 避免重复加入队列
      if (!queue.includes(subtaskId)) {
        queue.push(subtaskId);
        this.fileWaitQueues.set(blockingFile, queue);
      }

      // 覆盖/更新之前的延迟记录
      this.delayedApprovalsBySubtaskId.set(subtaskId, {
        workerId,
        approval,
        reason: `Waiting for file lock: ${blockingFile} (held by ${holder})`,
      });

      return false;
    }

    // 4. 获取所有锁
    const acquiredFiles = new Set<string>();
    const subtaskFiles = this.subtaskWriteFiles.get(subtaskId) ?? new Set<string>();

    for (const file of sortedFiles) {
      this.fileLocks.set(file, subtaskId);
      acquiredFiles.add(file);
      subtaskFiles.add(file);
    }
    this.subtaskWriteFiles.set(subtaskId, subtaskFiles);

    await this.approvePendingApproval(
      workerId,
      approval,
      true,
      `Approved ${action} (acquired file locks: ${Array.from(acquiredFiles).join(', ')})`
    );
    return true;
  }

  /**
   * 释放子任务的文件锁
   */
  async releaseFileLocksForSubtask(subtaskId: string): Promise<void> {
    const files = this.subtaskWriteFiles.get(subtaskId);
    if (!files || files.size === 0) return;

    // 必须释放暂存的延迟审批（如果有）防止内存泄漏
    this.delayedApprovalsBySubtaskId.delete(subtaskId);

    for (const filePath of files) {
      const holder = this.fileLocks.get(filePath);
      if (holder !== subtaskId) continue;

      this.fileLocks.delete(filePath);

      // 处理等待队列
      // 循环尝试唤醒等待者，直到有一个成功获取所有锁，或者队列为空，或者文件被新占用于其他锁
      const queue = this.fileWaitQueues.get(filePath);
      if (!queue || queue.length === 0) {
        this.fileWaitQueues.delete(filePath);
        continue;
      }

      while (queue.length > 0) {
        // 如果文件已经被其他人再次占用（在循环中被前面的候选者拿走了），停止唤醒
        if (this.fileLocks.has(filePath)) break;

        const candidateId = queue.shift();
        if (!candidateId) continue;

        const delayed = this.delayedApprovalsBySubtaskId.get(candidateId);
        // 如果 delayed 记录不存在（可能已取消），跳过
        if (!delayed) continue;

        // 重新尝试仲裁（这会尝试获取候选者所需的所有锁）
        // 如果成功，它会自动批准并占用锁（包括当前 filePath）
        // 如果失败，它会自动重新加入到（新的）阻塞文件的队列中
        
        // 构造参数
        const { action, affectedFiles } = this.extractApprovalActionAndInput(delayed.approval);
        
        const success = await this.handleFileWriteArbitration({
          workerId: delayed.workerId,
          approval: delayed.approval,
          action: action as 'apply_patch' | 'file_write',
          affectedFiles,
        });

        if (success) {
          // 候选者成功拿到了锁（包括当前 filePath），循环结束，filePath 现在被占用了
          this.delayedApprovalsBySubtaskId.delete(candidateId);
          break; 
        }
        // 如果失败，candidateId 应该已经被 handleFileWriteArbitration 重新加入到了某个队列
        // 我们可以继续尝试下一个队列中的候选者
      }

      if (queue.length === 0) {
        this.fileWaitQueues.delete(filePath);
      }
    }

    this.subtaskWriteFiles.delete(subtaskId);
  }

  /**
   * 处理展开提交仲裁
   */
  async handleExpandCommitArbitration(
    params: ExpandCommitArbitrationParams
  ): Promise<void> {
    const { workerId, approval, input } = params;

    if (!this.taskMasterCallbacks) {
      await this.approvePendingApproval(
        workerId,
        approval,
        false,
        'TaskMaster callbacks not configured for expand_commit'
      );
      return;
    }

    const ref = this.taskMasterCallbacks.getRefForCurrentTask();
    if (!ref) {
      await this.approvePendingApproval(
        workerId,
        approval,
        false,
        'No tasks.json reference available for expand_commit'
      );
      return;
    }

    const inputObj = input ?? {};
    const rawTargetId = typeof inputObj.targetId === 'string' ? inputObj.targetId.trim() : '';
    const targetId = rawTargetId || approval.subtaskId;

    const rawStrategy = typeof inputObj.strategy === 'string' ? inputObj.strategy : '';
    const strategy: 'serial' | 'parallel' = rawStrategy === 'parallel' ? 'parallel' : 'serial';
    const force = inputObj.force === true;

    const rawSubs = inputObj.subtasks;
    if (!Array.isArray(rawSubs) || rawSubs.length < 2) {
      await this.approvePendingApproval(
        workerId,
        approval,
        false,
        'expand_commit requires subtasks (array) with length >= 2'
      );
      return;
    }

    const generated = rawSubs.map((s) => {
      const obj = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      return {
        title: typeof obj.title === 'string' ? obj.title.trim() : '',
        description: typeof obj.description === 'string' ? obj.description.trim() : '',
        details: typeof obj.details === 'string' ? obj.details : '',
        testStrategy: typeof obj.testStrategy === 'string' ? obj.testStrategy : '',
      };
    });

    if (generated.some((g) => !g.title || !g.description)) {
      await this.approvePendingApproval(
        workerId,
        approval,
        false,
        'expand_commit subtasks must include non-empty title and description'
      );
      return;
    }

    // 执行展开操作
    await this.taskMasterCallbacks.expandSubtask(targetId, generated, {
      projectRoot: ref.projectRoot,
      file: ref.file,
      tag: ref.tag,
      force,
      strategy,
    });

    // 标记需要重规划
    this.taskMasterCallbacks.markPendingReplan();
    this.taskMasterCallbacks.addExpandedSubtask(approval.subtaskId);

    await this.approvePendingApproval(
      workerId,
      approval,
      true,
      `expand_commit applied: ${targetId} -> subtasks (strategy: ${strategy})`
    );
  }

  /**
   * 提取审批动作和输入
   */
  private extractApprovalActionAndInput(approval: PendingApprovalFile): {
    action: string | undefined;
    input: Record<string, unknown> | undefined;
    affectedFiles: string[];
  } {
    const meta = approval.details?.metadata as Record<string, unknown> | undefined;
    const action = meta && typeof meta.action === 'string' ? String(meta.action) : undefined;
    const inputRaw = (meta?.input ?? meta?.toolInput) as unknown;
    const input =
      inputRaw && typeof inputRaw === 'object'
        ? (inputRaw as Record<string, unknown>)
        : undefined;

    const filesRaw = approval.details?.affectedFiles;
    const affectedFiles = Array.isArray(filesRaw)
      ? filesRaw.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : [];

    // fallback：从输入推导 path
    if (affectedFiles.length === 0 && input && typeof input.path === 'string' && input.path.trim()) {
      affectedFiles.push(input.path.trim());
    }

    return { action, input, affectedFiles };
  }

  /**
   * 批准或拒绝审批请求
   */
  private async approvePendingApproval(
    workerId: string,
    approval: PendingApprovalFile,
    approved: boolean,
    reason: string
  ): Promise<void> {
    const response: ApprovalResponseFile = {
      requestId: approval.requestId,
      respondedAt: Date.now(),
      approved,
      respondedBy: 'orchestrator',
      reason,
    };

    await this.sessionManager.writeApprovalResponse(workerId, response);

    this.eventService.emit('approval:complete', approval.subtaskId, {
      requestId: approval.requestId,
      workerId,
      approved,
      reason,
    });
  }
}

/**
 * 创建审批仲裁服务实例
 */
export function createApprovalArbitrationService(options: {
  sessionManager: ISessionFileManager;
  eventService: IEventService;
  policy: ApprovalPolicy;
  taskMasterCallbacks?: TaskMasterCallbacks;
}): ApprovalArbitrationService {
  return new ApprovalArbitrationService(options);
}
