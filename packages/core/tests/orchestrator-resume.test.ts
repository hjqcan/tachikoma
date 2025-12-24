import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Orchestrator } from '../src/orchestrator';
import { DefaultWorkerPool } from '../src/orchestrator/worker-pool';
import { createAndInitializeSessionFileManager, CheckpointManager } from '../src/orchestrator/session';
import { BaseAgent } from '../src/abstracts/base-agent';
import type { Task, TaskResult } from '../src/types';

const SESSION_ROOT = resolve('.tachikoma-test-orchestrator-resume');
const PROJECT_ROOT = resolve('.tachikoma-test-orchestrator-resume-project');

async function cleanup(): Promise<void> {
  for (const dir of [SESSION_ROOT, PROJECT_ROOT]) {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function makeTasksJsonLegacy(tag: string): unknown {
  const now = new Date().toISOString();
  return {
    [tag]: {
      tasks: [
        {
          id: '1',
          title: 'Parent Task',
          description: 'Parent Task',
          status: 'pending',
          priority: 'medium',
          dependencies: [],
          details: '',
          testStrategy: '',
          subtasks: [
            {
              id: 1,
              title: 'Child Task 1',
              description: 'Child Task 1',
              status: 'pending',
              priority: 'medium',
              dependencies: [],
              details: '',
              testStrategy: '',
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
      metadata: {
        version: '1.0.0',
        lastModified: now,
        taskCount: 1,
        completedCount: 0,
        tags: [tag],
      },
    },
  };
}

class MockWorkerAgent extends BaseAgent {
  constructor(id: string) {
    super(id, 'worker', {
      name: id,
      description: 'Mock Worker',
      provider: 'mock',
      model: 'mock',
      temperature: 0,
      maxTokens: 100,
    });
  }

  protected async executeTask(task: Task, _signal: AbortSignal): Promise<TaskResult> {
    return {
      taskId: task.id,
      status: 'success',
      output: { text: `ok: ${task.objective}` },
      artifacts: [],
      metrics: { startTime: Date.now(), endTime: Date.now(), duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 },
      trace: { traceId: '', spanId: '', operation: 'mock', attributes: {}, events: [], duration: 0 },
    };
  }
}

describe('Orchestrator.resumeFrom (checkpoint)', () => {
  beforeEach(async () => {
    await cleanup();
    await mkdir(SESSION_ROOT, { recursive: true });
    await mkdir(PROJECT_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('应能从 checkpoint 恢复并继续执行 resumable 子任务（含 barrier 结点）', async () => {
    const sessionId = 'conv-resume';
    const tasksPath = join(PROJECT_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(PROJECT_ROOT, '.taskmaster', 'tasks'), { recursive: true });
    await writeFile(tasksPath, JSON.stringify(makeTasksJsonLegacy(sessionId), null, 2), 'utf-8');

    // 父任务级 role 预置（避免单测依赖 LLM 推理）
    await writeFile(
      join(PROJECT_ROOT, 'tachikoma.taskmeta.json'),
      JSON.stringify(
        {
          version: 1,
          roles: {
            assignments: {
              [sessionId]: {
                '1': { roleId: 'generalist', requiredCapabilities: ['role:generalist'] },
              },
            },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    // === 先在 session 内创建 runtime + checkpoint（模拟上一次 run 已落盘）===
    const sessionManager = await createAndInitializeSessionFileManager(sessionId, {
      rootDir: SESSION_ROOT,
      enableWatch: false,
      autoCreateDirs: true,
    });

    await sessionManager.writeRuntime({
      kind: 'taskmaster',
      taskId: 'task-001',
      createdAt: Date.now(),
      version: 1,
      tasksJson: { path: '.taskmaster/tasks/tasks.json', tag: sessionId },
      executionPlan: {
        steps: [
          { order: 1, subtaskIds: ['1.1'], parallel: false },
          { order: 2, subtaskIds: ['1'], parallel: false },
        ],
        isParallel: false,
      },
    });

    const ckptMgr = new CheckpointManager(sessionId, sessionManager, {
      rootDir: SESSION_ROOT,
      autoSave: false,
    });

    const checkpoint = await ckptMgr.saveCheckpoint({
      taskId: 'task-001',
      planStatus: 'executing',
      currentStep: 0,
      totalSteps: 2,
      completedSubtaskIds: [],
      failedSubtaskIds: [],
      runningSubtaskIds: [],
      subtaskSnapshots: [
        { id: '1.1', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
        { id: '1', status: 'pending', progress: 0, retryCount: 0, lastUpdatedAt: Date.now() },
      ],
      completedResults: {},
      totalRetries: 0,
      totalTokens: 0,
      executionPlan: {
        steps: [
          { order: 1, subtaskIds: ['1.1'], parallel: false },
          { order: 2, subtaskIds: ['1'], parallel: false },
        ],
      },
      contextData: { workDir: PROJECT_ROOT },
    });

    await ckptMgr.close();
    await sessionManager.close();

    // === 进行恢复 ===
    const workerPool = new DefaultWorkerPool({
      selectionStrategy: 'round-robin',
      maxWorkers: 2,
      minWorkers: 0,
      idleTimeout: 1000,
      healthCheckInterval: 5000,
    });
    workerPool.register({
      id: 'worker-generalist-0',
      status: 'idle',
      agent: new MockWorkerAgent('worker-generalist-0'),
      capabilities: ['role:generalist'],
    });

    const orchestrator = new Orchestrator('orch-resume-test', {
      workerPool,
      config: {
        session: { rootDir: SESSION_ROOT, enableWatch: false },
        checkpoint: { enabled: false },
        deviationDetection: { enabled: false },
      },
    });

    const result = await orchestrator.resumeFrom(checkpoint.id, { strategy: 'resume' });
    expect(result.status).toBe('success');

    // 校验 tasks.json 已被写回：1.1 done + barrier(1) done
    const tasksRaw = JSON.parse(await readFile(tasksPath, 'utf-8')) as any;
    const tasks = tasksRaw[sessionId]?.tasks ?? [];
    expect(tasks[0]?.subtasks?.[0]?.status).toBe('done');
    expect(tasks[0]?.status).toBe('done');

    await orchestrator.stop();
  });
});


