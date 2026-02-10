
import { RegressionGenerator } from '../packages/core/src/eval/regression-generator';
import { FailureCollector } from '../packages/core/src/eval/failure-collector';
import { resolve } from 'path';
import type { TrajectoryStep } from '../packages/core/src/eval/types';

async function main() {
  console.log('🚀 Generating sample regression data for Dashboard...');

  const STORAGE_PATH = resolve(process.cwd(), 'evals/regression-suite.json');
  const apiKey = process.env.OPENAI_API_KEY || 'mock-key';

  const generator = new RegressionGenerator({ apiKey });
  const collector = new FailureCollector(STORAGE_PATH);

  // MOCK generator if no key
  if (apiKey === 'mock-key') {
      console.log('⚠️ No API Key found, using mock generation...');
      generator.generateFromTrajectory = async (obj, traj, err) => ({
          id: `regression-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          objective: obj,
          expected: {
              success: true,
              contains: ['success'],
              llmCriteria: `Ensure the agent avoids: ${err}`
          },
          metadata: {
              originalError: err,
              timestamp: Date.now()
          }
      });
  }

  // Sample 1: File Not Found
  const traj1: TrajectoryStep[] = [
      { type: 'thinking', content: 'Reading config...', timestamp: Date.now() - 10000 },
      { type: 'tool_call', tool: 'file_read', input: { path: 'missing_config.json' }, timestamp: Date.now() - 9000 },
      { type: 'error', content: 'File not found: missing_config.json', timestamp: Date.now() - 8000 }
  ];
  const case1 = await generator.generateFromTrajectory(
      'Read configuration',
      traj1,
      'File not found exception'
  );
  await collector.addCase(case1);
  console.log(`✅ Added case: ${case1.id} (File Not Found)`);

  // Sample 2: Timeout
  const traj2: TrajectoryStep[] = [
      { type: 'thinking', content: 'Running heavy calculation...', timestamp: Date.now() - 20000 },
      { type: 'tool_call', tool: 'heavy_calc', input: { iterations: 1000000 }, timestamp: Date.now() - 15000 },
      { type: 'error', content: 'Timeout after 10000ms', timestamp: Date.now() - 5000 }
  ];
  const case2 = await generator.generateFromTrajectory(
      'Perform calculation',
      traj2,
      'Operation timed out'
  );
  await collector.addCase(case2);
  console.log(`✅ Added case: ${case2.id} (Timeout)`);

  // Sample 3: API Error
  const traj3: TrajectoryStep[] = [
      { type: 'thinking', content: 'Fetching user data...', timestamp: Date.now() - 5000 },
      { type: 'tool_call', tool: 'api_fetch', input: { url: 'https://api.example.com/users' }, timestamp: Date.now() - 4000 },
      { type: 'tool_result', tool: 'api_fetch', result: { status: 500, error: 'Internal Server Error' }, success: false, timestamp: Date.now() - 3000 }
  ];
  const case3 = await generator.generateFromTrajectory(
      'Fetch user data',
      traj3,
      'API returned 500'
  );
  await collector.addCase(case3);
  console.log(`✅ Added case: ${case3.id} (API Error)`);

  console.log(`\n🎉 Generated 3 regression cases in ${STORAGE_PATH}`);
}

main().catch(console.error);
