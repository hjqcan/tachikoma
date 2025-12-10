/**
 * 端到端执行测试
 * 
 * 验证：
 * 1. ToolExecutor在真实工作流下的执行
 * 2. 全量工具集的Registry性能
 * 3. 权限+上下文的综合验证
 * 4. Schema/Metadata一致性
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  ToolRegistry,
  globalToolExecutor,
  ToolExecutor,
  PermissionValidator,
  ProgressiveDisclosure,
  // 导入所有工具
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
import { ToolLayer, ToolCategory, ToolPermission } from '../../src/tools/types';
import type { ExecutionContext, Tool } from '../../src/types';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('End-to-End Tool Execution', () => {
  let testDir: string;
  let fullRegistry: ToolRegistry;
  let allTools: Tool[];
  let executor: ToolExecutor;
  let progressiveDisclosure: ProgressiveDisclosure;

  beforeAll(() => {
    // 收集所有生产环境工具
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

    // 创建完整的registry（模拟生产环境）
    fullRegistry = new ToolRegistry();
    allTools.forEach((tool) => fullRegistry.register(tool));

    // 创建executor
    executor = new ToolExecutor();

    // 创建ProgressiveDisclosure
    progressiveDisclosure = new ProgressiveDisclosure();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'tachikoma-e2e-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Full Tool Set Performance', () => {
    test('should query all tools efficiently', () => {
      const iterations = 100;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        for (const tool of allTools) {
          fullRegistry.getByName(tool.name);
        }
      }

      const end = performance.now();
      const totalQueries = iterations * allTools.length;
      const avgTime = (end - start) / totalQueries;

      console.log(`Full registry - ${totalQueries} queries in ${(end - start).toFixed(2)}ms`);
      console.log(`Average: ${avgTime.toFixed(4)}ms per query`);

      expect(avgTime).toBeLessThan(0.1); // <0.1ms per query
    });

    test('should filter by layer with full tool set', () => {
      const start = performance.now();
      
      const layer1 = fullRegistry.getByLayer(ToolLayer.Atomic);
      
      const end = performance.now();

      console.log(`Filter by layer (${layer1.length} tools): ${(end - start).toFixed(3)}ms`);
      
      expect(layer1.length).toBeGreaterThan(0);
      expect(end - start).toBeLessThan(5);
    });

    test('should validate permissions across all tools', () => {
      const validator = new PermissionValidator();
      
      const context: ExecutionContext = {
        taskId: 'e2e-test',
        agentId: 'e2e-agent',
        traceId: 'e2e-trace',
        workDir: testDir,
        env: {},
        permissions: {
          allowed: ['fs:read', 'fs:write', 'shell:exec', 'env:read'],
          denied: [],
          requireSandbox: false,
        },
        resourceLimits: {
          maxFileSize: 50 * 1024 * 1024,
          maxOutputSize: 50000,
          maxExecutionTime: 30000,
        },
      };

      const start = performance.now();

      for (const tool of allTools) {
        validator.validate(tool, context);
      }

      const end = performance.now();

      console.log(`Validated ${allTools.length} tools in ${(end - start).toFixed(3)}ms`);

      expect(end - start).toBeLessThan(10);
    });
  });

  describe('ToolExecutor Real Workflow', () => {
    test('should execute file workflow with full context', async () => {
      const context: ExecutionContext = {
        taskId: 'workflow-test',
        agentId: 'workflow-agent',
        traceId: 'workflow-trace',
        workDir: testDir,
        env: { NODE_ENV: 'test' },
        permissions: {
          allowed: ['fs:read', 'fs:write'],
          denied: [],
          requireSandbox: false,
        },
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 10000,
          maxExecutionTime: 5000,
        },
      };

      // Step 1: 写入文件
      const writeResult = await executor.execute(
        fileWriteTool,
        { 
          path: 'config.json', 
          content: JSON.stringify({ version: '1.0', env: 'test' }),
        },
        context
      );
      expect(writeResult.success).toBe(true);
      expect(writeResult.meta?.executionTime).toBeGreaterThan(0);

      // Step 2: 读取文件
      const readResult = await executor.execute(
        fileReadTool,
        { path: 'config.json' },
        context
      );
      expect(readResult.success).toBe(true);
      
      if (readResult.success && readResult.data) {
        const data = readResult.data as { content: string };
        expect(data.content).toContain('1.0');
      }

      // Step 3: 列出目录
      const listResult = await executor.execute(
        fileListTool,
        { path: '.' },
        context
      );
      expect(listResult.success).toBe(true);
    });

    test('should deny execution without required permissions', async () => {
      const restrictedContext: ExecutionContext = {
        taskId: 'restricted-test',
        agentId: 'restricted-agent',
        traceId: 'restricted-trace',
        workDir: testDir,
        env: {},
        permissions: {
          allowed: ['fs:read'], // 只允许读
          denied: ['fs:write'], // 明确拒绝写
          requireSandbox: false,
        },
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 10000,
          maxExecutionTime: 5000,
        },
      };

      const writeResult = await executor.execute(
        fileWriteTool,
        { path: 'forbidden.txt', content: 'should fail' },
        restrictedContext
      );

      // 应该被权限拒绝
      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toBeDefined();
      // 错误信息包含权限相关内容
      expect(writeResult.error).toMatch(/权限|Permission|fs:write/i);
    });

    test('should collect execution metrics', async () => {
      const context: ExecutionContext = {
        taskId: 'metrics-test',
        agentId: 'metrics-agent',
        traceId: 'metrics-trace',
        workDir: testDir,
        env: {},
        permissions: {
          allowed: ['env:read'],
          denied: [],
          requireSandbox: false,
        },
        resourceLimits: {
          maxFileSize: 10 * 1024 * 1024,
          maxOutputSize: 10000,
          maxExecutionTime: 5000,
        },
      };

      const result = await executor.execute(
        envGetTool,
        { keys: ['PATH', 'HOME'] },
        context
      );

      expect(result.meta).toBeDefined();
      expect(result.meta?.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Schema and Metadata Consistency', () => {
    test('should have consistent schema across all tools', () => {
      for (const tool of allTools) {
        // 验证必需字段
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        
        // 验证inputSchema结构
        expect(tool.inputSchema.type).toBe('object');
        
        // 验证layer（如果定义）
        if (tool.layer) {
          expect(Object.values(ToolLayer)).toContain(tool.layer);
        }
        
        // 验证category（如果定义）
        if (tool.category) {
          expect(Object.values(ToolCategory)).toContain(tool.category);
        }
        
        // 验证permissions（如果定义）
        if (tool.permissions) {
          for (const perm of tool.permissions) {
            expect(Object.values(ToolPermission)).toContain(perm);
          }
        }
      }
    });

    test('should have consistent metadata from ProgressiveDisclosure', () => {
      const metadata = progressiveDisclosure.getMetadata(allTools);

      expect(metadata.length).toBe(allTools.length);

      for (let i = 0; i < allTools.length; i++) {
        const tool = allTools[i]!;
        const meta = metadata[i]!;

        // 验证metadata与tool一致
        expect(meta.name).toBe(tool.name);
        expect(meta.title).toBe(tool.title || tool.name);
        
        if (tool.category) {
          expect(meta.category).toBe(tool.category);
        }
        if (tool.layer) {
          expect(meta.layer).toBe(tool.layer);
        }
      }
    });

    test('should have consistent basic definition', () => {
      for (const tool of allTools) {
        const basic = progressiveDisclosure.getBasicDefinition(tool);

        expect(basic.name).toBe(tool.name);
        expect(basic.description).toBe(tool.description);
        expect(basic.inputSchema).toBeDefined();
        
        if (tool.permissions) {
          expect(basic.permissions).toEqual(tool.permissions);
        }
      }
    });

    test('should have consistent full definition', () => {
      for (const tool of allTools) {
        const full = progressiveDisclosure.getFullDefinition(tool);

        expect(full.name).toBe(tool.name);
        expect(full.description).toBe(tool.description);
        expect(full.inputSchema).toEqual(tool.inputSchema);
        expect(full.outputSchema).toEqual(tool.outputSchema);
      }
    });
  });

  describe('Token Estimation Accuracy', () => {
    test('should estimate tokens proportionally', () => {
      const toolCount = allTools.length;
      
      const level1 = progressiveDisclosure.estimateTokens(1, toolCount);
      const level2 = progressiveDisclosure.estimateTokens(2, toolCount);
      const level3 = progressiveDisclosure.estimateTokens(3, toolCount);

      // 验证层级递增
      expect(level1).toBeLessThan(level2);
      expect(level2).toBeLessThan(level3);

      // 验证估算值合理
      expect(level1).toBe(50 * toolCount);
      expect(level2).toBe(200 * toolCount);
      expect(level3).toBe(500 * toolCount);

      // 验证减少比例
      const reduction = (level3 - level1) / level3;
      console.log(`Token reduction from Level 3 to Level 1: ${(reduction * 100).toFixed(1)}%`);
      expect(reduction).toBeGreaterThan(0.8); // >80%
    });
  });
});
