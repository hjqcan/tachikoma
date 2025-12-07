/**
 * CheckpointManager 单元测试
 *
 * 测试长时任务检查点保存与恢复功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import {
  // CheckpointManager
  CheckpointManager,
  createCheckpointManager,
  createSubtaskSnapshots,
  // SessionFileManager
  SessionFileManager,
  createAndInitializeSessionFileManager,
  // 类型
  type CheckpointData,
  type CheckpointRestoreResult,
  type SubtaskSnapshot,
  type WorkerSnapshot,
  // 工具
  SessionPathBuilder,
  atomicWriteJson,
  appendJsonlRecord,
  DEFAULT_CHECKPOINT_CONFIG,
} from '../src/orchestrator/session';

// ============================================================================
// 测试配置
// ============================================================================

const TEST_ROOT_DIR = '.tachikoma-checkpoint-test';
const TEST_SESSION_ID = 'test-checkpoint-session';

// 清理测试目录
async function cleanupTestDir(): Promise<void> {
  if (existsSync(TEST_ROOT_DIR)) {
    await rm(TEST_ROOT_DIR, { recursive: true, force: true });
  }
}

// ============================================================================
// CheckpointManager 测试
// ============================================================================

describe('CheckpointManager', () => {
  let sessionManager: SessionFileManager;
  let checkpointManager: CheckpointManager;

  beforeEach(async () => {
    await cleanupTestDir();
    sessionManager = await createAndInitializeSessionFileManager(TEST_SESSION_ID, {
      rootDir: TEST_ROOT_DIR,
      enableWatch: false,
    });
    checkpointManager = createCheckpointManager(TEST_SESSION_ID, sessionManager, {
      rootDir: TEST_ROOT_DIR,
      autoSave: false,
      maxCheckpoints: 3,
      enableGitIntegration: false,
    });
  });

  afterEach(async () => {
    await checkpointManager.close();
    await sessionManager.close();
    await cleanupTestDir();
  });

  // ==========================================================================
  // 基本功能测试
  // ==========================================================================

  describe('基本检查点操作', () => {
    it('应保存检查点并生成 ID', async () => {
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2'],
        failedSubtaskIds: [],
        runningSubtaskIds: ['sub-3'],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-3', status: 'running', progress: 50, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: { 'sub-1': { output: 'result-1' }, 'sub-2': { output: 'result-2' } },
        totalRetries: 0,
        totalTokens: 1500,
      });

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.id.startsWith('ckpt-')).toBe(true);
      expect(checkpoint.sessionId).toBe(TEST_SESSION_ID);
      expect(checkpoint.taskId).toBe('task-001');
      expect(checkpoint.version).toBe(1);
      expect(checkpoint.createdAt).toBeDefined();
      expect(checkpoint.updatedAt).toBeDefined();
    });

    it('应读取最新检查点', async () => {
      // 保存两个检查点
      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 1,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1'],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 500,
      });

      // 等待一小段时间确保时间戳不同
      await new Promise(r => setTimeout(r, 10));

      const secondCheckpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2'],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 1000,
      });

      const latest = await checkpointManager.loadCheckpoint();

      expect(latest).not.toBeNull();
      expect(latest?.id).toBe(secondCheckpoint.id);
      expect(latest?.currentStep).toBe(2);
      expect(latest?.version).toBe(2);
    });

    it('应通过 ID 读取指定检查点', async () => {
      const first = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 1,
        totalSteps: 5,
        completedSubtaskIds: [],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 0,
      });

      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: [],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 0,
      });

      const loaded = await checkpointManager.loadCheckpointById(first.id);

      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(first.id);
      expect(loaded?.currentStep).toBe(1);
    });

    it('应列出所有检查点（按时间倒序）', async () => {
      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 1,
        totalSteps: 5,
        completedSubtaskIds: [],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 0,
      });

      await new Promise(r => setTimeout(r, 10));

      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: [],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 0,
      });

      const checkpoints = await checkpointManager.listCheckpoints();

      expect(checkpoints).toHaveLength(2);
      // 最新的在前
      expect(checkpoints[0]!.currentStep).toBe(2);
      expect(checkpoints[1]!.currentStep).toBe(1);
    });

    it('应删除检查点', async () => {
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 1,
        totalSteps: 5,
        completedSubtaskIds: [],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 0,
      });

      const deleted = await checkpointManager.deleteCheckpoint(checkpoint.id);
      expect(deleted).toBe(true);

      const loaded = await checkpointManager.loadCheckpointById(checkpoint.id);
      expect(loaded).toBeNull();
    });

    it('删除不存在的检查点应返回 false', async () => {
      const deleted = await checkpointManager.deleteCheckpoint('nonexistent-id');
      expect(deleted).toBe(false);
    });
  });

  // ==========================================================================
  // 检查点清理测试
  // ==========================================================================

  describe('检查点清理', () => {
    it('应清理超过最大数量的旧检查点', async () => {
      // maxCheckpoints 设置为 3
      for (let i = 1; i <= 5; i++) {
        await checkpointManager.saveCheckpoint({
          taskId: 'task-001',
          planStatus: 'executing',
          currentStep: i,
          totalSteps: 10,
          completedSubtaskIds: [],
          failedSubtaskIds: [],
          runningSubtaskIds: [],
          subtaskSnapshots: [],
          completedResults: {},
          totalRetries: 0,
          totalTokens: i * 100,
        });
        // 确保时间戳不同
        await new Promise(r => setTimeout(r, 10));
      }

      const checkpoints = await checkpointManager.listCheckpoints();

      // 应该只保留最新的 3 个
      expect(checkpoints).toHaveLength(3);
      // 验证是最新的 3 个（step 5, 4, 3）
      expect(checkpoints[0]!.currentStep).toBe(5);
      expect(checkpoints[1]!.currentStep).toBe(4);
      expect(checkpoints[2]!.currentStep).toBe(3);
    });
  });

  // ==========================================================================
  // 恢复功能测试
  // ==========================================================================

  describe('检查点恢复', () => {
    it('没有检查点时恢复应返回失败', async () => {
      const result = await checkpointManager.restore();

      expect(result.success).toBe(false);
      expect(result.error).toBe('No checkpoint found');
    });

    it('应从最新检查点恢复', async () => {
      // 创建检查点
      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 3,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2', 'sub-3'],
        failedSubtaskIds: [],
        runningSubtaskIds: ['sub-4'],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-3', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-4', status: 'running', progress: 50, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-5', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 2000,
      });

      const result = await checkpointManager.restore({ strategy: 'resume' });

      expect(result.success).toBe(true);
      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint?.taskId).toBe('task-001');
      expect(result.resumableSubtaskIds).toBeDefined();
      // resume 策略应返回未完成的子任务
      expect(result.resumableSubtaskIds).toContain('sub-4');
      expect(result.resumableSubtaskIds).toContain('sub-5');
      expect(result.resumableSubtaskIds).not.toContain('sub-1');
    });

    it('retry-failed 策略应返回失败的子任务', async () => {
      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 3,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2'],
        failedSubtaskIds: ['sub-3'],
        runningSubtaskIds: ['sub-4'],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-3', status: 'failure', progress: 80, retryCount: 2, lastUpdatedAt: Date.now() },
          { id: 'sub-4', status: 'running', progress: 50, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-5', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 2,
        totalTokens: 2000,
      });

      const result = await checkpointManager.restore({ strategy: 'retry-failed' });

      expect(result.success).toBe(true);
      expect(result.resumableSubtaskIds).toContain('sub-3');
      expect(result.resumableSubtaskIds).toContain('sub-4');
    });

    it('restart-all 策略应返回所有子任务', async () => {
      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 3,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2'],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-3', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 1000,
      });

      const result = await checkpointManager.restore({ strategy: 'restart-all' });

      expect(result.success).toBe(true);
      expect(result.resumableSubtaskIds).toHaveLength(3);
      expect(result.resumableSubtaskIds).toContain('sub-1');
      expect(result.resumableSubtaskIds).toContain('sub-2');
      expect(result.resumableSubtaskIds).toContain('sub-3');
    });

    it('应从指定检查点恢复', async () => {
      const first = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 1,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1'],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 500,
      });

      await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 3,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2', 'sub-3'],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 1500,
      });

      const result = await checkpointManager.restoreFromCheckpoint(first.id);

      expect(result.success).toBe(true);
      expect(result.checkpoint?.currentStep).toBe(1);
    });

    it('恢复不存在的检查点应返回失败', async () => {
      const result = await checkpointManager.restoreFromCheckpoint('nonexistent-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ==========================================================================
  // 恢复策略分析测试
  // ==========================================================================

  describe('恢复策略分析', () => {
    it('有失败子任务但重试次数未耗尽时应建议 retry-failed', async () => {
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1'],
        failedSubtaskIds: ['sub-2'],
        runningSubtaskIds: [],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'failure', progress: 50, retryCount: 1, lastUpdatedAt: Date.now() },
          { id: 'sub-3', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 1,
        totalTokens: 800,
      });

      const analysis = await checkpointManager.analyzeRecoveryStrategy(checkpoint);

      expect(analysis.suggestedStrategy).toBe('retry-failed');
      expect(analysis.failedSubtaskIds).toContain('sub-2');
    });

    it('没有完成的子任务且没有待执行任务时应建议 restart-all', async () => {
      // 当所有子任务都失败，没有待执行的任务时，建议重新开始
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 1,
        totalSteps: 2,
        completedSubtaskIds: [],
        failedSubtaskIds: ['sub-1', 'sub-2'],
        runningSubtaskIds: [],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'failure', progress: 20, retryCount: 3, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'failure', progress: 50, retryCount: 3, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 6, // 超过 3 * failedCount = 6
        totalTokens: 500,
      });

      const analysis = await checkpointManager.analyzeRecoveryStrategy(checkpoint);

      // 当所有子任务都失败且没有pending时，restart-step 策略（重新开始当前步骤）
      // 实际上这种情况下，如果 completedCount === 0，则建议 restart-all
      expect(analysis.suggestedStrategy).toBe('restart-all');
    });

    it('有失败但还有待执行任务时应建议 resume（跳过失败继续）', async () => {
      // 有一个成功、一个失败、一个待执行
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: ['sub-0'], // 有一个已完成的
        failedSubtaskIds: ['sub-1'],
        runningSubtaskIds: [],
        subtaskSnapshots: [
          { id: 'sub-0', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-1', status: 'failure', progress: 20, retryCount: 3, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: { 'sub-0': { result: 'done' } },
        totalRetries: 3,
        totalTokens: 500,
      });

      const analysis = await checkpointManager.analyzeRecoveryStrategy(checkpoint);

      // 有待执行的任务且有成功完成的，建议跳过失败继续
      expect(analysis.suggestedStrategy).toBe('resume');
    });

    it('正常进行中应建议 resume', async () => {
      const checkpoint = await checkpointManager.saveCheckpoint({
        taskId: 'task-001',
        planStatus: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtaskIds: ['sub-1', 'sub-2'],
        failedSubtaskIds: [],
        runningSubtaskIds: [],
        subtaskSnapshots: [
          { id: 'sub-1', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-2', status: 'success', progress: 100, retryCount: 0, lastUpdatedAt: Date.now() },
          { id: 'sub-3', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        ],
        completedResults: {},
        totalRetries: 0,
        totalTokens: 1000,
      });

      const analysis = await checkpointManager.analyzeRecoveryStrategy(checkpoint);

      expect(analysis.suggestedStrategy).toBe('resume');
      expect(analysis.resumableSubtaskIds).toContain('sub-3');
    });
  });

  // ==========================================================================
  // Worker 状态收集测试
  // ==========================================================================

  describe('Worker 状态收集', () => {
    it('应收集所有 Worker 状态快照', async () => {
      // 注册多个 Worker
      await sessionManager.registerWorker('worker-001');
      await sessionManager.registerWorker('worker-002');

      // 更新 Worker 状态
      await sessionManager.writeWorkerStatus('worker-001', {
        status: 'thinking',
        currentSubtask: {
          id: 'sub-1',
          objective: 'Test task 1',
          startedAt: Date.now(),
        },
        progress: 50,
        lastHeartbeat: Date.now(),
      });

      await sessionManager.writeWorkerStatus('worker-002', {
        status: 'idle',
        progress: 0,
        lastHeartbeat: Date.now(),
      });

      const snapshots = await checkpointManager.collectWorkerSnapshots();

      expect(snapshots).toHaveLength(2);
      
      const worker1 = snapshots.find(s => s.workerId === 'worker-001');
      expect(worker1).toBeDefined();
      expect(worker1?.status).toBe('thinking');
      expect(worker1?.progress).toBe(50);
      expect(worker1?.currentSubtask?.id).toBe('sub-1');

      const worker2 = snapshots.find(s => s.workerId === 'worker-002');
      expect(worker2).toBeDefined();
      expect(worker2?.status).toBe('idle');
    });

    it('应获取单个 Worker 状态', async () => {
      await sessionManager.registerWorker('worker-001');
      await sessionManager.writeWorkerStatus('worker-001', {
        status: 'acting',
        progress: 75,
        lastHeartbeat: Date.now(),
      });

      const snapshot = await checkpointManager.getWorkerSnapshot('worker-001');

      expect(snapshot).not.toBeNull();
      expect(snapshot?.workerId).toBe('worker-001');
      expect(snapshot?.status).toBe('acting');
      expect(snapshot?.progress).toBe(75);
    });

    it('不存在的 Worker 应返回 null', async () => {
      const snapshot = await checkpointManager.getWorkerSnapshot('nonexistent-worker');

      expect(snapshot).toBeNull();
    });
  });

  // ==========================================================================
  // Git 集成测试
  // ==========================================================================

  describe('Git 集成', () => {
    it('禁用 Git 集成时应返回 null', async () => {
      const commit = await checkpointManager.getCurrentGitCommit();
      expect(commit).toBeNull();
    });

    it('禁用 Git 集成时创建检查点应返回 null', async () => {
      const tag = await checkpointManager.createGitCheckpoint('test checkpoint');
      expect(tag).toBeNull();
    });
  });

  // ==========================================================================
  // 自动保存测试
  // ==========================================================================

  describe('自动保存', () => {
    it('应启动和停止自动保存', async () => {
      // 设置自动保存回调
      let saveCount = 0;
      checkpointManager.setAutoSaveCallback(async () => {
        saveCount++;
        return {
          taskId: 'task-001',
          planStatus: 'executing',
          currentStep: saveCount,
          totalSteps: 10,
          completedSubtaskIds: [],
          failedSubtaskIds: [],
          runningSubtaskIds: [],
          subtaskSnapshots: [],
          completedResults: {},
          totalRetries: 0,
          totalTokens: saveCount * 100,
        };
      });

      // 创建启用自动保存的管理器
      const autoSaveManager = createCheckpointManager(TEST_SESSION_ID, sessionManager, {
        rootDir: TEST_ROOT_DIR,
        autoSave: true,
        autoSaveInterval: 100, // 100ms 间隔用于测试
        maxCheckpoints: 5,
        enableGitIntegration: false,
      });

      autoSaveManager.setAutoSaveCallback(async () => {
        saveCount++;
        return {
          taskId: 'task-001',
          planStatus: 'executing',
          currentStep: saveCount,
          totalSteps: 10,
          completedSubtaskIds: [],
          failedSubtaskIds: [],
          runningSubtaskIds: [],
          subtaskSnapshots: [],
          completedResults: {},
          totalRetries: 0,
          totalTokens: saveCount * 100,
        };
      });

      autoSaveManager.startAutoSave();

      // 等待几个保存周期
      await new Promise(r => setTimeout(r, 350));

      autoSaveManager.stopAutoSave();
      await autoSaveManager.close();

      // 应该至少保存了 2-3 次
      expect(saveCount).toBeGreaterThanOrEqual(2);
    });

    it('没有回调时自动保存应静默跳过', async () => {
      const autoSaveManager = createCheckpointManager(TEST_SESSION_ID, sessionManager, {
        rootDir: TEST_ROOT_DIR,
        autoSave: true,
        autoSaveInterval: 50,
        maxCheckpoints: 5,
        enableGitIntegration: false,
      });

      // 不设置回调
      autoSaveManager.startAutoSave();

      // 等待一个保存周期
      await new Promise(r => setTimeout(r, 100));

      autoSaveManager.stopAutoSave();
      await autoSaveManager.close();

      // 不应有检查点
      const checkpoints = await checkpointManager.listCheckpoints();
      expect(checkpoints).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 辅助函数测试
  // ==========================================================================

  describe('createSubtaskSnapshots 辅助函数', () => {
    it('应从子任务列表创建快照', () => {
      const subtasks = [
        { id: 'sub-1', status: 'success' as const, assignedWorkerId: 'worker-1' },
        { id: 'sub-2', status: 'running' as const },
        { id: 'sub-3', status: 'pending' as const },
      ];

      const snapshots = createSubtaskSnapshots(subtasks);

      expect(snapshots).toHaveLength(3);
      expect(snapshots[0]!.id).toBe('sub-1');
      expect(snapshots[0]!.status).toBe('success');
      expect(snapshots[0]!.assignedWorkerId).toBe('worker-1');
      expect(snapshots[1]!.status).toBe('running');
      expect(snapshots[2]!.status).toBe('pending');
    });

    it('应结合执行状态创建快照', () => {
      const subtasks = [
        { id: 'sub-1', status: 'pending' as const },
        { id: 'sub-2', status: 'pending' as const },
        { id: 'sub-3', status: 'pending' as const },
      ];

      const executionState = {
        completedSubtasks: new Map([['sub-1', { result: 'done' }]]),
        failedSubtasks: new Map([['sub-2', 'Error message']]),
        runningSubtasks: new Set(['sub-3']),
      };

      const snapshots = createSubtaskSnapshots(subtasks, executionState);

      expect(snapshots[0]!.status).toBe('success');
      expect(snapshots[0]!.progress).toBe(100);
      expect(snapshots[1]!.status).toBe('failure');
      expect(snapshots[2]!.status).toBe('running');
      expect(snapshots[2]!.progress).toBe(50);
    });
  });

  // ==========================================================================
  // 默认配置测试
  // ==========================================================================

  describe('DEFAULT_CHECKPOINT_CONFIG', () => {
    it('应包含正确的默认值', () => {
      expect(DEFAULT_CHECKPOINT_CONFIG.rootDir).toBe('.tachikoma');
      expect(DEFAULT_CHECKPOINT_CONFIG.autoSave).toBe(false);
      expect(DEFAULT_CHECKPOINT_CONFIG.autoSaveInterval).toBe(30000);
      expect(DEFAULT_CHECKPOINT_CONFIG.maxCheckpoints).toBe(5);
      expect(DEFAULT_CHECKPOINT_CONFIG.enableGitIntegration).toBe(false);
    });
  });
});
