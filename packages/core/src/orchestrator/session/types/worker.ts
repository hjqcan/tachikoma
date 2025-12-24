/**
 * Worker 侧文件类型：status/thinking/actions/approval/intervention 等
 */

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
  | 'tool_call' // 工具调用
  | 'code_execution' // 代码执行
  | 'file_operation' // 文件操作
  | 'api_call' // API 调用
  | 'message'; // 消息发送

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
  | 'file_deletion' // 文件删除
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
  | 'redirect' // 重定向（修改目标）
  | 'pause' // 暂停
  | 'resume' // 恢复
  | 'abort' // 中止
  | 'guidance'; // 指导建议

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


