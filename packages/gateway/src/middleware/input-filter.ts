/**
 * 输入过滤中间件
 *
 * 实现提示注入检测、正则 allowlist、最大长度校验
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv, InputValidationConfig } from '../types';
import { DEFAULT_SECURITY_POLICY, ERROR_CODES } from '../config';
import { logger } from './logger';

// ============================================================================
// 输入验证函数
// ============================================================================

/**
 * 提示注入检测结果
 */
export interface InjectionDetectionResult {
  /** 是否检测到注入 */
  detected: boolean;
  /** 匹配的模式（如果有） */
  pattern?: string;
  /** 匹配的内容（如果有） */
  match?: string;
}

/**
 * 检测提示注入
 */
export function detectPromptInjection(
  input: string,
  patterns: RegExp[]
): InjectionDetectionResult {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      return {
        detected: true,
        pattern: pattern.source,
        match: match[0],
      };
    }
  }

  return { detected: false };
}

/**
 * 验证输入长度
 */
export function validateLength(input: string, maxLength: number): boolean {
  return input.length <= maxLength;
}

/**
 * 验证输入是否匹配允许的模式
 */
export function matchesAllowlist(input: string, allowedPatterns: RegExp[]): boolean {
  if (allowedPatterns.length === 0) {
    return true; // 没有配置 allowlist，允许所有
  }

  return allowedPatterns.some((pattern) => pattern.test(input));
}

/**
 * 递归遍历对象中的所有字符串值
 */
function* traverseStrings(obj: unknown, path = ''): Generator<{ path: string; value: string }> {
  if (typeof obj === 'string') {
    yield { path, value: obj };
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      yield* traverseStrings(obj[i], `${path}[${i}]`);
    }
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      yield* traverseStrings(value, path ? `${path}.${key}` : key);
    }
  }
}

/**
 * 验证对象中的所有字符串
 */
export function validateObject(
  obj: unknown,
  config: InputValidationConfig
): { valid: true } | { valid: false; error: string; path?: string; details?: unknown } {
  for (const { path, value } of traverseStrings(obj)) {
    // 检查长度
    if (!validateLength(value, config.maxInputLength)) {
      return {
        valid: false,
        error: `Input at ${path} exceeds maximum length of ${config.maxInputLength}`,
        path,
      };
    }

    // 检查提示注入
    if (config.promptInjectionDetection) {
      const injectionResult = detectPromptInjection(value, config.blockedPatterns);
      if (injectionResult.detected) {
        return {
          valid: false,
          error: 'Potential prompt injection detected',
          path,
          details: {
            pattern: injectionResult.pattern,
          },
        };
      }
    }

    // 检查 allowlist（如果配置了）
    if (config.allowedPatterns.length > 0) {
      if (!matchesAllowlist(value, config.allowedPatterns)) {
        return {
          valid: false,
          error: `Input at ${path} does not match allowed patterns`,
          path,
        };
      }
    }
  }

  return { valid: true };
}

// ============================================================================
// 输入过滤中间件
// ============================================================================

/**
 * 输入过滤中间件配置
 */
export interface InputFilterMiddlewareOptions {
  /** 输入验证配置 */
  config?: Partial<InputValidationConfig>;
  /** 跳过的路径 */
  skipPaths?: RegExp[];
  /** 跳过的 Content-Type */
  skipContentTypes?: string[];
  /** 是否只检查请求体 */
  bodyOnly?: boolean;
  /** 自定义检测函数 */
  customDetector?: (input: string) => InjectionDetectionResult;
}

/**
 * 创建输入过滤中间件
 *
 * 功能:
 * - 检测提示注入攻击
 * - 验证输入长度
 * - 应用 allowlist 规则
 * - 记录过滤操作到日志
 */
export function inputFilterMiddleware(options: InputFilterMiddlewareOptions = {}) {
  const {
    config = {},
    skipPaths = [/^\/health$/],
    skipContentTypes = ['multipart/form-data'],
    bodyOnly = false,
    customDetector,
  } = options;

  // 合并配置
  const validationConfig: InputValidationConfig = {
    ...DEFAULT_SECURITY_POLICY.inputValidation,
    ...config,
  };

  // 如果提供了自定义检测器，添加到 blockedPatterns
  const blockedPatterns = [...validationConfig.blockedPatterns];

  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;

    // 跳过检查的路径
    if (skipPaths.some((pattern) => pattern.test(path))) {
      await next();
      return;
    }

    // 只对有请求体的方法进行检查
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (bodyOnly) {
        await next();
        return;
      }
    }

    // 检查 Content-Type
    const contentType = c.req.header('content-type') || '';
    if (skipContentTypes.some((type) => contentType.includes(type))) {
      await next();
      return;
    }

    // 获取要验证的数据
    const dataToValidate: Record<string, unknown> = {};

    // 验证查询参数
    if (!bodyOnly) {
      const query = c.req.query();
      if (Object.keys(query).length > 0) {
        dataToValidate.query = query;
      }
    }

    // 验证请求体
    if (contentType.includes('application/json') && ['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        const body = await c.req.raw.clone().json();
        dataToValidate.body = body;
      } catch {
        // JSON 解析失败，跳过
      }
    }

    // 执行验证
    const result = validateObject(dataToValidate, {
      ...validationConfig,
      blockedPatterns,
    });

    if (!result.valid) {
      const isInjection = result.error.includes('prompt injection');

      logger.warn('Input validation failed', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        path,
        method,
        error: result.error,
        fieldPath: result.path,
        isInjection,
      });

      const errorCode = isInjection
        ? ERROR_CODES.PROMPT_INJECTION_DETECTED
        : ERROR_CODES.VALIDATION_ERROR;

      return c.json(
        {
          success: false,
          error: {
            code: errorCode,
            message: result.error,
            details: result.details,
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        400 as const
      );
    }

    // 如果使用自定义检测器
    if (customDetector) {
      for (const { path: fieldPath, value } of traverseStrings(dataToValidate)) {
        const customResult = customDetector(value);
        if (customResult.detected) {
          logger.warn('Custom injection detection triggered', {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
            path,
            fieldPath,
            pattern: customResult.pattern,
          });

          return c.json(
            {
              success: false,
              error: {
                code: ERROR_CODES.PROMPT_INJECTION_DETECTED,
                message: 'Potential security threat detected',
              },
              meta: {
                traceId: c.get('traceId'),
                requestId: c.get('requestId'),
              },
            },
            400 as const
          );
        }
      }
    }

    await next();
    return;
  });
}

// ============================================================================
// 辅助中间件
// ============================================================================

/**
 * 简单的提示注入检测中间件
 *
 * 轻量级版本，只检查常见的注入模式
 */
export function simpleInjectionGuard() {
  const simplePatterns = [
    /ignore\s+(?:previous|above|all)\s+instructions?/i,
    /disregard\s+(?:previous|above|all)\s+instructions?/i,
    /system\s*:\s*/i,
    /\[system\]/i,
  ];

  return inputFilterMiddleware({
    config: {
      promptInjectionDetection: true,
      blockedPatterns: simplePatterns,
      maxInputLength: 50000,
      allowedPatterns: [],
    },
  });
}
