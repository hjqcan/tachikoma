/**
 * MCP 类型与配置测试
 *
 * @module mcp.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  // 类型相关
  type MCPServerConfig,
  type MCPConfig,
  type MCPCallMode,
  type MCPStdioParams,
  type MCPHttpParams,
  // 常量
  DEFAULT_MCP_CONFIG,
  DEFAULT_CALL_MODE,
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_CALL_TIMEOUT,
  // 辅助函数
  isStdioConfig,
  isHttpConfig,
  getConnectionParams,
  generateTachikomaToolName,
  // 配置函数
  loadMCPConfig,
  loadMCPConfigFromEnv,
  mergeConfigs,
  normalizeServerConfig,
  validateMCPConfig,
  createExampleMCPConfig,
  serializeMCPConfig,
  // 环境变量名
  ENV_MCP_SERVERS,
  ENV_MCP_DEFAULT_MODE,
  ENV_MCP_SERVERS_DIR,
} from './index';

// ============================================================================
// 类型检查测试
// ============================================================================

describe('MCP Types', () => {
  describe('MCPServerConfig', () => {
    it('should accept valid STDIO config', () => {
      const config: MCPServerConfig = {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        enabled: true,
        mode: 'traditional',
      };

      expect(config.name).toBe('filesystem');
      expect(config.transport).toBe('stdio');
      expect(config.command).toBe('npx');
    });

    it('should accept valid HTTP config', () => {
      const config: MCPServerConfig = {
        name: 'calculator',
        transport: 'http',
        url: 'http://localhost:8000',
        enabled: true,
        mode: 'code-execution',
      };

      expect(config.name).toBe('calculator');
      expect(config.transport).toBe('http');
      expect(config.url).toBe('http://localhost:8000');
    });
  });

  describe('MCPCallMode', () => {
    it('should accept valid modes', () => {
      const traditional: MCPCallMode = 'traditional';
      const codeExecution: MCPCallMode = 'code-execution';

      expect(traditional).toBe('traditional');
      expect(codeExecution).toBe('code-execution');
    });
  });
});

// ============================================================================
// 常量测试
// ============================================================================

describe('MCP Constants', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_CALL_MODE).toBe('traditional');
    expect(DEFAULT_CONNECTION_TIMEOUT).toBe(30000);
    expect(DEFAULT_CALL_TIMEOUT).toBe(60000);
  });

  it('should have valid default config', () => {
    expect(DEFAULT_MCP_CONFIG.servers).toEqual([]);
    expect(DEFAULT_MCP_CONFIG.defaultMode).toBe('traditional');
    expect(DEFAULT_MCP_CONFIG.enableToolCache).toBe(true);
    expect(DEFAULT_MCP_CONFIG.serversDir).toBe('./servers');
  });
});

// ============================================================================
// 辅助函数测试
// ============================================================================

describe('MCP Helper Functions', () => {
  describe('isStdioConfig', () => {
    it('should return true for valid STDIO config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'stdio',
        command: 'npx',
      };
      expect(isStdioConfig(config)).toBe(true);
    });

    it('should return false for HTTP config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'http',
        url: 'http://localhost:8000',
      };
      expect(isStdioConfig(config)).toBe(false);
    });

    it('should return false for STDIO config without command', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'stdio',
      };
      expect(isStdioConfig(config)).toBe(false);
    });
  });

  describe('isHttpConfig', () => {
    it('should return true for valid HTTP config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'http',
        url: 'http://localhost:8000',
      };
      expect(isHttpConfig(config)).toBe(true);
    });

    it('should return false for STDIO config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'stdio',
        command: 'npx',
      };
      expect(isHttpConfig(config)).toBe(false);
    });
  });

  describe('getConnectionParams', () => {
    it('should return STDIO params for STDIO config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-package'],
        env: { NODE_ENV: 'test' },
        cwd: '/workspace',
      };

      const params = getConnectionParams(config) as MCPStdioParams;
      expect(params.command).toBe('npx');
      expect(params.args).toEqual(['-y', 'some-package']);
      expect(params.env).toEqual({ NODE_ENV: 'test' });
      expect(params.cwd).toBe('/workspace');
    });

    it('should return HTTP params for HTTP config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'http',
        url: 'http://localhost:8000',
        headers: { Authorization: 'Bearer token' },
        connectionTimeout: 5000,
      };

      const params = getConnectionParams(config) as MCPHttpParams;
      expect(params.url).toBe('http://localhost:8000');
      expect(params.headers).toEqual({ Authorization: 'Bearer token' });
      expect(params.timeout).toBe(5000);
    });

    it('should throw for invalid config', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'stdio',
        // missing command
      };

      expect(() => getConnectionParams(config)).toThrow();
    });
  });

  describe('generateTachikomaToolName', () => {
    it('should generate valid tool name', () => {
      expect(generateTachikomaToolName('filesystem', 'read_file')).toBe(
        'mcp_filesystem_read_file'
      );
    });

    it('should sanitize special characters', () => {
      expect(generateTachikomaToolName('google-drive', 'getDocument')).toBe(
        'mcp_google_drive_getDocument'
      );
    });

    it('should handle dots and other special chars', () => {
      expect(generateTachikomaToolName('some.server', 'tool.name')).toBe(
        'mcp_some_server_tool_name'
      );
    });
  });
});

// ============================================================================
// 配置加载测试
// ============================================================================

describe('MCP Config Loading', () => {
  const testDir = join(process.cwd(), '__mcp_config_test__');
  const tachikomaDir = join(testDir, '.tachikoma');
  const configPath = join(tachikomaDir, 'mcp.json');

  beforeEach(async () => {
    // 清理测试目录
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
    await mkdir(tachikomaDir, { recursive: true });

    // 清理环境变量
    delete process.env[ENV_MCP_SERVERS];
    delete process.env[ENV_MCP_DEFAULT_MODE];
    delete process.env[ENV_MCP_SERVERS_DIR];
  });

  afterEach(async () => {
    // 清理测试目录
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }

    // 清理环境变量
    delete process.env[ENV_MCP_SERVERS];
    delete process.env[ENV_MCP_DEFAULT_MODE];
    delete process.env[ENV_MCP_SERVERS_DIR];
  });

  describe('loadMCPConfig', () => {
    it('should return default config when no file or env', async () => {
      const emptyDir = join(testDir, 'empty');
      await mkdir(emptyDir, { recursive: true });

      const config = await loadMCPConfig(emptyDir);

      expect(config.servers).toEqual([]);
      expect(config.defaultMode).toBe('traditional');
    });

    it('should load config from file', async () => {
      const fileConfig: MCPConfig = {
        servers: [
          {
            name: 'test-server',
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        ],
        defaultMode: 'code-execution',
      };

      await writeFile(configPath, JSON.stringify(fileConfig));

      const config = await loadMCPConfig(testDir);

      expect(config.servers.length).toBe(1);
      expect(config.servers[0].name).toBe('test-server');
      expect(config.defaultMode).toBe('code-execution');
    });

    it('should apply overrides', async () => {
      const config = await loadMCPConfig(testDir, {
        defaultMode: 'code-execution',
        serversDir: './custom-servers',
      });

      expect(config.defaultMode).toBe('code-execution');
      expect(config.serversDir).toBe('./custom-servers');
    });
  });

  describe('loadMCPConfigFromEnv', () => {
    it('should parse MCP_SERVERS JSON', () => {
      const servers = [
        { name: 'env-server', transport: 'http', url: 'http://localhost:9000' },
      ];
      process.env[ENV_MCP_SERVERS] = JSON.stringify(servers);

      const config = loadMCPConfigFromEnv();

      expect(config.servers?.length).toBe(1);
      expect(config.servers?.[0].name).toBe('env-server');
    });

    it('should parse MCP_DEFAULT_MODE', () => {
      process.env[ENV_MCP_DEFAULT_MODE] = 'code-execution';

      const config = loadMCPConfigFromEnv();

      expect(config.defaultMode).toBe('code-execution');
    });

    it('should parse MCP_SERVERS_DIR', () => {
      process.env[ENV_MCP_SERVERS_DIR] = '/custom/path';

      const config = loadMCPConfigFromEnv();

      expect(config.serversDir).toBe('/custom/path');
    });

    it('should ignore invalid MCP_DEFAULT_MODE', () => {
      process.env[ENV_MCP_DEFAULT_MODE] = 'invalid-mode';

      const config = loadMCPConfigFromEnv();

      expect(config.defaultMode).toBeUndefined();
    });
  });

  describe('mergeConfigs', () => {
    it('should merge configs correctly', () => {
      const base = { ...DEFAULT_MCP_CONFIG };
      const override: Partial<MCPConfig> = {
        defaultMode: 'code-execution',
        toolCacheTTL: 600000,
      };

      const merged = mergeConfigs(base, override);

      expect(merged.defaultMode).toBe('code-execution');
      expect(merged.toolCacheTTL).toBe(600000);
      // Unchanged fields should remain
      expect(merged.enableToolCache).toBe(true);
    });

    it('should replace servers array', () => {
      const base: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [{ name: 'old', transport: 'stdio', command: 'old' }],
      };
      const override: Partial<MCPConfig> = {
        servers: [{ name: 'new', transport: 'http', url: 'http://new' }],
      };

      const merged = mergeConfigs(base, override);

      expect(merged.servers.length).toBe(1);
      expect(merged.servers[0].name).toBe('new');
    });
  });

  describe('normalizeServerConfig', () => {
    it('should fill default values', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'stdio',
        command: 'node',
      };

      const normalized = normalizeServerConfig(config);

      expect(normalized.enabled).toBe(true);
      expect(normalized.mode).toBe('traditional');
      expect(normalized.connectionTimeout).toBe(30000);
      expect(normalized.callTimeout).toBe(60000);
      expect(normalized.autoReconnect).toBe(true);
      expect(normalized.maxRetries).toBe(3);
      expect(normalized.args).toEqual([]);
    });

    it('should preserve existing values', () => {
      const config: MCPServerConfig = {
        name: 'test',
        transport: 'http',
        url: 'http://localhost',
        enabled: false,
        mode: 'code-execution',
        connectionTimeout: 5000,
      };

      const normalized = normalizeServerConfig(config);

      expect(normalized.enabled).toBe(false);
      expect(normalized.mode).toBe('code-execution');
      expect(normalized.connectionTimeout).toBe(5000);
    });
  });
});

// ============================================================================
// 配置验证测试
// ============================================================================

describe('MCP Config Validation', () => {
  describe('validateMCPConfig', () => {
    it('should pass valid config', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [
          { name: 'server1', transport: 'stdio', command: 'node' },
          { name: 'server2', transport: 'http', url: 'http://localhost' },
        ],
      };

      const errors = validateMCPConfig(config);

      expect(errors).toEqual([]);
    });

    it('should detect missing name', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [{ transport: 'stdio', command: 'node' } as MCPServerConfig],
      };

      const errors = validateMCPConfig(config);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].path).toContain('name');
    });

    it('should detect duplicate names', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [
          { name: 'duplicate', transport: 'stdio', command: 'node' },
          { name: 'duplicate', transport: 'http', url: 'http://localhost' },
        ],
      };

      const errors = validateMCPConfig(config);

      expect(errors.some((e) => e.message.includes('duplicate'))).toBe(true);
    });

    it('should detect invalid transport', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [
          { name: 'test', transport: 'invalid' as 'stdio' } as MCPServerConfig,
        ],
      };

      const errors = validateMCPConfig(config);

      expect(errors.some((e) => e.path.includes('transport'))).toBe(true);
    });

    it('should detect missing command for STDIO', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [{ name: 'test', transport: 'stdio' }],
      };

      const errors = validateMCPConfig(config);

      expect(errors.some((e) => e.path.includes('command'))).toBe(true);
    });

    it('should detect missing url for HTTP', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [{ name: 'test', transport: 'http' }],
      };

      const errors = validateMCPConfig(config);

      expect(errors.some((e) => e.path.includes('url'))).toBe(true);
    });

    it('should detect invalid mode', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [
          {
            name: 'test',
            transport: 'stdio',
            command: 'node',
            mode: 'invalid' as MCPCallMode,
          },
        ],
      };

      const errors = validateMCPConfig(config);

      expect(errors.some((e) => e.path.includes('mode'))).toBe(true);
    });

    // ========== 顶层字段验证测试 ==========

    it('should detect invalid top-level defaultMode', () => {
      const config = {
        ...DEFAULT_MCP_CONFIG,
        servers: [],
        defaultMode: 'trad' as MCPCallMode, // Invalid mode
      };

      const errors = validateMCPConfig(config);

      expect(errors.some((e) => e.path === 'defaultMode')).toBe(true);
      expect(
        errors.some((e) => e.message.includes('traditional'))
      ).toBe(true);
    });

    it('should validate numeric fields - non-number type', () => {
      const config = {
        ...DEFAULT_MCP_CONFIG,
        servers: [],
        defaultConnectionTimeout: 'invalid' as unknown as number,
      };

      const errors = validateMCPConfig(config);

      expect(
        errors.some((e) => e.path === 'defaultConnectionTimeout')
      ).toBe(true);
      expect(
        errors.some((e) => e.message.includes('finite number'))
      ).toBe(true);
    });

    it('should validate numeric fields - negative value', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [],
        defaultCallTimeout: -1000,
      };

      const errors = validateMCPConfig(config);

      expect(
        errors.some((e) => e.path === 'defaultCallTimeout')
      ).toBe(true);
      expect(errors.some((e) => e.message.includes('>= 1'))).toBe(true);
    });

    it('should validate numeric fields - zero for fields requiring >= 1', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [],
        circuitBreakerThreshold: 0, // Must be >= 1
      };

      const errors = validateMCPConfig(config);

      expect(
        errors.some((e) => e.path === 'circuitBreakerThreshold')
      ).toBe(true);
    });

    it('should allow zero for toolCacheTTL', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [],
        toolCacheTTL: 0, // Zero is allowed (disable cache)
      };

      const errors = validateMCPConfig(config);

      expect(
        errors.some((e) => e.path === 'toolCacheTTL')
      ).toBe(false);
    });

    it('should validate server-level numeric fields', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [
          {
            name: 'test',
            transport: 'stdio',
            command: 'node',
            connectionTimeout: -100, // Invalid
            maxRetries: -1, // Invalid (must be >= 0)
          },
        ],
      };

      const errors = validateMCPConfig(config);

      expect(
        errors.some((e) => e.path.includes('connectionTimeout'))
      ).toBe(true);
      expect(errors.some((e) => e.path.includes('maxRetries'))).toBe(true);
    });

    it('should pass valid numeric fields', () => {
      const config: MCPConfig = {
        ...DEFAULT_MCP_CONFIG,
        servers: [
          { name: 'test', transport: 'stdio', command: 'node' },
        ],
        defaultConnectionTimeout: 5000,
        defaultCallTimeout: 30000,
        toolCacheTTL: 600000,
        circuitBreakerThreshold: 5,
        circuitBreakerRecoveryTime: 120000,
      };

      const errors = validateMCPConfig(config);

      expect(errors).toEqual([]);
    });
  });
});

// ============================================================================
// 辅助函数测试
// ============================================================================

describe('MCP Utility Functions', () => {
  describe('createExampleMCPConfig', () => {
    it('should create valid example config', () => {
      const example = createExampleMCPConfig();

      expect(example.servers.length).toBe(2);
      expect(example.servers[0].name).toBe('filesystem');
      expect(example.servers[1].name).toBe('calculator');

      // Validate the example config
      const errors = validateMCPConfig(example);
      expect(errors).toEqual([]);
    });
  });

  describe('serializeMCPConfig', () => {
    it('should serialize config to JSON', () => {
      const config = createExampleMCPConfig();
      const json = serializeMCPConfig(config);

      // Should be valid JSON
      const parsed = JSON.parse(json);
      expect(parsed.servers.length).toBe(2);
    });

    it('should be pretty-printed', () => {
      const config = createExampleMCPConfig();
      const json = serializeMCPConfig(config);

      // Should contain newlines (pretty-printed)
      expect(json).toContain('\n');
    });
  });
});
