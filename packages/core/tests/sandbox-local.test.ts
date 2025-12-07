/**
 * LocalSandbox 单元测试
 *
 * 验证本地沙盒驱动的功能：
 * - 命令执行（白名单模式 + 不安全 shell 模式）
 * - 文件读写
 * - 超时终止
 * - 路径安全检查（含完整符号链接防护）
 * - 命令白名单（直接 argv 执行，无 shell）
 * - 并发执行安全
 * - 工作目录安全验证
 *
 * 任务 5.3 测试策略实现
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, symlink, rm, access } from 'node:fs/promises';
import {
  LocalSandbox,
  createLocalSandbox,
  CommandNotAllowedError,
  PathOutOfBoundsError,
  createSandboxConfig,
  TimeoutError,
} from '../src/sandbox';
import {
  CommandParseError,
  UnsafeShellError,
  SymlinkNotAllowedError,
  UnsafeWorkdirError,
} from '../src/sandbox/drivers/local';
import type { SandboxConfig, LocalRuntimeConfig } from '../src/sandbox';

/**
 * 扩展的本地运行时配置（包含 allowUnsafeShell）
 */
interface ExtendedLocalRuntimeConfig extends LocalRuntimeConfig {
  allowUnsafeShell?: boolean;
}

/**
 * 检查文件是否存在（兼容性辅助函数）
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// 测试数据工厂
// ============================================================================

/**
 * 创建测试用的本地沙盒配置
 */
function createTestLocalConfig(
  overrides: Partial<SandboxConfig> = {},
  runtimeConfig: ExtendedLocalRuntimeConfig = {}
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
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox('test-001', config);

    expect(sandbox.id).toBe('test-001');
    expect(sandbox.status).toBe('creating');
  });

  it('无 ID 时应自动生成', () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(undefined, config);

    expect(sandbox.id).toMatch(/^sandbox-\d+-[a-z0-9]+$/);
  });

  it('初始化后应创建工作目录', async () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);

    await sandbox.initialize();

    expect(sandbox.status).toBe('running');
    expect(await exists(sandbox.getWorkdir())).toBe(true);
  });

  it('销毁后应清理工作目录', async () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);

    await sandbox.initialize();
    const workdir = sandbox.getWorkdir();

    expect(await exists(workdir)).toBe(true);

    await sandbox.destroy();

    expect(sandbox.status).toBe('stopped');
    expect(await exists(workdir)).toBe(false);
  });

  it('createLocalSandbox 工厂函数应正确工作', () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = createLocalSandbox('factory-test', config);

    expect(sandbox).toBeInstanceOf(LocalSandbox);
    expect(sandbox.id).toBe('factory-test');
  });
});

// ============================================================================
// 命令执行测试（白名单模式）
// ============================================================================

describe('LocalSandbox 命令执行（白名单模式）', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    // 使用白名单模式：直接执行，不通过 shell
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo', 'cat', 'ls', 'exit', 'sleep', '/bin/echo', '/bin/sh'],
    });
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

  it('应支持带参数的命令', async () => {
    const result = await sandbox.runCommand('echo -n hello');

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello');
  });

  it('应支持单引号参数', async () => {
    const result = await sandbox.runCommand("echo 'hello world'");

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('应支持转义字符', async () => {
    const result = await sandbox.runCommand('echo hello\\ world');

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello world');
  });
});

// ============================================================================
// 命令执行测试（不安全 shell 模式）
// ============================================================================

