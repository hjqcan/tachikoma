/**
 * 共享文件系统协调机制类型定义
 *
 * 基于 PRD 3.3 Layer 2: 统筹与规划层
 * 定义 .tachikoma 目录结构与文件格式
 */

import type { PlannerOutput } from '../types';

// ============================================================================
// 会话目录结构
// ============================================================================

/**
 * 会话根目录结构
 *
 * .tachikoma/sessions/{session-id}/
 * ├── orchestrator/           # 统筹者状态
 * │   ├── plan.json           # 当前执行计划
 * │   ├── progress.json       # 进度状态
 * │   └── decisions.jsonl     # 决策日志
 * ├── workers/                # Worker 状态目录
 * │   └── {worker-id}/
 * │       ├── thinking.jsonl   # 思考过程日志
 * │       ├── actions.jsonl    # 行动日志
 * │       ├── status.json      # 当前状态
 * │       ├── pending_approval.json  # 待审批请求
 * │       ├── approval_response.json # 审批响应
 * │       ├── intervention.json      # 干预指令
 * │       └── artifacts/       # 产出物目录
 * └── shared/                 # 共享状态
 *     ├── context.json        # 共享上下文
 *     └── messages.jsonl      # 消息日志
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
}

/**
 * 默认会话配置
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  rootDir: '.tachikoma',
  autoCreateDirs: true,
  watchPollInterval: 500,
  enableWatch: true,
};

// ============================================================================
// Orchestrator 文件类型
// ============================================================================

/**
 * 计划文件内容 (plan.json)
 */
export interface PlanFile {
  /** 会话 ID */
  sessionId: string;
  /** 任务 ID */
  taskId: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 规划输出 */
  plannerOutput: PlannerOutput;
  /** 执行计划版本 */
  version: number;
}

/**
 * 进度文件内容 (progress.json)
 */
export interface ProgressFile {
  /** 会话 ID */
  sessionId: string;
  /** 任务 ID */
  taskId: string;
  /** 当前状态 */
  status: 'planning' | 'executing' | 'paused' | 'completed' | 'failed';
  /** 当前执行步骤 */
  currentStep: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 已完成子任务 ID 列表 */
  completedSubtasks: string[];
  /** 失败子任务 ID 列表 */
  failedSubtasks: string[];
  /** 进行中子任务 ID 列表 */
  runningSubtasks: string[];
  /** 开始时间 */
  startedAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 预估剩余时间（毫秒） */
  estimatedRemaining?: number;
}

/**
 * 决策类型
 */
export type DecisionType =
  | 'approval'           // 审批决策
  | 'intervention'       // 干预决策
  | 'retry'              // 重试决策
  | 'delegation_change'  // 委托变更
  | 'abort';             // 中止决策

/**
 * 决策记录 (decisions.jsonl 中的单条记录)
 */
export interface DecisionRecord {
  /** 记录 ID */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 决策类型 */
  type: DecisionType;
  /** 相关 Worker ID */
  workerId?: string;
  /** 相关子任务 ID */
  subtaskId?: string;
  /** 决策内容 */
  decision: {
    /** 是否批准/通过 */
    approved?: boolean;
    /** 原因说明 */
    reason: string;
    /** 附加指令 */
    instructions?: string;
  };
  /** 触发条件 */
  trigger?: {
    /** 触发来源 */
    source: 'worker_request' | 'periodic_check' | 'manual' | 'system';
    /** 原始请求内容 */
    requestContent?: string;
    /** 审批请求 ID（用于幂等追踪） */
    requestId?: string;
    /** 干预 ID（用于幂等追踪） */
    interventionId?: string;
  };
}

// ============================================================================
// Worker 文件类型
// ============================================================================

/**
 * Worker 状态文件内容 (status.json)
 */
export interface WorkerStatusFile {
  /** Worker ID */
  workerId: string;
  /** 当前状态 */
  status: 'idle' | 'thinking' | 'acting' | 'waiting_approval' | 'error';
  /** 当前子任务 */
  currentSubtask?: {
    id: string;
    objective: string;
    startedAt: number;
  };
  /** 进度（0-100） */
  progress: number;
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
    timestamp: number;
  };
}

/**
 * 思考记录 (thinking.jsonl 中的单条记录)
 */
export interface ThinkingRecord {
  /** 记录 ID */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 子任务 ID */
  subtaskId: string;
  /** 思考内容 */
  content: string;
  /** 思考阶段 */
  stage: 'analysis' | 'planning' | 'decision' | 'reflection';
  /** 置信度 (0-1) */
  confidence?: number;
  /** 相关工具 */
  relatedTools?: string[];
}

