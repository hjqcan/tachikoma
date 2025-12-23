/**
 * Worker 文件协议契约测试
 *
 * 验证 Orchestrator 与 Task 5 Worker 之间的文件格式兼容性
 * 确保两端对共享文件结构有一致的理解
 */

import { describe, it, expect } from 'bun:test';
import type {
  // Worker 文件类型
  WorkerStatusFile,
  ThinkingRecord,
  ActionRecord,
  PendingApprovalFile,
  ApprovalResponseFile,
  InterventionFile,
  // 共享类型
  SharedContextFile,
  MessageRecord,
  DecisionRecord,
  // 计划类型
  RuntimeFile,
  ProgressFile,
} from '../src/orchestrator/session/types';

// ============================================================================
// 测试数据工厂
// ============================================================================

/**
 * 创建有效的 Worker 状态文件
 */
function createValidWorkerStatus(): WorkerStatusFile {
  return {
    workerId: 'worker-001',
    status: 'thinking',
    currentSubtask: {
      id: 'subtask-001',
      objective: '实现用户认证模块',
      startedAt: Date.now(),
    },
    progress: 45,
    lastHeartbeat: Date.now(),
  };
}

/**
 * 创建有效的思考记录
 */
function createValidThinkingRecord(): ThinkingRecord {
  return {
    id: 'think-001',
    timestamp: Date.now(),
    subtaskId: 'subtask-001',
    content: '分析任务需求，考虑使用 JWT 进行认证...',
    stage: 'analysis',
    confidence: 0.85,
    relatedTools: ['file_write', 'code_execute'],
  };
}

/**
 * 创建有效的行动记录
 */
function createValidActionRecord(): ActionRecord {
  return {
    id: 'action-001',
    timestamp: Date.now(),
    subtaskId: 'subtask-001',
    type: 'file_operation',
    description: '创建 auth.ts 文件',
    params: {
      path: 'src/auth.ts',
      content: 'export class AuthService {}',
    },
    result: {
      success: true,
      output: 'File created successfully',
      duration: 150,
    },
  };
}

/**
 * 创建有效的待审批请求
 */
function createValidPendingApproval(): PendingApprovalFile {
  return {
    requestId: 'approval-001',
    workerId: 'worker-001',
    subtaskId: 'subtask-001',
    requestedAt: Date.now(),
    type: 'file_deletion',
    description: '删除旧的配置文件',
    details: {
      affectedFiles: ['config/old.json', 'config/deprecated.yaml'],
      impactScope: 'low',
      reversible: true,
      metadata: { reason: 'cleanup' },
    },
    timeout: 30000,
    defaultDecision: 'approve',
  };
}

/**
 * 创建有效的审批响应
 */
function createValidApprovalResponse(): ApprovalResponseFile {
  return {
    requestId: 'approval-001',
    respondedAt: Date.now(),
    approved: true,
    respondedBy: 'orchestrator',
    reason: 'Low impact operation auto-approved',
  };
}

/**
 * 创建有效的干预指令
 */
function createValidIntervention(): InterventionFile {
  return {
    interventionId: 'intervention-001',
    createdAt: Date.now(),
    type: 'guidance',
    reason: '检测到思路偏离任务目标',
    detectedIssue: {
      type: 'deviation',
      description: 'Worker 正在处理与任务无关的文件',
      severity: 'medium',
    },
    instructions: '请回到用户认证模块的实现',
    suggestedNextSteps: [
      '检查 auth.ts 文件结构',
      '实现 JWT 验证逻辑',
    ],
    acknowledged: false,
  };
}

// ============================================================================
// 契约测试：Worker 状态文件
// ============================================================================

