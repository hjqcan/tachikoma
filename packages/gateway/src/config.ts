/**
 * Gateway 配置管理
 *
 * 加载和管理环境变量配置
 */

import type {
  Bindings,
  SecurityPolicy,
  RolePermissions,
  AllowlistEntry,
  LogLevel,
} from './types';

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认配置值
 */
export const DEFAULT_CONFIG = {
  /** 默认端口 */
  PORT: 3000,
  /** 默认日志级别 */
  LOG_LEVEL: 'info' as LogLevel,
  /** 默认服务名称 */
  SERVICE_NAME: 'tachikoma-gateway',
  /** 默认最大请求体大小（1MB） */
  MAX_BODY_SIZE: 1024 * 1024,
  /** 默认请求超时（30秒） */
  REQUEST_TIMEOUT: 30000,
  /** 默认 JWT 发行者 */
  JWT_ISSUER: 'tachikoma',
} as const;

// ============================================================================
// 配置加载函数
// ============================================================================

/**
 * 从环境变量加载配置
 */
export function loadConfig(env: Bindings) {
  return {
    port: parseInt(env.PORT || String(DEFAULT_CONFIG.PORT), 10),
    logLevel: (env.LOG_LEVEL || DEFAULT_CONFIG.LOG_LEVEL) as LogLevel,
    serviceName: env.SERVICE_NAME || DEFAULT_CONFIG.SERVICE_NAME,
    maxBodySize: parseInt(env.MAX_BODY_SIZE || String(DEFAULT_CONFIG.MAX_BODY_SIZE), 10),
    jwtSecret: env.JWT_SECRET,
    jwtIssuer: env.JWT_ISSUER || DEFAULT_CONFIG.JWT_ISSUER,
    otelEndpoint: env.OTEL_ENDPOINT,
    allowedHosts: env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()) || [],
  };
}

// ============================================================================
// 安全策略默认配置
// ============================================================================

/**
 * 默认安全策略
 */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  inputValidation: {
    promptInjectionDetection: true,
    maxInputLength: 100000, // 100KB
    allowedPatterns: [],
    blockedPatterns: [
      // 常见提示注入模式
      /ignore\s+(previous|above|all)\s+instructions?/i,
      /disregard\s+(previous|above|all)\s+instructions?/i,
      /forget\s+(previous|above|all)\s+instructions?/i,
      /you\s+are\s+now\s+/i,
      /act\s+as\s+(if|a|an)\s+/i,
      /pretend\s+(to\s+be|you\s+are)\s+/i,
      /system\s*:\s*/i,
      /\[system\]/i,
      /<<SYS>>/i,
      /<\|system\|>/i,
    ],
  },
  outputValidation: {
    piiDetection: true,
    sensitiveDataMasking: true,
    tokenLeakagePrevention: true,
  },
  permissions: {
    networkAccess: 'allowlist',
    fileSystemAccess: 'sandbox',
    shellExecution: false,
  },
};

// ============================================================================
// RBAC 权限配置
// ============================================================================

/**
 * 角色权限映射
 */
export const ROLE_PERMISSIONS: RolePermissions = {
  admin: [
    { resource: 'tasks', operations: ['read', 'create', 'update', 'delete'] },
    { resource: 'agents', operations: ['read', 'create', 'update', 'delete'] },
    { resource: 'execute', operations: ['read', 'execute'] },
    { resource: 'health', operations: ['read'] },
    { resource: 'admin', operations: ['read', 'create', 'update', 'delete'] },
  ],
  operator: [
    { resource: 'tasks', operations: ['read', 'create', 'update'] },
    { resource: 'agents', operations: ['read', 'create', 'update'] },
    { resource: 'execute', operations: ['read', 'execute'] },
    { resource: 'health', operations: ['read'] },
  ],
  agent: [
    { resource: 'tasks', operations: ['read', 'update'] },
    { resource: 'agents', operations: ['read'] },
    { resource: 'execute', operations: ['execute'] },
    { resource: 'health', operations: ['read'] },
  ],
  viewer: [
    { resource: 'tasks', operations: ['read'] },
    { resource: 'agents', operations: ['read'] },
    { resource: 'health', operations: ['read'] },
  ],
};

// ============================================================================
// A2A/MCP 允许列表
// ============================================================================

/**
 * 默认允许列表
 */
export const DEFAULT_ALLOWLIST: AllowlistEntry[] = [
  {
    host: 'api.anthropic.com',
    pathPatterns: [/^\/v1\//],
    methods: ['POST'],
    description: 'Anthropic Claude API',
  },
  {
    host: 'api.openai.com',
    pathPatterns: [/^\/v1\//],
    methods: ['POST'],
    description: 'OpenAI API',
  },
  {
    host: 'localhost',
    pathPatterns: [/^\/mcp\//],
    methods: ['GET', 'POST'],
    description: 'Local MCP servers',
  },
];

// ============================================================================
// PII 检测模式
// ============================================================================

/**
 * PII（个人身份信息）检测正则表达式
 */
export const PII_PATTERNS = {
  /** 邮箱地址 */
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  /** 电话号码（国际格式） */
  phone: /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
  /** 中国手机号 */
  chinesePhone: /\b1[3-9]\d{9}\b/g,
  /** 身份证号 */
  idCard: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  /** 信用卡号 */
  creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  /** SSN（美国社会安全号） */
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  /** IP 地址 */
  ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

/**
 * Token/密钥检测正则表达式
 */
export const TOKEN_PATTERNS = {
  /** API 密钥（通用格式） */
  apiKey: /\b(?:sk|pk|api)[_-]?[A-Za-z0-9]{20,}\b/gi,
  /** JWT Token */
  jwt: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g,
  /** AWS 密钥 */
  awsKey: /\b(?:AKIA|A3T|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
  /** 私钥标识 */
  privateKey: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
  /** 密码字段 */
  password: /"password"\s*:\s*"[^"]+"/gi,
};

// ============================================================================
// 错误码定义
// ============================================================================

/**
 * 错误码枚举
 */
export const ERROR_CODES = {
  // 认证错误 (401)
  UNAUTHORIZED: 'AUTH_001',
  TOKEN_EXPIRED: 'AUTH_002',
  TOKEN_INVALID: 'AUTH_003',

  // 权限错误 (403)
  FORBIDDEN: 'PERM_001',
  INSUFFICIENT_PERMISSIONS: 'PERM_002',

  // 请求错误 (400)
  BAD_REQUEST: 'REQ_001',
  VALIDATION_ERROR: 'REQ_002',
  PROMPT_INJECTION_DETECTED: 'REQ_003',
  PAYLOAD_TOO_LARGE: 'REQ_004',

  // 资源错误 (404)
  NOT_FOUND: 'RES_001',
  RESOURCE_NOT_FOUND: 'RES_002',

  // 代理错误 (502)
  PROXY_ERROR: 'PROXY_001',
  HOST_NOT_ALLOWED: 'PROXY_002',

  // 输出过滤错误 (500)
  OUTPUT_BLOCKED: 'OUTPUT_001',
  OUTPUT_SENSITIVE_DATA_DETECTED: 'OUTPUT_002',

  // 服务器错误 (500)
  INTERNAL_ERROR: 'SRV_001',
  SERVICE_UNAVAILABLE: 'SRV_002',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
