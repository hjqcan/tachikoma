/**
 * JWT 认证中间件
 *
 * 实现 JWT/OAuth2 token 验证
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv, JWTPayload, UserRole } from '../types';
import { DEFAULT_CONFIG, ERROR_CODES } from '../config';
import { logger } from './logger';

// ============================================================================
// JWT 工具函数
// ============================================================================

/** 支持的 JWT 算法（显式限制只支持 HS256） */
const SUPPORTED_ALGORITHMS = ['HS256'] as const;

/** 默认时钟偏移容忍窗口（秒） */
const DEFAULT_CLOCK_TOLERANCE = 60;

/**
 * Base64URL 解码为 Uint8Array（跨平台兼容）
 * 不依赖 atob/btoa，使用纯 JavaScript 实现
 */
function base64UrlToUint8Array(str: string): Uint8Array {
  // 替换 Base64URL 字符为标准 Base64
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');

  // 添加填充
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

  // Base64 解码查找表
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  // 计算输出长度
  let bufferLength = (padded.length * 3) / 4;
  if (padded.endsWith('==')) bufferLength -= 2;
  else if (padded.endsWith('=')) bufferLength -= 1;

  const bytes = new Uint8Array(bufferLength);
  let p = 0;

  for (let i = 0; i < padded.length; i += 4) {
    const encoded1 = lookup[padded.charCodeAt(i)] ?? 0;
    const encoded2 = lookup[padded.charCodeAt(i + 1)] ?? 0;
    const encoded3 = lookup[padded.charCodeAt(i + 2)] ?? 0;
    const encoded4 = lookup[padded.charCodeAt(i + 3)] ?? 0;

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (p < bufferLength) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    if (p < bufferLength) bytes[p++] = ((encoded3 & 3) << 6) | encoded4;
  }

  return bytes;
}

/**
 * Uint8Array 编码为 Base64URL（跨平台兼容）
 */
function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const byte1 = bytes[i] ?? 0;
    const byte2 = bytes[i + 1];
    const byte3 = bytes[i + 2];

    result += chars[byte1 >> 2];
    result += chars[((byte1 & 3) << 4) | ((byte2 ?? 0) >> 4)];
    result += byte2 !== undefined ? chars[((byte2 & 15) << 2) | ((byte3 ?? 0) >> 6)] : '';
    result += byte3 !== undefined ? chars[byte3 & 63] : '';
  }

  // 转换为 Base64URL 格式（不带填充）
  return result.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64URL 解码为字符串（UTF-8）
 */
function base64UrlDecode(str: string): string {
  const bytes = base64UrlToUint8Array(str);
  return new TextDecoder().decode(bytes);
}

/**
 * JWT Header 类型
 */
interface JWTHeader {
  alg: string;
  typ?: string;
}

/**
 * 解析 JWT Token（不验证签名）
 * 返回错误信息以便调用者了解失败原因
 */
export function parseJWT(
  token: string
): { header: JWTHeader; payload: JWTPayload } | { error: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { error: 'Invalid token format: expected 3 parts' };
    }

    const part0 = parts[0];
    const part1 = parts[1];
    if (!part0 || !part1) {
      return { error: 'Invalid token format: missing parts' };
    }

    const header = JSON.parse(base64UrlDecode(part0)) as JWTHeader;
    const payload = JSON.parse(base64UrlDecode(part1)) as JWTPayload;

    // 校验 header 中的 alg 字段
    if (!header.alg) {
      return { error: 'Invalid token header: missing alg field' };
    }

    // 显式拒绝 "none" 算法（防止签名绕过攻击）
    if (header.alg.toLowerCase() === 'none') {
      return { error: 'Algorithm "none" is not allowed' };
    }

    // 只支持 HS256 算法
    if (!SUPPORTED_ALGORITHMS.includes(header.alg as (typeof SUPPORTED_ALGORITHMS)[number])) {
      return { error: `Unsupported algorithm: ${header.alg}. Only ${SUPPORTED_ALGORITHMS.join(', ')} are supported` };
    }

    // 校验 typ 字段（如果存在，必须是 JWT）
    if (header.typ && header.typ.toUpperCase() !== 'JWT') {
      return { error: `Invalid token type: ${header.typ}` };
    }

    return { header, payload };
  } catch {
    return { error: 'Failed to parse token' };
  }
}

