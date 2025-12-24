/**
 * Orchestrator 侧文件类型：runtime/progress/decisions 等
 */

import type { ExecutionPlan, PlannerRole } from '../../types';
import type { TaskStatus as TaskMasterTaskStatus } from '../../../taskmaster-compat/types';

// ============================================================================
// Orchestrator 文件类型
// ============================================================================

/**
 * 运行时文件内容 (runtime.json) - Task Master tasks.json-only 脱敏格式
 *
 * 约束：runtime.json 不落盘任务描述文本；任务描述/依赖/状态以 tasks.json 为唯一真相。
 */
export interface TaskMasterRuntimeFile {
  kind: 'taskmaster';
  sessionId: string;
  taskId: string;
  createdAt: number;
  updatedAt: number;
  version: number;

  /** tasks.json 引用（相对 projectRoot 或绝对路径，取决于写入方） */
  tasksJson: {
    path: string;
    tag: string;
  };

  /** 执行顺序（仅包含 id，不包含 objective/constraints 等描述文本） */
  executionPlan: ExecutionPlan;

  /** roles 定义（非任务描述，可落盘） */
  roles?: PlannerRole[];

  /**
   * 任务/子任务到 role 的映射（仅 id 引用）
   * key: "1" 或 "1.2"
   */
  roleAssignments?: Record<
    string,
    {
      roleId?: string;
      requiredCapabilities?: string[];
    }
  >;

  /**
   * failure 不回写 tasks.json 的前提下，用于在 session 内保留“原始 status”以便失败回滚
   * key: "1" 或 "1.2"
   */
  originalStatuses?: Record<string, TaskMasterTaskStatus>;
}

/** 当前仅支持脱敏 runtime 格式（tasks.json 为唯一任务真相） */
export type RuntimeFile = TaskMasterRuntimeFile;

/**
 * Distributive Omit（用于 union 类型：避免 keyof 收缩导致字段丢失）
 *
 * 说明：`Omit<A | B, K>` 会先计算 `keyof (A | B)`（只保留公共 key），导致 A/B 的专有字段被抹掉。
 * 这里通过条件类型让 Omit 对 union 分发。
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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
  | 'approval' // 审批决策
  | 'intervention' // 干预决策
  | 'retry' // 重试决策
  | 'delegation_change' // 委托变更
  | 'abort'; // 中止决策

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