describe('Worker 文件协议契约', () => {
  describe('WorkerStatusFile', () => {
    it('应包含必需字段', () => {
      const status = createValidWorkerStatus();

      expect(status.workerId).toBeDefined();
      expect(status.status).toBeDefined();
      expect(status.progress).toBeDefined();
      expect(status.lastHeartbeat).toBeDefined();
    });

    it('状态值应是有效的枚举', () => {
      const validStatuses = ['idle', 'thinking', 'acting', 'waiting_approval', 'error'];
      const status = createValidWorkerStatus();

      expect(validStatuses).toContain(status.status);
    });

    it('进度值应在 0-100 之间', () => {
      const status = createValidWorkerStatus();

      expect(status.progress).toBeGreaterThanOrEqual(0);
      expect(status.progress).toBeLessThanOrEqual(100);
    });

    it('currentSubtask 应为可选字段', () => {
      const status: WorkerStatusFile = {
        workerId: 'worker-001',
        status: 'idle',
        progress: 0,
        lastHeartbeat: Date.now(),
      };

      expect(status.currentSubtask).toBeUndefined();
    });

    it('error 应为可选字段', () => {
      const statusWithError: WorkerStatusFile = {
        workerId: 'worker-001',
        status: 'error',
        progress: 50,
        lastHeartbeat: Date.now(),
        error: {
          code: 'TIMEOUT',
          message: 'Operation timed out',
          timestamp: Date.now(),
        },
      };

      expect(statusWithError.error).toBeDefined();
      expect(statusWithError.error?.code).toBe('TIMEOUT');
    });
  });

  // ==========================================================================
  // 契约测试：思考记录
  // ==========================================================================

  describe('ThinkingRecord', () => {
    it('应包含必需字段', () => {
      const record = createValidThinkingRecord();

      expect(record.id).toBeDefined();
      expect(record.timestamp).toBeDefined();
      expect(record.subtaskId).toBeDefined();
      expect(record.content).toBeDefined();
      expect(record.stage).toBeDefined();
    });

    it('stage 值应是有效的枚举', () => {
      const validStages = ['analysis', 'planning', 'decision', 'reflection'];
      const record = createValidThinkingRecord();

      expect(validStages).toContain(record.stage);
    });

    it('confidence 应在 0-1 之间（如果提供）', () => {
      const record = createValidThinkingRecord();

      if (record.confidence !== undefined) {
        expect(record.confidence).toBeGreaterThanOrEqual(0);
        expect(record.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ==========================================================================
  // 契约测试：行动记录
  // ==========================================================================

  describe('ActionRecord', () => {
    it('应包含必需字段', () => {
      const record = createValidActionRecord();

      expect(record.id).toBeDefined();
      expect(record.timestamp).toBeDefined();
      expect(record.subtaskId).toBeDefined();
      expect(record.type).toBeDefined();
      expect(record.description).toBeDefined();
    });

    it('type 值应是有效的枚举', () => {
      const validTypes = ['tool_call', 'code_execution', 'file_operation', 'api_call', 'message'];
      const record = createValidActionRecord();

      expect(validTypes).toContain(record.type);
    });

    it('result.success 应为布尔值', () => {
      const record = createValidActionRecord();

      if (record.result) {
        expect(typeof record.result.success).toBe('boolean');
        expect(typeof record.result.duration).toBe('number');
      }
    });
  });

  // ==========================================================================
  // 契约测试：审批请求
  // ==========================================================================

  describe('PendingApprovalFile', () => {
    it('应包含必需字段', () => {
      const approval = createValidPendingApproval();

      expect(approval.requestId).toBeDefined();
      expect(approval.workerId).toBeDefined();
      expect(approval.subtaskId).toBeDefined();
      expect(approval.requestedAt).toBeDefined();
      expect(approval.type).toBeDefined();
      expect(approval.description).toBeDefined();
      expect(approval.details).toBeDefined();
      expect(approval.timeout).toBeDefined();
      expect(approval.defaultDecision).toBeDefined();
    });

    it('type 值应是有效的审批请求类型', () => {
      const validTypes = [
        'file_deletion',
        'multi_file_refactor',
        'external_api_call',
        'dangerous_operation',
        'resource_intensive',
      ];
      const approval = createValidPendingApproval();

      expect(validTypes).toContain(approval.type);
    });

    it('defaultDecision 应是 approve 或 reject', () => {
      const approval = createValidPendingApproval();

      expect(['approve', 'reject']).toContain(approval.defaultDecision);
    });

    it('details.impactScope 应是有效的枚举', () => {
      const approval = createValidPendingApproval();

      if (approval.details.impactScope) {
        expect(['low', 'medium', 'high']).toContain(approval.details.impactScope);
      }
    });
  });

  // ==========================================================================
  // 契约测试：审批响应
  // ==========================================================================

  describe('ApprovalResponseFile', () => {
    it('应包含必需字段', () => {
      const response = createValidApprovalResponse();

      expect(response.requestId).toBeDefined();
      expect(response.respondedAt).toBeDefined();
      expect(typeof response.approved).toBe('boolean');
      expect(response.respondedBy).toBeDefined();
    });

    it('requestId 应与 PendingApprovalFile 对应', () => {
      const approval = createValidPendingApproval();
      const response = createValidApprovalResponse();

      // 模拟匹配
      response.requestId = approval.requestId;
      expect(response.requestId).toBe(approval.requestId);
    });

    it('respondedBy 应是 orchestrator 或 human', () => {
      const response = createValidApprovalResponse();

      expect(['orchestrator', 'human']).toContain(response.respondedBy);
    });
  });

  // ==========================================================================
  // 契约测试：干预指令
  // ==========================================================================

  describe('InterventionFile', () => {
    it('应包含必需字段', () => {
      const intervention = createValidIntervention();

      expect(intervention.interventionId).toBeDefined();
      expect(intervention.createdAt).toBeDefined();
      expect(intervention.type).toBeDefined();
      expect(intervention.reason).toBeDefined();
      expect(intervention.instructions).toBeDefined();
      expect(typeof intervention.acknowledged).toBe('boolean');
    });

    it('type 值应是有效的干预类型', () => {
      const validTypes = ['redirect', 'pause', 'resume', 'abort', 'guidance'];
      const intervention = createValidIntervention();

      expect(validTypes).toContain(intervention.type);
    });

    it('detectedIssue.severity 应是有效的枚举', () => {
      const intervention = createValidIntervention();

      if (intervention.detectedIssue) {
        expect(['low', 'medium', 'high', 'critical']).toContain(
          intervention.detectedIssue.severity
        );
      }
    });

    it('acknowledged 初始应为 false', () => {
      const intervention = createValidIntervention();

      expect(intervention.acknowledged).toBe(false);
      expect(intervention.acknowledgedAt).toBeUndefined();
    });
  });

  // ==========================================================================
  // 契约测试：序列化兼容性
  // ==========================================================================

  describe('JSON 序列化兼容性', () => {
    it('WorkerStatusFile 应正确序列化和反序列化', () => {
      const original = createValidWorkerStatus();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as WorkerStatusFile;

      expect(parsed.workerId).toBe(original.workerId);
      expect(parsed.status).toBe(original.status);
      expect(parsed.progress).toBe(original.progress);
    });

    it('PendingApprovalFile 应正确序列化和反序列化', () => {
      const original = createValidPendingApproval();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as PendingApprovalFile;

      expect(parsed.requestId).toBe(original.requestId);
      expect(parsed.type).toBe(original.type);
      expect(parsed.details.affectedFiles).toEqual(original.details.affectedFiles);
    });

    it('InterventionFile 应正确序列化和反序列化', () => {
      const original = createValidIntervention();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as InterventionFile;

      expect(parsed.interventionId).toBe(original.interventionId);
      expect(parsed.type).toBe(original.type);
      expect(parsed.acknowledged).toBe(original.acknowledged);
    });
  });
});

// ============================================================================
// 契约测试：共享文件类型
// ============================================================================

describe('共享文件协议契约', () => {
  // ==========================================================================
  // 测试数据工厂
  // ==========================================================================

  /**
   * 创建有效的共享上下文文件
   */
  function createValidSharedContext(): SharedContextFile {
    return {
      sessionId: 'session-001',
      objective: '实现用户认证模块',
      constraints: ['使用 JWT', '支持 OAuth2', '安全存储密码'],
      sharedKnowledge: {
        data: {
          selectedFramework: 'express',
          dbType: 'postgresql',
          authStrategy: 'jwt-with-refresh',
        },
        updatedAt: Date.now(),
      },
      workspace: {
        rootPath: '/project/src',
        keyFiles: ['auth.ts', 'middleware/auth.ts', 'routes/login.ts'],
      },
    };
  }

  /**
   * 创建有效的消息记录
   */
  function createValidMessage(): MessageRecord {
    return {
      id: 'msg-001',
      timestamp: Date.now(),
      senderId: 'orchestrator-001',
      receiverId: 'worker-001',
      direction: 'orchestrator_to_worker',
      type: 'task_assignment',
      content: {
        subtaskId: 'subtask-001',
        objective: '实现 JWT 签发逻辑',
        constraints: ['使用 RS256 算法'],
      },
      subtaskId: 'subtask-001',
    };
  }

  /**
   * 创建有效的运行时文件
   */
  function createValidRuntime(): RuntimeFile {
    return {
      kind: 'tachikoma',
      sessionId: 'session-001',
      taskId: 'task-001',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      plannerOutput: {
        taskId: 'task-001',
        subtasks: [
          {
            id: 'subtask-1',
            parentId: 'task-001',
            objective: '设计数据库模型',
            constraints: [],
            status: 'pending',
          },
          {
            id: 'subtask-2',
            parentId: 'task-001',
            objective: '实现 API 接口',
            constraints: [],
            status: 'pending',
          },
        ],
        delegation: {
          mode: 'communication',
          workerCount: 2,
          timeout: 300000,
          retryPolicy: {
            maxRetries: 3,
            baseDelay: 1000,
            backoffFactor: 2,
          },
        },
        executionPlan: {
          isParallel: false,
          steps: [
            { order: 1, subtaskIds: ['subtask-1'], parallel: false },
            { order: 2, subtaskIds: ['subtask-2'], parallel: false },
          ],
        },
      },
      version: 1,
    };
  }

  /**
   * 创建有效的进度文件
   */
  function createValidProgress(): ProgressFile {
    return {
      sessionId: 'session-001',
      taskId: 'task-001',
      status: 'executing',
      currentStep: 1,
      totalSteps: 3,
      completedSubtasks: ['subtask-1'],
      failedSubtasks: [],
      runningSubtasks: ['subtask-2'],
      startedAt: Date.now() - 60000,
      updatedAt: Date.now(),
      estimatedRemaining: 120000,
    };
  }

  /**
   * 创建有效的决策记录
   */
  function createValidDecision(): DecisionRecord {
    return {
      id: 'decision-001',
      timestamp: Date.now(),
      type: 'approval',
      workerId: 'worker-001',
      subtaskId: 'subtask-001',
      decision: {
        approved: true,
        reason: '低影响操作，自动批准',
        instructions: '继续执行',
      },
      trigger: {
        source: 'worker_request',
        requestContent: '删除临时文件',
        requestId: 'req-001',
      },
    };
  }

  // ==========================================================================
  // 契约测试：SharedContextFile
  // ==========================================================================

  describe('SharedContextFile', () => {
    it('应包含必需字段', () => {
      const context = createValidSharedContext();

      expect(context.sessionId).toBeDefined();
      expect(context.objective).toBeDefined();
      expect(context.constraints).toBeInstanceOf(Array);
      expect(context.sharedKnowledge).toBeDefined();
      expect(context.sharedKnowledge.data).toBeDefined();
      expect(context.sharedKnowledge.updatedAt).toBeDefined();
    });

    it('workspace 应为可选字段', () => {
      const context: SharedContextFile = {
        sessionId: 'session-001',
        objective: '测试目标',
        constraints: [],
        sharedKnowledge: {
          data: {},
          updatedAt: Date.now(),
        },
      };

      expect(context.workspace).toBeUndefined();
    });

    it('workspace 应包含正确结构', () => {
      const context = createValidSharedContext();

      if (context.workspace) {
        expect(context.workspace.rootPath).toBeDefined();
        expect(context.workspace.keyFiles).toBeInstanceOf(Array);
      }
    });

    it('sharedKnowledge.data 应支持任意键值对', () => {
      const context = createValidSharedContext();

      expect(typeof context.sharedKnowledge.data).toBe('object');
      expect(context.sharedKnowledge.data.selectedFramework).toBe('express');
    });
  });

  // ==========================================================================
  // 契约测试：MessageRecord
  // ==========================================================================

  describe('MessageRecord', () => {
    it('应包含必需字段', () => {
      const message = createValidMessage();

      expect(message.id).toBeDefined();
      expect(message.timestamp).toBeDefined();
      expect(message.senderId).toBeDefined();
      expect(message.receiverId).toBeDefined();
      expect(message.direction).toBeDefined();
      expect(message.type).toBeDefined();
      expect(message.content).toBeDefined();
    });

    it('direction 值应是有效的枚举', () => {
      const validDirections = [
        'orchestrator_to_worker',
        'worker_to_orchestrator',
        'worker_to_worker',
      ];
      const message = createValidMessage();

      expect(validDirections).toContain(message.direction);
    });

    it('type 值应是有效的枚举', () => {
      const validTypes = [
        'task_assignment',
        'progress_update',
        'result',
        'query',
        'response',
      ];
      const message = createValidMessage();

      expect(validTypes).toContain(message.type);
    });

    it('subtaskId 应为可选字段', () => {
      const message: MessageRecord = {
        id: 'msg-001',
        timestamp: Date.now(),
        senderId: 'orchestrator',
        receiverId: 'worker-001',
        direction: 'orchestrator_to_worker',
        type: 'query',
        content: { question: 'status?' },
      };

      expect(message.subtaskId).toBeUndefined();
    });

    it('content 应支持任意类型', () => {
      const message = createValidMessage();

      expect(message.content).toBeDefined();
      expect(typeof message.content).toBe('object');
    });
  });

  // ==========================================================================
  // 契约测试：RuntimeFile
  // ==========================================================================

  describe('RuntimeFile', () => {
    it('应包含必需字段', () => {
      const runtime = createValidRuntime();

      expect(runtime.sessionId).toBeDefined();
      expect(runtime.taskId).toBeDefined();
      expect(runtime.createdAt).toBeDefined();
      expect(runtime.updatedAt).toBeDefined();
      expect('plannerOutput' in runtime ? runtime.plannerOutput : undefined).toBeDefined();
      expect(runtime.version).toBeDefined();
    });

    it('plannerOutput 应包含必需结构', () => {
      const runtime = createValidRuntime();
      expect('plannerOutput' in runtime).toBe(true);
      if (!('plannerOutput' in runtime)) return;

      expect(runtime.plannerOutput.taskId).toBeDefined();
      expect(runtime.plannerOutput.subtasks).toBeInstanceOf(Array);
      expect(runtime.plannerOutput.delegation).toBeDefined();
      expect(runtime.plannerOutput.executionPlan).toBeDefined();
    });

    it('delegation 应包含正确配置', () => {
      const runtime = createValidRuntime();
      expect('plannerOutput' in runtime).toBe(true);
      if (!('plannerOutput' in runtime)) return;
      const delegation = runtime.plannerOutput.delegation;

      expect(['communication', 'shared-memory']).toContain(delegation.mode);
      expect(delegation.workerCount).toBeGreaterThan(0);
      expect(delegation.timeout).toBeGreaterThan(0);
      expect(delegation.retryPolicy).toBeDefined();
    });

    it('executionPlan.steps 应包含正确结构', () => {
      const runtime = createValidRuntime();
      expect('plannerOutput' in runtime).toBe(true);
      if (!('plannerOutput' in runtime)) return;
      const steps = runtime.plannerOutput.executionPlan.steps;

      expect(steps).toBeInstanceOf(Array);
      for (const step of steps) {
        expect(step.order).toBeDefined();
        expect(step.subtaskIds).toBeInstanceOf(Array);
        expect(typeof step.parallel).toBe('boolean');
      }
    });

    it('version 应为正整数', () => {
      const runtime = createValidRuntime();

      expect(runtime.version).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(runtime.version)).toBe(true);
    });
  });

  // ==========================================================================
  // 契约测试：ProgressFile
  // ==========================================================================

  describe('ProgressFile', () => {
    it('应包含必需字段', () => {
      const progress = createValidProgress();

      expect(progress.sessionId).toBeDefined();
      expect(progress.taskId).toBeDefined();
      expect(progress.status).toBeDefined();
      expect(progress.currentStep).toBeDefined();
      expect(progress.totalSteps).toBeDefined();
      expect(progress.completedSubtasks).toBeInstanceOf(Array);
      expect(progress.failedSubtasks).toBeInstanceOf(Array);
      expect(progress.runningSubtasks).toBeInstanceOf(Array);
      expect(progress.startedAt).toBeDefined();
      expect(progress.updatedAt).toBeDefined();
    });

    it('status 值应是有效的枚举', () => {
      const validStatuses = ['planning', 'executing', 'paused', 'completed', 'failed'];
      const progress = createValidProgress();

      expect(validStatuses).toContain(progress.status);
    });

    it('currentStep 应小于等于 totalSteps', () => {
      const progress = createValidProgress();

      expect(progress.currentStep).toBeLessThanOrEqual(progress.totalSteps);
    });

    it('estimatedRemaining 应为可选字段', () => {
      const progress: ProgressFile = {
        sessionId: 'session-001',
        taskId: 'task-001',
        status: 'executing',
        currentStep: 1,
        totalSteps: 3,
        completedSubtasks: [],
        failedSubtasks: [],
        runningSubtasks: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(progress.estimatedRemaining).toBeUndefined();
    });

    it('时间戳应合理', () => {
      const progress = createValidProgress();

      expect(progress.startedAt).toBeLessThanOrEqual(progress.updatedAt);
    });
  });

  // ==========================================================================
  // 契约测试：DecisionRecord
  // ==========================================================================

  describe('DecisionRecord', () => {
    it('应包含必需字段', () => {
      const decision = createValidDecision();

      expect(decision.id).toBeDefined();
      expect(decision.timestamp).toBeDefined();
      expect(decision.type).toBeDefined();
      expect(decision.decision).toBeDefined();
      expect(decision.decision.reason).toBeDefined();
    });

    it('type 值应是有效的枚举', () => {
      const validTypes = [
        'approval',
        'intervention',
        'retry',
        'delegation_change',
        'abort',
      ];
      const decision = createValidDecision();

      expect(validTypes).toContain(decision.type);
    });

    it('workerId 和 subtaskId 应为可选字段', () => {
      const decision: DecisionRecord = {
        id: 'decision-001',
        timestamp: Date.now(),
        type: 'abort',
        decision: {
          approved: false,
          reason: '任务超时，中止执行',
        },
      };

      expect(decision.workerId).toBeUndefined();
      expect(decision.subtaskId).toBeUndefined();
    });

    it('trigger 应包含正确结构', () => {
      const decision = createValidDecision();

      if (decision.trigger) {
        const validSources = ['worker_request', 'periodic_check', 'manual', 'system'];
        expect(validSources).toContain(decision.trigger.source);
      }
    });

    it('decision.approved 应为布尔值（如果提供）', () => {
      const decision = createValidDecision();

      if (decision.decision.approved !== undefined) {
        expect(typeof decision.decision.approved).toBe('boolean');
      }
    });
  });

  // ==========================================================================
  // 共享文件 JSON 序列化兼容性
  // ==========================================================================

  describe('共享文件 JSON 序列化兼容性', () => {
    it('SharedContextFile 应正确序列化和反序列化', () => {
      const original = createValidSharedContext();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as SharedContextFile;

      expect(parsed.sessionId).toBe(original.sessionId);
      expect(parsed.objective).toBe(original.objective);
      expect(parsed.constraints).toEqual(original.constraints);
      expect(parsed.sharedKnowledge.data).toEqual(original.sharedKnowledge.data);
    });

    it('MessageRecord 应正确序列化和反序列化', () => {
      const original = createValidMessage();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as MessageRecord;

      expect(parsed.id).toBe(original.id);
      expect(parsed.direction).toBe(original.direction);
      expect(parsed.type).toBe(original.type);
      expect(parsed.content).toEqual(original.content);
    });

    it('RuntimeFile 应正确序列化和反序列化', () => {
      const original = createValidRuntime();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as RuntimeFile;

      expect(parsed.sessionId).toBe(original.sessionId);
      expect(parsed.taskId).toBe(original.taskId);
      expect(parsed.version).toBe(original.version);
      if ('plannerOutput' in parsed && 'plannerOutput' in original) {
        expect(parsed.plannerOutput.subtasks.length).toBe(original.plannerOutput.subtasks.length);
      }
    });

    it('ProgressFile 应正确序列化和反序列化', () => {
      const original = createValidProgress();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as ProgressFile;

      expect(parsed.sessionId).toBe(original.sessionId);
      expect(parsed.status).toBe(original.status);
      expect(parsed.currentStep).toBe(original.currentStep);
      expect(parsed.completedSubtasks).toEqual(original.completedSubtasks);
    });

    it('DecisionRecord 应正确序列化和反序列化', () => {
      const original = createValidDecision();
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as DecisionRecord;

      expect(parsed.id).toBe(original.id);
      expect(parsed.type).toBe(original.type);
      expect(parsed.decision.reason).toBe(original.decision.reason);
      expect(parsed.trigger?.source).toBe(original.trigger?.source);
    });
  });
});
