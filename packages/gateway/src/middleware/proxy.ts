/**
 * A2A/MCP 代理中间件
 *
 * 实现外部调用的 allowlist 校验和代理
 */

import type { AllowlistEntry } from '../types';
import { DEFAULT_ALLOWLIST } from '../config';

/**
 * 代理请求配置
 */
export interface ProxyRequestConfig {
  /** 目标 URL */
  targetUrl: string;
  /** HTTP 方法 */
  method: string;
  /** 请求头 */
  headers?: Record<string, string>;
  /** 请求体 */
  body?: unknown;
  /** 超时时间（毫秒） */
  timeout?: number;
}
import { logger } from './logger';

// ============================================================================
// Allowlist 验证
// ============================================================================

/**
 * 验证 URL 是否在允许列表中
 */
export function isUrlAllowed(url: string, allowlist: AllowlistEntry[]): boolean {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    const path = parsedUrl.pathname;

    for (const entry of allowlist) {
      if (entry.host === host || entry.host === '*') {
        // 检查路径是否匹配
        const pathMatches = entry.pathPatterns.some((pattern) => pattern.test(path));
        if (pathMatches) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * 验证请求是否满足 allowlist 条件
 */
export function validateRequest(
  url: string,
  method: string,
  allowlist: AllowlistEntry[]
): { allowed: true } | { allowed: false; reason: string } {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    const path = parsedUrl.pathname;

    for (const entry of allowlist) {
      if (entry.host !== host && entry.host !== '*') {
        continue;
      }

      // 检查路径是否匹配
      const pathMatches = entry.pathPatterns.some((pattern) => pattern.test(path));
      if (!pathMatches) {
        continue;
      }

      // 检查方法是否允许
      if (!entry.methods.includes(method.toUpperCase())) {
        return {
          allowed: false,
          reason: `Method ${method} not allowed for ${host}`,
        };
      }

      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Host ${host} is not in the allowlist`,
    };
  } catch {
    return {
      allowed: false,
      reason: 'Invalid URL',
    };
  }
}

// ============================================================================
// 代理客户端
// ============================================================================

/**
 * 代理请求结果
 */
export interface ProxyResult {
  success: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: string;
  duration: number;
}

/**
 * 执行代理请求
 */
export async function proxyRequest(
  config: ProxyRequestConfig,
  context: {
    traceId: string;
    requestId: string;
  }
): Promise<ProxyResult> {
  const startTime = Date.now();

  try {
    const { targetUrl, method, headers = {}, body, timeout = 30000 } = config;

    // 添加追踪头
    const requestHeaders: Record<string, string> = {
      ...headers,
      'X-Trace-Id': context.traceId,
      'X-Request-Id': context.requestId,
      'X-Forwarded-By': 'tachikoma-gateway',
    };

    // 构建请求选项
    const requestInit: RequestInit = {
      method,
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeout),
    };

    // 添加请求体
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      requestInit.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    }

    // 执行请求
    const response = await fetch(targetUrl, requestInit);

    // 解析响应头
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // 解析响应体
    let responseBody: unknown;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    const duration = Date.now() - startTime;

    logger.info('Proxy request completed', {
      traceId: context.traceId,
      requestId: context.requestId,
      targetUrl,
      method,
      status: response.status,
      duration,
    });

    return {
      success: response.ok,
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
      duration,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err.message : 'Unknown error';

    logger.error('Proxy request failed', {
      traceId: context.traceId,
      requestId: context.requestId,
      targetUrl: config.targetUrl,
      error,
      duration,
    });

    return {
      success: false,
      error,
      duration,
    };
  }
}

// ============================================================================
// 代理服务类
// ============================================================================

/**
 * 代理服务配置
 */
export interface ProxyServiceOptions {
  /** 允许列表 */
  allowlist?: AllowlistEntry[];
  /** 默认超时时间 */
  defaultTimeout?: number;
  /** 是否启用重试 */
  enableRetry?: boolean;
  /** 最大重试次数 */
  maxRetries?: number;
}

/**
 * 代理服务类
 */
export class ProxyService {
  private allowlist: AllowlistEntry[];
  private defaultTimeout: number;
  private enableRetry: boolean;
  private maxRetries: number;

  constructor(options: ProxyServiceOptions = {}) {
    this.allowlist = options.allowlist || DEFAULT_ALLOWLIST;
    this.defaultTimeout = options.defaultTimeout || 30000;
    this.enableRetry = options.enableRetry || false;
    this.maxRetries = options.maxRetries || 3;
  }

  /**
   * 添加允许列表条目
   */
  addAllowlistEntry(entry: AllowlistEntry): void {
    this.allowlist.push(entry);
  }

  /**
   * 移除允许列表条目
   */
  removeAllowlistEntry(host: string): void {
    this.allowlist = this.allowlist.filter((e) => e.host !== host);
  }

  /**
   * 获取允许列表
   */
  getAllowlist(): AllowlistEntry[] {
    return [...this.allowlist];
  }

  /**
   * 验证请求
   */
  validate(url: string, method: string): ReturnType<typeof validateRequest> {
    return validateRequest(url, method, this.allowlist);
  }

  /**
   * 执行代理请求
   */
  async request(
    config: Omit<ProxyRequestConfig, 'timeout'> & { timeout?: number },
    context: { traceId: string; requestId: string }
  ): Promise<ProxyResult> {
    // 验证请求
    const validation = this.validate(config.targetUrl, config.method);
    if (!validation.allowed) {
      return {
        success: false,
        error: validation.reason,
        duration: 0,
      };
    }

    // 执行请求（带重试）
    const timeout = config.timeout || this.defaultTimeout;
    let lastResult: ProxyResult | null = null;
    const attempts = this.enableRetry ? this.maxRetries : 1;

    // 首次尝试
    lastResult = await proxyRequest({ ...config, timeout }, context);
    if (lastResult.success || !this.enableRetry || (lastResult.status && lastResult.status < 500)) {
      return lastResult;
    }

    // 重试逻辑
    for (let attempt = 2; attempt <= attempts; attempt++) {
      // 等待后重试
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt - 1)));

      lastResult = await proxyRequest({ ...config, timeout }, context);

      if (lastResult.success) {
        return lastResult;
      }

      // 如果不是超时或网络错误，不重试
      if (lastResult.status && lastResult.status < 500) {
        return lastResult;
      }
    }

    return lastResult ?? { success: false, error: 'Unknown error', duration: 0 };
  }
}

// ============================================================================
// 全局代理服务实例
// ============================================================================

/** 全局代理服务 */
export const proxyService = new ProxyService();

// ============================================================================
// MCP 代理辅助函数
// ============================================================================

/**
 * MCP 请求格式
 */
export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * MCP 响应格式
 */
export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * 代理 MCP 请求
 */
export async function proxyMCPRequest(
  serverUrl: string,
  request: MCPRequest,
  context: { traceId: string; requestId: string }
): Promise<MCPResponse> {
  const result = await proxyService.request(
    {
      targetUrl: serverUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: request,
    },
    context
  );

  if (!result.success) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: result.error || 'Proxy request failed',
      },
    };
  }

  return result.body as MCPResponse;
}