/**
 * 行动类型
 */
export type ActionType =
  | 'tool_call'      // 工具调用
  | 'code_execution' // 代码执行
  | 'file_operation' // 文件操作
  | 'api_call'       // API 调用
  | 'message';       // 消息发送

/**
 * 行动记录 (actions.jsonl 中的单条记录)
 */
export interface ActionRecord {
  /** 记录 ID */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 子任务 ID */
  subtaskId: string;
  /** 行动类型 */
  type: ActionType;
  /** 行动描述 */
  description: string;
  /** 行动参数 */
  params?: Record<string, unknown>;
  /** 行动结果 */
  result?: {
    success: boolean;
    output?: unknown;
    error?: string;
    duration: number;
  };
}

/**
 * 审批请求类型
 */
export type ApprovalRequestType =
  | 'file_deletion'     // 文件删除
  | 'multi_file_refactor' // 多文件重构
  | 'external_api_call' // 外部 API 调用
  | 'dangerous_operation' // 危险操作
  | 'resource_intensive'; // 资源密集型操作

/**
 * 待审批请求文件内容 (pending_approval.json)
 */
export interface PendingApprovalFile {
  /** 请求 ID */
  requestId: string;
  /** Worker ID */
  workerId: string;
  /** 子任务 ID */
  subtaskId: string;
  /** 请求时间 */
  requestedAt: number;
  /** 请求类型 */
  type: ApprovalRequestType;
  /** 请求描述 */
  description: string;
  /** 操作详情 */
  details: {
    /** 受影响的文件列表 */
    affectedFiles?: string[];
    /** 预估影响范围 */
    impactScope?: 'low' | 'medium' | 'high';
    /** 可逆性 */
    reversible?: boolean;
    /** 附加数据 */
    metadata?: Record<string, unknown>;
  };
  /** 超时时间（毫秒） */
  timeout: number;
  /** 默认决策（超时时使用） */
  defaultDecision: 'approve' | 'reject';
}

/**
 * 审批响应文件内容 (approval_response.json)
 */
export interface ApprovalResponseFile {
  /** 请求 ID（对应 pending_approval.json） */
  requestId: string;
  /** 响应时间 */
  respondedAt: number;
  /** 是否批准 */
  approved: boolean;
  /** 响应者 */
  respondedBy: 'orchestrator' | 'human';
  /** 原因说明 */
  reason?: string;
  /** 附加指令 */
  instructions?: string;
  /** 修改后的参数（如果需要调整） */
  modifiedParams?: Record<string, unknown>;
}

/**
 * 干预类型
 */
export type InterventionType =
  | 'redirect'   // 重定向（修改目标）
  | 'pause'      // 暂停
  | 'resume'     // 恢复
  | 'abort'      // 中止
  | 'guidance';  // 指导建议

/**
 * 干预指令文件内容 (intervention.json)
 */
export interface InterventionFile {
  /** 干预 ID */
  interventionId: string;
  /** 创建时间 */
  createdAt: number;
  /** 干预类型 */
  type: InterventionType;
  /** 干预原因 */
  reason: string;
  /** 检测到的问题 */
  detectedIssue?: {
    /** 问题类型 */
    type: 'deviation' | 'inefficiency' | 'error' | 'stuck';
    /** 问题描述 */
    description: string;
    /** 严重程度 */
    severity: 'low' | 'medium' | 'high' | 'critical';
  };
  /** 指令内容 */
  instructions: string;
  /** 建议的下一步 */
  suggestedNextSteps?: string[];
  /** 是否已确认 */
  acknowledged: boolean;
  /** 确认时间 */
  acknowledgedAt?: number;
}

// ============================================================================
// 共享文件类型
// ============================================================================

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
    data: Record<string, unknown>;
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

// ============================================================================
// 事件类型
// ============================================================================

/**
 * 文件监控事件类型
 */
export type SessionFileEventType =
  | 'pending_approval_created'    // 新的审批请求
  | 'pending_approval_removed'    // 审批请求已处理
  | 'worker_status_changed'       // Worker 状态变化
  | 'thinking_updated'            // 思考日志更新
  | 'action_completed'            // 行动完成
  | 'intervention_created'        // 干预指令创建
  | 'intervention_acknowledged'   // 干预已确认
  | 'progress_updated';           // 进度更新

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
export type SessionFileEventHandler<T = unknown> = (
  event: SessionFileEvent<T>
) => void | Promise<void>;

// ============================================================================
// SessionFileManager 接口
// ============================================================================

/**
 * SessionFileManager 接口
 */
