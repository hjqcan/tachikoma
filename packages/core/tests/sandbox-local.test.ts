/**
 * LocalSandbox 单元测试
 *
 * 验证本地沙盒驱动的功能：
 * - 命令执行
 * - 文件读写
 * - 超时终止
 * - 路径安全检查
 * - 命令白名单
 *
 * 任务 5.3 测试策略实现
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exists, rm } from 'node:fs/promises';
import {
  LocalSandbox,
  createLocalSandbox,
  CommandNotAllowedError,
  PathOutOfBoundsError,
  createSandboxConfig,
  TimeoutError,
} from '../src/sandbox';
import type { SandboxConfig, LocalRuntimeConfig } from '../src/sandbox';

// ============================================================================
// 测试数据工厂
// ============================================================================

/**
 * 创建测试用的本地沙盒配置
 */
function createTestLocalConfig(
  overrides: Partial<SandboxConfig> = {},
  runtimeConfig: LocalRuntimeConfig = {}
): SandboxConfig {
  return createSandboxConfig({
    runtime: 'local',
    timeout: 5000, // 测试用短超时
    runtimeConfig,
    ...overrides,
  });
}

/**
 * 创建唯一的测试沙盒 ID
 */
function createTestSandboxId(): string {
  return `test-local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ============================================================================
// 初始化与生命周期测试
// ============================================================================

describe('LocalSandbox 初始化与生命周期', () => {
  let sandbox: LocalSandbox;

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应正确创建沙盒实例', () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox('test-001', config);

    expect(sandbox.id).toBe('test-001');
    expect(sandbox.status).toBe('creating');
  });

  it('无 ID 时应自动生成', () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(undefined, config);

    expect(sandbox.id).toMatch(/^sandbox-\d+-[a-z0-9]+$/);
  });

  it('初始化后应创建工作目录', async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);

    await sandbox.initialize();

    expect(sandbox.status).toBe('running');
    expect(await exists(sandbox.getWorkdir())).toBe(true);
  });

  it('销毁后应清理工作目录', async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);

    await sandbox.initialize();
    const workdir = sandbox.getWorkdir();

    expect(await exists(workdir)).toBe(true);

    await sandbox.destroy();

    expect(sandbox.status).toBe('stopped');
    expect(await exists(workdir)).toBe(false);
  });

  it('createLocalSandbox 工厂函数应正确工作', () => {
    const config = createTestLocalConfig();
    sandbox = createLocalSandbox('factory-test', config);

    expect(sandbox).toBeInstanceOf(LocalSandbox);
    expect(sandbox.id).toBe('factory-test');
  });
});

// ============================================================================
// 命令执行测试
// ============================================================================

describe('LocalSandbox 命令执行', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应执行简单命令并返回输出', async () => {
    const result = await sandbox.runCommand('echo "Hello, World!"');

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Hello, World!');
    expect(result.command).toBe('echo "Hello, World!"');
  });

  it('应正确返回命令失败结果', async () => {
    const result = await sandbox.runCommand('exit 42');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('应正确捕获 stderr', async () => {
    const result = await sandbox.runCommand('echo "error" >&2');

    expect(result.stderr.trim()).toBe('error');
  });

  it('应支持执行多条命令', async () => {
    const result = await sandbox.runCommand('echo "first" && echo "second"');

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
  });

  it('应使用配置的环境变量', async () => {
    const config = createTestLocalConfig({
      env: { MY_VAR: 'my_value' },
    });
    await sandbox.destroy();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('echo $MY_VAR');

    expect(result.stdout.trim()).toBe('my_value');
  });

  it('应支持执行选项中的环境变量', async () => {
    const result = await sandbox.runCommand('echo $TEST_VAR', {
      env: { TEST_VAR: 'test_value' },
    });

    expect(result.stdout.trim()).toBe('test_value');
  });
});

// ============================================================================
// 代码执行测试
// ============================================================================

describe('LocalSandbox 代码执行', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应执行 TypeScript/JavaScript 代码', async () => {
    const code = `console.log("Hello from code!");`;
    const result = await sandbox.execute(code);

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('Hello from code!');
  });

  it('应正确处理代码执行错误', async () => {
    const code = `throw new Error("Test error");`;
    const result = await sandbox.execute(code);

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Test error');
  });

  it('应支持复杂的 TypeScript 代码', async () => {
    const code = `
      interface User {
        name: string;
        age: number;
      }

      const user: User = { name: "Alice", age: 30 };
      console.log(JSON.stringify(user));
    `;
    const result = await sandbox.execute(code);

    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({ name: 'Alice', age: 30 });
  });

  it('执行后应清理临时代码文件', async () => {
    const code = `console.log("test");`;
    await sandbox.execute(code);

    const codeFileExists = await exists(join(sandbox.getWorkdir(), '_code.ts'));
    expect(codeFileExists).toBe(false);
  });
});

// ============================================================================
// 文件操作测试
// ============================================================================

describe('LocalSandbox 文件操作', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应正确写入和读取文件', async () => {
    const content = 'Hello, File!';

    await sandbox.writeFile('test.txt', content);
    const readContent = await sandbox.readFile('test.txt');

    expect(readContent).toBe(content);
  });

  it('应支持写入嵌套目录中的文件', async () => {
    const content = 'Nested content';

    await sandbox.writeFile('subdir/nested/file.txt', content);
    const readContent = await sandbox.readFile('subdir/nested/file.txt');

    expect(readContent).toBe(content);
  });

  it('fileExists 应正确检查文件存在', async () => {
    expect(await sandbox.fileExists('nonexistent.txt')).toBe(false);

    await sandbox.writeFile('exists.txt', 'content');

    expect(await sandbox.fileExists('exists.txt')).toBe(true);
  });

  it('listDir 应列出目录内容', async () => {
    await sandbox.writeFile('file1.txt', 'content1');
    await sandbox.writeFile('file2.txt', 'content2');
    await sandbox.writeFile('subdir/file3.txt', 'content3');

    const files = await sandbox.listDir('.');

    expect(files).toContain('file1.txt');
    expect(files).toContain('file2.txt');
    expect(files).toContain('subdir');
  });

  it('读取不存在的文件应抛出错误', async () => {
    await expect(sandbox.readFile('nonexistent.txt')).rejects.toThrow();
  });

  it('应支持写入和读取多字节字符', async () => {
    const content = '你好，世界！🌍';

    await sandbox.writeFile('unicode.txt', content);
    const readContent = await sandbox.readFile('unicode.txt');

    expect(readContent).toBe(content);
  });
});

// ============================================================================
// 超时控制测试
// ============================================================================

describe('LocalSandbox 超时控制', () => {
  let sandbox: LocalSandbox;

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('命令超时应返回超时结果', async () => {
    const config = createTestLocalConfig({ timeout: 100 }); // 100ms 超时
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('sleep 5');

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('代码执行超时应返回超时结果', async () => {
    const config = createTestLocalConfig({ timeout: 100 }); // 100ms 超时
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const code = `
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log("done");
    `;
    const result = await sandbox.execute(code);

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('执行选项中的超时应覆盖默认超时', async () => {
    const config = createTestLocalConfig({ timeout: 10000 }); // 默认 10s
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('sleep 5', { timeout: 100 }); // 覆盖为 100ms

    expect(result.timedOut).toBe(true);
  });

  it('快速完成的命令应不触发超时', async () => {
    const config = createTestLocalConfig({ timeout: 5000 });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('echo "quick"');

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});

// ============================================================================
// 路径安全测试
// ============================================================================

describe('LocalSandbox 路径安全', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应阻止路径穿越攻击（writeFile）', async () => {
    await expect(
      sandbox.writeFile('../../../etc/passwd', 'malicious')
    ).rejects.toThrow(PathOutOfBoundsError);
  });

  it('应阻止路径穿越攻击（readFile）', async () => {
    await expect(
      sandbox.readFile('../../../etc/passwd')
    ).rejects.toThrow(PathOutOfBoundsError);
  });

  it('应阻止路径穿越攻击（fileExists）', async () => {
    // fileExists 捕获错误返回 false
    const result = await sandbox.fileExists('../../../etc/passwd');
    expect(result).toBe(false);
  });

  it('应阻止路径穿越攻击（listDir）', async () => {
    await expect(
      sandbox.listDir('../../../')
    ).rejects.toThrow(PathOutOfBoundsError);
  });

  it('应允许工作目录内的相对路径', async () => {
    await sandbox.writeFile('subdir/file.txt', 'content');
    const content = await sandbox.readFile('subdir/file.txt');

    expect(content).toBe('content');
  });
});

// ============================================================================
// 命令白名单测试
// ============================================================================

describe('LocalSandbox 命令白名单', () => {
  let sandbox: LocalSandbox;

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('未配置白名单时应允许所有命令', async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('echo "allowed"');
    expect(result.success).toBe(true);
  });

  it('配置白名单后应只允许白名单中的命令', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo', 'cat'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const echoResult = await sandbox.runCommand('echo "allowed"');
    expect(echoResult.success).toBe(true);
  });

  it('不在白名单中的命令应被拒绝', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    await expect(
      sandbox.runCommand('rm -rf /')
    ).rejects.toThrow(CommandNotAllowedError);
  });

  it('应支持完整路径命令', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // /bin/echo 应该被允许（因为以 /echo 结尾）
    const result = await sandbox.runCommand('/bin/echo "test"');
    expect(result.success).toBe(true);
  });

  it('空白名单数组应允许所有命令', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: [],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('echo "allowed"');
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// 环境变量继承测试
// ============================================================================

describe('LocalSandbox 环境变量继承', () => {
  let sandbox: LocalSandbox;

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('inheritEnv=false 时不应继承系统环境变量', async () => {
    const config = createTestLocalConfig({}, {
      inheritEnv: false,
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // HOME 是常见的系统环境变量
    const result = await sandbox.runCommand('echo $HOME');

    // 输出应该是空的或不包含系统 HOME 值
    // 注意：某些 shell 可能仍然设置某些默认值
    expect(result.stdout.trim()).not.toBe(process.env.HOME);
  });

  it('inheritEnv=true 时应继承系统环境变量', async () => {
    const config = createTestLocalConfig({}, {
      inheritEnv: true,
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('echo $HOME');

    expect(result.stdout.trim()).toBe(process.env.HOME);
  });
});

// ============================================================================
// 状态信息测试
// ============================================================================

describe('LocalSandbox 状态信息', () => {
  let sandbox: LocalSandbox;

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('getStateInfo 应返回正确的状态', async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const info = await sandbox.getStateInfo();

    expect(info.status).toBe('running');
    expect(info.createdAt).toBeLessThanOrEqual(Date.now());
    expect(info.lastActivityAt).toBeLessThanOrEqual(Date.now());
  });

  it('执行操作后 lastActivityAt 应更新', async () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const infoBefore = await sandbox.getStateInfo();

    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 10));

    await sandbox.runCommand('echo "test"');

    const infoAfter = await sandbox.getStateInfo();

    expect(infoAfter.lastActivityAt).toBeGreaterThanOrEqual(infoBefore.lastActivityAt);
  });

  it('getConfig 应返回配置副本', () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox(createTestSandboxId(), config);

    const returnedConfig = sandbox.getConfig();

    expect(returnedConfig.runtime).toBe('local');
    expect(returnedConfig.timeout).toBe(config.timeout);
  });

  it('getLogContext 应返回正确的日志上下文', () => {
    const config = createTestLocalConfig();
    sandbox = new LocalSandbox('log-test-001', config);

    const context = sandbox.getLogContext();

    expect(context.sandboxId).toBe('log-test-001');
    expect(context.status).toBe('creating');
    expect(context.runtime).toBe('local');
  });
});
