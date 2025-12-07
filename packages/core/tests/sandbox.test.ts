/**
 * Sandbox 模块类型与配置测试
 *
 * 验证沙盒类型定义、配置快照和基类行为
 * 任务 5.1 测试策略实现
 */

import { describe, it, expect } from 'bun:test';
import type {
  SandboxRuntime,
  SandboxConfig,
  SandboxResources,
  SandboxNetworkConfig,
  NetworkMode,
  SandboxStatus,
  ExecutionOptions,
  ExecutionResult,
  CommandResult,
  SandboxLifecycleHooks,
  Sandbox,
  SandboxCreateOptions,
  DockerRuntimeConfig,
  LocalRuntimeConfig,
  FilesystemConfig,
  MountConfig,
  ResourceUsage,
  SandboxStateInfo,
} from '../src/sandbox';
import {
  DEFAULT_SANDBOX_RESOURCES,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_CONFIG,
  createSandboxConfig,
  BaseSandbox,
} from '../src/sandbox';

// ============================================================================
// 测试数据工厂
// ============================================================================

/**
 * 创建有效的沙盒资源配置
 */
function createValidResources(): SandboxResources {
  return {
    cpu: '2',
    memory: '1g',
    storage: '5g',
    pidsLimit: 200,
    ioWeight: 500,
  };
}

/**
 * 创建有效的网络配置
 */
function createValidNetworkConfig(): SandboxNetworkConfig {
  return {
    mode: 'restricted',
    allowlist: ['api.example.com', 'cdn.example.com'],
    dnsServers: ['8.8.8.8', '1.1.1.1'],
    enableIPv6: false,
  };
}

/**
 * 创建有效的文件系统配置
 */
function createValidFilesystemConfig(): FilesystemConfig {
  return {
    workdir: '/workspace',
    mounts: [
      {
        source: './project',
        target: '/workspace/project',
        mode: 'rw',
        type: 'bind',
      },
      {
        source: './cache',
        target: '/cache',
        mode: 'ro',
      },
    ],
    tmpSize: '512m',
  };
}

/**
 * 创建有效的沙盒配置
 */
function createValidSandboxConfig(): SandboxConfig {
  return {
    runtime: 'docker',
    timeout: 60000,
    resources: createValidResources(),
    network: createValidNetworkConfig(),
    filesystem: createValidFilesystemConfig(),
    env: {
      NODE_ENV: 'production',
      DEBUG: 'false',
    },
  };
}

/**
 * 创建有效的执行选项
 */
function createValidExecutionOptions(): ExecutionOptions {
  return {
    timeout: 30000,
    cwd: '/workspace',
    env: { TEST_VAR: 'test' },
    stdin: 'input data',
    captureOutput: true,
  };
}

/**
 * 创建有效的执行结果
 */
function createValidExecutionResult(): ExecutionResult {
  return {
    success: true,
    stdout: 'Hello, World!',
    stderr: '',
    exitCode: 0,
    duration: 150,
    timedOut: false,
  };
}

/**
 * 创建有效的命令结果
 */
function createValidCommandResult(): CommandResult {
  return {
    success: true,
    stdout: 'file.txt\ndata.json\n',
    stderr: '',
    exitCode: 0,
    duration: 50,
    command: 'ls -la',
  };
}

// ============================================================================
// 类型契约测试：运行时枚举
// ============================================================================

describe('Sandbox 运行时类型', () => {
  it('SandboxRuntime 应包含所有有效值', () => {
    const validRuntimes: SandboxRuntime[] = ['docker', 'firecracker', 'local'];

    // 类型检查通过即可
    for (const runtime of validRuntimes) {
      expect(['docker', 'firecracker', 'local']).toContain(runtime);
    }
  });

  it('NetworkMode 应包含所有有效值', () => {
    const validModes: NetworkMode[] = ['none', 'restricted', 'full'];

    for (const mode of validModes) {
      expect(['none', 'restricted', 'full']).toContain(mode);
    }
  });

  it('SandboxStatus 应包含所有有效值', () => {
    const validStatuses: SandboxStatus[] = [
      'creating',
      'running',
      'paused',
      'stopped',
      'error',
    ];

    for (const status of validStatuses) {
      expect(['creating', 'running', 'paused', 'stopped', 'error']).toContain(status);
    }
  });
});

