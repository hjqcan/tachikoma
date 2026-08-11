/**
 * 关键决策检测模块测试
 */

import { describe, expect, test } from 'bun:test';
import {
  isKeyDecision,
  isDeleteOperation,
  isLargeModification,
  isMultiFileOperation,
  isExternalApiCall,
  isHighRiskTool,
  getRiskScore,
  checkToolMutating,
} from '../src/worker/key-decision';
import type { Tool } from '../src/types';

describe('key-decision', () => {
  // ==========================================================================
  // isDeleteOperation
  // ==========================================================================
  describe('isDeleteOperation', () => {
    test('should detect delete tool by name', () => {
      expect(isDeleteOperation('delete_file', {})).toBe(true);
      expect(isDeleteOperation('remove_directory', {})).toBe(true);
      expect(isDeleteOperation('rm', {})).toBe(true);
    });

    test('should detect delete keywords in input', () => {
      expect(isDeleteOperation('run_command', { command: 'rm -rf /tmp/test' })).toBe(true);
      expect(isDeleteOperation('execute', { script: 'delete from users' })).toBe(true);
    });

    test('should not flag non-delete operations', () => {
      expect(isDeleteOperation('read_file', { path: '/tmp/file.txt' })).toBe(false);
      expect(isDeleteOperation('write_file', { content: 'hello world' })).toBe(false);
    });
  });

  // ==========================================================================
  // isLargeModification
  // ==========================================================================
  describe('isLargeModification', () => {
    test('should detect large content by line count', () => {
      const largeContent = Array(150).fill('line').join('\n');
      expect(isLargeModification({ content: largeContent }, 100)).toBe(true);
    });

    test('should not flag small content', () => {
      const smallContent = Array(50).fill('line').join('\n');
      expect(isLargeModification({ content: smallContent }, 100)).toBe(false);
    });

    test('should detect large patch', () => {
      const largePatch = Array(150).fill('+line').join('\n');
      expect(isLargeModification({ patch: largePatch }, 100)).toBe(true);
    });

    test('should detect large changes array', () => {
      const changes = Array(5).fill({ content: Array(30).fill('line').join('\n') });
      expect(isLargeModification({ changes }, 100)).toBe(true);
    });

    test('should check lines field', () => {
      expect(isLargeModification({ lines: 150 }, 100)).toBe(true);
      expect(isLargeModification({ lines: 50 }, 100)).toBe(false);
    });
  });

  // ==========================================================================
  // isMultiFileOperation
  // ==========================================================================
  describe('isMultiFileOperation', () => {
    test('should detect multiple files in files field', () => {
      expect(isMultiFileOperation({ files: ['a.ts', 'b.ts', 'c.ts'] }, 3)).toBe(true);
      expect(isMultiFileOperation({ files: ['a.ts', 'b.ts'] }, 3)).toBe(false);
    });

    test('should detect multiple paths', () => {
      expect(isMultiFileOperation({ paths: ['/a', '/b', '/c', '/d'] }, 3)).toBe(true);
    });

    test('should detect multiple targets', () => {
      expect(isMultiFileOperation({ targets: ['x', 'y', 'z'] }, 3)).toBe(true);
    });

    test('should detect path-like array fields', () => {
      expect(isMultiFileOperation({ filePaths: ['1', '2', '3', '4'] }, 3)).toBe(true);
    });
  });

  // ==========================================================================
  // isExternalApiCall
  // ==========================================================================
  describe('isExternalApiCall', () => {
    test('should detect API tools by name', () => {
      expect(isExternalApiCall('http_request', {})).toBe(true);
      expect(isExternalApiCall('api_call', {})).toBe(true);
      expect(isExternalApiCall('fetch_data', {})).toBe(true);
    });

    test('should detect URLs in input', () => {
      expect(isExternalApiCall('execute', { url: 'https://api.example.com' })).toBe(true);
      expect(isExternalApiCall('run', { endpoint: 'http://localhost:3000' })).toBe(true);
    });

    test('should detect webhook references', () => {
      expect(isExternalApiCall('send', { target: 'webhook endpoint' })).toBe(true);
    });

    test('should not flag local operations', () => {
      expect(isExternalApiCall('read_file', { path: '/local/file.txt' })).toBe(false);
    });
  });

  // ==========================================================================
  // isHighRiskTool
  // ==========================================================================
  describe('isHighRiskTool', () => {
    test('should detect high-risk tool names', () => {
      expect(isHighRiskTool('delete_file', {})).toBe(true);
      expect(isHighRiskTool('execute_shell', {})).toBe(true);
      expect(isHighRiskTool('run_command', {})).toBe(true);
    });

    test('should detect dangerous patterns in input', () => {
      expect(isHighRiskTool('run', { cmd: 'rm -rf /' })).toBe(true);
      expect(isHighRiskTool('sql', { query: 'drop database' })).toBe(true);
    });

    test('should respect custom risk policy', () => {
      const customPolicy = {
        highRiskTools: ['custom_dangerous'],
        dangerousPatterns: ['danger_pattern'],
      };
      expect(isHighRiskTool('custom_dangerous', {}, customPolicy)).toBe(true);
      expect(isHighRiskTool('safe_tool', { data: 'danger_pattern' }, customPolicy)).toBe(true);
    });

    test('should use custom evaluator when provided', () => {
      const customPolicy = {
        customEvaluator: (toolName: string) => toolName === 'very_risky',
      };
      expect(isHighRiskTool('very_risky', {}, customPolicy)).toBe(true);
      expect(isHighRiskTool('delete_file', {}, customPolicy)).toBe(false); // Custom evaluator overrides
    });
  });

  // ==========================================================================
  // isKeyDecision
  // ==========================================================================
  describe('isKeyDecision', () => {
    const mockTool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {},
      async execute(): Promise<unknown> {
        return { success: true };
      },
    };

    test('should return not key decision when policy disabled', () => {
      const result = isKeyDecision('delete_file', {}, mockTool, { enabled: false });
      expect(result.isKeyDecision).toBe(false);
    });

    test('should detect high-risk tools', () => {
      const result = isKeyDecision('delete_file', {}, mockTool);
      expect(result.isKeyDecision).toBe(true);
      expect(result.category).toBe('high_risk_tool');
      expect(result.riskLevel).toBe('high');
    });

    test('should detect delete operations via high-risk tool', () => {
      const result = isKeyDecision('run', { cmd: 'rm -rf test' }, mockTool);
      expect(result.isKeyDecision).toBe(true);
      // High-risk tool matching happens first, returns 'high' level
      expect(result.riskLevel).toBe('high');
    });

    test('should detect external API calls', () => {
      const result = isKeyDecision('execute', { url: 'https://api.example.com' }, mockTool);
      expect(result.isKeyDecision).toBe(true);
      expect(result.category).toBe('key_decision');
    });

    test('should detect large modifications', () => {
      const largeContent = Array(150).fill('line').join('\n');
      const result = isKeyDecision('write_file', { content: largeContent }, mockTool);
      expect(result.isKeyDecision).toBe(true);
      expect(result.reason).toContain('100 lines');
    });

    test('should detect multi-file operations', () => {
      const result = isKeyDecision('refactor', { files: ['a.ts', 'b.ts', 'c.ts'] }, mockTool);
      expect(result.isKeyDecision).toBe(true);
      expect(result.reason).toContain('3+ files');
    });

    test('should respect custom thresholds', () => {
      const policy = {
        triggers: {
          maxLinesThreshold: 50,
          multiFileThreshold: 2,
        },
      };
      
      const mediumContent = Array(60).fill('line').join('\n');
      const result = isKeyDecision('write', { content: mediumContent }, mockTool, policy);
      expect(result.isKeyDecision).toBe(true);
    });

    test('should check tool metadata for approval requirement', () => {
      const toolWithMeta: Tool = {
        name: 'risky_tool',
        description: 'Requires approval',
        inputSchema: {
          requiresApproval: true,
        },
        async execute(): Promise<unknown> {
          return { success: true };
        },
      };
      
      const result = isKeyDecision('safe_name', {}, toolWithMeta);
      expect(result.isKeyDecision).toBe(true);
      expect(result.category).toBe('custom');
    });

    test('should return safe result for normal operations', () => {
      const result = isKeyDecision('read_file', { path: '/tmp/file.txt' }, mockTool);
      expect(result.isKeyDecision).toBe(false);
      expect(result.riskLevel).toBe('low');
    });
  });

  // ==========================================================================
  // getRiskScore
  // ==========================================================================
  describe('getRiskScore', () => {
    test('should return correct scores', () => {
      expect(getRiskScore('low')).toBe(1);
      expect(getRiskScore('medium')).toBe(2);
      expect(getRiskScore('high')).toBe(3);
      expect(getRiskScore('critical')).toBe(4);
    });
  });

  // ==========================================================================
  // checkToolMutating
  // ==========================================================================
  describe('checkToolMutating', () => {
    const mockContext = {
      taskId: 'test-task',
      agentId: 'test-agent',
      traceId: 'test-trace',
      workDir: '/tmp',
      env: {},
    };

    test('should return null when tool has no isMutating', async () => {
      const tool: Tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {},
        async execute() { return { success: true }; },
      };
      const result = await checkToolMutating(tool, {}, mockContext);
      expect(result).toBe(null);
    });

    test('should return null when tool is undefined', async () => {
      const result = await checkToolMutating(undefined, {}, mockContext);
      expect(result).toBe(null);
    });

    test('should call isMutating when defined (sync)', async () => {
      const tool: Tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {},
        isMutating: (input) => (input as { safe?: boolean }).safe === true ? false : true,
        async execute() { return { success: true }; },
      };
      expect(await checkToolMutating(tool, { safe: true }, mockContext)).toBe(false);
      expect(await checkToolMutating(tool, { safe: false }, mockContext)).toBe(true);
    });

    test('should handle async isMutating', async () => {
      const tool: Tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {},
        isMutating: async () => false,
        async execute() { return { success: true }; },
      };
      expect(await checkToolMutating(tool, {}, mockContext)).toBe(false);
    });

    test('should return true on isMutating error (conservative)', async () => {
      const tool: Tool = {
        name: 'test',
        description: 'Test tool',
        inputSchema: {},
        isMutating: () => { throw new Error('Test error'); },
        async execute() { return { success: true }; },
      };
      expect(await checkToolMutating(tool, {}, mockContext)).toBe(true);
    });
  });

  // ==========================================================================
  // shell_run isMutating
  // ==========================================================================
  describe('shell_run isMutating', () => {
    // Import shellRunTool dynamically to test
    test('should detect safe commands', async () => {
      const { shellRunTool } = await import('../src/tools/core/shell-run');
      
      // Safe commands should return false (no mutation)
      expect(shellRunTool.isMutating?.({ command: 'ls -la' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'cat package.json' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'git status' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'git log --oneline' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'npm list' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'node --version' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'pwd' })).toBe(false);
      expect(shellRunTool.isMutating?.({ command: 'echo hello' })).toBe(false);
    });

    test('should detect mutating commands', async () => {
      const { shellRunTool } = await import('../src/tools/core/shell-run');
      
      // Mutating commands should return true
      expect(shellRunTool.isMutating?.({ command: 'rm file.txt' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'npm install' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'git commit -m "test"' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'mv a.txt b.txt' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'touch newfile.txt' })).toBe(true);
    });

    test('should handle empty or missing command', async () => {
      const { shellRunTool } = await import('../src/tools/core/shell-run');
      
      // No command should return true (conservative)
      expect(shellRunTool.isMutating?.({})).toBe(true);
      expect(shellRunTool.isMutating?.({ command: '' })).toBe(true);
    });

    test('should detect dangerous operators (bypass prevention)', async () => {
      const { shellRunTool } = await import('../src/tools/core/shell-run');
      
      // Commands with dangerous operators should return true even if starting with safe command
      expect(shellRunTool.isMutating?.({ command: 'cat file.txt > output.txt' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'ls -la | xargs rm' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'git status && rm -rf .' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'echo hello; rm file.txt' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'cat $(rm important.txt)' })).toBe(true);
      expect(shellRunTool.isMutating?.({ command: 'ls `rm -rf /`' })).toBe(true);
    });
  });

  describe('isKeyDecisionAsync', () => {
    const mockContext = {
      taskId: 'test-task',
      agentId: 'test-agent',
      traceId: 'test-trace',
      workDir: '/tmp',
      env: {},
    };

    test('should skip approval when isMutating returns false', async () => {
      const { isKeyDecisionAsync } = await import('../src/worker/key-decision');
      const tool: Tool = {
        name: 'test_tool',
        description: 'Test tool',
        inputSchema: { type: 'object' },
        isMutating: () => false,  // Explicitly non-mutating
        execute: async () => ({ success: true }),
      };
      
      const result = await isKeyDecisionAsync(
        'test_tool',
        {},
        tool,
        mockContext
      );
      
      expect(result.isKeyDecision).toBe(false);
    });

    test('should use static rules when isMutating returns true', async () => {
      const { isKeyDecisionAsync } = await import('../src/worker/key-decision');
      const tool: Tool = {
        name: 'shell_run',  // High-risk tool name
        description: 'Test tool',
        inputSchema: { type: 'object' },
        isMutating: () => true,  // Explicitly mutating
        execute: async () => ({ success: true }),
      };
      
      const result = await isKeyDecisionAsync(
        'shell_run',
        {},
        tool,
        mockContext,
        { enabled: true },
        { highRiskTools: ['shell_run'], dangerousPatterns: [] }  // Custom risk policy
      );
      
      // Should trigger high-risk tool detection
      expect(result.isKeyDecision).toBe(true);
    });

    test('should use static rules when isMutating is not defined', async () => {
      const { isKeyDecisionAsync } = await import('../src/worker/key-decision');
      const tool: Tool = {
        name: 'shell_run',
        description: 'Test tool',
        inputSchema: { type: 'object' },
        // No isMutating defined
        execute: async () => ({ success: true }),
      };
      
      const result = await isKeyDecisionAsync(
        'shell_run',
        {},
        tool,
        mockContext,
        { enabled: true },
        { highRiskTools: ['shell_run'], dangerousPatterns: [] }  // Custom risk policy
      );
      
      // Should fall back to static rules and detect high-risk tool
      expect(result.isKeyDecision).toBe(true);
    });
  });
});
