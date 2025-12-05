/**
 * JSON 日志中间件
 *
 * 提供结构化日志输出，支持追踪信息
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv, LogLevel, LogEntry } from '../types';
import { DEFAULT_CONFIG } from '../config';

// ============================================================================
// 日志级别优先级
// ============================================================================

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================================================
// 日志工具类
// ============================================================================

/**
 * Logger 类
 */
export class Logger {
  private level: LogLevel;
  private serviceName: string;

  constructor(level: LogLevel = 'info', serviceName: string = DEFAULT_CONFIG.SERVICE_NAME) {
    this.level = level;
    this.serviceName = serviceName;
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * 检查是否应该记录该级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  /**
   * 格式化日志条目为 JSON
   */
  private formatEntry(entry: LogEntry): string {
    return JSON.stringify({
      ...entry,
      service: this.serviceName,
    });
  }

  /**
   * 输出日志
   */
  private output(entry: LogEntry): void {
    const formatted = this.formatEntry(entry);

    switch (entry.level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  /**
   * 创建基础日志条目
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: Partial<LogEntry>
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };
  }

  /**
   * Debug 级别日志
   */
  debug(message: string, context?: Partial<LogEntry>): void {
    if (this.shouldLog('debug')) {
      this.output(this.createEntry('debug', message, context));
    }
  }

  /**
   * Info 级别日志
   */
  info(message: string, context?: Partial<LogEntry>): void {
    if (this.shouldLog('info')) {
      this.output(this.createEntry('info', message, context));
    }
  }

  /**
   * Warn 级别日志
   */
  warn(message: string, context?: Partial<LogEntry>): void {
    if (this.shouldLog('warn')) {
      this.output(this.createEntry('warn', message, context));
    }
  }

  /**
   * Error 级别日志
   */
  error(message: string, context?: Partial<LogEntry>): void {
    if (this.shouldLog('error')) {
      this.output(this.createEntry('error', message, context));
    }
  }

  /**
   * 记录 HTTP 请求
   */
  request(
    method: string,
    route: string,
    status: number,
    duration: number,
    context?: Partial<LogEntry>
  ): void {
    const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

    if (this.shouldLog(level)) {
      this.output(
        this.createEntry(level, `${method} ${route} ${status} ${duration}ms`, {
          method,
          route,
          status,
          duration,
          ...context,
        })
      );
    }
  }
}

// ============================================================================
// 全局 Logger 实例
// ============================================================================

/** 全局 Logger 实例 */
export const logger = new Logger();

// ============================================================================
// 日志中间件
// ============================================================================

/**
 * 日志中间件配置
 */
export interface LoggerMiddlewareOptions {
  /** 日志级别 */
  level?: LogLevel;
  /** 服务名称 */
  serviceName?: string;
  /** 跳过的路径模式 */
  skipPaths?: RegExp[];
  /** 是否记录请求体 */
  logRequestBody?: boolean;
  /** 是否记录响应体（仅 JSON 响应，自动截断和基础脱敏） */
  logResponseBody?: boolean;
  /** 记录体内容的最大长度（字符），默认 1000 */
  maxBodyLogLength?: number;
}

/**
 * 创建日志中间件
 *
 * 功能:
 * - 记录每个请求的 JSON 结构化日志
 * - 包含追踪信息（traceId, spanId, requestId）
 * - 记录请求持续时间
 * - 支持跳过特定路径
 */
/**
 * 基础敏感数据脱敏（用于日志记录）
 * 注意：这是简化版本，完整脱敏应使用 output-filter 中的函数
 */
function basicSanitizeForLog(text: string): string {
  return text
    // 脱敏密码字段
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[REDACTED]"')
    // 脱敏 token 字段
    .replace(/"(?:token|secret|key|apiKey|api_key)"\s*:\s*"[^"]*"/gi, (match) => {
      const fieldName = match.match(/"([^"]+)"\s*:/)?.[1] || 'field';
      return `"${fieldName}":"[REDACTED]"`;
    })
    // 脱敏 Authorization header
    .replace(/"[Aa]uthorization"\s*:\s*"[^"]*"/gi, '"Authorization":"[REDACTED]"');
}

