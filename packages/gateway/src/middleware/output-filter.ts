/**
 * 输出过滤中间件
 *
 * 实现 PII 检测、敏感数据脱敏、Token 泄漏防护
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv, OutputValidationConfig } from '../types';
import { DEFAULT_SECURITY_POLICY, PII_PATTERNS, TOKEN_PATTERNS, ERROR_CODES } from '../config';
import { logger } from './logger';

// ============================================================================
// 脱敏函数
// ============================================================================

/**
 * 脱敏配置
 */
export interface MaskingOptions {
  /** 邮箱脱敏：显示前 N 个字符 */
  emailKeepChars?: number;
  /** 电话脱敏：显示最后 N 位 */
  phoneKeepDigits?: number;
  /** 信用卡：显示最后 N 位 */
  cardKeepDigits?: number;
  /** 通用替换字符 */
  maskChar?: string;
}

const DEFAULT_MASKING_OPTIONS: MaskingOptions = {
  emailKeepChars: 2,
  phoneKeepDigits: 4,
  cardKeepDigits: 4,
  maskChar: '*',
};

/**
 * 脱敏邮箱地址
 * 示例: john.doe@example.com -> jo***@***.com
 */
export function maskEmail(email: string, options: MaskingOptions = {}): string {
  const { emailKeepChars = 2, maskChar = '*' } = { ...DEFAULT_MASKING_OPTIONS, ...options };

  const parts = email.split('@');
  const local = parts[0];
  const domain = parts[1];
  if (!local || !domain) return maskChar.repeat(email.length);

  const maskedLocal =
    local.slice(0, emailKeepChars) + maskChar.repeat(Math.max(0, local.length - emailKeepChars));

  const domainParts = domain.split('.');
  const maskedDomain = domainParts.map((part, i) =>
    i === domainParts.length - 1 ? part : maskChar.repeat(part.length)
  ).join('.');

  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * 脱敏电话号码
 * 示例: 13812345678 -> *******5678
 */
export function maskPhone(phone: string, options: MaskingOptions = {}): string {
  const { phoneKeepDigits = 4, maskChar = '*' } = { ...DEFAULT_MASKING_OPTIONS, ...options };

  const digits = phone.replace(/\D/g, '');
  const keepPart = digits.slice(-phoneKeepDigits);
  const maskPart = maskChar.repeat(Math.max(0, digits.length - phoneKeepDigits));

  return maskPart + keepPart;
}

/**
 * 脱敏信用卡号
 * 示例: 4111-1111-1111-1111 -> ****-****-****-1111
 */
export function maskCreditCard(card: string, options: MaskingOptions = {}): string {
  const { cardKeepDigits = 4, maskChar = '*' } = { ...DEFAULT_MASKING_OPTIONS, ...options };

  // 保留原始格式中的分隔符
  const separator = card.includes('-') ? '-' : card.includes(' ') ? ' ' : '';
  const digits = card.replace(/\D/g, '');

  const keepPart = digits.slice(-cardKeepDigits);
  const maskPart = maskChar.repeat(Math.max(0, digits.length - cardKeepDigits));

  // 重新格式化
  if (separator) {
    const masked = maskPart + keepPart;
    return masked.match(/.{1,4}/g)?.join(separator) || masked;
  }

  return maskPart + keepPart;
}

/**
 * 脱敏身份证号
 * 示例: 110101199001011234 -> 110***********1234
 */
export function maskIdCard(idCard: string): string {
  if (idCard.length < 8) return '*'.repeat(idCard.length);

  return idCard.slice(0, 3) + '*'.repeat(idCard.length - 7) + idCard.slice(-4);
}

/**
 * 脱敏 IP 地址
 * 示例: 192.168.1.100 -> 192.168.*.*
 */
export function maskIpAddress(ip: string): string {
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;

  return `${parts[0]}.${parts[1]}.*.*`;
}

/**
 * 脱敏 Token/API Key
 * 示例: sk_live_abc123xyz789 -> sk_live_***...***
 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '*'.repeat(token.length);

  return token.slice(0, 4) + '***...***' + token.slice(-4);
}

// ============================================================================
// 检测和脱敏处理
// ============================================================================

/**
 * 检测结果
 */
export interface DetectionResult {
  /** 是否检测到敏感数据 */
  detected: boolean;
  /** 检测到的类型 */
  types: string[];
  /** 检测到的数量 */
  count: number;
}

/**
 * 检测 PII
 */
export function detectPII(text: string): DetectionResult {
  const types: string[] = [];
  let count = 0;

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      types.push(type);
      count += matches.length;
    }
  }

  return {
    detected: types.length > 0,
    types,
    count,
  };
}

/**
 * 检测 Token/密钥
 */