// ============================================================================
// 检查点管理类型
// ============================================================================

/**
 * 检查点存储数据
 *
 * 持久化到 orchestrator/checkpoint.json
 */
export interface CheckpointData {
  /** 检查点 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 任务 ID */
  taskId: string;
  /** 检查点版本 */
  version: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 计划状态 */
  planStatus: 'planning' | 'executing' | 'paused' | 'completed' | 'failed';
  /** 当前执行步骤 */
  currentStep: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 已完成子任务 ID 列表 */
  completedSubtaskIds: string[];
  /** 失败子任务 ID 列表 */
  failedSubtaskIds: string[];
  /** 进行中子任务 ID 列表 */
  runningSubtaskIds: string[];
  /** 子任务状态快照 */
  subtaskSnapshots: SubtaskSnapshot[];
  /** 已完成的子任务结果 */
  completedResults: Record<string, unknown>;
  /** 累计重试次数 */
  totalRetries: number;
  /** 累计 Token 使用量 */
  totalTokens: number;
  /** 执行计划（用于 restart-step 策略） */
  executionPlan?: {
    steps: {
      order: number;
      subtaskIds: string[];
      parallel: boolean;
    }[];
  };
  /** 上下文数据 */
  contextData?: Record<string, unknown>;
  /** Git 提交点（可选） */
  gitCommit?: string;
}

/**
 * 子任务快照
 */
export interface SubtaskSnapshot {
  /** 子任务 ID */
  id: string;
  /** 状态 */
  status: 'pending' | 'assigned' | 'running' | 'success' | 'failure' | 'retrying' | 'cancelled';
  /** 分配的 Worker ID */
  assignedWorkerId?: string | undefined;
  /** 进度 (0-100) */
  progress: number;
  /** 重试次数 */
  retryCount: number;
  /** 最后更新时间 */
  lastUpdatedAt: number;
}

/**
 * Worker 状态快照
 */
export interface WorkerSnapshot {
  /** Worker ID */
  workerId: string;
  /** Worker 状态 */
  status: 'idle' | 'thinking' | 'acting' | 'waiting_approval' | 'error';
  /** 当前子任务 */
  currentSubtask?: {
    id: string;
    objective: string;
    startedAt: number;
  } | undefined;
  /** 进度 (0-100) */
  progress: number;
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 错误信息 */
  error?: {
    code: string;
    message: string;
    timestamp: number;
  } | undefined;
}

/**
 * 恢复策略
 */
export type RecoveryStrategy =
  | 'resume'           // 从最后成功的子任务继续
  | 'retry-failed'     // 重试失败的子任务
  | 'restart-step'     // 重新开始当前步骤
  | 'restart-all';     // 完全重新开始

/**
 * 检查点恢复选项
 */
export interface CheckpointRestoreOptions {
  /** 恢复策略 */
  strategy: RecoveryStrategy;
  /** 是否跳过失败的子任务 */
  skipFailed?: boolean;
  /** 是否重置重试计数 */
  resetRetryCount?: boolean;
  /** 最大重试次数限制（用于 retry-failed 策略） */
  maxRetries?: number;
}

/**
 * 检查点恢复结果
 */
export interface CheckpointRestoreResult {
  /** 是否成功 */
  success: boolean;
  /** 错误消息 */
  error?: string;
  /** 恢复的检查点数据 */
  checkpoint?: CheckpointData;
  /** 恢复的 Worker 状态 */
  workerSnapshots?: WorkerSnapshot[];
  /** 恢复的规划数据 */
  planData?: PlanFile | null;
  /** 恢复的进度数据 */
  progressData?: ProgressFile | null;
  /** 建议的恢复策略 */
  suggestedStrategy?: RecoveryStrategy;
  /** 实际应用的恢复策略 */
  appliedStrategy?: RecoveryStrategy;
  /** 可恢复的子任务 ID 列表（从这些开始执行） */
  resumableSubtaskIds?: string[];
  /** Git 校验警告（代码版本与检查点不一致时） */
  gitWarning?: string;
}

/**
 * 检查点管理器配置
 */
export interface CheckpointManagerConfig {
  /** 会话根目录 */
  rootDir: string;
  /** 是否启用自动保存 */
  autoSave: boolean;
  /** 自动保存间隔（毫秒） */
  autoSaveInterval: number;
  /** 最大保留检查点数 */
  maxCheckpoints: number;
  /** 是否启用 Git 集成 */
  enableGitIntegration: boolean;
  /** 是否启用压缩（gzip） */
  enableCompression: boolean;
  /** 恢复时是否校验 Git 提交 */
  validateGitOnRestore: boolean;
  /** 自动保存失败最大重试次数 */
  autoSaveMaxRetries: number;
}

