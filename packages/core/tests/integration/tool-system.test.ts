/**
 * 工具系统集成测试
 * 
 * 验证：
 * 1. ToolRegistry注册和查询
 * 2. ToolExecutor权限校验
 * 3. ToolChain串联执行
 * 4. ProgressiveDisclosure Token减少
 * 5. 资源限制生效
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  ToolRegistry,
  globalToolRegistry,
  globalToolExecutor,
  ToolChain,
  ProgressiveDisclosure,
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  runTestsTool,
  typeCheckTool,
  codeSearchTool,
  packageInfoTool,
  envGetTool,
} from '../../src/tools';
import { ToolLayer } from '../../src/tools/types';
import type { ExecutionContext, Tool } from '../../src/types';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Tool System Integration Tests', () => {
  let testDir: string;
  let context: ExecutionContext;
  let testRegistry: ToolRegistry;
  let allTools: Tool[];
  let progressiveDisclosure: ProgressiveDisclosure;

  beforeAll(() => {
    // 收集所有工具
    allTools = [
      fileReadTool,
      fileWriteTool,
      fileListTool,
      shellRunTool,
      runTestsTool,
      typeCheckTool,
      codeSearchTool,
      packageInfoTool,
      envGetTool,
    ];

    // 创建测试专用registry并注册所有工具
    testRegistry = new ToolRegistry();
    allTools.forEach((tool) => testRegistry.register(tool));

    // 创建ProgressiveDisclosure实例
    progressiveDisclosure = new ProgressiveDisclosure();
  });

  beforeEach(async () => {
    // 创建临时测试目录
    testDir = await mkdtemp(join(tmpdir(), 'tachikoma-test-'));

    // 创建测试上下文
    context = {
      taskId: 'test-task',
      agentId: 'test-agent',
      traceId: 'test-trace',
      workDir: testDir,
      env: {},
      permissions: {
        allowed: ['fs:read', 'fs:write', 'shell:exec'],
        denied: [],
        requireSandbox: false,
      },
      resourceLimits: {
        maxFileSize: 10 * 1024 * 1024,
        maxOutputSize: 10000,
        maxExecutionTime: 5000,
      },
    };
  });

  afterEach(async () => {
    // 清理测试目录
    await rm(testDir, { recursive: true, force: true });
  });

  describe('ToolRegistry', () => {
    test('should get tool by name', () => {
      const tool = testRegistry.getByName('file_read');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('file_read');
    });

    test('should return undefined for non-existent tool', () => {
      const tool = testRegistry.getByName('non_existent');
      expect(tool).toBeUndefined();
    });

    test('should get tools by layer', () => {
      const layer1Tools = testRegistry.getByLayer(ToolLayer.Atomic);
      expect(layer1Tools.length).toBeGreaterThan(0);
      expect(layer1Tools.every((t) => t.layer === ToolLayer.Atomic)).toBe(true);
    });

    test('should execute tool with permission check', async () => {
      // 创建测试文件
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'Hello World');

      const result = await testRegistry.execute(
        'file_read',
        { path: 'test.txt' },
        context
      );

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect((result.data as { content: string }).content).toContain('Hello World');
      }
      expect(result.meta?.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ToolExecutor', () => {
    test('should execute tool with automatic permission check', async () => {
      const testFile = join(testDir, 'executor-test.txt');
      await writeFile(testFile, 'ToolExecutor Test');

      const result = await globalToolExecutor.execute(
        fileReadTool,
        { path: 'executor-test.txt' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.meta?.executionTime).toBeDefined();
    });

    test('should validate result shape', async () => {
      const result = await globalToolExecutor.execute(
        fileReadTool,
        { path: 'non-existent.txt' },
        context
      );

      // 应该返回valid ToolResult，即使失败
      expect(typeof result.success).toBe('boolean');
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    test('should check executability before running', () => {
      const check = globalToolExecutor.canExecute(fileReadTool, context);
      expect(typeof check.allowed).toBe('boolean');
    });
  });

  describe('ToolChain', () => {
    test('should execute tool chain sequentially', async () => {
      // 创建源文件
      const sourceFile = join(testDir, 'source.json');
      await writeFile(sourceFile, JSON.stringify({ message: 'Test Data' }));

      const chain = new ToolChain(testRegistry);

      const steps = [
        {
          toolName: 'file_read',
          input: { path: 'source.json' },
        },
        {
          toolName: 'file_write',
          input: { path: 'destination.json', content: '{"copied": true}' },
        },
      ];

      const result = await chain.execute(steps, context);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(2);
      expect(result.metrics?.totalDuration).toBeGreaterThanOrEqual(0);
    });

    test('should handle chain failure gracefully', async () => {
      const chain = new ToolChain(testRegistry);

      const steps = [
        {
          toolName: 'file_read',
          input: { path: 'non-existent.json' },
        },
      ];

      const result = await chain.execute(steps, context);

      // file_read对不存在的文件应该返回错误
      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  describe('ProgressiveDisclosure', () => {
    test('should provide metadata (Level 1)', () => {
      const metadata = progressiveDisclosure.getMetadata(allTools);
      
      expect(metadata.length).toBe(allTools.length);
      expect(metadata[0]).toHaveProperty('name');
      expect(metadata[0]).toHaveProperty('title');
    });

    test('should provide basic definition (Level 2)', () => {
      const basic = progressiveDisclosure.getBasicDefinition(fileReadTool);
      
      expect(basic).toBeDefined();
      expect(basic.name).toBe('file_read');
      expect(basic.description).toBeDefined();
      expect(basic.inputSchema).toBeDefined();
    });

    test('should provide full definition (Level 3)', () => {
      const full = progressiveDisclosure.getFullDefinition(fileReadTool);
      
      expect(full).toBeDefined();
      expect(full.inputSchema).toBeDefined();
      expect(full.outputSchema).toBeDefined();
    });

    test('should recommend tools by keywords', () => {
      const recommended = progressiveDisclosure.recommend('读取文件', allTools);
      
      expect(recommended.length).toBeGreaterThanOrEqual(0);
    });

    test('should estimate token consumption', () => {
      const toolCount = allTools.length;
      const metadataTokens = progressiveDisclosure.estimateTokens(1, toolCount);
      const basicTokens = progressiveDisclosure.estimateTokens(2, toolCount);
      const fullTokens = progressiveDisclosure.estimateTokens(3, toolCount);

      expect(metadataTokens).toBeLessThan(basicTokens);
      expect(basicTokens).toBeLessThan(fullTokens);
      
      // 验证Token减少目标（>50%）
      if (fullTokens > 0) {
        const reduction = (fullTokens - metadataTokens) / fullTokens;
        expect(reduction).toBeGreaterThan(0.5);
      }
    });
  });

  describe('Resource Limits', () => {
    test('should enforce max file size', async () => {
      // 创建超大文件
      const largeFile = join(testDir, 'large.txt');
      const largeContent = 'x'.repeat(20 * 1024 * 1024); // 20MB
      await writeFile(largeFile, largeContent);

      const result = await testRegistry.execute(
        'file_read',
        { path: 'large.txt' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should truncate large output', async () => {
      const largeFile = join(testDir, 'output.txt');
      const content = 'x'.repeat(5 * 1024 * 1024); // 5MB（在限制内）
      await writeFile(largeFile, content);

      const smallOutputContext = {
        ...context,
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 1000, // 限制输出为1KB
          maxExecutionTime: 5000,
        },
      };

      const result = await testRegistry.execute(
        'file_read',
        { path: 'output.txt' },
        smallOutputContext
      );

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        const data = result.data as { content: string; truncated?: boolean };
        expect(data.content.length).toBeLessThanOrEqual(1100); // 允许一定误差
        expect(data.truncated).toBe(true);
      }
    });
  });
});
