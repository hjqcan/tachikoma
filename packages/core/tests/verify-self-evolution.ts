
import { createSkillTool } from '../src/tools/core/create-skill';
import { globalToolRegistry } from '../src/tools/registry';
import { defaultRegistry } from '../src/factories/registry';
import { LocalSandbox } from '../src/sandbox/drivers/local'; // or index
import { join } from 'path';
import { homedir } from 'os';

// Register LocalSandbox for test
// Register LocalSandbox for test
defaultRegistry.registerSandbox((id: string, config: any) => {
  const testConfig = {
    ...config,
    runtimeConfig: {
      ...(config.runtimeConfig || {}),
      allowUnsafeShell: true
    }
  };
  return new LocalSandbox(id, testConfig) as any;
});

async function testSelfEvolution() {
  console.log('Testing Self-Evolution Capability...');

  // 1. Create a "Hello World" skill
  console.log('1. Creating hello-world skill...');
  const createResult = await createSkillTool.execute({
    name: 'hello-world',
    description: 'A simple skill to greet the user',
    script_content: `import sys
if len(sys.argv) > 1:
    print(f"Hello, {sys.argv[1]}!")
else:
    print("Hello, World!")`,
    filename: 'main.py',
    instructions: 'Usage: hello-world [name]'
  }, { context: {} } as any);

  if (!createResult.success) {
    console.error('Failed to create skill:', createResult.error);
    process.exit(1);
  }
  console.log('Skill created:', createResult.data);

  // 2. Verify registration
  console.log('2. Verifying registration...');
  const tool = globalToolRegistry.getByName('hello-world');
  if (!tool) {
    console.error('Tool hello-world not found in registry!');
    process.exit(1);
  }
  console.log('Tool found:', tool.name);

  // 3. Execute the new skill
  console.log('3. Executing hello-world skill...');
  try {
    const result = await tool.execute({ args: ['Self-Evolution'] }, { context: {} } as any);
    const res = result as any;
    if (res.success) {
      console.log('Execution Success:', res.data);
      if (res.data?.trim() === 'Hello, Self-Evolution!') {
        console.log('✅ TEST PASSED');
      } else {
        console.error('❌ Output mismatch');
      }
    } else {
      console.error('Execution Failed:', res.error);
    }
  } catch (err) {
    console.error('Execution Error:', err);
  }
}

testSelfEvolution().catch(console.error);