export function detectTokens(text: string): DetectionResult {
  const types: string[] = [];
  let count = 0;

  for (const [type, pattern] of Object.entries(TOKEN_PATTERNS)) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      types.push(type);
      count += matches.length;
    }
  }

  return {
    detected: types.length > 0,
    types,
    count,
  };
}

/**
 * 对文本进行脱敏处理
 */
export function sanitizeText(text: string, options: MaskingOptions = {}): string {
  let result = text;

  // 脱敏邮箱
  result = result.replace(PII_PATTERNS.email, (match) => maskEmail(match, options));

  // 脱敏中国手机号
  result = result.replace(PII_PATTERNS.chinesePhone, (match) => maskPhone(match, options));

  // 脱敏国际电话
  result = result.replace(PII_PATTERNS.phone, (match) => maskPhone(match, options));

  // 脱敏身份证
  result = result.replace(PII_PATTERNS.idCard, (match) => maskIdCard(match));

  // 脱敏信用卡
  result = result.replace(PII_PATTERNS.creditCard, (match) => maskCreditCard(match, options));

  // 脱敏 SSN
  result = result.replace(PII_PATTERNS.ssn, () => '***-**-****');

  // 脱敏 IP 地址
  result = result.replace(PII_PATTERNS.ipAddress, (match) => maskIpAddress(match));

  // 脱敏 API Key
  result = result.replace(TOKEN_PATTERNS.apiKey, (match) => maskToken(match));

  // 脱敏 JWT
  result = result.replace(TOKEN_PATTERNS.jwt, () => '[JWT_REDACTED]');

  // 脱敏 AWS Key
  result = result.replace(TOKEN_PATTERNS.awsKey, () => '[AWS_KEY_REDACTED]');

  // 脱敏私钥
  result = result.replace(TOKEN_PATTERNS.privateKey, () => '[PRIVATE_KEY_REDACTED]');

  // 脱敏密码字段
  result = result.replace(TOKEN_PATTERNS.password, () => '"password":"[REDACTED]"');

  return result;
}

/**
 * 递归脱敏对象
 */
export function sanitizeObject(obj: unknown, options: MaskingOptions = {}): unknown {
  if (typeof obj === 'string') {
    return sanitizeText(obj, options);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, options));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // 对敏感字段名特殊处理
      if (/password|secret|token|key|credential/i.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeObject(value, options);
      }
    }

    return result;
  }

  return obj;
}

// ============================================================================
// 输出过滤中间件
// ============================================================================

/**
 * 默认最大扫描体积（256KB）
 * 降低默认值以减少大响应的内存占用和阻塞
 */
const DEFAULT_MAX_SCAN_SIZE = 256 * 1024;

/**
 * 输出过滤中间件配置
 */
export interface OutputFilterMiddlewareOptions {
  /** 输出验证配置 */
  config?: Partial<OutputValidationConfig>;
  /** 跳过的路径 */
  skipPaths?: RegExp[];
  /** 脱敏选项 */
  maskingOptions?: MaskingOptions;
  /** 是否记录检测日志 */
  logDetections?: boolean;
  /** 检测到敏感数据时是否阻止响应 */
  blockOnDetection?: boolean;
  /** 最大扫描体积（字节），超过此大小的响应不进行扫描，默认 256KB */
  maxScanSize?: number;
  /**
   * 只扫描指定的字段路径（如 ['data', 'result']）
   * 如果设置，只对这些顶层字段进行敏感数据检测和脱敏
   * 可显著减少扫描范围，提升性能
   */
  scanFields?: string[];
}

/**
 * 创建输出过滤中间件
 *
 * 功能:
 * - 检测并脱敏 PII
 * - 检测并移除 Token/密钥泄漏
 * - 记录过滤操作到日志和 Span
 *
 * 安全与性能优化：
 * - 限制扫描体积，防止大响应卡顿
 * - 正确处理 Content-Length
 */
