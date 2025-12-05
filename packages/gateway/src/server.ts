/**
 * Tachikoma Gateway Server
 *
 * 基于 Hono 的 HTTP 服务实现
 * 集成安全中间件、身份认证、追踪和日志
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { DEFAULT_CONFIG } from './config';
import { success, internalError } from './utils/response';
import {
  traceMiddleware,
  loggerMiddleware,
  bodyLimitMiddleware,
  authMiddleware,
  rbacMiddleware,
  inputFilterMiddleware,
  outputFilterMiddleware,
  logger,
} from './middleware';
import { createTasksRouter, createAgentsRouter, createExecuteRouter } from './routes';

// ============================================================================
// 服务器配置选项
// ============================================================================

/**
 * CORS 配置选项
 */
export interface CorsOptions {
  /** 允许的来源（数组或 '*'） */
  origins?: string[] | '*';
  /** 是否允许凭据 */
  credentials?: boolean;
  /** 允许的 HTTP 方法 */
  allowMethods?: string[];
  /** 允许的请求头 */
  allowHeaders?: string[];
  /** 暴露的响应头 */
  exposeHeaders?: string[];
  /** 预检请求缓存时间（秒） */
  maxAge?: number;
}

/**
 * 服务器配置选项
 */
export interface ServerOptions {
  /** 是否启用认证 */
  enableAuth?: boolean;
  /** 是否启用 RBAC */
  enableRBAC?: boolean;
  /** 是否启用输入过滤 */
  enableInputFilter?: boolean;
  /** 是否启用输出过滤 */
  enableOutputFilter?: boolean;
  /** JWT 密钥 */
  jwtSecret?: string;
  /** 允许匿名访问的路径 */
  publicPaths?: RegExp[];
  /** CORS 配置 */
  cors?: CorsOptions | false;
}

const DEFAULT_OPTIONS: ServerOptions = {
  enableAuth: true,
  enableRBAC: true,
  enableInputFilter: true,
  enableOutputFilter: true,
  publicPaths: [/^\/health$/, /^\/$/],
  // 生产模式默认不开放 CORS
  cors: false,
};

// ============================================================================
// 创建服务器
// ============================================================================

/**
 * 创建 Hono 应用实例
 */
export function createServer(options: ServerOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const app = new Hono<AppEnv>();

  // ========================================
  // 基础中间件
  // ========================================

  // CORS（根据配置启用，生产模式应明确指定允许的来源）
  if (opts.cors !== false) {
    const corsConfig = opts.cors || {};

    // 构建 CORS 选项
    const corsOptions: Parameters<typeof cors>[0] = {
      // 允许的来源
      origin: corsConfig.origins === '*'
        ? '*'
        : (corsConfig.origins || []),
      // 是否允许凭据（注意：如果 origin 是 '*'，则不能设置 credentials: true）
      credentials: corsConfig.origins === '*' ? false : (corsConfig.credentials ?? false),
      // 允许的方法
      allowMethods: corsConfig.allowMethods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      // 允许的请求头
      allowHeaders: corsConfig.allowHeaders || ['Content-Type', 'Authorization', 'X-Trace-Id', 'X-Request-Id'],
      // 暴露的响应头
      exposeHeaders: corsConfig.exposeHeaders || ['X-Trace-Id', 'X-Request-Id', 'X-Span-Id', 'traceparent'],
      // 预检请求缓存
      maxAge: corsConfig.maxAge ?? 86400, // 默认 24 小时
    };

    app.use('*', cors(corsOptions));

    logger.debug('CORS enabled', {
      origins: corsConfig.origins,
      credentials: corsOptions.credentials,
    });
  } else {
    logger.debug('CORS disabled');
  }

  // 追踪中间件（最先执行，生成 TraceID）
  app.use('*', traceMiddleware({
    propagateFromRequest: true,
    includeInResponse: true,
  }));

  // 请求体大小限制
  app.use('*', bodyLimitMiddleware({
    maxSize: DEFAULT_CONFIG.MAX_BODY_SIZE,
  }));

  // JSON 日志中间件
  app.use('*', loggerMiddleware({
    skipPaths: [/^\/health$/],
  }));

  // ========================================
  // 安全中间件（条件启用）
  // ========================================

  // 输入过滤（提示注入检测等）
  if (opts.enableInputFilter) {
    app.use('/api/*', inputFilterMiddleware({
      ...(opts.publicPaths && { skipPaths: opts.publicPaths }),
    }));
  }

  // JWT 认证
  if (opts.enableAuth) {
    app.use('/api/*', authMiddleware({
      ...(opts.jwtSecret && { secret: opts.jwtSecret }),
      ...(opts.publicPaths && { skipPaths: opts.publicPaths }),
      allowAnonymous: false,
    }));
  }

  // RBAC 权限控制
  if (opts.enableRBAC && opts.enableAuth) {
    app.use('/api/*', rbacMiddleware({
      ...(opts.publicPaths && { skipPaths: opts.publicPaths }),
    }));
  }

  // 输出过滤（PII 脱敏等）
  if (opts.enableOutputFilter) {
    app.use('/api/*', outputFilterMiddleware({
      ...(opts.publicPaths && { skipPaths: opts.publicPaths }),
      logDetections: true,
    }));
  }

  // ========================================
  // 健康检查（无需认证）
  // ========================================

  app.get('/health', (c) => {
    return success(c, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      service: DEFAULT_CONFIG.SERVICE_NAME,
    });
  });

  // 根路径
  app.get('/', (c) => {
    return success(c, {
      name: 'Tachikoma Gateway',
      version: '0.1.0',
      docs: '/api/docs',
    });
  });

  // ========================================
  // API 路由
  // ========================================

  // Tasks API
  app.route('/api/tasks', createTasksRouter());

  // Agents API
  app.route('/api/agents', createAgentsRouter());

  // Execute API
  app.route('/api/execute', createExecuteRouter());

  // ========================================
  // 错误处理
  // ========================================

  // 404 处理
  app.notFound((c) => {
    return c.json(
      {
        success: false,
        error: {
          code: 'RES_001',
          message: 'Not Found',
        },
        meta: {
          traceId: c.get('traceId'),
          requestId: c.get('requestId'),
        },
      },
      404
    );
  });

  // 全局错误处理
  app.onError((err, c) => {
    logger.error('Unhandled server error', {
      traceId: c.get('traceId'),
      requestId: c.get('requestId'),
      error: err.message,
      stack: err.stack,
    });

    return internalError(c, 'Internal Server Error');
  });

  return app;
}

