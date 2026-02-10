import { describe, it, expect, afterEach } from 'vitest';
import { RegressionGenerator } from '../src/eval/regression-generator';
import { FailureCollector } from '../src/eval/failure-collector';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TrajectoryStep } from '../src/eval/types';

describe('End-to-End Quality Flywheel', () => {
  const TEST_STORAGE_PATH = resolve(__dirname, 'e2e-regression.json');

  afterEach(async () => {
    try {
      await unlink(TEST_STORAGE_PATH);
    } catch {}
  });

  it('should generate and store a regression test from a simulated failure', async () => {
    // 1. Simulate Failure Trajectory
    const mockTrajectory: TrajectoryStep[] = [
      {
        type: 'thinking',
        content: 'Attempting to read config.',
        timestamp: Date.now() - 1000
      },
      {
        type: 'error',
        content: 'File not found: config.json',
        timestamp: Date.now()
      }
    ];

    // 2. Initialize Components (Mocking LLM to avoid API costs/keys in CI)
    const generator = new RegressionGenerator({ apiKey: 'mock-key' });

    // Mock the LLM client response specifically for this generator instance
    // We have to cast to any because the client is private or we mock the module.
    // Since we didn't export the client, we'll mock the method on the instance if possible,
    // or rely on the fact that we mocked createLLMClient in the previous test file setup.
    // However, to be safe and independent, let's just mock the 'generateFromTrajectory' method
    // if we can't easily mock the internal client without module mocking.
    // Actually, let's use the module mock approach like in the unit tests.

    // BUT, we can't easily do module mocking inside a single 'it' block if we want it isolated
    // without affecting other tests if running in parallel, but here we run a specific file.
    // Let's try to overwrite the client property if it's accessible, or just mock the generator method.
    // Checking regression-generator.ts... it has a private client.

    // Alternative: Just mock the `generateFromTrajectory` method for this E2E test
    // since we already unit tested the LLM integration in `quality-flywheel.test.ts`.
    // The goal here is to test the PIPELINE (Generator -> Collector -> Storage).

    generator.generateFromTrajectory = async () => ({
      id: 'e2e-test-case',
      objective: 'Read config safely',
      expected: { success: true }
    });

    const collector = new FailureCollector(TEST_STORAGE_PATH);

    // 3. Run Pipeline
    const regressionCase = await generator.generateFromTrajectory(
      'Read config',
      mockTrajectory,
      'File not found'
    );

    await collector.addCase(regressionCase);

    // 4. Verify Storage (Dashboard Ingestion Source)
    const content = await readFile(TEST_STORAGE_PATH, 'utf-8');
    const storedData = JSON.parse(content);

    expect(storedData.cases).toHaveLength(1);
    expect(storedData.cases[0].id).toBe('e2e-test-case');
    expect(storedData.cases[0].objective).toBe('Read config safely');

    // This file 'e2e-regression.json' simulates the data source the Dashboard would read.
    // The successful existence of this file confirms the dashboard *could* read it.
  });
});
