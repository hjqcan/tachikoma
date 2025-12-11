/**
 * MCP 配置加载模块
 *
 * 从配置文件和环境变量加载 MCP 服务器配置
 *
 * 配置优先级（高到低）：
 * 1. 环境变量 MCP_SERVERS（JSON 格式）
 * 2. .tachikoma/mcp.json 文件
 * 3. 默认配置
 *
 * @module mcp/config
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import {
  type MCPConfig,
  type MCPServerConfig,
  type MCPCallMode,
  DEFAULT_MCP_CONFIG,
  DEFAULT_CALL_MODE,
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_CALL_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY,
} from './types';

// ============================================================================
// 配置文件路径
// ============================================================================

/** MCP 配置文件名 */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/** Tachikoma 配置目录名 */
export const TACHIKOMA_CONFIG_DIR = '.tachikoma';

// ============================================================================
// 环境变量名
// ============================================================================

/** MCP 服务器列表环境变量（JSON 格式） */
export const ENV_MCP_SERVERS = 'MCP_SERVERS';

/** MCP 默认调用模式环境变量 */
export const ENV_MCP_DEFAULT_MODE = 'MCP_DEFAULT_MODE';

/** MCP servers 目录路径环境变量 */
export const ENV_MCP_SERVERS_DIR = 'MCP_SERVERS_DIR';

// ============================================================================
// 配置加载
// ============================================================================

/**
 * 加载 MCP 配置
 *
 * @param workDir - 工作目录（用于查找 .tachikoma/mcp.json）
 * @param overrides - 覆盖配置（可选）
 * @returns 合并后的 MCP 配置
 *
 * @example
 * ```ts
 * const config = await loadMCPConfig('/path/to/project');
 * console.log(config.servers); // 配置的服务器列表
 * ```
 */
export async function loadMCPConfig(
  workDir: string = process.cwd(),
  overrides?: Partial<MCPConfig>
): Promise<MCPConfig> {
  // 1. 从默认配置开始
  let config: MCPConfig = { ...DEFAULT_MCP_CONFIG };

  // 2. 尝试加载配置文件
  const fileConfig = await loadMCPConfigFromFile(workDir);
  if (fileConfig) {
    config = mergeConfigs(config, fileConfig);
  }

  // 3. 从环境变量加载
  const envConfig = loadMCPConfigFromEnv();
  config = mergeConfigs(config, envConfig);

  // 4. 应用覆盖配置
  if (overrides) {
    config = mergeConfigs(config, overrides);
  }

  // 5. 规范化服务器配置
  config.servers = config.servers.map(normalizeServerConfig);

  return config;
}

/**
 * 从文件加载 MCP 配置
 *
 * @param workDir - 工作目录
 * @returns 配置对象，如果文件不存在返回 null
 */
export async function loadMCPConfigFromFile(
  workDir: string
): Promise<Partial<MCPConfig> | null> {
  const configPath = resolve(workDir, TACHIKOMA_CONFIG_DIR, MCP_CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(content);

    // 基础验证
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(`[MCP Config] Invalid config file format: ${configPath}`);
      return null;
    }

    return parsed as Partial<MCPConfig>;
  } catch (error) {
    console.warn(`[MCP Config] Failed to load config from ${configPath}:`, error);
    return null;
  }
}

/**
 * 从环境变量加载 MCP 配置
 *
 * @returns 从环境变量解析的部分配置
 */
export function loadMCPConfigFromEnv(): Partial<MCPConfig> {
  const config: Partial<MCPConfig> = {};

  // MCP_SERVERS: JSON 格式的服务器列表
  const serversJson = process.env[ENV_MCP_SERVERS];
  if (serversJson) {
    try {
      const servers = JSON.parse(serversJson);
      if (Array.isArray(servers)) {
        config.servers = servers;
      }
    } catch (error) {
      console.warn(`[MCP Config] Failed to parse ${ENV_MCP_SERVERS}:`, error);
    }
  }

  // MCP_DEFAULT_MODE: 默认调用模式
  const defaultMode = process.env[ENV_MCP_DEFAULT_MODE];
  if (defaultMode === 'traditional' || defaultMode === 'code-execution') {
    config.defaultMode = defaultMode as MCPCallMode;
  }

  // MCP_SERVERS_DIR: servers 目录路径
  const serversDir = process.env[ENV_MCP_SERVERS_DIR];
  if (serversDir) {
    config.serversDir = serversDir;
  }

  return config;
}

// ============================================================================
// 配置合并与规范化
// ============================================================================

/**
 * 合并两个配置对象
 *
 * @param base - 基础配置
 * @param override - 覆盖配置
 * @returns 合并后的配置
 */
export function mergeConfigs(
  base: MCPConfig,
  override: Partial<MCPConfig>
): MCPConfig {
  const result: MCPConfig = { ...base };

  // 合并服务器列表（覆盖，不合并）
  if (override.servers !== undefined) {
    result.servers = override.servers;
  }

  // 合并其他字段
  if (override.defaultMode !== undefined) {
    result.defaultMode = override.defaultMode;
  }
  if (override.defaultConnectionTimeout !== undefined) {
    result.defaultConnectionTimeout = override.defaultConnectionTimeout;
  }
  if (override.defaultCallTimeout !== undefined) {
    result.defaultCallTimeout = override.defaultCallTimeout;
  }
  if (override.enableToolCache !== undefined) {
    result.enableToolCache = override.enableToolCache;
  }
  if (override.toolCacheTTL !== undefined) {
    result.toolCacheTTL = override.toolCacheTTL;
  }
  if (override.circuitBreakerThreshold !== undefined) {
    result.circuitBreakerThreshold = override.circuitBreakerThreshold;
  }
  if (override.circuitBreakerRecoveryTime !== undefined) {
    result.circuitBreakerRecoveryTime = override.circuitBreakerRecoveryTime;
  }
  if (override.serversDir !== undefined) {
    result.serversDir = override.serversDir;
  }

  return result;
}