// ============================================================================
// 开发模式服务器（禁用认证）
// ============================================================================

/**
 * 创建开发模式服务器
 *
 * 禁用认证和部分安全检查，便于开发测试
 * 注意：开发模式允许所有来源的 CORS 请求
 */
export function createDevServer() {
  return createServer({
    enableAuth: false,
    enableRBAC: false,
    enableInputFilter: true,
    enableOutputFilter: false,
    // 开发模式允许所有来源
    cors: {
      origins: '*',
      credentials: false,
    },
  });
}

// ============================================================================
// 生产模式服务器
// ============================================================================

/**
 * 生产模式服务器配置
 */
export interface ProductionServerConfig {
  /** JWT 密钥（必须） */
  jwtSecret: string;
  /** CORS 允许的来源（不指定则禁用 CORS） */
  corsOrigins?: string[];
  /** 是否允许凭据（仅在指定 corsOrigins 时有效） */
  corsCredentials?: boolean;
}

/**
 * 创建生产模式服务器
 *
 * 启用所有安全特性
 * CORS 默认禁用，需要明确指定允许的来源
 */
export function createProductionServer(config: ProductionServerConfig | string) {
  // 兼容旧的 API（只传 jwtSecret 字符串）
  const { jwtSecret, corsOrigins, corsCredentials } = typeof config === 'string'
    ? { jwtSecret: config, corsOrigins: undefined, corsCredentials: undefined }
    : config;

  return createServer({
    enableAuth: true,
    enableRBAC: true,
    enableInputFilter: true,
    enableOutputFilter: true,
    jwtSecret,
    // 生产模式 CORS 配置
    cors: corsOrigins && corsOrigins.length > 0
      ? {
          origins: corsOrigins,
          credentials: corsCredentials ?? false,
        }
      : false,
  });
}

// ============================================================================
// 服务器启动
// ============================================================================

// 如果直接运行此文件，启动服务器
if (import.meta.main) {
  const isDev = process.env.NODE_ENV !== 'production';
  const port = parseInt(process.env.PORT || String(DEFAULT_CONFIG.PORT), 10);
  const jwtSecret = process.env.JWT_SECRET;

  // 解析 CORS 配置
  const corsOrigins = process.env.CORS_ORIGINS;
  const corsCredentials = process.env.CORS_CREDENTIALS === 'true';

  // 选择服务器模式
  let app: ReturnType<typeof createServer>;

  if (isDev || !jwtSecret) {
    console.log('⚠️  Running in development mode (authentication disabled)');
    app = createDevServer();
  } else {
    console.log('🔒 Running in production mode (authentication enabled)');

    // 解析 CORS 来源
    const parsedCorsOrigins = corsOrigins
      ? corsOrigins.split(',').map((o) => o.trim()).filter(Boolean)
      : undefined;

    if (parsedCorsOrigins && parsedCorsOrigins.length > 0) {
      console.log(`🌐 CORS enabled for origins: ${parsedCorsOrigins.join(', ')}`);
    } else {
      console.log('🚫 CORS disabled (no CORS_ORIGINS configured)');
    }

    // 构建生产模式配置（只包含有值的属性）
    const prodConfig: ProductionServerConfig = { jwtSecret };
    if (parsedCorsOrigins && parsedCorsOrigins.length > 0) {
      prodConfig.corsOrigins = parsedCorsOrigins;
      prodConfig.corsCredentials = corsCredentials;
    }
    app = createProductionServer(prodConfig);
  }

  console.log(`🚀 Tachikoma Gateway starting on port ${port}...`);

  Bun.serve({
    fetch: app.fetch,
    port,
  });

  console.log(`✅ Server running at http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
}
