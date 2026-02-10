
import { describe, it, expect, vi } from 'vitest';
import { scoreEvalCase } from '../src/eval/scorer';
import type { TrajectoryStep } from '../src/eval/types';

// Mock createLLMClient
vi.mock('../src/planner', () => ({
  createLLMClient: () => ({
    complete: async () => ({
      content: JSON.stringify({
        passed: true,
        score: 0.9,
        reasoning: "The agent followed instructions."
      })
    })
  })
}));

describe('Evaluation Framework', () => {
  const mockTrajectory: TrajectoryStep[] = [
    { type: 'thinking', content: 'Plan...', timestamp: 100 },
    { type: 'tool_call', tool: 'file_read', input: { path: 'test.txt' }, timestamp: 110 },
    { type: 'tool_result', tool: 'file_read', result: { content: 'hello' }, success: true, timestamp: 120 },
    { type: 'subtask_output', content: 'done', timestamp: 130 }
  ];

  it('should score basic success correctly', async () => {
    const result = await scoreEvalCase('Success', true, mockTrajectory, { success: true });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.checks[0].type).toBe('success');
  });

  it('should evaluate trajectory constraints (forbidden tools)', async () => {
    const result = await scoreEvalCase('Success', true, mockTrajectory, {
      trajectory: {
        forbiddenTools: ['file_write']
      }
    });
    expect(result.passed).toBe(true);
    expect(result.checks[0].type).toBe('trajectory_forbidden_tool');
    expect(result.checks[0].passed).toBe(true);
  });

  it('should fail trajectory constraints when forbidden tool is used', async () => {
    const result = await scoreEvalCase('Success', true, mockTrajectory, {
      trajectory: {
        forbiddenTools: ['file_read']
      }
    });
    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
  });

  it('should evaluate trajectory constraints (required tools)', async () => {
    const result = await scoreEvalCase('Success', true, mockTrajectory, {
      trajectory: {
        requiredTools: ['file_read']
      }
    });
    expect(result.passed).toBe(true);
    expect(result.checks[0].type).toBe('trajectory_required_tool');
  });

  it('should evaluate trajectory constraints (max steps)', async () => {
    const result = await scoreEvalCase('Success', true, mockTrajectory, {
      trajectory: {
        maxSteps: 10
      }
    });
    expect(result.passed).toBe(true);
  });

  it('should use LLM-as-Judge when criteria is provided', async () => {
    const result = await scoreEvalCase('Success', true, mockTrajectory, {
      llmCriteria: "Did the agent read a file?"
    }, {
      apiKey: 'test-key',
      provider: 'openai'
    });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('llm_judge');
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].score).toBe(0.9);
  });
});
