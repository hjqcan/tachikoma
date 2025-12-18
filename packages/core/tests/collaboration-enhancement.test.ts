/**
 * Collaboration 增强功能单元测试
 *
 * 测试 WorkerPool.getWorkersByCapability() 和 Orchestrator 协作路由
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DefaultWorkerPool } from '../src/orchestrator/worker-pool';
import type { WorkerInfo } from '../src/orchestrator/types';

describe('WorkerPool.getWorkersByCapability', () => {
  let pool: DefaultWorkerPool;

  beforeEach(() => {
    pool = new DefaultWorkerPool({
      minWorkers: 1,
      maxWorkers: 10,
      idleTimeout: 60000,
      selectionStrategy: 'least-loaded',
      healthCheckInterval: 60000,
    });
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  test('should return empty array when no workers registered', () => {
    const result = pool.getWorkersByCapability(['code']);
    expect(result).toHaveLength(0);
  });

  test('should return all idle workers when no capability filter', () => {
    // 注册空闲 Worker
    const mockAgent = {
      id: 'w1',
      type: 'worker' as const,
      config: { provider: 'mock', model: 'mock', maxTokens: 0 },
      run: async () => ({ taskId: '', status: 'success' as const, output: {}, artifacts: [], metrics: { startTime: 0, endTime: 0, duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 }, trace: { traceId: '', spanId: '', operation: '', attributes: {}, events: [], duration: 0 } }),
      stop: async () => {},
    };

    pool.register({ id: 'worker-1', status: 'idle', capabilities: ['code'], agent: mockAgent });
    pool.register({ id: 'worker-2', status: 'idle', capabilities: ['review'], priority: 8, agent: mockAgent });
    pool.register({ id: 'worker-3', status: 'busy', capabilities: ['test'], agent: mockAgent });

    const result = pool.getWorkersByCapability();
    expect(result).toHaveLength(2); // 只返回空闲的
  });

  test('should filter by capability', () => {
    const mockAgent = {
      id: 'w1',
      type: 'worker' as const,
      config: { provider: 'mock', model: 'mock', maxTokens: 0 },
      run: async () => ({ taskId: '', status: 'success' as const, output: {}, artifacts: [], metrics: { startTime: 0, endTime: 0, duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 }, trace: { traceId: '', spanId: '', operation: '', attributes: {}, events: [], duration: 0 } }),
      stop: async () => {},
    };

    pool.register({ id: 'worker-1', status: 'idle', capabilities: ['code', 'review'], agent: mockAgent });
    pool.register({ id: 'worker-2', status: 'idle', capabilities: ['test'], agent: mockAgent });

    const result = pool.getWorkersByCapability(['code']);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('worker-1');
  });

  test('should sort by priority descending', () => {
    const mockAgent = {
      id: 'w1',
      type: 'worker' as const,
      config: { provider: 'mock', model: 'mock', maxTokens: 0 },
      run: async () => ({ taskId: '', status: 'success' as const, output: {}, artifacts: [], metrics: { startTime: 0, endTime: 0, duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 }, trace: { traceId: '', spanId: '', operation: '', attributes: {}, events: [], duration: 0 } }),
      stop: async () => {},
    };

    pool.register({ id: 'worker-low', status: 'idle', capabilities: ['code'], priority: 3, agent: mockAgent });
    pool.register({ id: 'worker-high', status: 'idle', capabilities: ['code'], priority: 9, agent: mockAgent });
    pool.register({ id: 'worker-mid', status: 'idle', capabilities: ['code'], priority: 5, agent: mockAgent });

    const result = pool.getWorkersByCapability(['code']);
    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe('worker-high');
    expect(result[1]?.id).toBe('worker-mid');
    expect(result[2]?.id).toBe('worker-low');
  });

  test('should use default priority 5 when not specified', () => {
    const mockAgent = {
      id: 'w1',
      type: 'worker' as const,
      config: { provider: 'mock', model: 'mock', maxTokens: 0 },
      run: async () => ({ taskId: '', status: 'success' as const, output: {}, artifacts: [], metrics: { startTime: 0, endTime: 0, duration: 0, tokensUsed: 0, toolCallCount: 0, retryCount: 0 }, trace: { traceId: '', spanId: '', operation: '', attributes: {}, events: [], duration: 0 } }),
      stop: async () => {},
    };

    pool.register({ id: 'worker-1', status: 'idle', capabilities: ['code'], priority: 3, agent: mockAgent });
    pool.register({ id: 'worker-2', status: 'idle', capabilities: ['code'], agent: mockAgent }); // 无 priority，默认 5

    const result = pool.getWorkersByCapability(['code']);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('worker-2'); // priority 5 > 3
    expect(result[1]?.id).toBe('worker-1');
  });
});
