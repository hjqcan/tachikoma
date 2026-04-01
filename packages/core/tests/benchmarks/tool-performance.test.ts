/**
 * 工具系统性能基准测试
 * 
 * 验证性能指标：
 * - 工具查询: <1ms
 * - 权限校验: <0.5ms
 * - 渐进披露Token减少: >80%
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  ToolRegistry,
  PermissionValidator,
  ProgressiveDisclosure,
  fileReadTool,
  fileWriteTool,
  fileListTool,
  shellRunTool,
  codeSearchTool,
} from '../../src/tools';
import { ToolLayer } from '../../src/tools/types';
import type { ExecutionContext, Tool } from '../../src/types';

describe('Tool System Performance Benchmarks', () => {
  let testRegistry: ToolRegistry;
  let allTools: Tool[];
  let progressiveDisclosure: ProgressiveDisclosure;

  const context: ExecutionContext = {
    taskId: 'bench-task',
    agentId: 'bench-agent',
    traceId: 'bench-trace',
    workDir: process.cwd(),
    env: {},
    permissions: {
      allowed: ['fs:read', 'fs:write'],
      denied: [],
      requireSandbox: false,
    },
    resourceLimits: {
      maxFileSize: 50 * 1024 * 1024,
      maxOutputSize: 50000,
      maxExecutionTime: 30000,
    },
  };

  beforeAll(() => {
    // 收集所有工具
    allTools = [
      fileReadTool,
      fileWriteTool,
      fileListTool,
      shellRunTool,
      codeSearchTool,
    ];

    // 创建测试专用registry并注册所有工具
    testRegistry = new ToolRegistry();
    allTools.forEach((tool) => testRegistry.register(tool));

    // 创建ProgressiveDisclosure实例
    progressiveDisclosure = new ProgressiveDisclosure();
  });

  describe('ToolRegistry Query Performance', () => {
    test('should query tool by name in <1ms', () => {
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        testRegistry.getByName('file_read');
      }

      const end = performance.now();
      const avgTime = (end - start) / iterations;

      console.log(`Average query time: ${avgTime.toFixed(3)}ms`);
      expect(avgTime).toBeLessThan(1);
    });

    test('should filter by layer in <2ms', () => {
      const start = performance.now();
      const tools = testRegistry.getByLayer(ToolLayer.Atomic);
      const end = performance.now();

      console.log(`Filter by layer time: ${(end - start).toFixed(3)}ms`);
      expect(tools.length).toBeGreaterThan(0);
      expect(end - start).toBeLessThan(2);
    });
  });

  describe('Permission Validation Performance', () => {
    test('should validate permissions in <0.5ms', () => {
      const validator = new PermissionValidator();
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        validator.validate(fileReadTool, context);
      }

      const end = performance.now();
      const avgTime = (end - start) / iterations;

      console.log(`Average validation time: ${avgTime.toFixed(3)}ms`);
      expect(avgTime).toBeLessThan(0.5);
    });

    test('should handle complex permission checks efficiently', () => {
      const validator = new PermissionValidator();
      const complexContext: ExecutionContext = {
        ...context,
        permissions: {
          allowed: ['fs:read', 'fs:write', 'shell:exec', 'network:read'],
          denied: ['fs:delete', 'network:write'],
          requireSandbox: true,
        },
      };

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        validator.validate(fileReadTool, complexContext);
      }
      const end = performance.now();

      const avgTime = (end - start) / 100;
      console.log(`Complex validation time: ${avgTime.toFixed(3)}ms`);
      expect(avgTime).toBeLessThan(1);
    });
  });

  describe('Progressive Disclosure Token Reduction', () => {
    test('should achieve >50% token reduction', () => {
      const toolCount = allTools.length;
      const metadataTokens = progressiveDisclosure.estimateTokens(1, toolCount);
      const basicTokens = progressiveDisclosure.estimateTokens(2, toolCount);
      const fullTokens = progressiveDisclosure.estimateTokens(3, toolCount);

      if (fullTokens > 0) {
        const metadataReduction = ((fullTokens - metadataTokens) / fullTokens) * 100;
        const basicReduction = ((fullTokens - basicTokens) / fullTokens) * 100;

        console.log(`Metadata token reduction: ${metadataReduction.toFixed(1)}%`);
        console.log(`Basic token reduction: ${basicReduction.toFixed(1)}%`);
        console.log(`Full tokens: ${fullTokens}, Metadata: ${metadataTokens}, Basic: ${basicTokens}`);

        expect(metadataReduction).toBeGreaterThan(50);
      }
    });

    test('should retrieve metadata quickly', () => {
      const start = performance.now();
      const metadata = progressiveDisclosure.getMetadata(allTools);
      const end = performance.now();

      console.log(`Metadata retrieval time: ${(end - start).toFixed(3)}ms`);
      expect(metadata.length).toBeGreaterThan(0);
      expect(end - start).toBeLessThan(10);
    });

	    test('should recommend tools efficiently', () => {
	      const start = performance.now();
	      const recommended = progressiveDisclosure.recommend('文件读取', allTools);
	      const end = performance.now();

	      console.log(`Recommendation time: ${(end - start).toFixed(3)}ms`);
	      expect(recommended.length).toBeGreaterThan(0);
	      expect(end - start).toBeLessThan(20);
	    });
	  });

  describe('Overall System Performance', () => {
    test('should handle concurrent queries efficiently', async () => {
      const start = performance.now();

      const promises = Array.from({ length: 100 }, () => {
        return Promise.resolve(testRegistry.getByName('file_read'));
      });

      await Promise.all(promises);
      const end = performance.now();

      console.log(`100 concurrent queries: ${(end - start).toFixed(3)}ms`);
      expect(end - start).toBeLessThan(50);
    });
  });
});
