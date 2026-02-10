
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RegressionGenerator } from '../src/eval/regression-generator';
import { FailureCollector } from '../src/eval/failure-collector';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

// Mock createLLMClient
vi.mock('../src/planner', () => ({
  createLLMClient: () => ({
    complete: async () => ({
      content: JSON.stringify({
        id: 'test-regression-1',
        objective: 'Fix the bug',
        expected: { success: true }
      })
    })
  })
}));

describe('Quality Flywheel', () => {
  const testStoragePath = 'packages/core/tests/temp-regression.json';

  afterEach(async () => {
    try {
      await unlink(resolve(testStoragePath));
    } catch {}
  });

  it('should generate a regression test case from a failed trajectory', async () => {
    const generator = new RegressionGenerator({ apiKey: 'test' });
    const evalCase = await generator.generateFromTrajectory(
      'Do something',
      [{ type: 'error', content: 'Failed', timestamp: 100 }],
      'Error occurred'
    );

    expect(evalCase.objective).toBe('Fix the bug');
    expect(evalCase.expected?.success).toBe(true);
    expect(evalCase.id).toContain('regression-');
  });

  it('should save a regression test case to storage', async () => {
    const collector = new FailureCollector(testStoragePath);
    const evalCase = {
      id: 'reg-1',
      objective: 'Test',
      expected: { success: true }
    };

    await collector.addCase(evalCase);

    const content = await readFile(resolve(testStoragePath), 'utf-8');
    const data = JSON.parse(content);
    expect(data.cases).toHaveLength(1);
    expect(data.cases[0].id).toBe('reg-1');
  });
});
