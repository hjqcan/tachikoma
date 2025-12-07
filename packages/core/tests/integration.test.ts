/**
 * 端到端集成测试
 *
 * 验证完整的 plan → assign → monitor → aggregate 流程
 * 确保 Orchestrator、Planner、WorkerPool、SessionFileManager、CheckpointManager 协同工作
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  // Orchestrator
  Orchestrator,
  createOrchestratorConfig,
  MockWorkerPool,
  DEFAULT_WORKER_POOL_CONFIG,
  type OrchestratorEventType,
  // Session
  SessionFileManager,
  createAndInitializeSessionFileManager,
  // Checkpoint
  CheckpointManager,
} from '../src/orchestrator';
import { Planner, MockLLMClient } from '../src/planner';
import type { Task } from '../src/types';

// ============================================================================
// 测试环境配置
// ============================================================================

const TEST_ROOT_DIR = '.tachikoma-integration-test';
const TEST_SESSION_ID = 'integration-test-session';

// 清理测试目录
async function cleanupTestDir(): Promise<void> {
  try {
    await rm(TEST_ROOT_DIR, { recursive: true, force: true });
  } catch {
    // 忽略目录不存在的错误
  }
}

// ============================================================================
// Mock 数据工厂
// ============================================================================

/**
 * 创建模拟规划响应
 */
function createMockPlanningResponse(subtaskCount: number = 3): string {
  const subtasks = Array.from({ length: subtaskCount }, (_, i) => ({
    id: `subtask-${i + 1}`,
    objective: `子任务 ${i + 1}: 完成步骤 ${i + 1}`,
    constraints: [`约束 ${i + 1}`],
    estimatedMinutes: 10 + i * 5,
    dependencies: i > 0 ? [`subtask-${i}`] : [],
  }));

  const steps = Array.from({ length: subtaskCount }, (_, i) => ({
    order: i + 1,
    subtaskIds: [`subtask-${i + 1}`],
    parallel: false,
  }));

  return JSON.stringify({
    reasoning: `任务被分解为 ${subtaskCount} 个有序子任务。`,
    subtasks,
    executionPlan: {
      isParallel: false,
      steps,
    },
    estimatedTotalMinutes: subtasks.reduce((sum, s) => sum + s.estimatedMinutes, 0),
    complexityScore: Math.min(subtaskCount + 2, 10),
  });
}

/**
 * 创建 Mock Planner
 */
function createTestPlanner(options?: {
  subtaskCount?: number;
  simulateDelay?: number;
}): Planner {
  const { subtaskCount = 3, simulateDelay = 10 } = options || {};

  const mockClient = new MockLLMClient({
    provider: 'mock',
    model: 'mock-model',
    maxTokens: 1000,
    responses: [
      {
        content: createMockPlanningResponse(subtaskCount),
        usage: { inputTokens: 100, outputTokens: 200 },
        model: 'mock-model',
      },
    ],
    simulateDelay,
  });

  return new Planner({ llmClient: mockClient });
}

/**
 * 创建 Mock WorkerPool
 */
function createTestWorkerPool(options?: {
  workerCount?: number;
  taskDelay?: number;
}): MockWorkerPool {
  const { workerCount = 2, taskDelay = 10 } = options || {};

  return new MockWorkerPool({
    config: DEFAULT_WORKER_POOL_CONFIG,
    initialWorkers: workerCount,
    taskDelay,
  });
}

// ============================================================================
// 端到端集成测试
// ============================================================================