/**
 * 规范化服务器配置
 *
 * 填充默认值，确保必填字段存在
 *
 * @param config - 原始服务器配置
 * @returns 规范化后的配置
 */
export function normalizeServerConfig(config: MCPServerConfig): MCPServerConfig {
  return {
    ...config,
    enabled: config.enabled ?? true,
    mode: config.mode ?? DEFAULT_CALL_MODE,
    connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
    callTimeout: config.callTimeout ?? DEFAULT_CALL_TIMEOUT,
    autoReconnect: config.autoReconnect ?? true,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseDelay: config.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY,
    args: config.args ?? [],
  };
}

// ============================================================================
// 配置验证
// ============================================================================

/**
 * 验证配置错误
 */
export interface MCPConfigError {
  path: string;
  message: string;
}

/**
 * 验证 MCP 配置
 *
 * @param config - 待验证的配置
 * @returns 错误列表（空数组表示验证通过）
 */
export function validateMCPConfig(config: MCPConfig): MCPConfigError[] {
  const errors: MCPConfigError[] = [];

  // ========== 验证顶层字段 ==========

  // 验证 defaultMode
  if (
    config.defaultMode !== undefined &&
    !['traditional', 'code-execution'].includes(config.defaultMode)
  ) {
    errors.push({
      path: 'defaultMode',
      message: 'defaultMode must be "traditional" or "code-execution"',
    });
  }

  // 验证数值字段（必须是正数）
  const numericFields: { field: keyof MCPConfig; minValue?: number }[] = [
    { field: 'defaultConnectionTimeout', minValue: 1 },
    { field: 'defaultCallTimeout', minValue: 1 },
    { field: 'toolCacheTTL', minValue: 0 },
    { field: 'circuitBreakerThreshold', minValue: 1 },
    { field: 'circuitBreakerRecoveryTime', minValue: 1 },
  ];

  for (const { field, minValue = 0 } of numericFields) {
    const value = config[field];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({
          path: field,
          message: `${field} must be a finite number`,
        });
      } else if (value < minValue) {
        errors.push({
          path: field,
          message: `${field} must be >= ${minValue}`,
        });
      }
    }
  }

  // ========== 验证服务器列表 ==========

  if (!Array.isArray(config.servers)) {
    errors.push({
      path: 'servers',
      message: 'servers must be an array',
    });
    return errors;
  }

  // 验证每个服务器配置
  const serverNames = new Set<string>();

  config.servers.forEach((server, index) => {
    const prefix = `servers[${index}]`;

    // 名称必填且唯一
    if (!server.name || typeof server.name !== 'string') {
      errors.push({
        path: `${prefix}.name`,
        message: 'server name is required and must be a string',
      });
    } else if (serverNames.has(server.name)) {
      errors.push({
        path: `${prefix}.name`,
        message: `duplicate server name: ${server.name}`,
      });
    } else {
      serverNames.add(server.name);
    }

    // transport 必填
    if (!server.transport || !['stdio', 'http'].includes(server.transport)) {
      errors.push({
        path: `${prefix}.transport`,
        message: 'transport must be "stdio" or "http"',
      });
    }

    // STDIO 模式需要 command
    if (server.transport === 'stdio' && !server.command) {
      errors.push({
        path: `${prefix}.command`,
        message: 'command is required for stdio transport',
      });
    }

    // HTTP 模式需要 url
    if (server.transport === 'http' && !server.url) {
      errors.push({
        path: `${prefix}.url`,
        message: 'url is required for http transport',
      });
    }

    // mode 验证
    if (server.mode && !['traditional', 'code-execution'].includes(server.mode)) {
      errors.push({
        path: `${prefix}.mode`,
        message: 'mode must be "traditional" or "code-execution"',
      });
    }

    // 服务器级别的数值字段验证
    const serverNumericFields: {
      field: keyof MCPServerConfig;
      minValue?: number;
    }[] = [
      { field: 'connectionTimeout', minValue: 1 },
      { field: 'callTimeout', minValue: 1 },
      { field: 'maxRetries', minValue: 0 },
      { field: 'retryBaseDelay', minValue: 0 },
    ];

    for (const { field, minValue = 0 } of serverNumericFields) {
      const value = server[field];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push({
            path: `${prefix}.${field}`,
            message: `${field} must be a finite number`,
          });
        } else if (value < minValue) {
          errors.push({
            path: `${prefix}.${field}`,
            message: `${field} must be >= ${minValue}`,
          });
        }
      }
    }
  });

  return errors;
}

// ============================================================================
// 配置示例
// ============================================================================

/**
 * 创建示例 MCP 配置
 *
 * @returns 包含常见服务器的示例配置
 */
export function createExampleMCPConfig(): MCPConfig {
  return {
    ...DEFAULT_MCP_CONFIG,
    servers: [
      {
        name: 'filesystem',
        description: 'Local file system access',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
        enabled: true,
        mode: 'traditional',
      },
      {
        name: 'calculator',
        description: 'Simple calculator (FastMCP example)',
        transport: 'http',
        url: 'http://localhost:8000',
        enabled: false,
        mode: 'code-execution',
      },
    ],
  };
}

/**
 * 将配置序列化为 JSON 字符串
 *
 * @param config - MCP 配置
 * @returns 格式化的 JSON 字符串
 */
export function serializeMCPConfig(config: MCPConfig): string {
  return JSON.stringify(config, null, 2);
}