// ============================================================================
// 类型契约测试：资源配置
// ============================================================================

describe('SandboxResources 配置', () => {
  it('应包含必需字段', () => {
    const resources = createValidResources();

    expect(resources.cpu).toBeDefined();
    expect(resources.memory).toBeDefined();
    expect(resources.storage).toBeDefined();
  });

  it('可选字段应正确定义', () => {
    const resources = createValidResources();

    expect(resources.pidsLimit).toBeDefined();
    expect(resources.ioWeight).toBeDefined();
  });

  it('资源值应为字符串格式', () => {
    const resources = createValidResources();

    expect(typeof resources.cpu).toBe('string');
    expect(typeof resources.memory).toBe('string');
    expect(typeof resources.storage).toBe('string');
  });
});

// ============================================================================
// 类型契约测试：网络配置
// ============================================================================

describe('SandboxNetworkConfig 配置', () => {
  it('应包含必需字段', () => {
    const network = createValidNetworkConfig();

    expect(network.mode).toBeDefined();
    expect(network.allowlist).toBeDefined();
    expect(network.allowlist).toBeInstanceOf(Array);
  });

  it('mode 值应是有效的 NetworkMode', () => {
    const network = createValidNetworkConfig();

    expect(['none', 'restricted', 'full']).toContain(network.mode);
  });

  it('可选字段应正确定义', () => {
    const network = createValidNetworkConfig();

    expect(network.dnsServers).toBeInstanceOf(Array);
    expect(typeof network.enableIPv6).toBe('boolean');
  });
});

// ============================================================================
// 类型契约测试：文件系统配置
// ============================================================================

describe('FilesystemConfig 配置', () => {
  it('应包含必需字段', () => {
    const filesystem = createValidFilesystemConfig();

    expect(filesystem.workdir).toBeDefined();
    expect(filesystem.mounts).toBeDefined();
    expect(filesystem.mounts).toBeInstanceOf(Array);
  });

  it('挂载配置应包含正确结构', () => {
    const filesystem = createValidFilesystemConfig();

    for (const mount of filesystem.mounts) {
      expect(mount.source).toBeDefined();
      expect(mount.target).toBeDefined();
      expect(['ro', 'rw']).toContain(mount.mode);
    }
  });

  it('挂载类型应是有效值', () => {
    const filesystem = createValidFilesystemConfig();
    const validTypes = ['bind', 'volume', 'tmpfs'];

    for (const mount of filesystem.mounts) {
      if (mount.type) {
        expect(validTypes).toContain(mount.type);
      }
    }
  });
});

// ============================================================================
// 类型契约测试：完整沙盒配置
// ============================================================================

describe('SandboxConfig 完整配置', () => {
  it('应包含所有必需字段', () => {
    const config = createValidSandboxConfig();

    expect(config.runtime).toBeDefined();
    expect(config.timeout).toBeDefined();
    expect(config.resources).toBeDefined();
    expect(config.network).toBeDefined();
  });

  it('runtime 应是有效的 SandboxRuntime', () => {
    const config = createValidSandboxConfig();

    expect(['docker', 'firecracker', 'local']).toContain(config.runtime);
  });

  it('timeout 应为正整数', () => {
    const config = createValidSandboxConfig();

    expect(config.timeout).toBeGreaterThan(0);
    expect(Number.isInteger(config.timeout)).toBe(true);
  });

  it('可选字段应正确定义', () => {
    const config = createValidSandboxConfig();

    expect(config.filesystem).toBeDefined();
    expect(config.env).toBeDefined();
    expect(typeof config.env).toBe('object');
  });
});

// ============================================================================
// 默认配置快照测试
// ============================================================================