/**
 * 验证 JWT 签名（使用 HMAC-SHA256）
 * 使用跨平台兼容的 Base64URL 解码
 */
async function verifyJWTSignature(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const headerB64 = parts[0];
    const payloadB64 = parts[1];
    const signatureB64 = parts[2];

    if (!headerB64 || !payloadB64 || !signatureB64) return false;

    // 导入密钥
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );

    // 验证签名
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    // 使用跨平台兼容的 Base64URL 解码
    const signature = base64UrlToUint8Array(signatureB64);

    return await crypto.subtle.verify('HMAC', key, signature, data);
  } catch {
    return false;
  }
}

/**
 * JWT 验证选项
 */
export interface VerifyJWTOptions {
  /** 发行者 */
  issuer?: string;
  /** 受众（允许多个） */
  audience?: string | string[];
  /** 是否验证过期时间 */
  validateExpiry?: boolean;
  /** 时钟偏移容忍窗口（秒），默认 60 秒 */
  clockTolerance?: number;
}

/**
 * 验证 JWT Token
 *
 * 安全特性：
 * - 显式校验 alg/typ header
 * - 支持 aud（受众）验证
 * - 支持时钟偏移容忍
 */
export async function verifyJWT(
  token: string,
  secret: string,
  options?: VerifyJWTOptions
): Promise<{ valid: true; payload: JWTPayload } | { valid: false; error: string }> {
  const {
    issuer,
    audience,
    validateExpiry = true,
    clockTolerance = DEFAULT_CLOCK_TOLERANCE,
  } = options || {};

  // 解析 Token（包含 alg/typ 校验）
  const parsed = parseJWT(token);
  if ('error' in parsed) {
    return { valid: false, error: parsed.error };
  }

  const { payload } = parsed;

  // 验证签名
  const signatureValid = await verifyJWTSignature(token, secret);
  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  const now = Math.floor(Date.now() / 1000);

  // 验证过期时间（考虑时钟偏移容忍）
  if (validateExpiry && payload.exp) {
    if (payload.exp + clockTolerance < now) {
      return { valid: false, error: 'Token expired' };
    }
  }

  // 验证 not before（考虑时钟偏移容忍）
  if (typeof payload.nbf === 'number') {
    if (payload.nbf - clockTolerance > now) {
      return { valid: false, error: 'Token not yet valid' };
    }
  }

  // 验证发行者
  if (issuer && payload.iss !== issuer) {
    return { valid: false, error: 'Invalid issuer' };
  }

  // 验证受众（aud）
  if (audience) {
    const tokenAud = payload.aud;
    const allowedAudiences = Array.isArray(audience) ? audience : [audience];

    if (!tokenAud) {
      return { valid: false, error: 'Token missing audience claim' };
    }

    // Token 的 aud 可以是字符串或数组
    const tokenAudiences = Array.isArray(tokenAud) ? tokenAud : [tokenAud];
    const hasValidAudience = tokenAudiences.some((aud) => allowedAudiences.includes(aud as string));

    if (!hasValidAudience) {
      return { valid: false, error: 'Invalid audience' };
    }
  }

  return { valid: true, payload };
}

/**
 * 生成 JWT Token（用于测试）
 * 使用跨平台兼容的 Base64URL 编码
 */
export async function signJWT(
  payload: Omit<JWTPayload, 'iat' | 'exp'>,
  secret: string,
  options?: {
    expiresIn?: number; // 秒
  }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = options?.expiresIn ? now + options.expiresIn : now + 3600; // 默认 1 小时

  const fullPayload: JWTPayload = {
    ...payload,
    sub: payload.sub as string,
    roles: payload.roles as UserRole[],
    iat: now,
    exp,
  };

  // Header（显式指定 alg 和 typ）
  const header: JWTHeader = { alg: 'HS256', typ: 'JWT' };

  // 使用跨平台兼容的 Base64URL 编码
  const headerB64 = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));

  // 签名
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign('HMAC', key, data);

  // 使用跨平台兼容的 Base64URL 编码
  const signatureB64 = uint8ArrayToBase64Url(new Uint8Array(signature));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// ============================================================================
// 认证中间件
// ============================================================================

/**
 * 认证中间件配置
 */
