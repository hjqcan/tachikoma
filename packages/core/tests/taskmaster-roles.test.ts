import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Orchestrator, type PlannerOutput, type ISessionFileManager } from '../src/orchestrator';
import { DefaultWorkerPool } from '../src/orchestrator/worker-pool';
import { BaseAgent } from '../src/abstracts/base-agent';
import { Planner, MockLLMClient } from '../src/planner';
import type { Task, TaskResult } from '../src/types';

const TEST_ROOT = resolve('.tachikoma-test-taskmaster-roles');

async function cleanup(): Promise<void> {
  if (existsSync(TEST_ROOT)) {
    await rm(TEST_ROOT, { recursive: true, force: true });
  }
}

function makeTasksJsonLegacy(tag: string): unknown {
  const now = new Date().toISOString();
  const makeTask = (id: string, title: string, description: string) => ({
    id,
    title,
    description,
    status: 'pending',
    priority: 'medium',
    dependencies: [],
    details: '',
    testStrategy: '',
    subtasks: [],
    createdAt: now,
    updatedAt: now,
  });

  return {
    [tag]: {
      tasks: [
        makeTask('1', 'Setup React project', 'React + Tailwind project structure'),
        makeTask('2', 'Create Python backend API', 'FastAPI mock endpoints for music data'),
        makeTask('3', 'Write unit tests', 'Use Jest/pytest for unit and integration tests'),
      ],
      metadata: {
        version: '1.0.0',
        lastModified: now,
        taskCount: 3,
        completedCount: 0,
        tags: [tag],
      },
    },
  };
}

function createNoopSessionManager(): ISessionFileManager {
  // 最小可用的 no-op SessionFileManager：避免在单测里落盘 runtime/progress 等 session 文件
  const noop = async () => undefined;
  const noopNull = async () => null;
  const noopArr = async () => [];

  return {
    sessionId: 'test-session',
    config: { rootDir: TEST_ROOT, autoCreateDirs: false, enableWatch: false, watchPollInterval: 1000 },
    initializeSession: noop,
    registerWorker: noop,
    startWatching: noop,
    stopWatching: () => undefined,
    close: noop,

    getSessionPath: () => join(TEST_ROOT, 'sessions', 'test-session'),
    getWorkerPath: (workerId: string) => join(TEST_ROOT, 'sessions', 'test-session', 'workers', workerId),

    writeRuntime: noop,
    readRuntime: noopNull,
    readOrchestratorRuntime: noopNull,
    writeProgress: noop,
    readProgress: noopNull,
    appendDecision: noop,
    readDecisions: noopArr,
    readWorkerStatus: noopNull,
    writeWorkerStatus: noop,
    readPendingApproval: noopNull,
    writeApprovalResponse: noop,
    readApprovalResponse: noopNull,
    writeIntervention: noop,
    readIntervention: noopNull,
    readThinkingLogs: noopArr,
    readActionLogs: noopArr,
    readSharedContext: noopNull,
    writeSharedContext: noop,
    appendMessage: noop,
    readMessages: noopArr,

    on: () => undefined,
    off: () => undefined,
  } as unknown as ISessionFileManager;
}

// Helper Mock Agent
class MockWorkerAgent extends BaseAgent {
  constructor(id: string) {
    super(id, 'worker', { 
        name: id, 
        description: 'Mock Worker',
        model: 'mock',
        provider: 'mock',
        temperature: 0,
        maxTokens: 100
    });
  }

  protected async executeTask(task: Task, signal: AbortSignal): Promise<TaskResult> {
    return {
      taskId: task.id,
      status: 'success',
      output: { text: `Mock execution for ${task.objective}` },
      artifacts: [],
      metrics: { startTime: Date.now(), endTime: Date.now(), duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 },
      trace: { traceId: '', spanId: '', operation: 'mock-execute', attributes: {}, events: [], duration: 0 },
    };
  }
}

