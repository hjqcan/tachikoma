/**
 * 可观测性模块测试
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  ConsoleLogger,
  NoopLogger,
  createLogger,
  NoopTracer,
  ConsoleTracer,
  createTracer,
  MemoryMetrics,
  NoopMetrics,
  createMetrics,
  createObservability,
  noopObservability,
  WORKER_METRICS,
  SANDBOX_METRICS,
} from '../src/observability';

// ============================================================================
// Logger 测试
// ============================================================================

describe('ConsoleLogger', () => {
  it('应支持不同日志级别', () => {
    const logger = new ConsoleLogger({ level: 'debug', enabled: true });

    // 通过不抛出错误验证方法可用
    expect(() => logger.debug('debug message')).not.toThrow();
    expect(() => logger.info('info message')).not.toThrow();
    expect(() => logger.warn('warn message')).not.toThrow();
    expect(() => logger.error('error message')).not.toThrow();
  });

  it('应支持日志上下文', () => {
    const logger = new ConsoleLogger({ level: 'debug', enabled: true });

    expect(() =>
      logger.info('message', {
        traceId: 'trace-123',
        spanId: 'span-456',
        workerId: 'worker-001',
      })
    ).not.toThrow();
  });

  it('应支持创建子 Logger', () => {
    const logger = new ConsoleLogger({ level: 'info', enabled: true });
    const childLogger = logger.child({ workerId: 'worker-001' });

    expect(childLogger).toBeDefined();
    expect(() => childLogger.info('child message')).not.toThrow();
  });

  it('disabled时不应输出', () => {
    const logger = new ConsoleLogger({ enabled: false });

    // 不抛出错误即可
    expect(() => logger.info('should not output')).not.toThrow();
  });
});

describe('NoopLogger', () => {
  it('所有方法都不应抛出错误', () => {
    const logger = new NoopLogger();

    expect(() => logger.debug('msg')).not.toThrow();
    expect(() => logger.info('msg')).not.toThrow();
    expect(() => logger.warn('msg')).not.toThrow();
    expect(() => logger.error('msg')).not.toThrow();
    expect(() => logger.child({})).not.toThrow();
  });
});

describe('createLogger', () => {
  it('默认创建 ConsoleLogger', () => {
    const logger = createLogger();
    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it('enabled=false 时创建 NoopLogger', () => {
    const logger = createLogger({ enabled: false });
    expect(logger).toBeInstanceOf(NoopLogger);
  });
});

// ============================================================================
// Tracer 测试
// ============================================================================

describe('NoopTracer', () => {
  it('应创建有效的 Span', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('test-span');

    expect(span.spanId).toBeDefined();
    expect(span.spanId.length).toBe(16);
    expect(span.traceId).toBeDefined();
    expect(span.traceId.length).toBe(32);
    expect(span.name).toBe('test-span');
  });

  it('应支持 Span 操作', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('test-span');

    expect(() => span.addTag('key', 'value')).not.toThrow();
    expect(() => span.addEvent('event-name', { data: 'test' })).not.toThrow();
    expect(() => span.setStatus('ok')).not.toThrow();
    expect(() => span.end()).not.toThrow();

    expect(span.getDuration()).toBeDefined();
  });

  it('应复用设置的 traceId', () => {
    const tracer = new NoopTracer();
    tracer.setCurrentTraceId('custom-trace-id-12345678');

    expect(tracer.getCurrentTraceId()).toBe('custom-trace-id-12345678');
  });

  it('应支持父 Span', () => {
    const tracer = new NoopTracer();
    const parentSpan = tracer.startSpan('parent');
    const childSpan = tracer.startSpan('child', {
      parentSpanId: parentSpan.spanId,
      traceId: parentSpan.traceId,
    });

    expect(childSpan.traceId).toBe(parentSpan.traceId);
  });
});

describe('ConsoleTracer', () => {
  it('应创建有效的 Span', () => {
    const tracer = new ConsoleTracer();
    const span = tracer.startSpan('console-span');

    expect(span.spanId).toBeDefined();
    expect(span.traceId).toBeDefined();
    span.end();
  });
});

describe('createTracer', () => {
  it('默认创建 NoopTracer', () => {
    const tracer = createTracer();
    expect(tracer).toBeInstanceOf(NoopTracer);
  });

  it('useConsole=true 时创建 ConsoleTracer', () => {
    const tracer = createTracer({}, true);
    expect(tracer).toBeInstanceOf(ConsoleTracer);
  });

  it('enabled=false 时创建 NoopTracer', () => {
    const tracer = createTracer({ enabled: false }, true);
    expect(tracer).toBeInstanceOf(NoopTracer);
  });
});

// ============================================================================
// Metrics 测试
// ============================================================================

describe('MemoryMetrics', () => {
  let metrics: MemoryMetrics;

  beforeEach(() => {
    metrics = new MemoryMetrics();
  });

  describe('counter', () => {
    it('应正确递增计数器', () => {
      metrics.increment('test.counter');
      metrics.increment('test.counter');
      metrics.increment('test.counter', 5);

      const snapshot = metrics.getMetrics();
      expect(snapshot.metrics['test.counter']).toEqual({
        type: 'counter',
        value: 7,
      });
    });

    it('应支持带 tags 的计数器', () => {
      metrics.increment('test.counter', 1, { env: 'prod' });
      metrics.increment('test.counter', 1, { env: 'dev' });

      const snapshot = metrics.getMetrics();
      expect(snapshot.metrics['test.counter{env=prod}']).toEqual({
        type: 'counter',
        value: 1,
      });
      expect(snapshot.metrics['test.counter{env=dev}']).toEqual({
        type: 'counter',
        value: 1,
      });
    });
  });

  describe('gauge', () => {
    it('应正确设置 gauge 值', () => {
      metrics.gauge('test.gauge', 42);
      metrics.gauge('test.gauge', 100);

      const snapshot = metrics.getMetrics();
      expect(snapshot.metrics['test.gauge']).toEqual({
        type: 'gauge',
        value: 100, // 最后设置的值
      });
    });
  });

  describe('histogram (timing)', () => {
    it('应正确记录时间分布', () => {
      metrics.timing('test.duration', 100);
      metrics.timing('test.duration', 200);
      metrics.timing('test.duration', 300);

      const snapshot = metrics.getMetrics();
      const histogram = snapshot.metrics['test.duration'];

      expect(histogram.type).toBe('histogram');
      if (histogram.type === 'histogram') {
        expect(histogram.count).toBe(3);
        expect(histogram.sum).toBe(600);
        expect(histogram.min).toBe(100);
        expect(histogram.max).toBe(300);
        expect(histogram.avg).toBe(200);
        expect(histogram.percentiles?.p50).toBeDefined();
      }
    });
  });

  describe('reset', () => {
    it('应清空所有指标', () => {
      metrics.increment('counter', 10);
      metrics.gauge('gauge', 50);
      metrics.timing('timing', 100);

      metrics.reset();

      const snapshot = metrics.getMetrics();
      expect(Object.keys(snapshot.metrics)).toHaveLength(0);
    });
  });

  describe('disabled', () => {
    it('disabled时不应收集指标', () => {
      const disabledMetrics = new MemoryMetrics({ enabled: false });
      disabledMetrics.increment('test');
      disabledMetrics.gauge('test', 100);
      disabledMetrics.timing('test', 50);

      const snapshot = disabledMetrics.getMetrics();
      expect(Object.keys(snapshot.metrics)).toHaveLength(0);
    });
  });
});

describe('NoopMetrics', () => {
  it('所有方法都不应抛出错误', () => {
    const metrics = new NoopMetrics();

    expect(() => metrics.increment('test')).not.toThrow();
    expect(() => metrics.gauge('test', 100)).not.toThrow();
    expect(() => metrics.timing('test', 50)).not.toThrow();
    expect(() => metrics.reset()).not.toThrow();

    const snapshot = metrics.getMetrics();
    expect(Object.keys(snapshot.metrics)).toHaveLength(0);
  });
});

describe('createMetrics', () => {
  it('默认创建 MemoryMetrics', () => {
    const metrics = createMetrics();
    expect(metrics).toBeInstanceOf(MemoryMetrics);
  });

  it('enabled=false 时创建 NoopMetrics', () => {
    const metrics = createMetrics({ enabled: false });
    expect(metrics).toBeInstanceOf(NoopMetrics);
  });
});

// ============================================================================
// 组合工厂测试
// ============================================================================

describe('createObservability', () => {
  it('应创建完整的可观测性实例', () => {
    const obs = createObservability();

    expect(obs.logger).toBeDefined();
    expect(obs.tracer).toBeDefined();
    expect(obs.metrics).toBeDefined();
  });
});

describe('noopObservability', () => {
  it('应提供 no-op 实例', () => {
    expect(noopObservability.logger).toBeInstanceOf(NoopLogger);
    expect(noopObservability.metrics).toBeInstanceOf(NoopMetrics);
  });
});

// ============================================================================
// 预定义指标名称测试
// ============================================================================

describe('预定义指标名称', () => {
  it('WORKER_METRICS 应包含预期字段', () => {
    expect(WORKER_METRICS.EXECUTION_DURATION).toBe('worker.execution.duration');
    expect(WORKER_METRICS.TOOL_CALLS_COUNT).toBe('worker.tool_calls.count');
    expect(WORKER_METRICS.THINKING_ROUNDS).toBe('worker.thinking.rounds');
    expect(WORKER_METRICS.TOKENS_USED).toBe('worker.tokens.used');
    expect(WORKER_METRICS.ERRORS_COUNT).toBe('worker.errors.count');
  });

  it('SANDBOX_METRICS 应包含预期字段', () => {
    expect(SANDBOX_METRICS.COMMAND_DURATION).toBe('sandbox.command.duration');
    expect(SANDBOX_METRICS.COMMAND_COUNT).toBe('sandbox.command.count');
    expect(SANDBOX_METRICS.FILE_READ_COUNT).toBe('sandbox.file.read_count');
    expect(SANDBOX_METRICS.FILE_WRITE_COUNT).toBe('sandbox.file.write_count');
  });
});