export interface AuthMiddlewareOptions {
  /** JWT 密钥 */
  secret?: string;
  /** 发行者 */
  issuer?: string;
  /** 受众（支持单个或多个） */
  audience?: string | string[];
  /** 时钟偏移容忍窗口（秒） */
  clockTolerance?: number;
  /** 是否允许匿名访问 */
  allowAnonymous?: boolean;
  /** 跳过认证的路径 */
  skipPaths?: RegExp[];
  /** 自定义头名称 */
  headerName?: string;
  /** Token 前缀 */
  tokenPrefix?: string;
}

/**
 * 创建 JWT 认证中间件
 *
 * 功能:
 * - 验证 Authorization 头中的 JWT Token
 * - 校验 alg/typ header（防止算法混淆攻击）
 * - 支持 issuer 和 audience 验证
 * - 支持时钟偏移容忍
 * - 解析并存储用户信息到上下文
 * - 支持跳过特定路径
 * - 支持匿名访问模式
 */
export function authMiddleware(options: AuthMiddlewareOptions = {}) {
  const {
    secret,
    issuer = DEFAULT_CONFIG.JWT_ISSUER,
    audience,
    clockTolerance,
    allowAnonymous = false,
    skipPaths = [/^\/health$/, /^\/$/],
    headerName = 'Authorization',
    tokenPrefix = 'Bearer',
  } = options;

  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path;

    // 检查是否跳过该路径
    if (skipPaths.some((pattern) => pattern.test(path))) {
      await next();
      return;
    }

    // 获取 Token
    const authHeader = c.req.header(headerName);

    if (!authHeader) {
      if (allowAnonymous) {
        await next();
        return;
      }

      logger.warn('Missing authorization header', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        path,
      });

      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message: 'Missing authorization header',
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        401
      );
    }

    // 解析 Token
    const prefix = tokenPrefix + ' ';
    if (!authHeader.startsWith(prefix)) {
      logger.warn('Invalid authorization format', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
      });

      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.TOKEN_INVALID,
            message: `Authorization header must start with "${tokenPrefix}"`,
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        401
      );
    }

    const token = authHeader.slice(prefix.length);

    // 获取密钥（优先使用配置，否则从环境变量）
    const jwtSecret = secret || c.env?.JWT_SECRET;

    if (!jwtSecret) {
      logger.error('JWT secret not configured', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
      });

      return c.json(
        {
          success: false,
          error: {
            code: ERROR_CODES.INTERNAL_ERROR,
            message: 'Authentication service not configured',
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        500
      );
    }

    // 验证 Token（包含 alg/typ 校验、aud 验证、时钟偏移容忍）
    const verifyOptions: VerifyJWTOptions = { issuer };
    if (audience !== undefined) verifyOptions.audience = audience;
    if (clockTolerance !== undefined) verifyOptions.clockTolerance = clockTolerance;
    const result = await verifyJWT(token, jwtSecret, verifyOptions);

    if (!result.valid) {
      const isExpired = result.error === 'Token expired';

      logger.warn('Token validation failed', {
        traceId: c.get('traceId'),
        requestId: c.get('requestId'),
        reason: result.error,
      });

      return c.json(
        {
          success: false,
          error: {
            code: isExpired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.TOKEN_INVALID,
            message: result.error,
          },
          meta: {
            traceId: c.get('traceId'),
            requestId: c.get('requestId'),
          },
        },
        401
      );
    }

    // 存储 JWT payload 和用户信息
    c.set('jwtPayload', result.payload);
    c.set('user', {
      id: result.payload.sub,
      roles: result.payload.roles || ['viewer' as UserRole],
    });

    logger.debug('Authentication successful', {
      traceId: c.get('traceId'),
      requestId: c.get('requestId'),
      userId: result.payload.sub,
      roles: result.payload.roles,
    });

    await next();
    return;
  });
}

// ============================================================================
// 可选认证中间件
// ============================================================================

/**
 * 可选认证中间件
 *
 * 如果提供了 Token 则验证，否则允许匿名访问
 */
export function optionalAuthMiddleware(options: Omit<AuthMiddlewareOptions, 'allowAnonymous'> = {}) {
  const mergedOptions: AuthMiddlewareOptions = { ...options, allowAnonymous: true };
  return authMiddleware(mergedOptions);
}