export function outputFilterMiddleware(options: OutputFilterMiddlewareOptions = {}) {
  const {
    config = {},
    skipPaths = [/^\/health$/],
    maskingOptions = {},
    logDetections = true,
    blockOnDetection = false,
    maxScanSize = DEFAULT_MAX_SCAN_SIZE,
    scanFields,
  } = options;

  // 合并配置
  const validationConfig: OutputValidationConfig = {
    ...DEFAULT_SECURITY_POLICY.outputValidation,
    ...config,
  };

  /**
   * 提取指定字段的内容用于扫描
   * 如果 scanFields 未设置，返回整个响应文本
   */
  function getTextToScan(body: unknown, fullText: string): string {
    if (!scanFields || scanFields.length === 0) {
      return fullText;
    }

    // 只有对象才能提取字段
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fullText;
    }

    const parts: string[] = [];
    for (const field of scanFields) {
      const value = (body as Record<string, unknown>)[field];
      if (value !== undefined) {
        parts.push(JSON.stringify(value));
      }
    }

    return parts.length > 0 ? parts.join('\n') : fullText;
  }

  /**
   * 只脱敏指定字段
   */
  function sanitizeTargetFields(body: unknown): unknown {
    if (!scanFields || scanFields.length === 0) {
      return sanitizeObject(body, maskingOptions);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sanitizeObject(body, maskingOptions);
    }

    // 只脱敏指定字段，保留其他字段不变
    const result = { ...(body as Record<string, unknown>) };
    for (const field of scanFields) {
      if (result[field] !== undefined) {
        result[field] = sanitizeObject(result[field], maskingOptions);
      }
    }

    return result;
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path;

    // 跳过检查的路径
    if (skipPaths.some((pattern) => pattern.test(path))) {
      await next();
      return;
    }

    // 先执行下一个中间件
    await next();

    // 检查响应是否是 JSON
    const contentType = c.res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return;
    }

    // 检查 Content-Length，如果超过最大扫描体积则跳过
    const contentLengthHeader = c.res.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > maxScanSize) {
        logger.debug('Response too large for scanning, skipping output filter', {
          traceId: c.get('traceId'),
          requestId: c.get('requestId'),
          contentLength,
          maxScanSize,
        });
        return;
      }
    }

    // 克隆响应以读取内容
    const originalResponse = c.res.clone();
    let responseText: string;

    try {
      responseText = await originalResponse.text();
    } catch {
      // 读取失败，跳过
      return;
    }

    // 检查实际大小
    const actualSize = new TextEncoder().encode(responseText).length;
    if (actualSize > maxScanSize) {
      logger.debug('Response body too large for scanning, skipping output filter', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        actualSize,
        maxScanSize,
      });
      return;
    }

    // 解析 JSON
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // 非有效 JSON，跳过
      return;
    }

    // 获取要扫描的文本（可能只是部分字段）
    const textToScan = getTextToScan(responseBody, responseText);

    // 检测敏感数据
    let hasDetections = false;
    const detectedTypes: string[] = [];

    if (validationConfig.piiDetection) {
      const piiResult = detectPII(textToScan);
      if (piiResult.detected) {
        hasDetections = true;
        detectedTypes.push(...piiResult.types.map((t) => `pii:${t}`));
      }
    }

    if (validationConfig.tokenLeakagePrevention) {
      const tokenResult = detectTokens(textToScan);
      if (tokenResult.detected) {
        hasDetections = true;
        detectedTypes.push(...tokenResult.types.map((t) => `token:${t}`));
      }
    }

    // 记录检测结果
    if (hasDetections && logDetections) {
      logger.warn('Sensitive data detected in response', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        path,
        detectedTypes,
      });
    }

    // 如果配置为阻止响应
    if (hasDetections && blockOnDetection) {
      const errorBody = JSON.stringify({
        success: false,
        error: {
          code: ERROR_CODES.OUTPUT_BLOCKED,
          message: 'Response blocked due to sensitive data detection',
        },
        meta: {
          traceId: c.get('traceId'),
          requestId: c.get('requestId'),
        },
      });

      c.res = new Response(errorBody, {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(errorBody).length),
        },
      });
      return;
    }

    // 脱敏处理（如果设置了 scanFields，只脱敏指定字段）
    if (hasDetections && validationConfig.sensitiveDataMasking) {
      const sanitizedBody = sanitizeTargetFields(responseBody);
      const sanitizedText = JSON.stringify(sanitizedBody);
      const sanitizedBytes = new TextEncoder().encode(sanitizedText);

      // 创建新的 Headers，移除旧的 content-length 并设置新的
      const newHeaders = new Headers();
      c.res.headers.forEach((value, key) => {
        // 跳过 content-length，我们会重新计算
        if (key.toLowerCase() !== 'content-length') {
          newHeaders.set(key, value);
        }
      });
      // 设置正确的 Content-Length
      newHeaders.set('Content-Length', String(sanitizedBytes.length));

      // 创建新的响应
      c.res = new Response(sanitizedText, {
        status: c.res.status,
        headers: newHeaders,
      });

      logger.debug('Response sanitized', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        sanitizedTypes: detectedTypes,
        originalSize: actualSize,
        sanitizedSize: sanitizedBytes.length,
      });
    }
  });
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查文本是否包含敏感数据
 */
export function containsSensitiveData(text: string): boolean {
  const piiResult = detectPII(text);
  const tokenResult = detectTokens(text);

  return piiResult.detected || tokenResult.detected;
}

/**
 * 获取敏感数据摘要
 */
export function getSensitiveDataSummary(text: string): {
  pii: DetectionResult;
  tokens: DetectionResult;
} {
  return {
    pii: detectPII(text),
    tokens: detectTokens(text),
  };
}