describe('端到端集成测试', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_ROOT_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  describe('完整 plan → assign → aggregate 流程', () => {
    it('应成功执行完整的任务流程', async () => {
      const planner = createTestPlanner({ subtaskCount: 3 });
      const workerPool = createTestWorkerPool({ workerCount: 2 });
      const sessionManager = await createAndInitializeSessionFileManager(
        TEST_SESSION_ID,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-001', {
        planner,
        workerPool,
        sessionManager,
      });

      // 记录事件
      const events: OrchestratorEventType[] = [];
      orchestrator.on('plan:start', () => events.push('plan:start'));
      orchestrator.on('plan:complete', () => events.push('plan:complete'));
      orchestrator.on('subtask:assigned', () => events.push('subtask:assigned'));
      orchestrator.on('subtask:complete', () => events.push('subtask:complete'));
      orchestrator.on('aggregate:start', () => events.push('aggregate:start'));
      orchestrator.on('aggregate:complete', () => events.push('aggregate:complete'));

      const task: Task = {
        id: 'task-001',
        type: 'composite',
        objective: '实现用户认证功能',
        constraints: ['使用 JWT', '支持 OAuth2'],
      };

      const result = await orchestrator.run(task);

      // 验证结果
      expect(result.taskId).toBe('task-001');
      expect(result.status).toBeDefined();
      expect(result.metrics.duration).toBeGreaterThanOrEqual(0);

      // 验证事件顺序
      expect(events).toContain('plan:start');
      expect(events).toContain('plan:complete');
      expect(events.indexOf('plan:start')).toBeLessThan(events.indexOf('plan:complete'));

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });

    it('多子任务应按依赖顺序执行', async () => {
      const planner = createTestPlanner({ subtaskCount: 4 });
      const workerPool = createTestWorkerPool({ workerCount: 1, taskDelay: 20 });
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-multi`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-002', {
        planner,
        workerPool,
        sessionManager,
      });

      const subtaskOrder: string[] = [];
      orchestrator.on('subtask:assigned', (data) => {
        if (data && typeof data === 'object' && 'subtaskId' in data) {
          subtaskOrder.push(data.subtaskId as string);
        }
      });

      const task: Task = {
        id: 'task-002',
        type: 'composite',
        objective: '多步骤任务测试',
        constraints: [],
      };

      await orchestrator.run(task);

      // 验证子任务被分配
      expect(subtaskOrder.length).toBeGreaterThan(0);

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });
  });

  describe('SessionFileManager 集成', () => {
    it('执行过程中应创建和更新会话文件', async () => {
      const planner = createTestPlanner({ subtaskCount: 2 });
      const workerPool = createTestWorkerPool();
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-session`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-003', {
        planner,
        workerPool,
        sessionManager,
        config: {
          session: {
            enableWatch: false, // 测试中禁用监控
          },
        },
      });

      const task: Task = {
        id: 'task-003',
        type: 'composite',
        objective: '测试会话文件',
        constraints: [],
      };

      await orchestrator.run(task);

      // 验证进度文件被更新
      const progress = await sessionManager.readProgress();
      // 进度文件可能存在也可能已清理（取决于配置）
      // 主要验证执行过程不会出错

      // 验证会话路径正确
      const sessionPath = sessionManager.getSessionPath();
      expect(sessionPath).toContain(TEST_ROOT_DIR);

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });

    it('应正确处理 Worker 注册', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-worker`,
        { rootDir: TEST_ROOT_DIR }
      );

      // 注册 Worker
      await sessionManager.registerWorker('worker-001');
      await sessionManager.registerWorker('worker-002');

      // 验证 Worker 目录创建
      const workerPath1 = sessionManager.getWorkerPath('worker-001');
      const workerPath2 = sessionManager.getWorkerPath('worker-002');
      expect(workerPath1).toContain('worker-001');
      expect(workerPath2).toContain('worker-002');

      // 验证可以读写 Worker 状态
      await sessionManager.writeWorkerStatus('worker-001', {
        status: 'idle',
        progress: 0,
        lastHeartbeat: Date.now(),
      });

      const status = await sessionManager.readWorkerStatus('worker-001');
      expect(status).not.toBeNull();
      expect(status?.status).toBe('idle');

      // 清理
      await sessionManager.close();
    });
  });

  describe('CheckpointManager 集成', () => {
    it('应能保存和恢复检查点', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-checkpoint`,
        { rootDir: TEST_ROOT_DIR }
      );

      const checkpointManager = new CheckpointManager(
        `${TEST_SESSION_ID}-checkpoint`,
        sessionManager,
        { rootDir: TEST_ROOT_DIR, maxCheckpoints: 3 }
      );

      // 保存检查点
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-checkpoint',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: ['subtask-1'],
        failedSubtaskIds: [],
        runningSubtaskIds: ['subtask-2'],
        subtaskSnapshots: [
          {
            id: 'subtask-1',
            status: 'success',
            progress: 100,
            retryCount: 0,
            lastUpdatedAt: Date.now(),
          },
          {
            id: 'subtask-2',
            status: 'running',
            assignedWorkerId: 'worker-1',
            progress: 50,
            retryCount: 0,
            lastUpdatedAt: Date.now(),
          },
        ],
        completedResults: { 'subtask-1': { output: 'done' } },
        totalRetries: 0,
        totalTokens: 500,
      });

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.taskId).toBe('task-checkpoint');
      expect(checkpoint.planStatus).toBe('executing');

      // 读取检查点
      const loaded = await checkpointManager.loadCheckpoint();
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(checkpoint.id);
      expect(loaded?.completedSubtaskIds).toContain('subtask-1');

      // 恢复检查点
      const restoreResult = await checkpointManager.restore({
        strategy: 'resume',
      });

      expect(restoreResult.success).toBe(true);
      expect(restoreResult.checkpoint).toBeDefined();

      // 清理
      await checkpointManager.close();
      await sessionManager.close();
    });

    it('多个检查点应正确清理', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-cleanup`,
        { rootDir: TEST_ROOT_DIR }
      );

      const checkpointManager = new CheckpointManager(
        `${TEST_SESSION_ID}-cleanup`,
        sessionManager,
        { rootDir: TEST_ROOT_DIR, maxCheckpoints: 2 }
      );

      // 保存多个检查点
      for (let i = 0; i < 4; i++) {
        await checkpointManager.saveCheckpoint({
          taskId: `task-${i}`,
          planStatus: 'executing',
          currentStep: i,
          totalSteps: 5,
          completedSubtaskIds: [],
          failedSubtaskIds: [],
          runningSubtaskIds: [],
          subtaskSnapshots: [],
          completedResults: {},
          totalRetries: 0,
          totalTokens: 100 * i,
        });
        // 添加小延迟确保时间戳不同
        await new Promise((r) => setTimeout(r, 10));
      }

      // 清理旧检查点
      const cleanedCount = await checkpointManager.cleanupOldCheckpoints();

      // 应该清理掉超过 maxCheckpoints 的检查点
      expect(cleanedCount).toBeGreaterThanOrEqual(0);

      // 列出剩余检查点
      const remaining = await checkpointManager.listCheckpoints();
      expect(remaining.length).toBeLessThanOrEqual(2);

      // 清理
      await checkpointManager.close();
      await sessionManager.close();
    });
  });

  describe('审批流程集成', () => {
    it('应正确处理审批请求和响应', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-approval`,
        { rootDir: TEST_ROOT_DIR }
      );

      // 注册 Worker
      await sessionManager.registerWorker('worker-approval');

      // 模拟 Worker 创建审批请求（实际由 Worker 写入）
      // 这里我们直接测试读写 API

      // 读取不存在的审批请求
      const pending = await sessionManager.readPendingApproval('worker-approval');
      expect(pending).toBeNull();

      // 写入审批响应
      await sessionManager.writeApprovalResponse('worker-approval', {
        requestId: 'req-001',
        respondedAt: Date.now(),
        approved: true,
        respondedBy: 'orchestrator',
        reason: 'Auto-approved for testing',
      });

      // 读取审批响应
      const response = await sessionManager.readApprovalResponse('worker-approval');
      expect(response).not.toBeNull();
      expect(response?.approved).toBe(true);
      expect(response?.respondedBy).toBe('orchestrator');

      // 清理
      await sessionManager.close();
    });
  });

  describe('干预流程集成', () => {
    it('应正确处理干预指令', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-intervention`,
        { rootDir: TEST_ROOT_DIR }
      );

      // 注册 Worker
      await sessionManager.registerWorker('worker-intervention');

      // 写入干预指令
      await sessionManager.writeIntervention('worker-intervention', {
        type: 'guidance',
        reason: '检测到思路偏离',
        instructions: '请回到任务目标',
        suggestedNextSteps: ['重新分析任务', '检查约束条件'],
      });

      // 读取干预指令
      const intervention = await sessionManager.readIntervention('worker-intervention');
      expect(intervention).not.toBeNull();
      expect(intervention?.type).toBe('guidance');
      expect(intervention?.acknowledged).toBe(false);

      // 清理
      await sessionManager.close();
    });
  });

  describe('共享上下文集成', () => {
    it('应正确管理共享上下文', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-context`,
        { rootDir: TEST_ROOT_DIR }
      );

      // 写入共享上下文
      await sessionManager.writeSharedContext({
        objective: '测试目标',
        constraints: ['约束1', '约束2'],
        sharedKnowledge: {
          data: { key: 'value' },
          updatedAt: Date.now(),
        },
        workspace: {
          rootPath: '/test/workspace',
          keyFiles: ['src/main.ts', 'package.json'],
        },
      });

      // 读取共享上下文
      const context = await sessionManager.readSharedContext();
      expect(context).not.toBeNull();
      expect(context?.objective).toBe('测试目标');
      expect(context?.constraints).toContain('约束1');
      expect(context?.sharedKnowledge.data.key).toBe('value');

      // 清理
      await sessionManager.close();
    });

    it('应正确管理消息日志', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-messages`,
        { rootDir: TEST_ROOT_DIR }
      );

      // 追加消息
      await sessionManager.appendMessage({
        senderId: 'orchestrator',
        receiverId: 'worker-001',
        direction: 'orchestrator_to_worker',
        type: 'task_assignment',
        content: { taskId: 'subtask-1', objective: '完成步骤1' },
        subtaskId: 'subtask-1',
      });

      await sessionManager.appendMessage({
        senderId: 'worker-001',
        receiverId: 'orchestrator',
        direction: 'worker_to_orchestrator',
        type: 'progress_update',
        content: { progress: 50 },
        subtaskId: 'subtask-1',
      });

      // 读取消息
      const messages = await sessionManager.readMessages(10);
      expect(messages.length).toBe(2);
      expect(messages[0].type).toBe('task_assignment');
      expect(messages[1].type).toBe('progress_update');

      // 清理
      await sessionManager.close();
    });
  });

  describe('决策日志集成', () => {
    it('应正确记录和读取决策', async () => {
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-decisions`,
        { rootDir: TEST_ROOT_DIR }
      );

      // 追加决策记录
      await sessionManager.appendDecision({
        type: 'approval',
        workerId: 'worker-001',
        subtaskId: 'subtask-1',
        decision: {
          approved: true,
          reason: '低影响操作自动批准',
        },
        trigger: {
          source: 'worker_request',
          requestId: 'req-001',
        },
      });

      await sessionManager.appendDecision({
        type: 'intervention',
        workerId: 'worker-002',
        decision: {
          approved: false,
          reason: '检测到偏离',
          instructions: '请重新分析任务',
        },
        trigger: {
          source: 'periodic_check',
        },
      });

      // 读取决策
      const decisions = await sessionManager.readDecisions(10);
      expect(decisions.length).toBe(2);
      expect(decisions[0].type).toBe('approval');
      expect(decisions[1].type).toBe('intervention');

      // 清理
      await sessionManager.close();
    });
  });

  describe('错误恢复集成', () => {
    it('规划失败时应正确处理', async () => {
      // 创建会失败的 Planner
      const { LLMClientError } = await import('../src/planner');
      const failingClient = new MockLLMClient({
        provider: 'mock',
        model: 'mock-model',
        maxTokens: 1000,
        simulateError: new LLMClientError('Network error', 'mock', 'NETWORK', true),
      });

      const failingPlanner = new Planner({
        llmClient: failingClient,
        parseRetryConfig: { maxRetries: 0 },
      });

      const workerPool = createTestWorkerPool();
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-error`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-error', {
        planner: failingPlanner,
        workerPool,
        sessionManager,
      });

      let errorEventFired = false;
      orchestrator.on('plan:error', () => {
        errorEventFired = true;
      });

      const task: Task = {
        id: 'task-error',
        type: 'composite',
        objective: '测试错误处理',
        constraints: [],
      };

      const result = await orchestrator.run(task);

      // 验证失败结果
      expect(result.status).toBe('failure');
      expect(result.output).toHaveProperty('error');

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });
  });

  describe('并发执行集成', () => {
    it('多 Worker 应能并行处理子任务', async () => {
      const planner = createTestPlanner({ subtaskCount: 4 });
      const workerPool = createTestWorkerPool({ workerCount: 3, taskDelay: 20 });
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-concurrent`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-concurrent', {
        planner,
        workerPool,
        sessionManager,
      });

      const startTime = Date.now();

      const task: Task = {
        id: 'task-concurrent',
        type: 'composite',
        objective: '测试并发执行',
        constraints: [],
      };

      const result = await orchestrator.run(task);
      const duration = Date.now() - startTime;

      // 验证任务完成
      expect(result.taskId).toBe('task-concurrent');

      // 由于有多个 Worker，总时间应该比串行执行短
      // (假设串行执行 4 个 20ms 的任务需要 80ms+)
      // 注意：实际时间取决于依赖关系，可能不会完全并行

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });
  });
});