describe('默认配置快照', () => {
  it('DEFAULT_SANDBOX_RESOURCES 应包含合理默认值', () => {
    expect(DEFAULT_SANDBOX_RESOURCES).toMatchSnapshot();
  });

  it('DEFAULT_SANDBOX_NETWORK 应包含安全默认值', () => {
    expect(DEFAULT_SANDBOX_NETWORK).toMatchSnapshot();
    expect(DEFAULT_SANDBOX_NETWORK.mode).toBe('restricted');
    expect(DEFAULT_SANDBOX_NETWORK.allowlist).toBeInstanceOf(Array);
    expect(DEFAULT_SANDBOX_NETWORK.allowlist.length).toBeGreaterThan(0);
  });

  it('DEFAULT_SANDBOX_CONFIG 应包含完整默认配置', () => {
    expect(DEFAULT_SANDBOX_CONFIG).toMatchSnapshot();
    expect(DEFAULT_SANDBOX_CONFIG.runtime).toBe('docker');
    expect(DEFAULT_SANDBOX_CONFIG.timeout).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_CONFIG.resources).toBeDefined();
    expect(DEFAULT_SANDBOX_CONFIG.network).toBeDefined();
  });
});

// ============================================================================
// createSandboxConfig 工具函数测试
// ============================================================================

describe('createSandboxConfig 工具函数', () => {
  it('无参数时应返回默认配置', () => {
    const config = createSandboxConfig();

    expect(config.runtime).toBe('docker');
    expect(config.timeout).toBe(DEFAULT_SANDBOX_CONFIG.timeout);
    expect(config.resources).toEqual(DEFAULT_SANDBOX_RESOURCES);
  });

  it('应正确合并部分配置', () => {
    const config = createSandboxConfig({
      runtime: 'local',
      timeout: 60000,
      resources: { cpu: '4', memory: '2g', storage: '10g' },
    });

    expect(config.runtime).toBe('local');
    expect(config.timeout).toBe(60000);
    expect(config.resources.cpu).toBe('4');
    expect(config.resources.memory).toBe('2g');
    // 应保留 DEFAULT 的 pidsLimit（如果用户未指定）
    expect(config.resources.pidsLimit).toBe(DEFAULT_SANDBOX_RESOURCES.pidsLimit);
  });

  it('应正确合并网络配置', () => {
    const config = createSandboxConfig({
      network: {
        mode: 'none',
        allowlist: [],
      },
    });

    expect(config.network.mode).toBe('none');
    expect(config.network.allowlist).toEqual([]);
  });

  it('应保留自定义 allowlist', () => {
    const customAllowlist = ['custom.api.com'];
    const config = createSandboxConfig({
      network: {
        mode: 'restricted',
        allowlist: customAllowlist,
      },
    });

    expect(config.network.allowlist).toEqual(customAllowlist);
  });
});

// ============================================================================
// 执行相关类型测试
// ============================================================================

describe('执行相关类型', () => {
  describe('ExecutionOptions', () => {
    it('应包含所有可选字段', () => {
      const options = createValidExecutionOptions();

      expect(options.timeout).toBeDefined();
      expect(options.cwd).toBeDefined();
      expect(options.env).toBeDefined();
      expect(options.stdin).toBeDefined();
      expect(options.captureOutput).toBeDefined();
    });

    it('空对象应是有效的 ExecutionOptions', () => {
      const options: ExecutionOptions = {};

      expect(options.timeout).toBeUndefined();
      expect(options.cwd).toBeUndefined();
    });
  });

  describe('ExecutionResult', () => {
    it('应包含所有必需字段', () => {
      const result = createValidExecutionResult();

      expect(typeof result.success).toBe('boolean');
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
      expect(typeof result.exitCode).toBe('number');
      expect(typeof result.duration).toBe('number');
    });

    it('成功执行的退出码应为 0', () => {
      const result = createValidExecutionResult();

      if (result.success) {
        expect(result.exitCode).toBe(0);
      }
    });

    it('超时执行应设置 timedOut 标志', () => {
      const result: ExecutionResult = {
        success: false,
        stdout: '',
        stderr: 'Operation timed out',
        exitCode: -1,
        duration: 30000,
        timedOut: true,
      };

      expect(result.timedOut).toBe(true);
    });
  });

  describe('CommandResult', () => {
    it('应扩展 ExecutionResult 并包含 command 字段', () => {
      const result = createValidCommandResult();

      expect(result.command).toBeDefined();
      expect(typeof result.command).toBe('string');
      // 继承自 ExecutionResult
      expect(result.success).toBeDefined();
      expect(result.exitCode).toBeDefined();
    });
  });
});

// ============================================================================
// JSON 序列化兼容性测试
// ============================================================================

