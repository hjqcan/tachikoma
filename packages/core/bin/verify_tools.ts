
import { researchToSpecTool } from '../src/tools/core/research-to-spec';
import { taskManagerTool } from '../src/tools/core/task-manager';
import { codePlannerTool } from '../src/tools/core/code-planner';
import { scaffoldProjectTool } from '../src/tools/core/scaffold-project';
import { resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';

async function verify() {
  const workDir = resolve('./demo_workspace_manual');
  if (existsSync(workDir)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rmSync } = require('fs');
    rmSync(workDir, { recursive: true, force: true });
  }
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const context: any = { 
    workDir, 
    executionId: 'test-exec',
    agentId: 'test-agent',
    taskId: 'test-task',
    traceId: 'test-trace',
    env: process.env
  };

  console.log('--- 0. Env Check ---');
  console.log('OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? 'Set' : 'Unset');
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Set' : 'Unset');

  console.log('--- 1. Testing Research to Spec ---');
  const res1 = await researchToSpecTool.execute({
    report: "A simple calculator app. Features: Add, Subtract. Tech: Python.",
    projectName: "calculator",
    outputDir: "specs"
  }, context);
  console.log('Research Result:', res1.success);
  if (!res1.success) console.error('Error:', res1.error);

  console.log('--- 2. Testing Scaffold ---');
  const res2 = await scaffoldProjectTool.execute({
    template: 'streamlit',
    projectName: 'calculator',
    outputDir: 'calculator',
    description: 'Simple Calculator'
  }, context);
  console.log('Scaffold Result:', res2.success);
  if (!res2.success) console.error('Error:', res2.error);

  console.log('--- 3. Testing Task Manager (Add) ---');
  // Initialize tasks.md if not exists (research_to_spec should have created it, but let's ensure)
  // research_to_spec creates specs/tasks.md. task_manager reads it.
  const res3 = await taskManagerTool.execute({
    action: 'add_task',
    taskContent: 'Implement add function',
    taskFile: 'specs/tasks.md'
  }, context);
  console.log('Task Add Result:', res3.success);
  if (!res3.success) console.error('Error:', res3.error);

  console.log('--- 4. Testing Task Manager (Read) ---');
  const res4 = await taskManagerTool.execute({
    action: 'read_next',
    taskFile: 'specs/tasks.md' 
  }, context);
  console.log('Task Read Result:', res4.success, res4.data?.task?.title);
  if (!res4.success) console.error('Error:', res4.error);

  console.log('--- 5. Testing Code Planner ---');
  const res5 = await codePlannerTool.execute({
    task: "Implement add function in calculator.py",
    contextDir: "specs",
    fileList: ["calculator/app.py"]
  }, context);
  console.log('Code Planner Result:', res5.success);
  if (res5.success) console.log('Plan:', JSON.stringify(res5.data.plan, null, 2));
  else console.error('Error:', res5.error);
}

verify().catch(console.error);