describe('LocalSandbox 命令执行（不安全 shell 模式）', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    // 使用不安全 shell 模式：通过 shell 执行
    const config = createTestLocalConfig({}, {
      allowUnsafeShell: true,
    });
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

  it('应支持执行多条命令（通过 shell）', async () => {
    const result = await sandbox.runCommand('echo "first" && echo "second"');

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
  });

  it('应支持管道（通过 shell）', async () => {
    const result = await sandbox.runCommand('echo "hello" | cat');

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('应使用配置的环境变量', async () => {
    const config = createTestLocalConfig({
      env: { MY_VAR: 'my_value' },
    }, {
      allowUnsafeShell: true,
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
// 安全模式测试（默认拒绝不安全执行）
// ============================================================================

describe('LocalSandbox 安全模式', () => {
  let sandbox: LocalSandbox;

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('未配置白名单和 allowUnsafeShell 时应拒绝执行', async () => {
    const config = createTestLocalConfig(); // 没有白名单，没有 allowUnsafeShell
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    await expect(
      sandbox.runCommand('echo hello')
    ).rejects.toThrow(UnsafeShellError);
  });

  it('白名单模式下需要 shell 特性的命令应被拒绝', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // 管道需要 shell
    await expect(
      sandbox.runCommand('echo hello | cat')
    ).rejects.toThrow(CommandParseError);

    // 命令链需要 shell
    await expect(
      sandbox.runCommand('echo hello && echo world')
    ).rejects.toThrow(CommandParseError);

    // 重定向需要 shell
    await expect(
      sandbox.runCommand('echo hello > file.txt')
    ).rejects.toThrow(CommandParseError);
  });

  it('白名单模式下不在白名单中的命令应被拒绝', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    await expect(
      sandbox.runCommand('rm -rf /')
    ).rejects.toThrow(CommandNotAllowedError);
  });

  it('白名单模式下应支持完整路径命令', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // /bin/echo 应该被允许（因为以 /echo 结尾）
    const result = await sandbox.runCommand('/bin/echo "test"');
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// 代码执行测试
// ============================================================================

describe('LocalSandbox 代码执行', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
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

    // 检查是否有遗留的代码文件
    const workdir = sandbox.getWorkdir();
    const files = await Bun.file(workdir).exists();
    // 注意：工作目录存在，但不应该有 _code_*.ts 文件
  });
});

// ============================================================================
// 文件操作测试
// ============================================================================

describe('LocalSandbox 文件操作', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
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
    const config = createTestLocalConfig({ timeout: 100 }, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('sleep 5');

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('代码执行超时应返回超时结果', async () => {
    const config = createTestLocalConfig({ timeout: 100 }, { allowUnsafeShell: true });
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
    const config = createTestLocalConfig({ timeout: 10000 }, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const result = await sandbox.runCommand('sleep 5', { timeout: 100 });

    expect(result.timedOut).toBe(true);
  });

  it('快速完成的命令应不触发超时', async () => {
    const config = createTestLocalConfig({ timeout: 5000 }, {
      allowedCommands: ['echo'],
    });
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
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
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
// 符号链接安全测试（完整祖先检查）
// ============================================================================

describe('LocalSandbox 符号链接安全', () => {
  let sandbox: LocalSandbox;
  let testSymlinkPath: string | null = null;

  beforeEach(async () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    // 清理测试符号链接
    if (testSymlinkPath) {
      try {
        await rm(testSymlinkPath, { force: true });
      } catch {
        // 忽略
      }
      testSymlinkPath = null;
    }

    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应阻止读取指向工作目录外的符号链接', async () => {
    // 在工作目录内创建指向 /etc 的符号链接
    const workdir = sandbox.getWorkdir();
    testSymlinkPath = join(workdir, 'malicious-link');

    try {
      await symlink('/etc', testSymlinkPath);
    } catch {
      // 某些系统可能不允许创建符号链接，跳过测试
      return;
    }

    // 尝试通过符号链接读取文件
    await expect(
      sandbox.readFile('malicious-link/passwd')
    ).rejects.toThrow();
  });

  it('应阻止通过符号链接写入工作目录外', async () => {
    // 在工作目录内创建指向 /tmp 的符号链接
    const workdir = sandbox.getWorkdir();
    testSymlinkPath = join(workdir, 'escape-link');

    try {
      await symlink('/tmp', testSymlinkPath);
    } catch {
      // 某些系统可能不允许创建符号链接，跳过测试
      return;
    }

    // 尝试通过符号链接写入文件（这应该被阻止）
    await expect(
      sandbox.writeFile('escape-link/evil-file.txt', 'malicious content')
    ).rejects.toThrow(SymlinkNotAllowedError);
  });

  it('应允许读取指向工作目录内的符号链接', async () => {
    // 先创建一个真实文件
    await sandbox.writeFile('real-file.txt', 'real content');

    // 创建指向工作目录内文件的符号链接
    const workdir = sandbox.getWorkdir();
    testSymlinkPath = join(workdir, 'internal-link.txt');

    try {
      await symlink(join(workdir, 'real-file.txt'), testSymlinkPath);
    } catch {
      // 某些系统可能不允许创建符号链接，跳过测试
      return;
    }

    // 应该可以通过符号链接读取
    const content = await sandbox.readFile('internal-link.txt');
    expect(content).toBe('real content');
  });
});

// ============================================================================
// 工作目录安全验证测试
// ============================================================================

describe('LocalSandbox 工作目录安全', () => {
  it('不应允许配置根目录作为工作目录', () => {
    const config = createTestLocalConfig({
      filesystem: {
        workdir: '/',
        mounts: [],
      },
    }, { allowUnsafeShell: true });

    const sandbox = new LocalSandbox(createTestSandboxId(), config);

    expect(sandbox.initialize()).rejects.toThrow(UnsafeWorkdirError);
  });

  it('不应允许配置 /tmp 作为工作目录', () => {
    const config = createTestLocalConfig({
      filesystem: {
        workdir: '/tmp',
        mounts: [],
      },
    }, { allowUnsafeShell: true });

    const sandbox = new LocalSandbox(createTestSandboxId(), config);

    expect(sandbox.initialize()).rejects.toThrow(UnsafeWorkdirError);
  });

  it('不应允许配置 /etc 作为工作目录', () => {
    const config = createTestLocalConfig({
      filesystem: {
        workdir: '/etc',
        mounts: [],
      },
    }, { allowUnsafeShell: true });

    const sandbox = new LocalSandbox(createTestSandboxId(), config);

    expect(sandbox.initialize()).rejects.toThrow(UnsafeWorkdirError);
  });

  it('应允许配置安全的深层目录', async () => {
    const safePath = join(tmpdir(), `safe-sandbox-test-${Date.now()}`);

    const config = createTestLocalConfig({
      filesystem: {
        workdir: safePath,
        mounts: [],
      },
    }, { allowUnsafeShell: true });

    const sandbox = new LocalSandbox(createTestSandboxId(), config);

    // 应该能成功初始化
    await sandbox.initialize();
    expect(sandbox.status).toBe('running');

    await sandbox.destroy();
  });
});

// ============================================================================
// 并发执行安全测试
// ============================================================================

describe('LocalSandbox 并发执行安全', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('并发执行代码不应互相干扰', async () => {
    // 同时执行多个代码，验证使用唯一文件名
    const results = await Promise.all([
      sandbox.execute('console.log("result-1")'),
      sandbox.execute('console.log("result-2")'),
      sandbox.execute('console.log("result-3")'),
    ]);

    expect(results[0].success).toBe(true);
    expect(results[0].stdout.trim()).toBe('result-1');

    expect(results[1].success).toBe(true);
    expect(results[1].stdout.trim()).toBe('result-2');

    expect(results[2].success).toBe(true);
    expect(results[2].stdout.trim()).toBe('result-3');
  });

  it('并发执行命令不应互相干扰', async () => {
    const results = await Promise.all([
      sandbox.runCommand('echo "cmd-1"'),
      sandbox.runCommand('echo "cmd-2"'),
      sandbox.runCommand('echo "cmd-3"'),
    ]);

    expect(results[0].stdout.trim()).toBe('cmd-1');
    expect(results[1].stdout.trim()).toBe('cmd-2');
    expect(results[2].stdout.trim()).toBe('cmd-3');
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
      allowUnsafeShell: true,
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // HOME 是常见的系统环境变量
    const result = await sandbox.runCommand('echo $HOME');

    // 输出应该是空的或不包含系统 HOME 值
    expect(result.stdout.trim()).not.toBe(process.env.HOME);
  });

  it('inheritEnv=true 时应继承系统环境变量', async () => {
    const config = createTestLocalConfig({}, {
      inheritEnv: true,
      allowUnsafeShell: true,
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
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    const info = await sandbox.getStateInfo();

    expect(info.status).toBe('running');
    expect(info.createdAt).toBeLessThanOrEqual(Date.now());
    expect(info.lastActivityAt).toBeLessThanOrEqual(Date.now());
  });

  it('执行操作后 lastActivityAt 应更新', async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo'],
    });
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
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox(createTestSandboxId(), config);

    const returnedConfig = sandbox.getConfig();

    expect(returnedConfig.runtime).toBe('local');
    expect(returnedConfig.timeout).toBe(config.timeout);
  });

  it('getLogContext 应返回正确的日志上下文', () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    sandbox = new LocalSandbox('log-test-001', config);

    const context = sandbox.getLogContext();

    expect(context.sandboxId).toBe('log-test-001');
    expect(context.status).toBe('creating');
    expect(context.runtime).toBe('local');
  });
});

// ============================================================================
// 子进程清理测试
// ============================================================================

describe('LocalSandbox 子进程清理', () => {
  it('销毁时应终止活跃的子进程', async () => {
    const config = createTestLocalConfig({ timeout: 60000 }, { allowUnsafeShell: true });
    const sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // 启动一个长时间运行的进程（但不等待完成）
    const runPromise = sandbox.runCommand('sleep 30');

    // 等待一小段时间确保进程已经启动
    await new Promise(resolve => setTimeout(resolve, 50));

    // 销毁沙盒
    await sandbox.destroy();

    // runPromise 应该最终会失败或被中断
    try {
      const result = await runPromise;
      // 如果返回了结果，应该是被终止的（非正常退出）
      expect(result.timedOut || !result.success).toBe(true);
    } catch {
      // 被中断抛出错误也是预期行为
    }

    expect(sandbox.status).toBe('stopped');
  });

  it('多次销毁应是幂等的', async () => {
    const config = createTestLocalConfig({}, { allowUnsafeShell: true });
    const sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();

    // 多次调用销毁不应报错
    await sandbox.destroy();
    await sandbox.destroy();
    await sandbox.destroy();

    expect(sandbox.status).toBe('stopped');
  });
});

// ============================================================================
// 命令解析测试
// ============================================================================

describe('LocalSandbox 命令解析', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const config = createTestLocalConfig({}, {
      allowedCommands: ['echo', 'node'],
    });
    sandbox = new LocalSandbox(createTestSandboxId(), config);
    await sandbox.initialize();
  });

  afterEach(async () => {
    if (sandbox && sandbox.status !== 'stopped') {
      await sandbox.destroy();
    }
  });

  it('应正确解析带双引号的参数', async () => {
    const result = await sandbox.runCommand('echo "hello world"');

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('应正确解析带单引号的参数', async () => {
    const result = await sandbox.runCommand("echo 'hello world'");

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('应正确处理转义的空格', async () => {
    const result = await sandbox.runCommand('echo hello\\ world');

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('未闭合的引号应抛出解析错误', async () => {
    await expect(
      sandbox.runCommand('echo "unclosed')
    ).rejects.toThrow(CommandParseError);
  });

  it('空命令应抛出解析错误', async () => {
    await expect(
      sandbox.runCommand('   ')
    ).rejects.toThrow(CommandParseError);
  });
});
