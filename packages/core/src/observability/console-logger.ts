/**
 * Console Logger 实现
 *
 * 轻量级 JSON 格式日志输出到 console
 */

import type { Logger, LoggerConfig, LogContext, LogLevel, LogEntry } from './types';

// 日志级别权重
const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * 默认 Logger 配置
 */
export const DEFAULT_LOGGER_CONFIG: Required<LoggerConfig> = {
  level: 'info',
  enabled: true,
  context: {},
};

/**
 * Console Logger 实现
 *
 * 输出 JSON 格式的结构化日志到 console
 */
export class ConsoleLogger implements Logger {
  private readonly config: Required<LoggerConfig>;

  constructor(config: LoggerConfig = {}) {
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };
  }

  debug(msg: string, context?: LogContext): void {
    this.log('debug', msg, context);
  }

  info(msg: string, context?: LogContext): void {
    this.log('info', msg, context);
  }

  warn(msg: string, context?: LogContext): void {
    this.log('warn', msg, context);
  }

  error(msg: string, context?: LogContext): void {
    this.log('error', msg, context);
  }

  child(context: LogContext): Logger {
    return new ConsoleLogger({
      ...this.config,
      context: { ...this.config.context, ...context },
    });
  }

  private log(level: LogLevel, msg: string, context?: LogContext): void {
    if (!this.config.enabled) return;
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.config.level]) return;

    const entry: LogEntry = {
      level,
      ts: new Date().toISOString(),
      msg,
      ...this.config.context,
      ...context,
    };

    // 输出到对应的 console 方法
    const output = JSON.stringify(entry);
    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }
}

/**
 * No-op Logger 实现
 *
 * 不产生任何输出，用于禁用日志或测试
 */
export class NoopLogger implements Logger {
  debug(_msg: string, _context?: LogContext): void {
    // no-op
  }

  info(_msg: string, _context?: LogContext): void {
    // no-op
  }

  warn(_msg: string, _context?: LogContext): void {
    // no-op
  }

  error(_msg: string, _context?: LogContext): void {
    // no-op
  }

  child(_context: LogContext): Logger {
    return this;
  }
}

/**
 * 默认 Logger 实例
 */
export const defaultLogger: Logger = new ConsoleLogger();

/**
 * No-op Logger 实例
 */
export const noopLogger: Logger = new NoopLogger();

/**
 * 创建 Logger
 */
export function createLogger(config?: LoggerConfig): Logger {
  if (config?.enabled === false) {
    return noopLogger;
  }
  return new ConsoleLogger(config);
}
