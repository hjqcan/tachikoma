/**
 * Worker 池模块测试
 *
 * 测试 Worker 注册/注销、选择策略、并发控制、超时取消等功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  DefaultWorkerPool,
  MockWorkerPool,
  createWorkerPool,
  createMockWorkerPool,
  type IWorkerPool,
  type WorkerPoolEvent,
  type AssignmentResult,
} from '../src/orchestrator/worker-pool';
import { DEFAULT_WORKER_POOL_CONFIG, DEFAULT_RETRY_POLICY } from '../src/orchestrator';
import type { WorkerInfo, SubTask, WorkerPoolConfig } from '../src/orchestrator';

// ============================================================================
// 测试辅助函数
// ============================================================================

/**
 * 创建测试用 Worker
 */
function createTestWorker(
  id: string,
  status: WorkerInfo['status'] = 'idle',
  capabilities: string[] = []
): WorkerInfo {
  return {
    id,
    status,
    capabilities,
    lastHeartbeat: Date.now(),
  };
}

/**
 * 创建测试用子任务
 */
function createTestSubtask(id: string, parentId = 'task-1'): SubTask {
  return {
    id,
    parentId,
    objective: `测试子任务 ${id}`,
    constraints: [],
    status: 'pending',
  };
}

/**
 * 等待指定时间
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 基础功能测试
// ============================================================================

describe('DefaultWorkerPool 基础功能', () => {
  let pool: DefaultWorkerPool;

  beforeEach(() => {
    pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe('配置访问', () => {
    it('应返回正确的配置副本', () => {
      expect(pool.config).toEqual(DEFAULT_WORKER_POOL_CONFIG);
      expect(pool.config).not.toBe(DEFAULT_WORKER_POOL_CONFIG);
    });

    it('初始状态应正确', () => {
      expect(pool.workerCount).toBe(0);
      expect(pool.idleWorkerCount).toBe(0);
      expect(pool.activeTaskCount).toBe(0);
    });
  });
});

// ============================================================================
// Worker 注册/注销测试
// ============================================================================

describe('Worker 注册与注销', () => {
  let pool: DefaultWorkerPool;

  beforeEach(() => {
    pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe('register()', () => {
    it('应成功注册 Worker', () => {
      const worker = createTestWorker('worker-1');
      const result = pool.register(worker);

      expect(result).toBe(true);
      expect(pool.workerCount).toBe(1);
      expect(pool.idleWorkerCount).toBe(1);
    });

    it('不应重复注册同一 Worker', () => {
      const worker = createTestWorker('worker-1');
      pool.register(worker);
      const result = pool.register(worker);

      expect(result).toBe(false);
      expect(pool.workerCount).toBe(1);
    });

    it('应触发 worker:registered 事件', () => {
      const events: WorkerPoolEvent[] = [];
      pool.on('worker:registered', (e) => events.push(e));

      pool.register(createTestWorker('worker-1'));

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('worker:registered');
      expect(events[0].workerId).toBe('worker-1');
    });

    it('超过 maxWorkers 时应拒绝注册并触发 pool:full 事件', () => {
      const config: WorkerPoolConfig = { ...DEFAULT_WORKER_POOL_CONFIG, maxWorkers: 2 };
      const testPool = new DefaultWorkerPool(config);

      const events: WorkerPoolEvent[] = [];
      testPool.on('pool:full', (e) => events.push(e));

      testPool.register(createTestWorker('worker-1'));
      testPool.register(createTestWorker('worker-2'));
      const result = testPool.register(createTestWorker('worker-3'));

      expect(result).toBe(false);
      expect(testPool.workerCount).toBe(2);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('pool:full');

      testPool.shutdown();
    });
  });

  describe('unregister()', () => {
    it('应成功注销 Worker', () => {
      pool.register(createTestWorker('worker-1'));
      const result = pool.unregister('worker-1');

      expect(result).toBe(true);
      expect(pool.workerCount).toBe(0);
    });

    it('注销不存在的 Worker 应返回 false', () => {
      const result = pool.unregister('non-existent');
      expect(result).toBe(false);
    });

    it('应触发 worker:unregistered 事件', () => {
      const events: WorkerPoolEvent[] = [];
      pool.on('worker:unregistered', (e) => events.push(e));

      pool.register(createTestWorker('worker-1'));
      pool.unregister('worker-1');

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('worker:unregistered');
    });

    it('注销最后一个 Worker 时应触发 pool:empty 事件', () => {
      const events: WorkerPoolEvent[] = [];
      pool.on('pool:empty', (e) => events.push(e));

      pool.register(createTestWorker('worker-1'));
      pool.unregister('worker-1');

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('pool:empty');
    });
  });

  describe('getWorker() / getAllWorkers()', () => {
    it('应返回 Worker 信息副本', () => {
      const worker = createTestWorker('worker-1');
      pool.register(worker);

      const retrieved = pool.getWorker('worker-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('worker-1');
      expect(retrieved).not.toBe(worker);
    });

    it('获取不存在的 Worker 应返回 undefined', () => {
      expect(pool.getWorker('non-existent')).toBeUndefined();
    });

    it('getAllWorkers 应返回所有 Worker 副本', () => {
      pool.register(createTestWorker('worker-1'));
      pool.register(createTestWorker('worker-2'));

      const workers = pool.getAllWorkers();
      expect(workers.length).toBe(2);
    });
  });

  describe('updateWorkerStatus()', () => {
    it('应成功更新 Worker 状态', () => {
      pool.register(createTestWorker('worker-1', 'idle'));
      const result = pool.updateWorkerStatus('worker-1', 'busy');

      expect(result).toBe(true);
      expect(pool.getWorker('worker-1')!.status).toBe('busy');
      expect(pool.idleWorkerCount).toBe(0);
    });

    it('更新不存在的 Worker 应返回 false', () => {
      const result = pool.updateWorkerStatus('non-existent', 'busy');
      expect(result).toBe(false);
    });

    it('状态改变时应触发 worker:status-changed 事件', () => {
      const events: WorkerPoolEvent[] = [];
      pool.on('worker:status-changed', (e) => events.push(e));

      pool.register(createTestWorker('worker-1', 'idle'));
      pool.updateWorkerStatus('worker-1', 'busy');

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('worker:status-changed');
      expect((events[0].data as { oldStatus: string }).oldStatus).toBe('idle');
      expect((events[0].data as { newStatus: string }).newStatus).toBe('busy');
    });

    it('应能更新负载信息', () => {
      pool.register(createTestWorker('worker-1'));
      pool.updateWorkerStatus('worker-1', 'idle', { cpu: 50, memory: 30 });

      const worker = pool.getWorker('worker-1');
      expect(worker!.load).toEqual({ cpu: 50, memory: 30 });
    });
  });
});

// ============================================================================
// Worker 选择策略测试
// ============================================================================

describe('Worker 选择策略', () => {
  describe('round-robin 策略', () => {
    it('应按顺序轮询选择 Worker', () => {
      const config: WorkerPoolConfig = {
        ...DEFAULT_WORKER_POOL_CONFIG,
        selectionStrategy: 'round-robin',
      };
      const pool = new DefaultWorkerPool(config);

      pool.register(createTestWorker('worker-1'));
      pool.register(createTestWorker('worker-2'));
      pool.register(createTestWorker('worker-3'));

      const selections: string[] = [];
      for (let i = 0; i < 6; i++) {
        const selected = pool.selectWorker();
        if (selected) selections.push(selected);
      }

      // 应该按顺序轮询
      expect(selections[0]).toBe(selections[3]);
      expect(selections[1]).toBe(selections[4]);
      expect(selections[2]).toBe(selections[5]);

      pool.shutdown();
    });
  });

  describe('least-loaded 策略', () => {
    it('应选择负载最低的 Worker', () => {
      const config: WorkerPoolConfig = {
        ...DEFAULT_WORKER_POOL_CONFIG,
        selectionStrategy: 'least-loaded',
      };
      const pool = new DefaultWorkerPool(config);

      pool.register(createTestWorker('worker-1'));
      pool.register(createTestWorker('worker-2'));
      pool.register(createTestWorker('worker-3'));

      // 设置不同负载
      pool.updateWorkerStatus('worker-1', 'idle', { cpu: 80, memory: 70 });
      pool.updateWorkerStatus('worker-2', 'idle', { cpu: 20, memory: 30 });
      pool.updateWorkerStatus('worker-3', 'idle', { cpu: 50, memory: 50 });

      // 应选择负载最低的 worker-2
      const selected = pool.selectWorker();
      expect(selected).toBe('worker-2');

      pool.shutdown();
    });

    it('无负载信息时应视为最低负载', () => {
      const config: WorkerPoolConfig = {
        ...DEFAULT_WORKER_POOL_CONFIG,
        selectionStrategy: 'least-loaded',
      };
      const pool = new DefaultWorkerPool(config);

      pool.register(createTestWorker('worker-1'));
      pool.register(createTestWorker('worker-2'));
      pool.updateWorkerStatus('worker-2', 'idle', { cpu: 50, memory: 50 });

      // worker-1 无负载信息，应被优先选择
      const selected = pool.selectWorker();
      expect(selected).toBe('worker-1');

      pool.shutdown();
    });
  });

  describe('random 策略', () => {
    it('应随机选择 Worker', () => {
      const config: WorkerPoolConfig = {
        ...DEFAULT_WORKER_POOL_CONFIG,
        selectionStrategy: 'random',
      };
      const pool = new DefaultWorkerPool(config);

      pool.register(createTestWorker('worker-1'));
      pool.register(createTestWorker('worker-2'));
      pool.register(createTestWorker('worker-3'));

      const selections = new Set<string>();
      for (let i = 0; i < 30; i++) {
        const selected = pool.selectWorker();
        if (selected) selections.add(selected);
      }

      // 30 次选择应该覆盖所有 Worker（概率非常高）
      expect(selections.size).toBeGreaterThanOrEqual(2);

      pool.shutdown();
    });
  });

  describe('capability-match 策略', () => {
    it('应选择能力匹配的 Worker', () => {
      const config: WorkerPoolConfig = {
        ...DEFAULT_WORKER_POOL_CONFIG,
        selectionStrategy: 'capability-match',
      };
      const pool = new DefaultWorkerPool(config);

      pool.register(createTestWorker('worker-1', 'idle', ['python', 'ml']));
      pool.register(createTestWorker('worker-2', 'idle', ['javascript', 'web']));
      pool.register(createTestWorker('worker-3', 'idle', ['python', 'web', 'ml']));

      // 需要 python 和 ml 能力
      const selected = pool.selectWorker(['python', 'ml']);
      
      // 应选择 worker-1 或 worker-3（两者都匹配）
      expect(['worker-1', 'worker-3']).toContain(selected);

      pool.shutdown();
    });

    it('同等匹配度下应选择负载较低的', () => {
      const config: WorkerPoolConfig = {
        ...DEFAULT_WORKER_POOL_CONFIG,
        selectionStrategy: 'capability-match',
      };
      const pool = new DefaultWorkerPool(config);

      pool.register(createTestWorker('worker-1', 'idle', ['python']));
      pool.register(createTestWorker('worker-2', 'idle', ['python']));

      pool.updateWorkerStatus('worker-1', 'idle', { cpu: 80 });
      pool.updateWorkerStatus('worker-2', 'idle', { cpu: 20 });

      const selected = pool.selectWorker(['python']);
      expect(selected).toBe('worker-2');

      pool.shutdown();
    });
  });

  describe('通用行为', () => {
    it('无可用 Worker 时应返回 undefined', () => {
      const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
      expect(pool.selectWorker()).toBeUndefined();
      pool.shutdown();
    });

    it('只应选择空闲 Worker', () => {
      const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);

      pool.register(createTestWorker('worker-1', 'busy'));
      pool.register(createTestWorker('worker-2', 'draining'));
      pool.register(createTestWorker('worker-3', 'offline'));

      expect(pool.selectWorker()).toBeUndefined();

      pool.shutdown();
    });

    it('应根据能力过滤 Worker', () => {
      const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);

      pool.register(createTestWorker('worker-1', 'idle', ['python']));
      pool.register(createTestWorker('worker-2', 'idle', ['javascript']));

      const selected = pool.selectWorker(['rust']);
      expect(selected).toBeUndefined();

      pool.shutdown();
    });
  });
});

// ============================================================================
// 任务分配测试
// ============================================================================

describe('任务分配', () => {
  let pool: DefaultWorkerPool;

  beforeEach(() => {
    pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));
    pool.register(createTestWorker('worker-2'));
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe('assign()', () => {
    it('应成功分配任务', async () => {
      const subtask = createTestSubtask('subtask-1');
      const result = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      expect(result.success).toBe(true);
      expect(result.workerId).toBeDefined();
      expect(result.cancel).toBeDefined();
      expect(pool.activeTaskCount).toBe(1);
    });

    it('分配后 Worker 状态应变为 busy', async () => {
      const subtask = createTestSubtask('subtask-1');
      const result = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      const worker = pool.getWorker(result.workerId!);
      expect(worker!.status).toBe('busy');
      expect(worker!.currentTaskId).toBe('subtask-1');
    });

    it('应触发 task:assigned 事件', async () => {
      const events: WorkerPoolEvent[] = [];
      pool.on('task:assigned', (e) => events.push(e));

      const subtask = createTestSubtask('subtask-1');
      await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('task:assigned');
      expect(events[0].taskId).toBe('subtask-1');
    });

    it('无可用 Worker 时应返回失败', async () => {
      // 把所有 Worker 设为忙碌
      pool.updateWorkerStatus('worker-1', 'busy');
      pool.updateWorkerStatus('worker-2', 'busy');

      const subtask = createTestSubtask('subtask-1');
      const result = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No available workers');
    });

    it('shutdown 后应拒绝分配', async () => {
      await pool.shutdown();

      const subtask = createTestSubtask('subtask-1');
      const result = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Worker pool is shutdown');
    });
  });

  describe('cancelTask()', () => {
    it('应成功取消任务', async () => {
      const subtask = createTestSubtask('subtask-1');
      await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      const result = pool.cancelTask('subtask-1');

      expect(result).toBe(true);
      expect(pool.activeTaskCount).toBe(0);
    });

    it('取消后 Worker 状态应恢复为 idle', async () => {
      const subtask = createTestSubtask('subtask-1');
      const assignResult = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      pool.cancelTask('subtask-1');

      const worker = pool.getWorker(assignResult.workerId!);
      expect(worker!.status).toBe('idle');
      expect(worker!.currentTaskId).toBeUndefined();
    });

    it('应触发 task:cancelled 事件', async () => {
      const events: WorkerPoolEvent[] = [];
      pool.on('task:cancelled', (e) => events.push(e));

      const subtask = createTestSubtask('subtask-1');
      await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);
      pool.cancelTask('subtask-1');

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('task:cancelled');
      expect(events[0].taskId).toBe('subtask-1');
    });

    it('取消不存在的任务应返回 false', () => {
      const result = pool.cancelTask('non-existent');
      expect(result).toBe(false);
    });

    it('通过返回的 cancel 函数取消任务', async () => {
      const subtask = createTestSubtask('subtask-1');
      const result = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      result.cancel!();

      expect(pool.activeTaskCount).toBe(0);
    });
  });

  describe('completeTask()', () => {
    it('应成功完成任务', async () => {
      const subtask = createTestSubtask('subtask-1');
      const assignResult = await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

      const result = pool.completeTask('subtask-1');

      expect(result).toBe(true);
      expect(pool.activeTaskCount).toBe(0);

      const worker = pool.getWorker(assignResult.workerId!);
      expect(worker!.status).toBe('idle');
    });

    it('完成不存在的任务应返回 false', () => {
      const result = pool.completeTask('non-existent');
      expect(result).toBe(false);
    });
  });
});

// ============================================================================
// 超时控制测试
// ============================================================================

describe('超时控制', () => {
  it('超时应触发 task:timeout 事件并取消任务', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));

    const events: WorkerPoolEvent[] = [];
    pool.on('task:timeout', (e) => events.push(e));
    pool.on('task:cancelled', (e) => events.push(e));

    const subtask = createTestSubtask('subtask-1');
    // 设置 100ms 超时
    await pool.assign(subtask, 100, DEFAULT_RETRY_POLICY);

    // 等待超时触发
    await sleep(150);

    expect(events.some((e) => e.type === 'task:timeout')).toBe(true);
    expect(events.some((e) => e.type === 'task:cancelled')).toBe(true);
    expect(pool.activeTaskCount).toBe(0);

    await pool.shutdown();
  });

  it('任务完成后不应触发超时', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));

    const events: WorkerPoolEvent[] = [];
    pool.on('task:timeout', (e) => events.push(e));

    const subtask = createTestSubtask('subtask-1');
    await pool.assign(subtask, 200, DEFAULT_RETRY_POLICY);

    // 立即完成任务
    pool.completeTask('subtask-1');

    // 等待超时时间过去
    await sleep(250);

    expect(events.length).toBe(0);

    await pool.shutdown();
  });

  it('任务取消后不应触发超时', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));

    const events: WorkerPoolEvent[] = [];
    pool.on('task:timeout', (e) => events.push(e));

    const subtask = createTestSubtask('subtask-1');
    await pool.assign(subtask, 200, DEFAULT_RETRY_POLICY);

    // 立即取消任务
    pool.cancelTask('subtask-1');

    // 等待超时时间过去
    await sleep(250);

    // 只有取消事件，没有超时事件
    expect(events.filter((e) => e.type === 'task:timeout').length).toBe(0);

    await pool.shutdown();
  });
});

// ============================================================================
// 事件系统测试
// ============================================================================

describe('事件系统', () => {
  let pool: DefaultWorkerPool;

  beforeEach(() => {
    pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('on() 应注册事件处理器', () => {
    const events: WorkerPoolEvent[] = [];
    pool.on('worker:registered', (e) => events.push(e));

    pool.register(createTestWorker('worker-1'));

    expect(events.length).toBe(1);
  });

  it('off() 应移除事件处理器', () => {
    const events: WorkerPoolEvent[] = [];
    const handler = (e: WorkerPoolEvent) => events.push(e);

    pool.on('worker:registered', handler);
    pool.off('worker:registered', handler);

    pool.register(createTestWorker('worker-1'));

    expect(events.length).toBe(0);
  });

  it('同一事件可注册多个处理器', () => {
    let count = 0;
    pool.on('worker:registered', () => count++);
    pool.on('worker:registered', () => count++);

    pool.register(createTestWorker('worker-1'));

    expect(count).toBe(2);
  });

  it('处理器错误不应影响其他处理器', () => {
    let secondCalled = false;

    pool.on('worker:registered', () => {
      throw new Error('Test error');
    });
    pool.on('worker:registered', () => {
      secondCalled = true;
    });

    pool.register(createTestWorker('worker-1'));

    expect(secondCalled).toBe(true);
  });
});

// ============================================================================
// 生命周期测试
// ============================================================================

describe('生命周期', () => {
  it('shutdown 应取消所有活跃任务', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));
    pool.register(createTestWorker('worker-2'));

    await pool.assign(createTestSubtask('subtask-1'), 30000, DEFAULT_RETRY_POLICY);
    await pool.assign(createTestSubtask('subtask-2'), 30000, DEFAULT_RETRY_POLICY);

    expect(pool.activeTaskCount).toBe(2);

    await pool.shutdown();

    expect(pool.activeTaskCount).toBe(0);
    expect(pool.workerCount).toBe(0);
  });

  it('shutdown 后应拒绝新的注册', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    await pool.shutdown();

    const result = pool.register(createTestWorker('worker-1'));
    expect(result).toBe(false);
  });
});

// ============================================================================
// MockWorkerPool 测试
// ============================================================================

describe('MockWorkerPool', () => {
  it('应创建指定数量的初始 Worker', () => {
    const pool = createMockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 3,
    });

    expect(pool.workerCount).toBe(3);

    pool.shutdown();
  });

  it('应自动完成任务', async () => {
    const pool = createMockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 2,
      taskDelay: 50,
    });

    const subtask = createTestSubtask('subtask-1');
    await pool.assign(subtask, 30000, DEFAULT_RETRY_POLICY);

    // 等待任务自动完成
    await sleep(100);

    expect(pool.activeTaskCount).toBe(0);
    expect(pool.idleWorkerCount).toBe(2);

    await pool.shutdown();
  });

  it('应记录已分配的任务', async () => {
    const pool = createMockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 2,
    });

    const subtask1 = createTestSubtask('subtask-1');
    const subtask2 = createTestSubtask('subtask-2');

    await pool.assign(subtask1, 30000, DEFAULT_RETRY_POLICY);
    await pool.assign(subtask2, 30000, DEFAULT_RETRY_POLICY);

    const assigned = pool.getAssignedTasks();
    expect(assigned.length).toBe(2);
    expect(pool.getAssignedTask('subtask-1')).toBeDefined();
    expect(pool.getAssignedTask('subtask-2')).toBeDefined();

    await pool.shutdown();
  });

  it('支持自定义执行器', async () => {
    const executedTasks: string[] = [];

    const pool = createMockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 1,
      taskDelay: 10,
      executor: async (subtask) => {
        executedTasks.push(subtask.id);
      },
    });

    await pool.assign(createTestSubtask('subtask-1'), 30000, DEFAULT_RETRY_POLICY);
    await sleep(50);

    expect(executedTasks).toContain('subtask-1');

    await pool.shutdown();
  });

  it('执行器抛错时任务不应完成', async () => {
    const pool = createMockWorkerPool({
      config: DEFAULT_WORKER_POOL_CONFIG,
      initialWorkers: 1,
      taskDelay: 10,
      executor: async () => {
        throw new Error('Executor error');
      },
    });

    await pool.assign(createTestSubtask('subtask-1'), 30000, DEFAULT_RETRY_POLICY);
    await sleep(50);

    // 任务未完成，仍在活跃状态
    expect(pool.activeTaskCount).toBe(1);

    await pool.shutdown();
  });
});

// ============================================================================
// 工厂函数测试
// ============================================================================

describe('工厂函数', () => {
  describe('createWorkerPool()', () => {
    it('应创建 DefaultWorkerPool 实例', () => {
      const pool = createWorkerPool(DEFAULT_WORKER_POOL_CONFIG);

      expect(pool).toBeInstanceOf(DefaultWorkerPool);
      expect(pool.config).toEqual(DEFAULT_WORKER_POOL_CONFIG);

      pool.shutdown();
    });
  });

  describe('createMockWorkerPool()', () => {
    it('应创建 MockWorkerPool 实例', () => {
      const pool = createMockWorkerPool({
        config: DEFAULT_WORKER_POOL_CONFIG,
        initialWorkers: 2,
      });

      expect(pool).toBeInstanceOf(MockWorkerPool);
      expect(pool.workerCount).toBe(2);

      pool.shutdown();
    });
  });
});

// ============================================================================
// 并发控制测试
// ============================================================================

describe('并发控制', () => {
  it('应限制最大 Worker 数量', () => {
    const config: WorkerPoolConfig = {
      ...DEFAULT_WORKER_POOL_CONFIG,
      maxWorkers: 3,
    };
    const pool = new DefaultWorkerPool(config);

    pool.register(createTestWorker('worker-1'));
    pool.register(createTestWorker('worker-2'));
    pool.register(createTestWorker('worker-3'));
    const result = pool.register(createTestWorker('worker-4'));

    expect(result).toBe(false);
    expect(pool.workerCount).toBe(3);

    pool.shutdown();
  });

  it('应正确追踪活跃任务数', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));
    pool.register(createTestWorker('worker-2'));
    pool.register(createTestWorker('worker-3'));

    await pool.assign(createTestSubtask('subtask-1'), 30000, DEFAULT_RETRY_POLICY);
    expect(pool.activeTaskCount).toBe(1);

    await pool.assign(createTestSubtask('subtask-2'), 30000, DEFAULT_RETRY_POLICY);
    expect(pool.activeTaskCount).toBe(2);

    pool.completeTask('subtask-1');
    expect(pool.activeTaskCount).toBe(1);

    pool.cancelTask('subtask-2');
    expect(pool.activeTaskCount).toBe(0);

    await pool.shutdown();
  });

  it('应正确追踪空闲 Worker 数', async () => {
    const pool = new DefaultWorkerPool(DEFAULT_WORKER_POOL_CONFIG);
    pool.register(createTestWorker('worker-1'));
    pool.register(createTestWorker('worker-2'));

    expect(pool.idleWorkerCount).toBe(2);

    await pool.assign(createTestSubtask('subtask-1'), 30000, DEFAULT_RETRY_POLICY);
    expect(pool.idleWorkerCount).toBe(1);

    await pool.assign(createTestSubtask('subtask-2'), 30000, DEFAULT_RETRY_POLICY);
    expect(pool.idleWorkerCount).toBe(0);

    pool.completeTask('subtask-1');
    expect(pool.idleWorkerCount).toBe(1);

    await pool.shutdown();
  });
});
