
import { RegressionGenerator } from '../regression-generator';
import { FailureCollector } from '../failure-collector';
import { resolve } from 'path';
import { readFile, unlink } from 'fs/promises';
import type { TrajectoryStep } from '../types';

async function main() {
  console.log('🚀 Starting End-to-End Quality Flywheel Verification...');

  // 1. Setup
  const TEST_STORAGE_PATH = resolve(process.cwd(), 'evals/integration-test-suite.json');
  // Clean up previous run
  try { await unlink(TEST_STORAGE_PATH); } catch {}

  // Mock a failed trajectory
  const mockTrajectory: TrajectoryStep[] = [
    {
      type: 'thinking',
      content: 'I will try to read the file "config.json" to understand the project structure.',
      timestamp: Date.now() - 5000
    },
    {
      type: 'tool_call',
      tool: 'file_read',
      input: { path: 'config.json' },
      timestamp: Date.now() - 4000
    },
    {
      type: 'error',
      content: 'Error: File "config.json" does not exist.',
      timestamp: Date.now() - 3000
    },
    {
      type: 'thinking',
      content: 'I failed to read the config file. I am stuck.',
      timestamp: Date.now() - 2000
    }
  ];

  const originalObjective = 'Read the project configuration';
  const errorSummary = 'Failed to find config.json';

  console.log('📉 Simulating failure trajectory...');

  // 2. Initialize Components
  // Note: We need a real API key for this to work, or we can mock the client if we don't want to spend tokens.
  // For this integration test, we will assume the environment has OPENAI_API_KEY or similar.
  // If not, we'll mock the generator for the sake of the test structure.

  const apiKey = process.env.OPENAI_API_KEY || 'mock-key';
  const generator = new RegressionGenerator({ apiKey });

  // MOCKING generateFromTrajectory if no API key is present to avoid failure in CI/Sandbox without keys
  if (apiKey === 'mock-key') {
      console.log('⚠️ No API Key found, mocking RegressionGenerator response...');
      generator.generateFromTrajectory = async () => ({
          id: `regression-${Date.now()}`,
          objective: 'Read project configuration safely',
          expected: {
              success: true,
              contains: ['config.json'],
              trajectory: { requiredTools: ['file_list'] }
          }
      });
  }

  const collector = new FailureCollector(TEST_STORAGE_PATH);

  // 3. Generate Regression Case
  console.log('🧠 Generating regression test case from trajectory...');
  const regressionCase = await generator.generateFromTrajectory(
      originalObjective,
      mockTrajectory,
      errorSummary
  );

  console.log('✅ Generated Case:', JSON.stringify(regressionCase, null, 2));

  // 4. Collect/Save Case
  console.log('💾 Saving case to FailureCollector...');
  await collector.addCase(regressionCase);

  // 5. Verify Storage
  console.log('🔍 Verifying storage file...');
  const fileContent = await readFile(TEST_STORAGE_PATH, 'utf-8');
  const storedData = JSON.parse(fileContent);

  if (storedData.cases.length === 1 && storedData.cases[0].id === regressionCase.id) {
      console.log('🎉 SUCCESS: Regression case successfully stored!');
  } else {
      console.error('❌ FAILURE: Stored data does not match generated case.');
      process.exit(1);
  }

  // Cleanup
  await unlink(TEST_STORAGE_PATH);
  console.log('🧹 Cleanup complete.');
}

main().catch(console.error);
