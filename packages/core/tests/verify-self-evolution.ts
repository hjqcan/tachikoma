/**
 * Self-Evolution 能力验证脚本
 *
 * 验证 Agent 能够动态创建和执行新的 Skill
 *
 * ⚠️ 注意：这是一个手动运行的验证脚本，不是自动化测试
 * - 会写入 ~/.tachikoma/skills 目录
 * - 依赖系统上安装了 Python
 * - 使用 `bun run packages/core/tests/verify-self-evolution.ts` 手动执行
 */

import { createSkillTool } from '../src/tools/core/create-skill';
import { globalToolRegistry } from '../src/tools/registry';
import { defaultRegistry } from '../src/factories/registry';
import { LocalSandbox } from '../src/sandbox/drivers/local';
import type { ExecutionContext } from '../src/types';

// 测试用的简化类型定义
interface ToolExecuteResult {
  success: boolean;
  data?: string;
  error?: string;
}

// 注册 LocalSandbox 用于测试
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

// 创建完整的 ExecutionContext（避免字段缺失导致运行时错误）
function createTestExecutionContext(): ExecutionContext {
  return {
    taskId: 'test-self-evolution',
    agentId: 'test-agent',
    traceId: `trace-${Date.now()}`,
    workDir: process.cwd(),
    env: {},
    permissions: {
      allowed: ['fs:read', 'fs:write', 'shell:exec'],
      denied: [],
      requireSandbox: false,
    },
    resourceLimits: {
      maxFileSize: 10 * 1024 * 1024,
      maxOutputSize: 1024 * 1024,
      maxExecutionTime: 30000,
    },
  };
}

async function testSelfEvolution() {
  console.log('Testing Self-Evolution Capability...\n');
  console.log('⚠️  Warning: This script writes to ~/.tachikoma/skills');
  console.log('⚠️  Warning: Requires Python installed on the system\n');

  const context = createTestExecutionContext();

  // 1. Create a "Hello World" skill
  console.log('1. Creating hello-world skill...');
  const createResult = await createSkillTool.execute(
    {
      name: 'hello-world',
      description: 'A simple skill to greet the user',
      script_content: `import sys
if len(sys.argv) > 1:
    print(f"Hello, {sys.argv[1]}!")
else:
    print("Hello, World!")`,
      filename: 'main.py',
      instructions: 'Usage: hello-world [name]',
    },
    context
  ) as ToolExecuteResult;

  if (!createResult.success) {
    console.error('Failed to create skill:', createResult.error);
    process.exit(1);
  }
  console.log('Skill created:', createResult.data);

  // 2. Verify registration
  console.log('\n2. Verifying registration...');
  const tool = globalToolRegistry.getByName('hello-world');
  if (!tool) {
    console.error('Tool hello-world not found in registry!');
    process.exit(1);
  }
  console.log('Tool found:', tool.name);

  // 3. Execute the new skill
  console.log('\n3. Executing hello-world skill...');
  try {
    const result = (await tool.execute(
      { args: ['Self-Evolution'] },
      context
    )) as ToolExecuteResult;

    if (result.success) {
      console.log('Execution Success:', result.data);
      if (result.data?.trim() === 'Hello, Self-Evolution!') {
        console.log('\n✅ TEST PASSED');
      } else {
        console.error('\n❌ Output mismatch, expected "Hello, Self-Evolution!"');
        process.exit(1);
      }
    } else {
      console.error('Execution Failed:', result.error);
      process.exit(1);
    }
  } catch (err) {
    console.error('Execution Error:', err);
    process.exit(1);
  }
}

// 只在直接运行时执行，避免被 import 时意外执行
if (import.meta.main) {
  testSelfEvolution().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