describe('JSON 序列化兼容性', () => {
  it('SandboxConfig 应正确序列化和反序列化', () => {
    const original = createValidSandboxConfig();
    const json = JSON.stringify(original);
    const parsed = JSON.parse(json) as SandboxConfig;

    expect(parsed.runtime).toBe(original.runtime);
    expect(parsed.timeout).toBe(original.timeout);
    expect(parsed.resources).toEqual(original.resources);
    expect(parsed.network).toEqual(original.network);
  });

  it('ExecutionResult 应正确序列化和反序列化', () => {
    const original = createValidExecutionResult();
    const json = JSON.stringify(original);
    const parsed = JSON.parse(json) as ExecutionResult;

    expect(parsed.success).toBe(original.success);
    expect(parsed.stdout).toBe(original.stdout);
    expect(parsed.exitCode).toBe(original.exitCode);
    expect(parsed.duration).toBe(original.duration);
  });

  it('CommandResult 应正确序列化和反序列化', () => {
    const original = createValidCommandResult();
    const json = JSON.stringify(original);
    const parsed = JSON.parse(json) as CommandResult;

    expect(parsed.command).toBe(original.command);
    expect(parsed.success).toBe(original.success);
  });

  it('DEFAULT_SANDBOX_CONFIG 应正确序列化', () => {
    const json = JSON.stringify(DEFAULT_SANDBOX_CONFIG);
    const parsed = JSON.parse(json) as SandboxConfig;

    expect(parsed).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});

// ============================================================================
// BaseSandbox 抽象类测试（使用 Stub 实现）
// ============================================================================

/**
 * 测试用 Stub Sandbox 实现
 */
class StubSandbox extends BaseSandbox {
  public initializeCalled = false;
  public destroyCalled = false;
  public executedCodes: string[] = [];
  public executedCommands: string[] = [];
  public files = new Map<string, string>();
  public shouldFail = false;

  protected async doInitialize(): Promise<void> {
    this.initializeCalled = true;
    if (this.shouldFail) {
      throw new Error('Initialization failed');
    }
  }

  protected async doExecute(code: string, _options?: ExecutionOptions): Promise<ExecutionResult> {
    this.executedCodes.push(code);
    return {
      success: !this.shouldFail,
      stdout: `Executed: ${code.slice(0, 50)}...`,
      stderr: '',
      exitCode: this.shouldFail ? 1 : 0,
      duration: 100,
    };
  }

  protected async doRunCommand(command: string, _options?: ExecutionOptions): Promise<CommandResult> {
    this.executedCommands.push(command);
    return {
      success: !this.shouldFail,
      stdout: `Command output: ${command}`,
      stderr: '',
      exitCode: this.shouldFail ? 1 : 0,
      duration: 50,
      command,
    };
  }

  protected async doWriteFile(path: string, content: string): Promise<void> {
    if (this.shouldFail) {
      throw new Error('Write failed');
    }
    this.files.set(path, content);
  }

  protected async doReadFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  protected async doFileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  protected async doListDir(_path: string): Promise<string[]> {
    return Array.from(this.files.keys());
  }

  protected async doDestroy(): Promise<void> {
    this.destroyCalled = true;
    this.files.clear();
  }
}

describe('BaseSandbox 抽象基类', () => {
  it('应在构造时设置 ID 和状态', () => {
    const sandbox = new StubSandbox('test-sandbox-001', DEFAULT_SANDBOX_CONFIG);

    expect(sandbox.id).toBe('test-sandbox-001');
    expect(sandbox.status).toBe('creating');
  });

  it('无 ID 时应自动生成', () => {
    const sandbox = new StubSandbox(undefined, DEFAULT_SANDBOX_CONFIG);

    expect(sandbox.id).toMatch(/^sandbox-\d+-[a-z0-9]+$/);
  });

  it('初始化后状态应变为 running', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);

    await sandbox.initialize();

    expect(sandbox.status).toBe('running');
    expect(sandbox.initializeCalled).toBe(true);
  });

  it('不能重复初始化', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);

    await sandbox.initialize();

    await expect(sandbox.initialize()).rejects.toThrow('Cannot initialize sandbox');
  });

  it('未初始化时不能执行操作', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);

    await expect(sandbox.execute('console.log("test")')).rejects.toThrow('not running');
    await expect(sandbox.runCommand('ls')).rejects.toThrow('not running');
    await expect(sandbox.writeFile('test.txt', 'content')).rejects.toThrow('not running');
    await expect(sandbox.readFile('test.txt')).rejects.toThrow('not running');
  });

  it('execute 应调用 doExecute', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();

    const result = await sandbox.execute('const x = 1;');

    expect(result.success).toBe(true);
    expect(sandbox.executedCodes).toContain('const x = 1;');
  });

  it('runCommand 应调用 doRunCommand', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();

    const result = await sandbox.runCommand('echo hello');

    expect(result.success).toBe(true);
    expect(result.command).toBe('echo hello');
    expect(sandbox.executedCommands).toContain('echo hello');
  });

  it('writeFile 和 readFile 应正确工作', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();

    await sandbox.writeFile('test.txt', 'Hello, World!');
    const content = await sandbox.readFile('test.txt');

    expect(content).toBe('Hello, World!');
  });

  it('fileExists 应返回正确结果', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();

    expect(await sandbox.fileExists('nonexistent.txt')).toBe(false);

    await sandbox.writeFile('exists.txt', 'content');
    expect(await sandbox.fileExists('exists.txt')).toBe(true);
  });

  it('destroy 应将状态设置为 stopped', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();

    await sandbox.destroy();

    expect(sandbox.status).toBe('stopped');
    expect(sandbox.destroyCalled).toBe(true);
  });

  it('销毁后不能执行操作', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();
    await sandbox.destroy();

    await expect(sandbox.execute('code')).rejects.toThrow('not running');
  });

  it('生命周期钩子应被调用', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    const calls: string[] = [];

    sandbox.setHooks({
      onCreate: async () => { calls.push('onCreate'); },
      onBeforeExecute: async () => { calls.push('onBeforeExecute'); },
      onAfterExecute: async () => { calls.push('onAfterExecute'); },
      onBeforeCommand: async () => { calls.push('onBeforeCommand'); },
      onAfterCommand: async () => { calls.push('onAfterCommand'); },
      onBeforeDestroy: async () => { calls.push('onBeforeDestroy'); },
    });

    await sandbox.initialize();
    expect(calls).toContain('onCreate');

    await sandbox.execute('code');
    expect(calls).toContain('onBeforeExecute');
    expect(calls).toContain('onAfterExecute');

    await sandbox.runCommand('ls');
    expect(calls).toContain('onBeforeCommand');
    expect(calls).toContain('onAfterCommand');

    await sandbox.destroy();
    expect(calls).toContain('onBeforeDestroy');
  });

  it('错误钩子应在失败时被调用', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    sandbox.shouldFail = false;
    await sandbox.initialize();

    let errorCaught: Error | null = null;
    sandbox.setHooks({
      onError: async (error) => { errorCaught = error; },
    });

    // 尝试读取不存在的文件
    await expect(sandbox.readFile('nonexistent.txt')).rejects.toThrow();
    expect(errorCaught).not.toBeNull();
    expect(errorCaught?.message).toContain('File not found');
  });

  it('getStateInfo 应返回正确的状态信息', async () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    await sandbox.initialize();

    const info = await sandbox.getStateInfo();

    expect(info.status).toBe('running');
    expect(info.createdAt).toBeLessThanOrEqual(Date.now());
    expect(info.lastActivityAt).toBeLessThanOrEqual(Date.now());
    expect(info.error).toBeUndefined();
  });

  it('getConfig 应返回配置副本', () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    const config = sandbox.getConfig();

    expect(config).toEqual(DEFAULT_SANDBOX_CONFIG);
    // 应是副本，不应影响原配置
    config.timeout = 99999;
    expect(sandbox.getConfig().timeout).toBe(DEFAULT_SANDBOX_CONFIG.timeout);
  });

  it('getLogContext 应返回正确的日志上下文', () => {
    const sandbox = new StubSandbox('test-001', DEFAULT_SANDBOX_CONFIG);
    const context = sandbox.getLogContext();

    expect(context.sandboxId).toBe('test-001');
    expect(context.status).toBe('creating');
    expect(context.runtime).toBe('docker');
  });
});
