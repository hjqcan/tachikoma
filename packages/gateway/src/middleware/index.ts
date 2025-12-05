/**
 * 中间件导出
 *
 * 统一导出所有中间件模块
 */

// 追踪中间件
export {
  traceMiddleware,
  generateTraceId,
  generateSpanId,
  generateRequestId,
  parseTraceparent,
  formatTraceparent,
  createSpanContext,
  setSpanAttribute,
  addSpanEvent,
  endSpan,
  type TraceMiddlewareOptions,
  type SpanContext,
  type SpanStatus,
} from './trace';

// 日志中间件
export {
  loggerMiddleware,
  bodyLimitMiddleware,
  Logger,
  logger,
  type LoggerMiddlewareOptions,
  type BodyLimitMiddlewareOptions,
} from './logger';

// 认证中间件
export {
  authMiddleware,
  optionalAuthMiddleware,
  verifyJWT,
  signJWT,
  parseJWT,
  type AuthMiddlewareOptions,
} from './auth';

// RBAC 中间件
export {
  rbacMiddleware,
  requirePermission,
  requireRole,
  hasPermission,
  getPermissions,
  hasAnyRole,
  hasAllRoles,
  methodToOperation,
  pathToResource,
  type RBACMiddlewareOptions,
} from './rbac';

// 输入过滤中间件
export {
  inputFilterMiddleware,
  simpleInjectionGuard,
  detectPromptInjection,
  validateLength,
  matchesAllowlist,
  validateObject,
  type InputFilterMiddlewareOptions,
  type InjectionDetectionResult,
} from './input-filter';

// 输出过滤中间件
export {
  outputFilterMiddleware,
  maskEmail,
  maskPhone,
  maskCreditCard,
  maskIdCard,
  maskIpAddress,
  maskToken,
  detectPII,
  detectTokens,
  sanitizeText,
  sanitizeObject,
  containsSensitiveData,
  getSensitiveDataSummary,
  type OutputFilterMiddlewareOptions,
  type MaskingOptions,
  type DetectionResult,
} from './output-filter';

// 代理服务
export {
  ProxyService,
  proxyService,
  proxyRequest,
  proxyMCPRequest,
  isUrlAllowed,
  validateRequest,
  type ProxyServiceOptions,
  type ProxyResult,
  type ProxyRequestConfig,
  type MCPRequest,
  type MCPResponse,
} from './proxy';
