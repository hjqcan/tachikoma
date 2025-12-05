/**
 * 统一响应格式工具
 *
 * 提供标准化的 API 响应格式
 */

import type { Context } from 'hono';
import type { AppEnv, ApiSuccessResponse, ApiErrorResponse } from '../types';
import { ERROR_CODES, type ErrorCode } from '../config';

// ============================================================================
// 成功响应构造器
// ============================================================================

/**
 * 创建成功响应
 */
type SuccessStatusCode = 200 | 201 | 202;

export function success<T>(
  c: Context<AppEnv>,
  data: T,
  options?: {
    status?: SuccessStatusCode;
    pagination?: {
      page: number;
      pageSize: number;
      total: number;
    };
  }
): Response {
  const traceId = c.get('traceId');
  const requestId = c.get('requestId');
  const requestStart = c.get('requestStart');
  const duration = requestStart ? Date.now() - requestStart : undefined;

  const response: ApiSuccessResponse<T> = {
    success: true,
    data,
    meta: {
      traceId,
      requestId,
      ...(duration !== undefined && { duration }),
      ...(options?.pagination && {
        pagination: {
          ...options.pagination,
          totalPages: Math.ceil(options.pagination.total / options.pagination.pageSize),
        },
      }),
    },
  };

  const status: SuccessStatusCode = options?.status ?? 200;
  return c.json(response, status);
}

// ============================================================================
// 错误响应构造器
// ============================================================================

/**
 * 创建错误响应
 */
export function error(
  c: Context<AppEnv>,
  code: ErrorCode,
  message: string,
  options?: {
    status?: 400 | 401 | 403 | 404 | 413 | 500 | 502 | 503;
    details?: unknown;
  }
): Response {
  const traceId = c.get('traceId');
  const requestId = c.get('requestId');

  const response: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      details: options?.details,
    },
    meta: {
      traceId,
      requestId,
    },
  };

  // 根据错误码确定状态码
  const status = options?.status ?? (getStatusFromErrorCode(code) as 400 | 401 | 403 | 404 | 413 | 500 | 502 | 503);

  return c.json(response, status);
}

/**
 * 根据错误码获取 HTTP 状态码
 */
function getStatusFromErrorCode(code: ErrorCode): number {
  if (code.startsWith('AUTH_')) return 401;
  if (code.startsWith('PERM_')) return 403;
  if (code.startsWith('REQ_')) return 400;
  if (code.startsWith('RES_')) return 404;
  if (code.startsWith('PROXY_')) return 502;
  if (code.startsWith('SRV_')) return 500;
  return 500;
}

// ============================================================================
// 常用错误响应快捷方法
// ============================================================================

/**
 * 未授权响应 (401)
 */
export function unauthorized(c: Context<AppEnv>, message = 'Unauthorized'): Response {
  return error(c, ERROR_CODES.UNAUTHORIZED, message, { status: 401 });
}

/**
 * Token 过期响应 (401)
 */
export function tokenExpired(c: Context<AppEnv>): Response {
  return error(c, ERROR_CODES.TOKEN_EXPIRED, 'Token has expired', { status: 401 });
}

/**
 * Token 无效响应 (401)
 */
export function tokenInvalid(c: Context<AppEnv>): Response {
  return error(c, ERROR_CODES.TOKEN_INVALID, 'Invalid token', { status: 401 });
}

/**
 * 禁止访问响应 (403)
 */
export function forbidden(c: Context<AppEnv>, message = 'Forbidden'): Response {
  return error(c, ERROR_CODES.FORBIDDEN, message, { status: 403 });
}

/**
 * 权限不足响应 (403)
 */
export function insufficientPermissions(
  c: Context<AppEnv>,
  resource?: string,
  operation?: string
): Response {
  const message =
    resource && operation
      ? `Insufficient permissions to ${operation} ${resource}`
      : 'Insufficient permissions';
  return error(c, ERROR_CODES.INSUFFICIENT_PERMISSIONS, message, { status: 403 });
}

/**
 * 请求错误响应 (400)
 */
export function badRequest(c: Context<AppEnv>, message = 'Bad request', details?: unknown): Response {
  return error(c, ERROR_CODES.BAD_REQUEST, message, { status: 400, details });
}

/**
 * 验证错误响应 (400)
 */
export function validationError(c: Context<AppEnv>, details: unknown): Response {
  return error(c, ERROR_CODES.VALIDATION_ERROR, 'Validation failed', { status: 400, details });
}

/**
 * 提示注入检测响应 (400)
 */
export function promptInjectionDetected(c: Context<AppEnv>): Response {
  return error(c, ERROR_CODES.PROMPT_INJECTION_DETECTED, 'Potential prompt injection detected', {
    status: 400,
  });
}

/**
 * 请求体过大响应 (413)
 */
export function payloadTooLarge(c: Context<AppEnv>, maxSize: number): Response {
  return error(c, ERROR_CODES.PAYLOAD_TOO_LARGE, `Payload exceeds maximum size of ${maxSize} bytes`, {
    status: 413,
  });
}

/**
 * 资源未找到响应 (404)
 */
export function notFound(c: Context<AppEnv>, resource = 'Resource'): Response {
  return error(c, ERROR_CODES.RESOURCE_NOT_FOUND, `${resource} not found`, { status: 404 });
}

/**
 * 主机不允许响应 (403)
 */
export function hostNotAllowed(c: Context<AppEnv>, host: string): Response {
  return error(c, ERROR_CODES.HOST_NOT_ALLOWED, `Host ${host} is not in the allowlist`, {
    status: 403,
  });
}

/**
 * 代理错误响应 (502)
 */
export function proxyError(c: Context<AppEnv>, message: string): Response {
  return error(c, ERROR_CODES.PROXY_ERROR, message, { status: 502 });
}

/**
 * 服务器内部错误响应 (500)
 */
export function internalError(c: Context<AppEnv>, message = 'Internal server error'): Response {
  return error(c, ERROR_CODES.INTERNAL_ERROR, message, { status: 500 });
}
