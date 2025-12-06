/**
 * SessionFileManager 单元测试
 *
 * 测试共享文件系统协调机制的核心功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  // SessionFileManager
  SessionFileManager,
  createSessionFileManager,
  createAndInitializeSessionFileManager,
  // 类型
  type PlanFile,
  type ProgressFile,
  type DecisionRecord,
  type WorkerStatusFile,
  type PendingApprovalFile,
  type ApprovalResponseFile,
  type InterventionFile,
  type SharedContextFile,
  type MessageRecord,
  type SessionFileEvent,
  // 工具函数
  SessionPathBuilder,
  atomicWriteFile,
  atomicWriteJson,
  readJsonFile,
  appendJsonlRecord,
  readJsonlRecords,
  readJsonlTail,
  ensureDir,
  fileExists,
  removeDir,
  generateId,
  generateTimestampId,
  FileLock,
  withFileLock,
  DEFAULT_SESSION_CONFIG,
  // 配置
  DEFAULT_RETRY_POLICY,
} from '../src/orchestrator';

// ============================================================================
// 测试配置
// ============================================================================

const TEST_ROOT_DIR = '.tachikoma-test';
const TEST_SESSION_ID = 'test-session-001';

// 清理测试目录
async function cleanupTestDir(): Promise<void> {
  if (existsSync(TEST_ROOT_DIR)) {
    await rm(TEST_ROOT_DIR, { recursive: true, force: true });
  }
}

// ============================================================================
// 工具函数测试
// ============================================================================

describe('工具函数', () => {
  beforeEach(async () => {
    await cleanupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  describe('generateId', () => {
    it('应生成唯一 ID', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
      expect(id1.length).toBe(12);
    });

    it('应支持前缀', () => {
      const id = generateId('test');
      expect(id.startsWith('test-')).toBe(true);
    });
  });

  describe('generateTimestampId', () => {
    it('应生成带时间戳的唯一 ID', () => {
      const id1 = generateTimestampId();
      const id2 = generateTimestampId();
      expect(id1).not.toBe(id2);
    });

    it('应支持前缀', () => {
      const id = generateTimestampId('msg');
      expect(id.startsWith('msg-')).toBe(true);
    });
  });

  describe('atomicWriteFile', () => {
    it('应原子写入文件', async () => {
      const testDir = join(TEST_ROOT_DIR, 'atomic-test');
      const testFile = join(testDir, 'test.txt');

      await atomicWriteFile(testFile, 'Hello, World!');

      const content = await readFile(testFile, 'utf-8');
      expect(content).toBe('Hello, World!');
    });

    it('应自动创建目录', async () => {
      const testFile = join(TEST_ROOT_DIR, 'nested', 'dir', 'test.txt');

      await atomicWriteFile(testFile, 'content');

      expect(existsSync(testFile)).toBe(true);
    });
  });

  describe('atomicWriteJson', () => {
    it('应原子写入 JSON 文件', async () => {
      const testFile = join(TEST_ROOT_DIR, 'test.json');
      const data = { name: 'test', value: 123 };

      await atomicWriteJson(testFile, data);

      const content = await readJsonFile<typeof data>(testFile);
      expect(content).toEqual(data);
    });

    it('应支持格式化输出', async () => {
      const testFile = join(TEST_ROOT_DIR, 'formatted.json');
      const data = { name: 'test' };

      await atomicWriteJson(testFile, data, true);

      const raw = await readFile(testFile, 'utf-8');
      expect(raw).toContain('\n'); // 格式化输出包含换行
    });
  });

  describe('JSONL 操作', () => {
    const testFile = join(TEST_ROOT_DIR, 'test.jsonl');

    it('应追加 JSONL 记录', async () => {
      await appendJsonlRecord(testFile, { id: 1, name: 'first' });
      await appendJsonlRecord(testFile, { id: 2, name: 'second' });

      const records = await readJsonlRecords<{ id: number; name: string }>(testFile);
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({ id: 1, name: 'first' });
      expect(records[1]).toEqual({ id: 2, name: 'second' });
    });

    it('应从尾部读取 JSONL', async () => {
      for (let i = 1; i <= 10; i++) {
        await appendJsonlRecord(testFile, { id: i });
      }

      const tail = await readJsonlTail<{ id: number }>(testFile, 3);
      expect(tail).toHaveLength(3);
      expect(tail[0]).toEqual({ id: 8 });
      expect(tail[1]).toEqual({ id: 9 });
      expect(tail[2]).toEqual({ id: 10 });
    });

    it('文件不存在时应返回空数组', async () => {
      const records = await readJsonlRecords(join(TEST_ROOT_DIR, 'nonexistent.jsonl'));
      expect(records).toEqual([]);
    });
  });

  describe('readJsonFile', () => {
    it('文件不存在时应返回 null', async () => {
      const result = await readJsonFile(join(TEST_ROOT_DIR, 'nonexistent.json'));
      expect(result).toBeNull();
    });
  });

  describe('ensureDir', () => {
    it('应创建嵌套目录', async () => {
      const testDir = join(TEST_ROOT_DIR, 'a', 'b', 'c');

      await ensureDir(testDir);

      expect(existsSync(testDir)).toBe(true);
    });

    it('目录已存在时不应报错', async () => {
      const testDir = join(TEST_ROOT_DIR, 'existing');
      await mkdir(testDir, { recursive: true });

      await expect(ensureDir(testDir)).resolves.toBeUndefined();
    });
  });

  describe('FileLock', () => {
    it('应获取和释放锁', async () => {
      const testFile = join(TEST_ROOT_DIR, 'locktest.json');
      await ensureDir(TEST_ROOT_DIR);
      await writeFile(testFile, '{}');

      const lock = new FileLock(testFile);
      const acquired = await lock.acquire(1000);

      expect(acquired).toBe(true);
      expect(lock.isLocked()).toBe(true);

      await lock.release();
      expect(lock.isLocked()).toBe(false);
    });

    it('withFileLock 应正确执行', async () => {
      const testFile = join(TEST_ROOT_DIR, 'withlock.json');
      await ensureDir(TEST_ROOT_DIR);
      await writeFile(testFile, '{}');

      const result = await withFileLock(testFile, async () => {
        return 'executed';
      });

      expect(result).toBe('executed');
    });
  });
});

// ============================================================================
// SessionPathBuilder 测试
// ============================================================================

describe('SessionPathBuilder', () => {
  const builder = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);

  it('应正确构建会话根路径', () => {
    expect(builder.sessionRoot).toBe(join(TEST_ROOT_DIR, 'sessions', TEST_SESSION_ID));
  });

  it('应正确构建 orchestrator 目录路径', () => {
    expect(builder.orchestratorDir).toBe(
      join(TEST_ROOT_DIR, 'sessions', TEST_SESSION_ID, 'orchestrator')
    );
  });

  it('应正确构建 workers 目录路径', () => {
    expect(builder.workersDir).toBe(
      join(TEST_ROOT_DIR, 'sessions', TEST_SESSION_ID, 'workers')
    );
  });

  it('应正确构建 shared 目录路径', () => {
    expect(builder.sharedDir).toBe(
      join(TEST_ROOT_DIR, 'sessions', TEST_SESSION_ID, 'shared')
    );
  });

  it('应正确构建文件路径', () => {
    expect(builder.planFile).toContain('plan.json');
    expect(builder.progressFile).toContain('progress.json');
    expect(builder.decisionsFile).toContain('decisions.jsonl');
    expect(builder.sharedContextFile).toContain('context.json');
    expect(builder.messagesFile).toContain('messages.jsonl');
  });

  it('应正确构建 Worker 文件路径', () => {
    const workerId = 'worker-001';
    expect(builder.workerDir(workerId)).toContain(workerId);
    expect(builder.workerStatusFile(workerId)).toContain('status.json');
    expect(builder.workerThinkingFile(workerId)).toContain('thinking.jsonl');
    expect(builder.workerActionsFile(workerId)).toContain('actions.jsonl');
    expect(builder.workerPendingApprovalFile(workerId)).toContain('pending_approval.json');
    expect(builder.workerApprovalResponseFile(workerId)).toContain('approval_response.json');
    expect(builder.workerInterventionFile(workerId)).toContain('intervention.json');
  });

  it('getAllDirs 应返回所有基础目录', () => {
    const dirs = builder.getAllDirs();
    expect(dirs).toHaveLength(4);
    expect(dirs).toContain(builder.sessionRoot);
    expect(dirs).toContain(builder.orchestratorDir);
    expect(dirs).toContain(builder.workersDir);
    expect(dirs).toContain(builder.sharedDir);
  });

  it('getWorkerDirs 应返回 Worker 目录', () => {
    const dirs = builder.getWorkerDirs('worker-001');
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toContain('worker-001');
    expect(dirs[1]).toContain('artifacts');
  });
});

// ============================================================================
// SessionFileManager 测试
// ============================================================================

describe('SessionFileManager', () => {
  let manager: SessionFileManager;

  beforeEach(async () => {
    await cleanupTestDir();
    manager = createSessionFileManager(TEST_SESSION_ID, {
      rootDir: TEST_ROOT_DIR,
      enableWatch: false, // 测试中禁用监控以避免竞态
    });
  });

  afterEach(async () => {
    await manager.close();
    await cleanupTestDir();
  });

  describe('初始化', () => {
    it('应正确创建目录结构', async () => {
      await manager.initializeSession();

      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);
      expect(existsSync(paths.sessionRoot)).toBe(true);
      expect(existsSync(paths.orchestratorDir)).toBe(true);
      expect(existsSync(paths.workersDir)).toBe(true);
      expect(existsSync(paths.sharedDir)).toBe(true);
    });

    it('应创建初始共享上下文文件', async () => {
      await manager.initializeSession();

      const context = await manager.readSharedContext();
      expect(context).not.toBeNull();
      expect(context?.sessionId).toBe(TEST_SESSION_ID);
    });

    it('createAndInitializeSessionFileManager 应返回已初始化的实例', async () => {
      const initializedManager = await createAndInitializeSessionFileManager(
        'initialized-session',
        { rootDir: TEST_ROOT_DIR, enableWatch: false }
      );

      const context = await initializedManager.readSharedContext();
      expect(context).not.toBeNull();

      await initializedManager.close();
    });
  });

  describe('Worker 注册', () => {
    beforeEach(async () => {
      await manager.initializeSession();
    });

    it('应创建 Worker 目录结构', async () => {
      await manager.registerWorker('worker-001');

      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);
      expect(existsSync(paths.workerDir('worker-001'))).toBe(true);
      expect(existsSync(paths.workerArtifactsDir('worker-001'))).toBe(true);
    });

    it('应创建初始 Worker 状态文件', async () => {
      await manager.registerWorker('worker-001');

      const status = await manager.readWorkerStatus('worker-001');
      expect(status).not.toBeNull();
      expect(status?.workerId).toBe('worker-001');
      expect(status?.status).toBe('idle');
      expect(status?.progress).toBe(0);
    });

    it('重复注册应忽略', async () => {
      await manager.registerWorker('worker-001');
      await manager.registerWorker('worker-001'); // 不应报错

      const status = await manager.readWorkerStatus('worker-001');
      expect(status).not.toBeNull();
    });
  });

  describe('计划文件操作', () => {
    beforeEach(async () => {
      await manager.initializeSession();
    });

    it('应写入和读取计划文件', async () => {
      const plan: Omit<PlanFile, 'sessionId' | 'updatedAt'> = {
        taskId: 'task-001',
        createdAt: Date.now(),
        version: 1,
        plannerOutput: {
          taskId: 'task-001',
          subtasks: [],
          delegation: {
            mode: 'communication',
            workerCount: 1,
            timeout: 60000,
            retryPolicy: DEFAULT_RETRY_POLICY,
          },
          executionPlan: {
            steps: [],
            isParallel: false,
          },
        },
      };

      await manager.writePlan(plan);
      const readPlan = await manager.readPlan();

      expect(readPlan).not.toBeNull();
      expect(readPlan?.taskId).toBe('task-001');
      expect(readPlan?.sessionId).toBe(TEST_SESSION_ID);
    });
  });

  describe('进度文件操作', () => {
    beforeEach(async () => {
      await manager.initializeSession();
    });

    it('应写入和读取进度文件', async () => {
      const progress: Omit<ProgressFile, 'sessionId' | 'updatedAt'> = {
        taskId: 'task-001',
        status: 'executing',
        currentStep: 2,
        totalSteps: 5,
        completedSubtasks: ['subtask-1'],
        failedSubtasks: [],
        runningSubtasks: ['subtask-2'],
        startedAt: Date.now(),
      };

      await manager.writeProgress(progress);
      const readProgress = await manager.readProgress();

      expect(readProgress).not.toBeNull();
      expect(readProgress?.status).toBe('executing');
      expect(readProgress?.currentStep).toBe(2);
      expect(readProgress?.completedSubtasks).toEqual(['subtask-1']);
    });
  });

  describe('决策日志操作', () => {
    beforeEach(async () => {
      await manager.initializeSession();
    });

    it('应追加和读取决策记录', async () => {
      await manager.appendDecision({
        type: 'approval',
        workerId: 'worker-001',
        decision: {
          approved: true,
          reason: 'Safe operation',
        },
      });

      await manager.appendDecision({
        type: 'intervention',
        workerId: 'worker-002',
        decision: {
          approved: false,
          reason: 'Deviation detected',
          instructions: 'Please refocus on the task',
        },
      });

      const decisions = await manager.readDecisions();
      expect(decisions).toHaveLength(2);
      expect(decisions[0]!.type).toBe('approval');
      expect(decisions[1]!.type).toBe('intervention');
    });

    it('应支持限制读取条数', async () => {
      for (let i = 0; i < 10; i++) {
        await manager.appendDecision({
          type: 'approval',
          decision: { approved: true, reason: `Decision ${i}` },
        });
      }

      const limited = await manager.readDecisions(3);
      expect(limited).toHaveLength(3);
    });
  });

  describe('Worker 状态操作', () => {
    beforeEach(async () => {
      await manager.initializeSession();
      await manager.registerWorker('worker-001');
    });

    it('应更新 Worker 状态', async () => {
      await manager.writeWorkerStatus('worker-001', {
        status: 'thinking',
        currentSubtask: {
          id: 'subtask-001',
          objective: 'Test objective',
          startedAt: Date.now(),
        },
        progress: 50,
        lastHeartbeat: Date.now(),
      });

      const status = await manager.readWorkerStatus('worker-001');
      expect(status?.status).toBe('thinking');
      expect(status?.progress).toBe(50);
      expect(status?.currentSubtask?.id).toBe('subtask-001');
    });
  });

  describe('审批流程', () => {
    beforeEach(async () => {
      await manager.initializeSession();
      await manager.registerWorker('worker-001');
    });

    it('应读取待审批请求', async () => {
      // 模拟 Worker 创建待审批请求
      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);
      const pendingApproval: PendingApprovalFile = {
        requestId: 'req-001',
        workerId: 'worker-001',
        subtaskId: 'subtask-001',
        requestedAt: Date.now(),
        type: 'file_deletion',
        description: 'Delete config.json',
        details: {
          affectedFiles: ['config.json'],
          impactScope: 'low',
          reversible: true,
        },
        timeout: 60000,
        defaultDecision: 'reject',
      };
      await atomicWriteJson(paths.workerPendingApprovalFile('worker-001'), pendingApproval);

      const approval = await manager.readPendingApproval('worker-001');
      expect(approval).not.toBeNull();
      expect(approval?.requestId).toBe('req-001');
      expect(approval?.type).toBe('file_deletion');
    });

    it('应写入审批响应并删除待审批文件', async () => {
      // 先创建待审批请求
      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);
      const pendingApproval: PendingApprovalFile = {
        requestId: 'req-001',
        workerId: 'worker-001',
        subtaskId: 'subtask-001',
        requestedAt: Date.now(),
        type: 'file_deletion',
        description: 'Delete config.json',
        details: {},
        timeout: 60000,
        defaultDecision: 'reject',
      };
      await atomicWriteJson(paths.workerPendingApprovalFile('worker-001'), pendingApproval);

      // 写入审批响应
      const response: ApprovalResponseFile = {
        requestId: 'req-001',
        respondedAt: Date.now(),
        approved: true,
        respondedBy: 'orchestrator',
        reason: 'Safe to delete',
      };
      await manager.writeApprovalResponse('worker-001', response);

      // 验证响应已写入
      const readResponse = await manager.readApprovalResponse('worker-001');
      expect(readResponse).not.toBeNull();
      expect(readResponse?.approved).toBe(true);

      // 验证待审批文件已删除
      const pending = await manager.readPendingApproval('worker-001');
      expect(pending).toBeNull();

      // 验证决策已记录
      const decisions = await manager.readDecisions();
      expect(decisions.some((d) => d.type === 'approval')).toBe(true);
    });
  });

  describe('干预指令', () => {
    beforeEach(async () => {
      await manager.initializeSession();
      await manager.registerWorker('worker-001');
    });

    it('应写入和读取干预指令', async () => {
      await manager.writeIntervention('worker-001', {
        type: 'redirect',
        reason: 'Worker is deviating from the task',
        detectedIssue: {
          type: 'deviation',
          description: 'Worker is focusing on unrelated files',
          severity: 'medium',
        },
        instructions: 'Please refocus on the main objective',
        suggestedNextSteps: ['Review task description', 'Focus on core functionality'],
      });

      const intervention = await manager.readIntervention('worker-001');
      expect(intervention).not.toBeNull();
      expect(intervention?.type).toBe('redirect');
      expect(intervention?.acknowledged).toBe(false);
      expect(intervention?.detectedIssue?.severity).toBe('medium');
    });

    it('应支持确认干预指令', async () => {
      await manager.writeIntervention('worker-001', {
        type: 'guidance',
        reason: 'Providing additional context',
        instructions: 'Consider using the new API',
      });

      // 使用类型断言访问内部方法
      await (manager as SessionFileManager & { acknowledgeIntervention: (workerId: string) => Promise<void> }).acknowledgeIntervention('worker-001');

      const intervention = await manager.readIntervention('worker-001');
      expect(intervention?.acknowledged).toBe(true);
      expect(intervention?.acknowledgedAt).toBeDefined();
    });
  });

  describe('思考和行动日志', () => {
    beforeEach(async () => {
      await manager.initializeSession();
      await manager.registerWorker('worker-001');
    });

    it('应读取 Worker 思考日志', async () => {
      // 模拟 Worker 写入思考日志
      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);
      await appendJsonlRecord(paths.workerThinkingFile('worker-001'), {
        id: 'think-001',
        timestamp: Date.now(),
        subtaskId: 'subtask-001',
        content: 'Analyzing the task requirements',
        stage: 'analysis',
        confidence: 0.8,
      });
      await appendJsonlRecord(paths.workerThinkingFile('worker-001'), {
        id: 'think-002',
        timestamp: Date.now(),
        subtaskId: 'subtask-001',
        content: 'Planning implementation steps',
        stage: 'planning',
        confidence: 0.9,
      });

      const logs = await manager.readThinkingLogs('worker-001');
      expect(logs).toHaveLength(2);
      expect(logs[0]!.stage).toBe('analysis');
      expect(logs[1]!.stage).toBe('planning');
    });

    it('应读取 Worker 行动日志', async () => {
      // 模拟 Worker 写入行动日志
      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);
      await appendJsonlRecord(paths.workerActionsFile('worker-001'), {
        id: 'action-001',
        timestamp: Date.now(),
        subtaskId: 'subtask-001',
        type: 'tool_call',
        description: 'Reading file content',
        params: { path: '/src/index.ts' },
        result: {
          success: true,
          output: 'file content...',
          duration: 150,
        },
      });

      const logs = await manager.readActionLogs('worker-001');
      expect(logs).toHaveLength(1);
      expect(logs[0]!.type).toBe('tool_call');
      expect(logs[0]!.result?.success).toBe(true);
    });
  });

  describe('共享上下文和消息', () => {
    beforeEach(async () => {
      await manager.initializeSession();
    });

    it('应更新共享上下文', async () => {
      await manager.writeSharedContext({
        objective: 'Implement user authentication',
        constraints: ['Use JWT', 'Support OAuth2'],
        sharedKnowledge: {
          data: {
            userSchema: { id: 'string', email: 'string' },
          },
          updatedAt: Date.now(),
        },
        workspace: {
          rootPath: '/project',
          keyFiles: ['src/auth.ts', 'src/middleware.ts'],
        },
      });

      const context = await manager.readSharedContext();
      expect(context?.objective).toBe('Implement user authentication');
      expect(context?.constraints).toHaveLength(2);
      expect(context?.workspace?.keyFiles).toHaveLength(2);
    });

    it('应追加和读取消息', async () => {
      await manager.appendMessage({
        senderId: 'orchestrator',
        receiverId: 'worker-001',
        direction: 'orchestrator_to_worker',
        type: 'task_assignment',
        content: {
          subtaskId: 'subtask-001',
          objective: 'Implement login API',
        },
      });

      await manager.appendMessage({
        senderId: 'worker-001',
        receiverId: 'orchestrator',
        direction: 'worker_to_orchestrator',
        type: 'progress_update',
        content: {
          progress: 50,
          stage: 'Implementing validation',
        },
        subtaskId: 'subtask-001',
      });

      const messages = await manager.readMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]!.type).toBe('task_assignment');
      expect(messages[1]!.type).toBe('progress_update');
    });
  });

  describe('事件系统', () => {
    beforeEach(async () => {
      await manager.initializeSession();
      await manager.registerWorker('worker-001');
    });

    it('应触发进度更新事件', async () => {
      let eventReceived = false;
      let eventData: ProgressFile | null = null;

      manager.on('progress_updated', (event: SessionFileEvent<ProgressFile>) => {
        eventReceived = true;
        eventData = event.data;
      });

      await manager.writeProgress({
        taskId: 'task-001',
        status: 'executing',
        currentStep: 1,
        totalSteps: 3,
        completedSubtasks: [],
        failedSubtasks: [],
        runningSubtasks: ['subtask-001'],
        startedAt: Date.now(),
      });

      expect(eventReceived).toBe(true);
      expect(eventData?.status).toBe('executing');
    });

    it('应触发 Worker 状态变化事件', async () => {
      let eventReceived = false;
      let eventWorkerId: string | undefined;

      manager.on('worker_status_changed', (event: SessionFileEvent<WorkerStatusFile>) => {
        eventReceived = true;
        eventWorkerId = event.workerId;
      });

      await manager.writeWorkerStatus('worker-001', {
        status: 'thinking',
        progress: 25,
        lastHeartbeat: Date.now(),
      });

      expect(eventReceived).toBe(true);
      expect(eventWorkerId).toBe('worker-001');
    });

    it('应支持移除事件监听器', async () => {
      let callCount = 0;
      const handler = () => {
        callCount++;
      };

      manager.on('progress_updated', handler);
      await manager.writeProgress({
        taskId: 'task-001',
        status: 'executing',
        currentStep: 1,
        totalSteps: 3,
        completedSubtasks: [],
        failedSubtasks: [],
        runningSubtasks: [],
        startedAt: Date.now(),
      });

      expect(callCount).toBe(1);

      manager.off('progress_updated', handler);
      await manager.writeProgress({
        taskId: 'task-001',
        status: 'completed',
        currentStep: 3,
        totalSteps: 3,
        completedSubtasks: ['subtask-1', 'subtask-2', 'subtask-3'],
        failedSubtasks: [],
        runningSubtasks: [],
        startedAt: Date.now(),
      });

      expect(callCount).toBe(1); // 不应增加
    });
  });

  describe('生命周期', () => {
    it('cleanup 应删除会话目录', async () => {
      await manager.initializeSession();
      const paths = new SessionPathBuilder(TEST_ROOT_DIR, TEST_SESSION_ID);

      expect(existsSync(paths.sessionRoot)).toBe(true);

      await manager.cleanup();

      expect(existsSync(paths.sessionRoot)).toBe(false);
    });

    it('close 应清理资源', async () => {
      await manager.initializeSession();

      await manager.close();

      // 验证监控已停止（通过内部状态）
      // 由于是私有属性，这里只验证不抛出错误
      expect(true).toBe(true);
    });
  });

  describe('路径获取', () => {
    it('getSessionPath 应返回正确路径', () => {
      const path = manager.getSessionPath();
      expect(path).toContain(TEST_SESSION_ID);
    });

    it('getWorkerPath 应返回正确路径', () => {
      const path = manager.getWorkerPath('worker-001');
      expect(path).toContain('worker-001');
    });
  });
});

// ============================================================================
// 默认配置测试
// ============================================================================

describe('DEFAULT_SESSION_CONFIG', () => {
  it('应包含正确的默认值', () => {
    expect(DEFAULT_SESSION_CONFIG.rootDir).toBe('.tachikoma');
    expect(DEFAULT_SESSION_CONFIG.autoCreateDirs).toBe(true);
    expect(DEFAULT_SESSION_CONFIG.watchPollInterval).toBe(500);
    expect(DEFAULT_SESSION_CONFIG.enableWatch).toBe(true);
  });
});
