/**
 * @tachikoma/core 基础测试
 */

import { describe, expect, it } from 'bun:test';
import { VERSION } from '../src/index';
import type { AgentConfig, Task, TaskResult, Config } from '../src/types';

describe('@tachikoma/core', () => {
  describe('版本信息', () => {
    it('应导出正确的版本号', () => {
      expect(VERSION).toBe('0.1.0');
    });
  });

  describe('类型定义', () => {
    it('AgentConfig 类型应包含必需字段', () => {
      const config: AgentConfig = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        maxTokens: 8192,
      };

      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe('claude-opus-4');
      expect(config.maxTokens).toBe(8192);
    });

    it('Task 类型应包含必需字段', () => {
      const task: Task = {
        id: 'task-1',
        type: 'atomic',
        objective: '测试任务',
        constraints: ['限制1', '限制2'],
      };

      expect(task.id).toBe('task-1');
      expect(task.type).toBe('atomic');
      expect(task.objective).toBe('测试任务');
      expect(task.constraints).toHaveLength(2);
    });

    it('TaskResult 类型应包含必需字段', () => {
      const result: TaskResult = {
        taskId: 'task-1',
        status: 'success',
        output: { data: 'test' },
        artifacts: [],
        metrics: {
          startTime: Date.now(),
          endTime: Date.now() + 1000,
          duration: 1000,
          tokensUsed: 500,
          toolCallCount: 3,
          retryCount: 0,
        },
        trace: {
          traceId: 'trace-1',
          spanId: 'span-1',
          operation: 'test',
          attributes: {},
          events: [],
          duration: 1000,
        },
      };

      expect(result.status).toBe('success');
      expect(result.metrics.duration).toBe(1000);
    });
  });
});

describe('配置默认值测试', () => {
  it('Config 类型应支持完整配置', () => {
    const config: Config = {
      models: {
        orchestrator: {
          provider: 'anthropic',
          model: 'claude-opus-4',
          maxTokens: 8192,
        },
        worker: {
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          maxTokens: 4096,
        },
        planner: {
          provider: 'anthropic',
          model: 'claude-haiku-3.5',
          maxTokens: 2048,
        },
      },
      context: {
        hardLimit: 1_000_000,
        rotThreshold: 200_000,
        compactionTrigger: 128_000,
        summarizationTrigger: 150_000,
        preserveRecentToolCalls: 5,
      },
      sandbox: {
        runtime: 'bun',
        timeout: 1800_000,
        resources: {
          cpu: '2',
          memory: '4G',
          storage: '10G',
        },
        network: {
          mode: 'restricted',
          allowlist: [],
        },
      },
      agentops: {
        tracing: {
          enabled: true,
          endpoint: 'http://localhost:4317',
          serviceName: 'tachikoma',
        },
        logging: {
          level: 'info',
          format: 'json',
        },
        metrics: {
          enabled: true,
          endpoint: '/metrics',
        },
      },
    };

    expect(config.models.orchestrator.provider).toBe('anthropic');
    expect(config.context.hardLimit).toBe(1_000_000);
    expect(config.sandbox.runtime).toBe('bun');
    expect(config.agentops.tracing.enabled).toBe(true);
  });
});