/**
 * 默认检查点管理器配置
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointManagerConfig = {
  rootDir: '.tachikoma',
  autoSave: false,
  autoSaveInterval: 30000, // 30 秒
  maxCheckpoints: 5,
  enableGitIntegration: false,
  enableCompression: false,
  validateGitOnRestore: false,
  autoSaveMaxRetries: 3,
};

/**
 * CheckpointManager 接口
 */
export interface ICheckpointManager {
  /** 会话 ID */
  readonly sessionId: string;

  /** 配置 */
  readonly config: CheckpointManagerConfig;

  // === 检查点操作 ===

  /**
   * 保存检查点
   * @param data - 要保存的检查点数据（部分字段自动生成）
   */
  saveCheckpoint(data: Omit<CheckpointData, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'version'>): Promise<CheckpointData>;

  /**
   * 读取最新检查点
   */
  loadCheckpoint(): Promise<CheckpointData | null>;

  /**
   * 读取指定检查点
   * @param checkpointId - 检查点 ID
   */
  loadCheckpointById(checkpointId: string): Promise<CheckpointData | null>;

  /**
   * 列出所有检查点
   */
  listCheckpoints(): Promise<CheckpointData[]>;

  /**
   * 删除检查点
   * @param checkpointId - 检查点 ID
   */
  deleteCheckpoint(checkpointId: string): Promise<boolean>;

  /**
   * 清理旧检查点（保留最新的 maxCheckpoints 个）
   */
  cleanupOldCheckpoints(): Promise<number>;

  // === 恢复操作 ===

  /**
   * 从检查点恢复
   * @param options - 恢复选项
   */
  restore(options?: Partial<CheckpointRestoreOptions>): Promise<CheckpointRestoreResult>;

  /**
   * 从指定检查点恢复
   * @param checkpointId - 检查点 ID
   * @param options - 恢复选项
   */
  restoreFromCheckpoint(checkpointId: string, options?: Partial<CheckpointRestoreOptions>): Promise<CheckpointRestoreResult>;

  /**
   * 分析恢复策略
   *
   * 根据检查点状态和 Worker 状态，建议最佳恢复策略
   */
  analyzeRecoveryStrategy(checkpoint: CheckpointData): Promise<{
    suggestedStrategy: RecoveryStrategy;
    reason: string;
    resumableSubtaskIds: string[];
    failedSubtaskIds: string[];
  }>;

  // === Worker 状态收集 ===

  /**
   * 收集所有 Worker 状态快照
   */
  collectWorkerSnapshots(): Promise<WorkerSnapshot[]>;

  /**
   * 收集指定 Worker 状态
   * @param workerId - Worker ID
   */
  getWorkerSnapshot(workerId: string): Promise<WorkerSnapshot | null>;

  // === Git 集成（可选） ===

  /**
   * 获取当前 Git 提交点
   */
  getCurrentGitCommit(): Promise<string | null>;

  /**
   * 创建 Git 检查点（tag 或 commit）
   * @param message - 提交/标签消息
   */
  createGitCheckpoint(message: string): Promise<string | null>;

  // === 生命周期 ===

  /**
   * 启动自动保存（如果启用）
   */
  startAutoSave(): void;

  /**
   * 停止自动保存
   */
  stopAutoSave(): void;

  /**
   * 关闭管理器
   */
  close(): Promise<void>;
}

// ============================================================================
// SessionFileManager 接口
// ============================================================================

export interface ISessionFileManager {
  /** 会话 ID */
  readonly sessionId: string;

  /** 配置 */
  readonly config: SessionConfig;

  // === 目录管理 ===

  /**
   * 初始化会话目录结构
   */
  initializeSession(): Promise<void>;

  /**
   * 注册 Worker 目录
   * @param workerId - Worker ID
   */
  registerWorker(workerId: string): Promise<void>;

  /**
   * 获取会话根目录路径
   */
  getSessionPath(): string;

  /**
   * 获取 Worker 目录路径
   * @param workerId - Worker ID
   */
  getWorkerPath(workerId: string): string;

  // === Orchestrator 文件操作 ===

  /**
   * 写入计划文件
   * @param plan - 计划内容
   */
  writePlan(plan: Omit<PlanFile, 'sessionId' | 'updatedAt'>): Promise<void>;

  /**
   * 读取计划文件
   */
  readPlan(): Promise<PlanFile | null>;