describe('taskmaster: roles + auto-assignment', () => {
  beforeEach(async () => {
    await cleanup();
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('应推理生成 frontend/backend/test 三角色，并为每个 subtask 分配 roleId，写回 tachikoma.taskmeta.json', async () => {
    const tag = 'conv-abc';
    const tasksPath = join(TEST_ROOT, '.taskmaster', 'tasks', 'tasks.json');
    await mkdir(join(TEST_ROOT, '.taskmaster', 'tasks'), { recursive: true });
    await writeFile(tasksPath, JSON.stringify(makeTasksJsonLegacy(tag), null, 2), 'utf-8');

    // 角色推理由 Planner.inferRolesForSubtasks() 完成，并写回 taskmeta（父任务级 role，子任务继承）

    const sessionManager = createNoopSessionManager();
    const roleInferenceResponse = JSON.stringify(
      {
        reasoning: 'Assign roles by domain.',
        roles: [
          {
            id: 'frontend',
            name: '前端工程师',
            responsibilities: '负责前端页面/组件实现与交互体验',
            capabilities: ['role:frontend'],
          },
          {
            id: 'backend',
            name: '后端工程师',
            responsibilities: '负责后端 API/服务与数据(mock)支持',
            capabilities: ['role:backend'],
          },
          {
            id: 'test',
            name: '测试工程师',
            responsibilities: '负责单元/集成/E2E 测试与质量验证',
            capabilities: ['role:test'],
          },
        ],
        assignments: {
          '1': { roleId: 'frontend', requiredCapabilities: ['role:frontend'] },
          '2': { roleId: 'backend', requiredCapabilities: ['role:backend'] },
          '3': { roleId: 'test', requiredCapabilities: ['role:test'] },
        },
      },
      null,
      2
    );
    const mockClient = new MockLLMClient({
      provider: 'mock',
      model: 'mock-model',
      maxTokens: 1000,
      responses: [
        {
          content: roleInferenceResponse,
          usage: { inputTokens: 50, outputTokens: 200 },
          model: 'mock-model',
        },
      ],
    });
    const planner = new Planner({ llmClient: mockClient });

    // P0 FIX: Pre-register mock workers to avoid real execution timeouts
    // Since we only test planning & role assignment, execution phase should be mocked.
    const workerPool = new DefaultWorkerPool({
      selectionStrategy: 'round-robin',
      maxWorkers: 3,
      minWorkers: 0,
      idleTimeout: 1000,
      healthCheckInterval: 5000,
    });
    
    // Register workers matching the expected roles
    const mockRoles = ['frontend', 'backend', 'test'];
    for (const roleId of mockRoles) {
       // Create a simple mock agent that succeeds immediately
       const mockAgent = new MockWorkerAgent(`worker-${roleId}`);
       workerPool.register({
         id: `worker-${roleId}`,
         status: 'idle',
         agent: mockAgent,
         capabilities: [`role:${roleId}`, roleId], // Ensure capability match
       });
    }

    const orchestrator = new Orchestrator('test-orch', {
      sessionManager,
      planner,
      workerPool,
      config: {
        checkpoint: { enabled: false },
        deviationDetection: { enabled: false },
      },
    });

    let capturedPlan: PlannerOutput | null = null;
    orchestrator.on('plan:complete', (evt) => {
      capturedPlan = (evt.data as { plan: PlannerOutput }).plan;
    });

    const task: Task = {
      id: 'task-001',
      type: 'composite',
      objective: 'anything',
      constraints: [],
      context: {
        sessionId: tag,
        parentTaskId: tag,
        metadata: {
          workDir: TEST_ROOT,
          planSource: 'taskmaster',
          taskmaster: { tag },
          planner: { mode: 'full' },
        },
      },
    };

    const result = await orchestrator.run(task);
    expect(result.status).toBeDefined();
    expect(capturedPlan).not.toBeNull();

    const plan = capturedPlan!;
    const roleIds = (plan.roles ?? []).map((r) => r.id);
    expect(roleIds).toEqual(expect.arrayContaining(['frontend', 'backend', 'test']));

    for (const st of plan.subtasks) {
      expect(st.roleId).toBeDefined();
      expect(['frontend', 'backend', 'test']).toContain(st.roleId!);
      expect(st.requiredCapabilities ?? []).toContain(`role:${st.roleId!}`);
    }

    const metaPath = join(TEST_ROOT, 'tachikoma.taskmeta.json');
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    expect(meta.version).toBe(1);
    expect(meta.roles.assignments[tag]['1'].roleId).toBe('frontend');
    expect(meta.roles.assignments[tag]['2'].roleId).toBe('backend');
    expect(meta.roles.assignments[tag]['3'].roleId).toBe('test');

    await orchestrator.stop();
  });
});