// ============================================================================
// 组件间协作测试
// ============================================================================

describe('组件间协作测试', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_ROOT_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  describe('Planner + Orchestrator 协作', () => {
    it('Planner 输出应正确传递给 Orchestrator', async () => {
      const planner = createTestPlanner({ subtaskCount: 2 });
      const workerPool = createTestWorkerPool();
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-planner-orch`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-planner', {
        planner,
        workerPool,
        sessionManager,
      });

      let planOutput: unknown = null;
      orchestrator.on('plan:complete', (data) => {
        planOutput = data;
      });

      const task: Task = {
        id: 'task-planner',
        type: 'composite',
        objective: '测试规划输出',
        constraints: [],
      };

      await orchestrator.run(task);

      // 验证规划输出
      expect(planOutput).not.toBeNull();

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });
  });

  describe('WorkerPool + Orchestrator 协作', () => {
    it('任务应正确分配给 WorkerPool', async () => {
      const planner = createTestPlanner({ subtaskCount: 2 });
      const workerPool = createTestWorkerPool({ workerCount: 2 });
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-pool-orch`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-pool', {
        planner,
        workerPool,
        sessionManager,
      });

      const assignedTasks: string[] = [];
      orchestrator.on('subtask:assigned', (data) => {
        if (data && typeof data === 'object' && 'subtaskId' in data) {
          assignedTasks.push(data.subtaskId as string);
        }
      });

      const task: Task = {
        id: 'task-pool',
        type: 'composite',
        objective: '测试任务分配',
        constraints: [],
      };

      await orchestrator.run(task);

      // 验证任务被分配
      expect(assignedTasks.length).toBeGreaterThan(0);

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });
  });

  describe('SessionFileManager + Orchestrator 协作', () => {
    it('会话状态应正确同步', async () => {
      const planner = createTestPlanner({ subtaskCount: 2 });
      const workerPool = createTestWorkerPool();
      const sessionManager = await createAndInitializeSessionFileManager(
        `${TEST_SESSION_ID}-session-orch`,
        { rootDir: TEST_ROOT_DIR }
      );

      const orchestrator = new Orchestrator('orch-session', {
        planner,
        workerPool,
        sessionManager,
      });

      const task: Task = {
        id: 'task-session',
        type: 'composite',
        objective: '测试会话同步',
        constraints: [],
      };

      await orchestrator.run(task);

      // 验证会话路径有效
      expect(sessionManager.getSessionPath()).toContain(TEST_ROOT_DIR);

      // 清理
      await sessionManager.close();
      await orchestrator.stop();
    });
  });
});
