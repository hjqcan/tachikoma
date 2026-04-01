/**
 * 可观测性模块类型定义
 *
 * 定义 Logger、Tracer、Span、MetricsCollector 等核心接口
 *
 * 扩展性说明：
 * - Logger: 可替换为 pino/winston 实现
 * - Tracer: 接口兼容 OpenTelemetry，可替换为 OTEL TracerProvider
 * - MetricsCollector: 可替换为 Prometheus/OTEL Metrics exporter
 *
 * 实现时只需提供公共工厂函数（如 createTracer），
 * 并在 createObservability 中注入即可替换全局实现。
 *
 * @packageDocumentation
 */

// ============================================================================
// Logger 类型
// ============================================================================

/**
 * 日志级别
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 日志上下文，用于关联追踪
 */
export interface LogContext {
  /** 追踪 ID */
  traceId?: string;
  /** Span ID */
  spanId?: string;
  /** 任务 ID */
  taskId?: string;
  /** Worker ID */
  workerId?: string;
  /** 子任务 ID */
  subtaskId?: string;
  /** 其他上下文数据 */
  [key: string]: unknown;
}

/**
 * 结构化日志条目
 */
export interface LogEntry {
  /** 日志级别 */
  level: LogLevel;
  /** 时间戳 (ISO 格式) */
  ts: string;
  /** 日志消息 */
  msg: string;
  /** 追踪 ID */
  traceId?: string;
  /** Span ID */
  spanId?: string;
  /** 任务 ID */
  taskId?: string;
  /** Worker ID */
  workerId?: string;
  /** 其他字段 */
  [key: string]: unknown;
}

/**
 * Logger 接口
 */
export interface Logger {
  /** 调试日志 */
  debug(msg: string, context?: LogContext): void;
  /** 信息日志 */
  info(msg: string, context?: LogContext): void;
  /** 警告日志 */
  warn(msg: string, context?: LogContext): void;
  /** 错误日志 */
  error(msg: string, context?: LogContext): void;
  /** 创建子 Logger，附加固定上下文 */
  child(context: LogContext): Logger;
}

/**
 * Logger 配置
 */
export interface LoggerConfig {
  /** 最低日志级别 */
  level?: LogLevel;
  /** 是否启用 */
  enabled?: boolean;
  /** 固定上下文 */
  context?: LogContext;
}

// ============================================================================
// Tracer / Span 类型
// ============================================================================

/**
 * Span 状态
 */
export type SpanStatus = 'unset' | 'ok' | 'error';

/**
 * Span 选项
 */
export interface SpanOptions {
  /** 父 Span ID */
  parentSpanId?: string;
  /** 追踪 ID（复用已有追踪） */
  traceId?: string;
  /** 初始属性 */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Span 事件
 */
export interface SpanEvent {
  /** 事件名称 */
  name: string;
  /** 时间戳 */
  timestamp: number;
  /** 事件属性 */
  attributes?: Record<string, unknown>;
}

/**
 * Span 接口
 */
export interface Span {
  /** Span ID */
  readonly spanId: string;
  /** 追踪 ID */
  readonly traceId: string;
  /** Span 名称 */
  readonly name: string;
  /** 开始时间 */
  readonly startTime: number;
  /** 添加标签 */
  addTag(key: string, value: string | number | boolean): void;
  /** 添加事件 */
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  /** 设置状态 */
  setStatus(status: SpanStatus, message?: string): void;
  /** 结束 Span */
  end(): void;
  /** 获取持续时间（仅在 end() 后可用） */
  getDuration(): number | undefined;
}

/**
 * Span 快照（用于导出）
 */
export interface SpanSnapshot {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

/**
 * Tracer 接口
 */
export interface Tracer {
  /** 创建新 Span */
  startSpan(name: string, options?: SpanOptions): Span;
  /** 获取当前追踪 ID */
  getCurrentTraceId(): string | undefined;
  /** 设置当前追踪 ID */
  setCurrentTraceId(traceId: string): void;
}

/**
 * Tracer 配置
 *
 * 扩展说明：未来可添加 exporter 字段指向 OTLP endpoint，
 * 通过 createTracer 工厂函数根据配置创建对应实现。
 */
export interface TracerConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 服务名称 */
  serviceName?: string;
  /**
   * 输出级别（仅对 ConsoleTracer 生效）
   * - 'full': 输出 span_start, span_event, span_end
   * - 'end-only': 仅输出 span_end（默认）
   * - 'none': 不输出（但仍生成 spanId/traceId）
   */
  outputLevel?: 'full' | 'end-only' | 'none';
}

// ============================================================================
// Metrics 类型
// ============================================================================

/**
 * Metric 类型
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Metric 标签
 */
export type MetricTags = Record<string, string>;

/**
 * Counter 指标值
 */
export interface CounterValue {
  type: 'counter';
  value: number;
}

/**
 * Gauge 指标值
 */
export interface GaugeValue {
  type: 'gauge';
  value: number;
}

/**
 * Histogram 指标值
 */
export interface HistogramValue {
  type: 'histogram';
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  /** 百分位数 (p50, p90, p99) */
  percentiles?: {
    p50?: number;
    p90?: number;
    p99?: number;
  };
}

/**
 * Metric 值联合类型
 */
export type MetricValue = CounterValue | GaugeValue | HistogramValue;

/**
 * Metrics 快照
 */
export interface MetricsSnapshot {
  /** 快照时间戳 */
  timestamp: number;
  /** 指标数据，key 格式为 "name{tag1=v1,tag2=v2}" */
  metrics: Record<string, MetricValue>;
}

/**
 * MetricsCollector 接口
 */
export interface MetricsCollector {
  /** 递增计数器 */
  increment(name: string, value?: number, tags?: MetricTags): void;
  /** 记录时间（添加到 histogram） */
  timing(name: string, duration: number, tags?: MetricTags): void;
  /** 设置 gauge 值 */
  gauge(name: string, value: number, tags?: MetricTags): void;
  /** 获取当前快照 */
  getMetrics(): MetricsSnapshot;
  /** 重置所有指标 */
  reset(): void;
}

/**
 * MetricsCollector 配置
 *
 * 注意：MemoryMetrics 保留最近 1000 个 histogram 样本。
 * 长时间运行建议定期调用 reset() 或导出 snapshot 后清空。
 * 未来可添加 maxAge/maxSamples 配置项。
 *
 * 扩展说明：可替换为 Prometheus/OTEL Metrics exporter。
 */
export interface MetricsCollectorConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 默认标签 */
  defaultTags?: MetricTags;
}