  /**
   * 更新进度文件
   * @param progress - 进度内容
   */
  writeProgress(progress: Omit<ProgressFile, 'sessionId' | 'updatedAt'>): Promise<void>;

  /**
   * 读取进度文件
   */
  readProgress(): Promise<ProgressFile | null>;

  /**
   * 追加决策记录
   * @param decision - 决策记录
   */
  appendDecision(decision: Omit<DecisionRecord, 'id' | 'timestamp'>): Promise<void>;

  /**
   * 读取决策日志
   * @param limit - 最大条数
   */
  readDecisions(limit?: number): Promise<DecisionRecord[]>;

  // === Worker 文件操作 ===

  /**
   * 读取 Worker 状态
   * @param workerId - Worker ID
   */
  readWorkerStatus(workerId: string): Promise<WorkerStatusFile | null>;

  /**
   * 写入 Worker 状态
   * @param workerId - Worker ID
   * @param status - 状态内容
   */
  writeWorkerStatus(workerId: string, status: Omit<WorkerStatusFile, 'workerId'>): Promise<void>;

  /**
   * 读取待审批请求
   * @param workerId - Worker ID
   */
  readPendingApproval(workerId: string): Promise<PendingApprovalFile | null>;

  /**
   * 写入审批响应
   * @param workerId - Worker ID
   * @param response - 响应内容
   */
  writeApprovalResponse(workerId: string, response: ApprovalResponseFile): Promise<void>;

  /**
   * 读取审批响应
   * @param workerId - Worker ID
   */
  readApprovalResponse(workerId: string): Promise<ApprovalResponseFile | null>;

  /**
   * 写入干预指令
   * @param workerId - Worker ID
   * @param intervention - 干预内容
   */
  writeIntervention(workerId: string, intervention: Omit<InterventionFile, 'interventionId' | 'createdAt' | 'acknowledged'>): Promise<void>;

  /**
   * 读取干预指令
   * @param workerId - Worker ID
   */
  readIntervention(workerId: string): Promise<InterventionFile | null>;

  /**
   * 读取 Worker 思考日志
   * @param workerId - Worker ID
   * @param limit - 最大条数（从尾部读取）
   */
  readThinkingLogs(workerId: string, limit?: number): Promise<ThinkingRecord[]>;

  /**
   * 读取 Worker 行动日志
   * @param workerId - Worker ID
   * @param limit - 最大条数（从尾部读取）
   */
  readActionLogs(workerId: string, limit?: number): Promise<ActionRecord[]>;

  /**
   * 追加 Worker 思考记录
   * @param workerId - Worker ID
   * @param record - 思考记录（不含 id）
   */
  appendThinking(workerId: string, record: Omit<ThinkingRecord, 'id'>): Promise<void>;

  /**
   * 追加 Worker 行动记录
   * @param workerId - Worker ID
   * @param record - 行动记录（不含 id）
   */
  appendAction(workerId: string, record: Omit<ActionRecord, 'id'>): Promise<void>;

  /**
   * 写入待审批请求文件
   * @param workerId - Worker ID
   * @param approval - 待审批请求
   */
  writePendingApproval(workerId: string, approval: PendingApprovalFile): Promise<void>;

  // === 共享文件操作 ===

  /**
   * 读取共享上下文
   */
  readSharedContext(): Promise<SharedContextFile | null>;

  /**
   * 更新共享上下文
   * @param context - 上下文内容
   */
  writeSharedContext(context: Omit<SharedContextFile, 'sessionId'>): Promise<void>;

  /**
   * 追加消息记录
   * @param message - 消息内容
   */
  appendMessage(message: Omit<MessageRecord, 'id' | 'timestamp'>): Promise<void>;

  /**
   * 读取消息日志
   * @param limit - 最大条数
   */
  readMessages(limit?: number): Promise<MessageRecord[]>;

  // === 事件监控 ===

  /**
   * 添加事件监听器
   * @param type - 事件类型
   * @param handler - 事件处理器
   */
  on<T = unknown>(type: SessionFileEventType, handler: SessionFileEventHandler<T>): void;

  /**
   * 移除事件监听器
   * @param type - 事件类型
   * @param handler - 事件处理器
   */
  off<T = unknown>(type: SessionFileEventType, handler: SessionFileEventHandler<T>): void;

  /**
   * 启动文件监控
   */
  startWatching(): Promise<void>;

  /**
   * 停止文件监控
   */
  stopWatching(): void;

  // === 生命周期 ===

  /**
   * 清理会话目录
   */
  cleanup(): Promise<void>;

  /**
   * 关闭 SessionFileManager
   */
  close(): Promise<void>;
}

