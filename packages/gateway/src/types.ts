/**
 * Gateway 类型定义
 *
 * 定义 API 网关层的所有类型接口
 */

import type { Context } from 'hono';

// ============================================================================
// 环境变量和上下文类型
// ============================================================================

/**
 * 环境变量绑定类型
 */
export interface Bindings {
  /** 端口号 */
  PORT?: string;
  /** JWT 密钥 */
  JWT_SECRET?: string;
  /** JWT 发行者 */
  JWT_ISSUER?: string;
  /** 日志级别 */
  LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
  /** OTEL 端点 */
  OTEL_ENDPOINT?: string;
  /** 服务名称 */
  SERVICE_NAME?: string;
  /** 请求体大小限制（字节） */
  MAX_BODY_SIZE?: string;
  /** 允许的外部主机列表（逗号分隔） */
  ALLOWED_HOSTS?: string;
  /** CORS 允许的来源（逗号分隔，* 表示全部允许，空表示禁用 CORS） */
  CORS_ORIGINS?: string;
  /** 是否允许携带凭据的 CORS 请求 */
  CORS_CREDENTIALS?: string;
}

/**
 * 用户角色类型
 */
export type UserRole = 'admin' | 'operator' | 'agent' | 'viewer';

/**
 * JWT Payload 类型
 */
export interface JWTPayload {
  /** 主体标识 */
  sub: string;
  /** 用户角色 */
  roles: UserRole[];
  /** 发行者 */
  iss?: string;
  /** 受众（可以是字符串或字符串数组） */
  aud?: string | string[];
  /** 签发时间 */
  iat?: number;
  /** 过期时间 */
  exp?: number;
  /** 生效时间（Not Before） */
  nbf?: number;
  /** 额外声明 */
  [key: string]: unknown;
}

/**
 * 上下文变量类型
 */
export interface Variables {
  /** 追踪 ID */
  traceId: string;
  /** Span ID */
  spanId: string;
  /** 请求开始时间 */
  requestStart: number;
  /** JWT Payload */
  jwtPayload?: JWTPayload;
  /** 当前用户 */
  user?: {
    id: string;
    roles: UserRole[];
  };
  /** 请求 ID（用于日志） */
  requestId: string;
}

/**
 * Hono 应用环境类型
 */
export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}

// ============================================================================
// 响应类型
// ============================================================================

/**
 * API 成功响应
 */
export interface ApiSuccessResponse<T = unknown> {
  /** 是否成功 */
  success: true;
  /** 响应数据 */
  data: T;
  /** 元数据 */
  meta?: {
    /** 追踪 ID */
    traceId?: string;
    /** 请求 ID */
    requestId?: string;
    /** 响应时间（毫秒） */
    duration?: number;
    /** 分页信息 */
    pagination?: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}

/**
 * API 错误响应
 */
export interface ApiErrorResponse {
  /** 是否成功 */
  success: false;
  /** 错误信息 */
  error: {
    /** 错误码 */
    code: string;
    /** 错误消息 */
    message: string;
    /** 详细信息 */
    details?: unknown;
  };
  /** 元数据 */
  meta?: {
    /** 追踪 ID */
    traceId?: string;
    /** 请求 ID */
    requestId?: string;
  };
}

/**
 * API 响应类型
 */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// ============================================================================
// 安全策略类型
// ============================================================================

/**
 * 输入验证配置
 */
export interface InputValidationConfig {
  /** 是否启用提示注入检测 */
  promptInjectionDetection: boolean;
  /** 最大输入长度 */
  maxInputLength: number;
  /** 允许的输入模式（正则表达式） */
  allowedPatterns: RegExp[];
  /** 禁止的输入模式（正则表达式） */
  blockedPatterns: RegExp[];
}

/**
 * 输出验证配置
 */
export interface OutputValidationConfig {
  /** 是否启用 PII 检测 */
  piiDetection: boolean;
  /** 是否启用敏感数据脱敏 */
  sensitiveDataMasking: boolean;
  /** 是否启用 Token 泄漏防护 */
  tokenLeakagePrevention: boolean;
}

/**
 * 安全策略配置
 */
export interface SecurityPolicy {
  /** 输入验证配置 */
  inputValidation: InputValidationConfig;
  /** 输出验证配置 */
  outputValidation: OutputValidationConfig;
  /** 权限配置 */
  permissions: {
    /** 网络访问权限 */
    networkAccess: 'none' | 'allowlist' | 'all';
    /** 文件系统访问权限 */
    fileSystemAccess: 'sandbox' | 'readonly' | 'full';
    /** Shell 执行权限 */
    shellExecution: boolean;
  };
}

// ============================================================================
// RBAC 类型
// ============================================================================

/**
 * 资源类型
 */
export type ResourceType = 'tasks' | 'agents' | 'execute' | 'health' | 'admin';

/**
 * 操作类型
 */
export type Operation = 'read' | 'create' | 'update' | 'delete' | 'execute';

/**
 * 权限规则
 */
export interface Permission {
  /** 资源类型 */
  resource: ResourceType;
  /** 允许的操作 */
  operations: Operation[];
}

/**
 * 角色权限映射
 */
export type RolePermissions = Record<UserRole, Permission[]>;

// ============================================================================
// 日志类型
// ============================================================================

/**
 * 日志级别
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 结构化日志条目
 */
export interface LogEntry {
  /** 时间戳 */
  timestamp: string;
  /** 日志级别 */
  level: LogLevel;
  /** 消息 */
  message: string;
  /** 追踪 ID */
  traceId?: string;
  /** Span ID */
  spanId?: string;
  /** 请求 ID */
  requestId?: string;
  /** 路由路径 */
  route?: string;
  /** HTTP 方法 */
  method?: string;
  /** 响应状态码 */
  status?: number;
  /** 持续时间（毫秒） */
  duration?: number;
  /** 用户 ID */
  userId?: string;
  /** 额外数据 */
  [key: string]: unknown;
}

// ============================================================================
// A2A/MCP 代理类型
// ============================================================================

/**
 * 允许列表条目
 */
export interface AllowlistEntry {
  /** 主机名 */
  host: string;
  /** 允许的路径模式 */
  pathPatterns: RegExp[];
  /** 允许的 HTTP 方法 */
  methods: string[];
  /** 描述 */
  description: string;
}

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

// ============================================================================
// 路由元数据
// ============================================================================

/**
 * 路由元数据
 */
export interface RouteMetadata {
  /** 路由路径 */
  path: string;
  /** 所需资源类型 */
  resource: ResourceType;
  /** 所需操作 */
  operation: Operation;
  /** 是否公开（无需认证） */
  public?: boolean;
  /** 描述 */
  description?: string;
}

// ============================================================================
// 工具类型
// ============================================================================

/**
 * Hono Context 类型（带自定义环境）
 */
export type AppContext = Context<AppEnv>;