export function loggerMiddleware(options: LoggerMiddlewareOptions = {}) {
  const {
    level = 'info',
    serviceName = DEFAULT_CONFIG.SERVICE_NAME,
    skipPaths = [/^\/health$/],
    logRequestBody = false,
    logResponseBody = false,
    maxBodyLogLength = 1000,
  } = options;

  const middlewareLogger = new Logger(level, serviceName);

  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path;

    // 检查是否跳过该路径
    if (skipPaths.some((pattern) => pattern.test(path))) {
      await next();
      return;
    }

    const method = c.req.method;
    const userAgent = c.req.header('user-agent');
    const contentType = c.req.header('content-type');

    // 记录请求开始（debug 级别）
    middlewareLogger.debug('Request started', {
      method,
      route: path,
      traceId: c.get('traceId'),
      spanId: c.get('spanId'),
      requestId: c.get('requestId'),
      userAgent,
      contentType,
    });

    // 如果需要记录请求体
    if (logRequestBody && contentType?.includes('application/json')) {
      try {
        const body = await c.req.raw.clone().json();
        const bodyStr = JSON.stringify(body);
        const sanitized = basicSanitizeForLog(bodyStr);
        const truncated = sanitized.length > maxBodyLogLength
          ? sanitized.slice(0, maxBodyLogLength) + '...[truncated]'
          : sanitized;

        middlewareLogger.debug('Request body', {
          traceId: c.get('traceId'),
          requestId: c.get('requestId'),
          body: truncated,
          originalLength: bodyStr.length,
        });
      } catch {
        // 忽略解析错误
      }
    }

    // 执行下一个中间件
    await next();

    // 计算持续时间
    const requestStart = c.get('requestStart');
    const duration = requestStart ? Date.now() - requestStart : 0;

    // 获取响应状态
    const status = c.res.status;

    // 记录响应体（如果启用且是 JSON 响应）
    if (logResponseBody) {
      const resContentType = c.res.headers.get('content-type') || '';
      if (resContentType.includes('application/json')) {
        try {
          // 克隆响应以避免消耗原始响应
          const clonedResponse = c.res.clone();
          const bodyStr = await clonedResponse.text();

          // 基础脱敏和截断
          const sanitized = basicSanitizeForLog(bodyStr);
          const truncated = sanitized.length > maxBodyLogLength
            ? sanitized.slice(0, maxBodyLogLength) + '...[truncated]'
            : sanitized;

          middlewareLogger.debug('Response body', {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
            body: truncated,
            originalLength: bodyStr.length,
            status,
          });
        } catch {
          // 忽略读取错误
        }
      }
    }

    // 记录请求完成
    const userId = c.get('user')?.id;
    middlewareLogger.request(method, path, status, duration, {
      traceId: c.get('traceId'),
      spanId: c.get('spanId'),
      requestId: c.get('requestId'),
      ...(userId && { userId }),
      ...(userAgent && { userAgent }),
    });

    // 如果有错误，记录错误详情
    if (c.error) {
      middlewareLogger.error('Request error', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        error: c.error.message,
        stack: c.error.stack,
      });
    }
  });
}

// ============================================================================
// 请求体大小限制中间件
// ============================================================================

import { ERROR_CODES } from '../config';

/**
 * 请求体大小限制中间件配置
 */
export interface BodyLimitMiddlewareOptions {
  /** 最大请求体大小（字节） */
  maxSize?: number;
}

/**
 * 创建请求体大小限制中间件
 *
 * 安全特性：
 * - 优先检查 Content-Length header（快速拒绝）
 * - 对于 chunked 传输或缺失 Content-Length 的请求，读取实际字节进行验证
 * - 防止大包攻击绕过
 */
export function bodyLimitMiddleware(options: BodyLimitMiddlewareOptions = {}) {
  const { maxSize = DEFAULT_CONFIG.MAX_BODY_SIZE } = options;

  return createMiddleware<AppEnv>(async (c, next) => {
    const contentLength = c.req.header('content-length');
    const transferEncoding = c.req.header('transfer-encoding');
    const method = c.req.method;

    // 对于没有请求体的方法，直接跳过
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'DELETE') {
      await next();
      return;
    }

    // 1. 首先检查 Content-Length（快速拒绝明确超限的请求）
    if (contentLength) {
      const size = parseInt(contentLength, 10);

      if (!isNaN(size) && size > maxSize) {
        logger.warn('Request body too large (Content-Length check)', {
          traceId: c.get('traceId'),
          requestId: c.get('requestId'),
          contentLength: size,
          maxSize,
        });

        return c.json(
          {
            success: false,
            error: {
              code: ERROR_CODES.PAYLOAD_TOO_LARGE,
              message: `Payload exceeds maximum size of ${maxSize} bytes`,
            },
            meta: {
              traceId: c.get('traceId'),
              requestId: c.get('requestId'),
            },
          },
          413 as const
        );
      }
    }

    // 2. 对于 chunked 传输或没有 Content-Length 的请求，需要读取实际字节
    const isChunked = transferEncoding?.toLowerCase().includes('chunked');
    const needsBodyCheck = isChunked || !contentLength;

    if (needsBodyCheck) {
      try {
        // 克隆请求以便读取 body
        const clonedRequest = c.req.raw.clone();
        const reader = clonedRequest.body?.getReader();

        if (reader) {
          let totalSize = 0;

          // 逐块读取并计算大小
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.length;

            // 超限时立即中断读取
            if (totalSize > maxSize) {
              reader.cancel();

              logger.warn('Request body too large (stream check)', {
                traceId: c.get('traceId'),
                requestId: c.get('requestId'),
                bytesRead: totalSize,
                maxSize,
                isChunked,
              });

              return c.json(
                {
                  success: false,
                  error: {
                    code: ERROR_CODES.PAYLOAD_TOO_LARGE,
                    message: `Payload exceeds maximum size of ${maxSize} bytes`,
                  },
                  meta: {
                    traceId: c.get('traceId'),
                    requestId: c.get('requestId'),
                  },
                },
                413 as const
              );
            }
          }
        }
      } catch (error) {
        // 读取错误不阻止请求，仅记录警告
        logger.warn('Failed to verify request body size', {
          traceId: c.get('traceId'),
          requestId: c.get('requestId'),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    await next();
    return;
  });
}
