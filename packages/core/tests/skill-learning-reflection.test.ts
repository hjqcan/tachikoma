/**
 * Trajectory Reflection tests
 *
 * Tests for TrajectoryReflector
 *
 * @module tests/skill-learning-reflection.test
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  TrajectoryReflector,
  createTrajectoryReflector,
  thinkingRecordToTrajectory,
  actionRecordToTrajectory,
  type TrajectoryRecord,
  type ExecutionFeedback,
  type ReflectionResult,
} from '../src/skills';

// ============================================================================
// Mock LLM
// ============================================================================

/**
 * 创建 Mock LLM 返回预设的 JSON 响应
 */
function createMockLlm(response: Partial<ReflectionResult>): (prompt: string) => Promise<string> {
  return async () => {
    return '```json\n' + JSON.stringify(response) + '\n```';
  };
}

/**
 * 创建 Mock LLM 返回原始文本
 */
function createMockLlmRaw(text: string): (prompt: string) => Promise<string> {
  return async () => text;
}

// ============================================================================
// TrajectoryReflector 测试
// ============================================================================

describe('TrajectoryReflector', () => {
  describe('constructor', () => {
    test('creates reflector with default config', () => {
      const reflector = new TrajectoryReflector({
        llmCall: async () => '{}',
      });
      expect(reflector).toBeInstanceOf(TrajectoryReflector);
    });

    test('creates reflector with custom config', () => {
      const reflector = createTrajectoryReflector({
        llmCall: async () => '{}',
        detailed: false,
        maxRecords: 100,
        suggestSkill: false,
      });
      expect(reflector).toBeInstanceOf(TrajectoryReflector);
    });
  });

  describe('reflect', () => {
    test('parses valid JSON response', async () => {
      const mockResponse: Partial<ReflectionResult> = {
        success: true,
        reasoningValid: true,
        reasoningSummary: 'Task completed successfully.',
        patterns: [
          {
            name: 'file-first-approach',
            description: 'Always read files before modifying',
            type: 'solution',
            confidence: 0.9,
            evidence: ['record-1'],
          },
        ],
        failureModes: [],
        abstractableKnowledge: ['Always verify file existence before operations.'],
        suggestedSkillName: 'file-operations',
        suggestedSkillDescription: 'Best practices for file operations',
        suggestedTags: ['files', 'io'],
      };

      const reflector = new TrajectoryReflector({
        llmCall: createMockLlm(mockResponse),
      });

      const trajectory: TrajectoryRecord[] = [
        {
          id: 'record-1',
          timestamp: Date.now(),
          type: 'thinking',
          content: 'Analyzing task requirements',
        },
      ];

      const result = await reflector.reflect(
        trajectory,
        'Create a hello world file',
      );

      expect(result.success).toBe(true);
      expect(result.reasoningValid).toBe(true);
      expect(result.reasoningSummary).toBe('Task completed successfully.');
      expect(result.patterns).toHaveLength(1);
      expect(result.patterns[0]?.name).toBe('file-first-approach');
      expect(result.suggestedSkillName).toBe('file-operations');
    });

    test('handles feedback in reflection', async () => {
      const mockResponse: Partial<ReflectionResult> = {
        success: false,
        reasoningValid: false,
        reasoningSummary: 'Failed due to permission error.',
        failureModes: [
          {
            type: 'error',
            description: 'Permission denied when writing file',
            rootCause: 'Insufficient permissions',
            mitigation: 'Check file permissions before write',
          },
        ],
      };

      const reflector = new TrajectoryReflector({
        llmCall: createMockLlm(mockResponse),
      });

      const feedback: ExecutionFeedback = {
        success: false,
        error: 'EACCES: permission denied',
        testResults: {
          passed: 3,
          failed: 1,
          errors: ['Permission denied'],
        },
      };

      const result = await reflector.reflect(
        [],
        'Write to protected directory',
        feedback,
      );

      expect(result.success).toBe(false);
      expect(result.failureModes).toHaveLength(1);
      expect(result.failureModes[0]?.type).toBe('error');
    });

    test('handles malformed JSON response gracefully', async () => {
      const reflector = new TrajectoryReflector({
        llmCall: createMockLlmRaw('This is not valid JSON'),
      });

      const result = await reflector.reflect(
        [],
        'Some task',
      );

      expect(result.reasoningSummary).toContain('Unable to parse');
      expect(result.rawResponse).toBe('This is not valid JSON');
    });

    test('extracts JSON from markdown code block', async () => {
      const reflector = new TrajectoryReflector({
        llmCall: createMockLlmRaw(`
Here is my analysis:

\`\`\`json
{
  "success": true,
  "reasoningValid": true,
  "reasoningSummary": "Extracted from code block",
  "patterns": [],
  "failureModes": [],
  "abstractableKnowledge": []
}
\`\`\`

That's my analysis.
        `),
      });

      const result = await reflector.reflect([], 'Test task');

      expect(result.success).toBe(true);
      expect(result.reasoningSummary).toBe('Extracted from code block');
    });

    test('truncates long trajectories', async () => {
      let capturedPrompt = '';
      const reflector = new TrajectoryReflector({
        llmCall: async (prompt) => {
          capturedPrompt = prompt;
          return '{}';
        },
        maxRecords: 10,
      });

      // 创建 20 条记录
      const trajectory: TrajectoryRecord[] = Array.from({ length: 20 }, (_, i) => ({
        id: `record-${i}`,
        timestamp: Date.now() + i * 1000,
        type: 'thinking' as const,
        content: `Step ${i}`,
      }));

      await reflector.reflect(trajectory, 'Long task');

      // 应该只包含 10 条记录（30% 开头 + 70% 结尾）
      const recordCount = (capturedPrompt.match(/\[ID: record-/g) || []).length;
      expect(recordCount).toBe(10);
    });
  });
});

// ============================================================================
// Conversion functions 测试
// ============================================================================

describe('thinkingRecordToTrajectory', () => {
  test('converts basic thinking record', () => {
    const record = {
      id: 'think-1',
      timestamp: 1703500000000,
      content: 'Analyzing the problem',
    };

    const result = thinkingRecordToTrajectory(record);

    expect(result.id).toBe('think-1');
    expect(result.type).toBe('thinking');
    expect(result.content).toBe('Analyzing the problem');
    expect(result.stage).toBeUndefined();
    expect(result.toolName).toBeUndefined();
    expect(result.subtaskId).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  test('converts thinking record with stage', () => {
    const record = {
      id: 'think-2',
      timestamp: 1703500000000,
      content: 'Planning next steps',
      stage: 'planning',
    };

    const result = thinkingRecordToTrajectory(record);

    expect(result.stage).toBe('planning');
  });

  test('converts thinking record with related tools', () => {
    const record = {
      id: 'think-3',
      timestamp: 1703500000000,
      content: 'Need to read file',
      relatedTools: ['file_read', 'file_write'],
    };

    const result = thinkingRecordToTrajectory(record);

    expect(result.toolName).toBe('file_read');
    expect(result.relatedTools).toEqual(['file_read', 'file_write']);
  });

  test('converts thinking record with subtaskId and confidence', () => {
    const record = {
      id: 'think-4',
      timestamp: 1703500000000,
      subtaskId: 'subtask-123',
      content: 'Confident analysis',
      stage: 'analysis',
      confidence: 0.85,
      relatedTools: ['grep_search'],
    };

    const result = thinkingRecordToTrajectory(record);

    expect(result.subtaskId).toBe('subtask-123');
    expect(result.confidence).toBe(0.85);
    expect(result.stage).toBe('analysis');
    expect(result.relatedTools).toEqual(['grep_search']);
    expect(result.toolName).toBe('grep_search');
  });
});

describe('actionRecordToTrajectory', () => {
  test('converts tool_call action', () => {
    const record = {
      id: 'action-1',
      timestamp: 1703500000000,
      type: 'tool_call',
      description: 'Reading config.json',
      params: { tool: 'file_read', path: '/config.json' },
      result: {
        success: true,
        output: '{}',
        duration: 50,
      },
    };

    const result = actionRecordToTrajectory(record);

    expect(result.id).toBe('action-1');
    expect(result.type).toBe('tool_call');
    expect(result.toolName).toBe('file_read');
    expect(result.toolParams).toEqual({ tool: 'file_read', path: '/config.json' });
    expect(result.result?.success).toBe(true);
  });

  test('converts non-tool_call action', () => {
    const record = {
      id: 'action-2',
      timestamp: 1703500000000,
      type: 'file_operation',
      description: 'Creating directory',
    };

    const result = actionRecordToTrajectory(record);

    expect(result.type).toBe('action');
    expect(result.toolName).toBeUndefined();
  });

  test('converts action with error result', () => {
    const record = {
      id: 'action-3',
      timestamp: 1703500000000,
      type: 'tool_call',
      description: 'Failed operation',
      params: { tool: 'shell_run' },
      result: {
        success: false,
        error: 'Command failed',
        duration: 100,
      },
    };

    const result = actionRecordToTrajectory(record);

    expect(result.result?.success).toBe(false);
    expect(result.result?.error).toBe('Command failed');
  });

  test('converts action record with subtaskId', () => {
    const record = {
      id: 'action-4',
      timestamp: 1703500000000,
      subtaskId: 'subtask-456',
      type: 'tool_call',
      description: 'Searching codebase',
      params: { tool: 'grep_search', query: 'function' },
      result: {
        success: true,
        output: 'Found 10 matches',
        duration: 200,
      },
    };

    const result = actionRecordToTrajectory(record);

    expect(result.subtaskId).toBe('subtask-456');
    expect(result.toolName).toBe('grep_search');
    expect(result.result?.success).toBe(true);
  });
});
