/**
 * SpecKit Basic Example
 *
 * Demonstrates basic usage of SpecKit for Spec-Driven Development
 *
 * Run with: bun run packages/core/src/speckit/examples/basic-usage.ts
 */

import { createSpecKitFileManager, SpecKitWorkflow } from '../index';
import { createLLMClient } from '../../planner/llm-client';

async function main() {
  console.log('🚀 SpecKit Basic Usage Example\n');

  // Check for API key
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ Please set OPENROUTER_API_KEY or OPENAI_API_KEY environment variable');
    process.exit(1);
  }

  // Create LLM client
  const llmConfig: Parameters<typeof createLLMClient>[0] = {
    provider: 'openai',
    apiKey,
    model: process.env.OPENROUTER_MODEL || 'gpt-4o',
    maxTokens: 4096,
  };
  if (process.env.OPENROUTER_BASE_URL) {
    llmConfig.baseUrl = process.env.OPENROUTER_BASE_URL;
  }
  const llmClient = createLLMClient(llmConfig);

  // Create file manager in a temp directory
  const workDir = '/tmp/speckit-example';
  const fileManager = createSpecKitFileManager({ workDir });

  console.log(`📁 Work directory: ${workDir}`);

  // Initialize SpecKit
  await fileManager.init();
  console.log('✅ SpecKit initialized\n');

  // Create workflow
  const workflow = new SpecKitWorkflow({ llmClient, fileManager });

  // Step 1: Create Constitution
  console.log('📜 Creating project constitution...');
  const constitutionResult = await workflow.constitution(`
    This is a TypeScript CLI tool project.
    We follow clean code principles.
    We use comprehensive error handling.
  `);

  if (constitutionResult.success) {
    console.log(`✅ Constitution created: ${constitutionResult.filePath}`);
  } else {
    console.error(`❌ Failed: ${constitutionResult.error}`);
  }

  // Step 2: Create Specification
  console.log('\n📋 Creating feature specification...');
  const specResult = await workflow.specify(`
    Add a "hello" command that:
    - Accepts a --name flag
    - Prints a greeting message
    - Supports --loud flag to uppercase output
  `);

  if (specResult.success && specResult.data) {
    console.log(`✅ Specification created: ${specResult.filePath}`);
    console.log(`   Spec ID: ${specResult.data.id}`);
    console.log(`   Name: ${specResult.data.name}`);

    const specId = specResult.data.id;

    // Step 3: Create Plan
    console.log('\n📝 Creating implementation plan...');
    const planResult = await workflow.plan(
      specId,
      'Use commander.js for CLI, TypeScript, and Jest for testing'
    );

    if (planResult.success) {
      console.log(`✅ Plan created: ${planResult.filePath}`);
    } else {
      console.error(`❌ Failed: ${planResult.error}`);
    }

    // Step 4: Create Tasks
    console.log('\n📦 Creating task breakdown...');
    const tasksResult = await workflow.tasks(specId);

    if (tasksResult.success && tasksResult.data) {
      console.log(`✅ Tasks created: ${tasksResult.filePath}`);
      console.log(`   Total tasks: ${tasksResult.data.tasks.length}`);

      // List tasks
      console.log('\n📋 Tasks:');
      for (const task of tasksResult.data.tasks) {
        const status = task.status === 'done' ? '✅' : '⬜';
        console.log(`   ${status} ${task.title}`);
      }
    } else {
      console.error(`❌ Failed: ${tasksResult.error}`);
    }

    // Show workflow status
    console.log('\n📊 Workflow Status:');
    const status = await workflow.getStatus(specId);
    console.log(`   Constitution: ${status.hasConstitution ? '✅' : '❌'}`);
    console.log(`   Specification: ${status.hasSpec ? '✅' : '❌'}`);
    console.log(`   Plan: ${status.hasPlan ? '✅' : '❌'}`);
    console.log(`   Tasks: ${status.hasTasks ? '✅' : '❌'}`);
  } else {
    console.error(`❌ Failed to create specification: ${specResult.error}`);
  }

  console.log('\n🎉 Example completed!');
  console.log(`📁 Check output in: ${workDir}/.tachikoma/speckit/`);
}

main().catch(console.error);