// ============================================================================
// 预定义指标名称
// ============================================================================

/**
 * 预定义的 Worker 指标
 */
export const WORKER_METRICS = {
  /** 执行持续时间 */
  EXECUTION_DURATION: 'worker.execution.duration',
  /** 工具调用次数 */
  TOOL_CALLS_COUNT: 'worker.tool_calls.count',
  /** 工具预检不匹配次数（工具提示/能力漂移） */
  TOOL_PREFLIGHT_MISMATCH_COUNT: 'worker.tool_preflight.mismatch_count',
  /** synthetic tool_result 次数 */
  TOOL_SYNTHETIC_RESULT_COUNT: 'worker.tool.synthetic_result_count',
  /** recoverable 工具错误次数（tool_result + isError） */
  TOOL_RECOVERABLE_ERROR_COUNT: 'worker.tool.recoverable_error_count',
  /** fatal 工具错误次数（error message） */
  TOOL_FATAL_ERROR_COUNT: 'worker.tool.fatal_error_count',
  /** todo FSM 非法转移次数（strict 阻断 + warn 告警） */
  TODO_FSM_INVALID_TRANSITION_COUNT: 'todo.fsm.invalid_transition_count',
  /** 思考轮次 */
  THINKING_ROUNDS: 'worker.thinking.rounds',
  /** Token 使用量 */
  TOKENS_USED: 'worker.tokens.used',
  /** 审批等待时间 */
  APPROVAL_WAIT_DURATION: 'worker.approval.wait_duration',
  /** 错误次数 */
  ERRORS_COUNT: 'worker.errors.count',
} as const;

/**
 * 预定义的 Orchestrator 指标
 */
export const ORCHESTRATOR_METRICS = {
  /** resume/replan 命中幂等 replay guard 次数 */
  TODO_RESUME_IDEMPOTENT_REPLAY_COUNT: 'todo.resume.idempotent_replay_count',
  /** 中间态探测触发次数 */
  MID_SMOKE_TRIGGER_COUNT: 'orchestrator.mid_smoke.trigger_count',
  /** 中间态探测失败次数（预留） */
  MID_SMOKE_FAIL_COUNT: 'orchestrator.mid_smoke.fail_count',
  /** session compaction 触发次数 */
  SESSION_COMPACTION_COUNT: 'session.compaction.count',
  /** compaction 摘要与 todo 快照 hash 冲突次数 */
  SESSION_COMPACTION_TODO_MISMATCH_COUNT: 'session.compaction.todo_mismatch_count',
  /** 任务闭环成功率（滚动比率） */
  TASK_CLOSURE_SUCCESS_RATE: 'task.closure.success_rate',
} as const;

/**
 * 预定义的 Sandbox 指标
 */
export const SANDBOX_METRICS = {
  /** 命令执行持续时间 */
  COMMAND_DURATION: 'sandbox.command.duration',
  /** 命令执行次数 */
  COMMAND_COUNT: 'sandbox.command.count',
  /** 代码执行持续时间 */
  EXECUTE_DURATION: 'sandbox.execute.duration',
  /** 文件读取次数 */
  FILE_READ_COUNT: 'sandbox.file.read_count',
  /** 文件写入次数 */
  FILE_WRITE_COUNT: 'sandbox.file.write_count',
  /** 错误次数 */
  ERRORS_COUNT: 'sandbox.errors.count',
} as const;

// ============================================================================
// 工厂选项
// ============================================================================

/**
 * 可观测性配置（组合）
 */
export interface ObservabilityConfig {
  logger?: LoggerConfig;
  tracer?: TracerConfig;
  metrics?: MetricsCollectorConfig;
}

/**
 * 可观测性实例（组合）
 */
export interface Observability {
  logger: Logger;
  tracer: Tracer;
  metrics: MetricsCollector;
}
