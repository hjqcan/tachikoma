/**
 * 命令型工具资源限制测试
 * 
 * 验证：
 * 1. shell_run / run_tests / type_check 的超时行为
 * 2. 命令输出截断（maxOutputSize）
 * 3. 执行超时（maxExecutionTime）
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  ToolRegistry,
  shellRunTool,
  runTestsTool,
  typeCheckTool,
} from '../../src/tools';
import type { ExecutionContext } from '../../src/types';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Command Tool Resource Limits', () => {
  let testDir: string;
  let testRegistry: ToolRegistry;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'tachikoma-cmd-test-'));
    testRegistry = new ToolRegistry();
    testRegistry.register(shellRunTool);
    testRegistry.register(runTestsTool);
    testRegistry.register(typeCheckTool);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const createContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
    taskId: 'cmd-test-task',
    agentId: 'cmd-test-agent',
    traceId: 'cmd-test-trace',
    workDir: testDir,
    env: {},
    permissions: {
      allowed: ['shell:exec', 'fs:read', 'fs:write'],
      denied: [],
      requireSandbox: false,
    },
    resourceLimits: {
      maxFileSize: 10 * 1024 * 1024,
      maxOutputSize: 1000, // 限制输出为1KB
      maxExecutionTime: 2000, // 限制2秒超时
    },
    ...overrides,
  });

  describe('shell_run', () => {
    test('should truncate large command output', async () => {
      const context = createContext();

      // 生成大量输出的命令
      const result = await testRegistry.execute(
        'shell_run',
        { 
          command: 'yes "test output line" | head -n 1000',
          timeout: 5000,
        },
        context
      );

      // 验证输出被截断
      if (result.success && result.data) {
        const data = result.data as { stdout?: string; truncated?: boolean };
        if (data.stdout) {
          // 输出应该在限制范围内（允许一些余量）
          expect(data.stdout.length).toBeLessThanOrEqual(2000);
        }
      }
    });

    test('should respect execution timeout', async () => {
      const context = createContext({
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 10000,
          maxExecutionTime: 1000, // 1秒超时
        },
      });

      const startTime = Date.now();
      
      // 执行一个长时间运行的命令
      const result = await testRegistry.execute(
        'shell_run',
        { 
          command: 'sleep 10',
          timeout: 10000, // 命令自己的超时，但context限制更短
        },
        context
      );

      const elapsed = Date.now() - startTime;

      // 验证执行时间不超过context限制太多（允许一些buffer）
      // 注意：如果工具实现尊重context.resourceLimits.maxExecutionTime
      // 如果没有实现，这个测试会失败，提示需要添加该功能
      expect(elapsed).toBeLessThan(5000); // 至少不应该等待完整的10秒
    });

    test('should handle command not found gracefully', async () => {
      const context = createContext();

      const result = await testRegistry.execute(
        'shell_run',
        { command: 'nonexistent_command_12345' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('run_tests', () => {
    test('should respect timeout for test execution', async () => {
      // 创建一个简单的package.json
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          scripts: {
            test: 'sleep 10', // 长时间运行的测试
          },
        })
      );

      const context = createContext({
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 10000,
          maxExecutionTime: 2000, // 2秒超时
        },
      });

      const startTime = Date.now();

      const result = await testRegistry.execute(
        'run_tests',
        { mode: 'npm', timeout: 10000 },
        context
      );

      const elapsed = Date.now() - startTime;

      // 验证执行被超时终止
      expect(elapsed).toBeLessThan(8000);
    });

    test('should truncate test output', async () => {
      // 创建一个产生大量输出的测试
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          scripts: {
            test: 'for i in $(seq 1 500); do echo "Test output line $i"; done',
          },
        })
      );

      const context = createContext({
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 500, // 限制输出为500字节
          maxExecutionTime: 5000,
        },
      });

      const result = await testRegistry.execute(
        'run_tests',
        { mode: 'npm', timeout: 5000 },
        context
      );

      // 验证输出被截断
      if (result.data) {
        const data = result.data as { stdout?: string; output?: string };
        const output = data.stdout || data.output || '';
        // 输出应该在合理范围内
        expect(output.length).toBeLessThan(2000);
      }
    });
  });

  describe('type_check', () => {
    test('should handle missing tsconfig gracefully', async () => {
      const context = createContext();

      // 不创建任何文件，直接运行type_check
      const result = await testRegistry.execute(
        'type_check',
        {},
        context
      );

      // 应该失败但不崩溃
      expect(typeof result.success).toBe('boolean');
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    test('should respect timeout', async () => {
      // 创建一个复杂的TypeScript项目模拟
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(
        join(testDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2020', outDir: './dist' },
          include: ['src/**/*'],
        })
      );
      await writeFile(
        join(testDir, 'src', 'index.ts'),
        'const x: string = "hello";'
      );

      const context = createContext({
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 10000,
          maxExecutionTime: 5000,
        },
      });

      const startTime = Date.now();

      const result = await testRegistry.execute(
        'type_check',
        { timeout: 30000 },
        context
      );

      const elapsed = Date.now() - startTime;

      // 验证执行完成（小项目应该很快）
      expect(elapsed).toBeLessThan(10000);
      expect(typeof result.success).toBe('boolean');
    });
  });
});
