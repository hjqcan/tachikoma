/**
 * @tachikoma/gateway
 *
 * Tachikoma API 网关 - HTTP 服务、安全中间件、身份认证
 *
 * @packageDocumentation
 */

// 导出版本信息
export const VERSION = '0.1.0';

// 导出类型
export type {
  // 环境和上下文
  AppEnv,
  Bindings,
  Variables,
  AppContext,
  // 用户和认证
  UserRole,
  JWTPayload,
  // 响应类型
  ApiResponse,
  ApiSuccessResponse,
  ApiErrorResponse,
  // 安全策略
  SecurityPolicy,
  InputValidationConfig,
  OutputValidationConfig,
  // RBAC
  ResourceType,
  Operation,
  Permission,
  RolePermissions,
  // 日志
  LogLevel,
  LogEntry,
  // 路由
  RouteMetadata,
  // 代理
  AllowlistEntry,
  ProxyRequestConfig,
} from './types';

// 导出配置
export {
  DEFAULT_CONFIG,
  DEFAULT_SECURITY_POLICY,
  ROLE_PERMISSIONS,
  DEFAULT_ALLOWLIST,
  PII_PATTERNS,
  TOKEN_PATTERNS,
  ERROR_CODES,
  loadConfig,
  type ErrorCode,
} from './config';

// 导出服务器创建函数
export {
  createServer,
  createDevServer,
  createProductionServer,
  type ServerOptions,
} from './server';

// 导出中间件
export * from './middleware';

// 导出工具函数
export { success, error } from './utils/response';
export * from './utils/response';

// 导出路由
export { createTasksRouter, createAgentsRouter, createExecuteRouter } from './routes';
