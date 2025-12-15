#!/usr/bin/env bun
/**
 * Tachikoma CLI 入口
 *
 * Conversation-first 命令行工具（内部驱动 Orchestrator + WorkerAgent）
 *
 * Usage:
 *   bun run packages/core/bin/tachikoma.ts run --task "任务描述" --workdir ./project
 */

import { parseArgs } from 'util';
import { resolve } from 'node:path';
import { ConversationalRunner } from '../src/conversation/conversational-runner';

// =============================================================================
// 类型定义
// =============================================================================

interface RunOptions {
  task: string;
  workdir: string;
  verbose: boolean;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

// =============================================================================
// 颜色输出
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(icon: string, message: string, color = colors.reset): void {
  console.log(`${color}${icon} ${message}${colors.reset}`);
}

function logSuccess(message: string): void {
  log('✅', message, colors.green);
}

function logError(message: string): void {
  log('❌', message, colors.red);
}

function logInfo(message: string): void {
  log('ℹ️', message, colors.blue);
}

function logWarn(message: string): void {
  log('⚠️', message, colors.yellow);
}

function logStep(message: string): void {
  log('▶️', message, colors.cyan);
}

function compactLine(text: string, maxLen = 160): string {
  const line = text.trim().split('\n')[0] ?? '';
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen)}...`;
}

// =============================================================================
// 命令: run
// =============================================================================

async function runCommand(options: RunOptions): Promise<void> {
  const { task, workdir, verbose, apiKey, baseUrl, model } = options;

  console.log(`
${colors.bold}${colors.cyan}╔════════════════════════════════════════════════════════════╗
║                🤖 Tachikoma (Conversation-first)             ║
╚════════════════════════════════════════════════════════════╝${colors.reset}
`);

  logInfo(`任务: ${colors.bold}${task}${colors.reset}`);
  logInfo(`工作目录: ${workdir}`);

  if (verbose) {
    logInfo('详细模式已启用');
  }

  console.log('');

  // 检查环境变量
  const resolvedApiKey =
    apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!resolvedApiKey) {
    logError('缺少 API Key：请使用 --api-key 或设置 OPENROUTER_API_KEY/OPENAI_API_KEY');
    process.exit(1);
  }

  logSuccess('配置检查通过');
  console.log('');

  try {
    const runner = new ConversationalRunner({
      sessionDir: resolve(workdir, '.tachikoma', 'conversations'),
      workDir: workdir,
      llm: {
        apiKey: resolvedApiKey,
        baseUrl: baseUrl ?? process.env.OPENROUTER_BASE_URL,
        model: model ?? process.env.OPENROUTER_MODEL,
      },
      verbose,
      enableCheckpoints: false,
    });

    const session = await runner.createSession();

    let finalComplete: { success: boolean; summary: string } | null = null;
    let lastError: string | null = null;

    for await (const evt of runner.handleMessage(session.sessionId, task)) {
      switch (evt.type) {
        case 'thinking':
          logStep(compactLine(evt.content, 200));
          break;
        case 'tool_call':
          console.log(`${colors.yellow}  [tool] ${evt.tool}${colors.reset}`);
          break;
        case 'tool_result':
          console.log(
            `${colors.dim}  [tool] ${evt.tool} ${evt.success ? colors.green + '✓' : colors.red + '✗'}${colors.reset}`
          );
          break;
        case 'subtask_complete':
          console.log(
            `${colors.dim}  [subtask] ${evt.subtaskId} ${evt.success ? colors.green + '✓' : colors.red + '✗'}${colors.reset}`
          );
          break;
        case 'need_user_input':
          logWarn(`需要用户输入: ${evt.question}`);
          break;
        case 'complete':
          finalComplete = { success: evt.success, summary: evt.summary };
          if (evt.success) {
            logSuccess(evt.summary);
          } else {
            logError(evt.summary);
          }
          break;
        case 'error':
          lastError = evt.error;
          logError(evt.error);
          break;
      }
    }

    if (finalComplete) {
      if (finalComplete.success) {
        logSuccess('任务执行完成！');
      } else {
        logError('任务执行失败！');
        process.exit(1);
      }
      return;
    }

    if (lastError) {
      logError('任务执行失败！');
      process.exit(1);
    }

    logSuccess('任务执行完成！');
  } catch (error) {
    logError(`任务执行失败: ${error instanceof Error ? error.message : String(error)}`);
    if (verbose && error instanceof Error) {
      console.log(`${colors.dim}${error.stack}${colors.reset}`);
    }
    process.exit(1);
  }
}

// =============================================================================
// 命令: help
// =============================================================================

function showHelp(): void {
  console.log(`
${colors.bold}Tachikoma CLI${colors.reset} - AI 驱动的任务执行工具

${colors.bold}用法:${colors.reset}
  tachikoma <command> [options]

${colors.bold}命令:${colors.reset}
  run         执行任务
  help        显示帮助信息

${colors.bold}选项 (run 命令):${colors.reset}
  --task, -t      任务描述 (必需)
  --workdir, -w   工作目录 (默认: ./workspace)
  --verbose, -v   详细输出
  --api-key       API Key（或设置 OPENROUTER_API_KEY/OPENAI_API_KEY）
  --base-url      自定义端点（可选）
  --model         模型名称（可选）

${colors.bold}示例:${colors.reset}
  bun run packages/core/bin/tachikoma.ts run \\
    --task "帮我实现一个网易云音乐的网站" \\
    --workdir ./my-project

${colors.bold}环境变量:${colors.reset}
  OPENROUTER_API_KEY      OpenRouter API Key (必需)
  OPENROUTER_BASE_URL     API 端点 (默认: https://openrouter.ai/api/v1)
  OPENROUTER_MODEL        模型名称 (默认: openai/gpt-4o)
  TACHIKOMA_LOG_LEVEL     日志级别 (debug|info|warn|error)
`);
}

// =============================================================================
// 主入口
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const command = args[0];

  if (command === 'run') {
    try {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          task: { type: 'string', short: 't' },
          workdir: { type: 'string', short: 'w', default: './workspace' },
          verbose: { type: 'boolean', short: 'v', default: false },
          'api-key': { type: 'string' },
          'base-url': { type: 'string' },
          model: { type: 'string' },
        },
        strict: true,
      });

      if (!values.task) {
        logError('缺少 --task 参数');
        console.log('使用 --help 查看帮助');
        process.exit(1);
      }

      await runCommand({
        task: values.task,
        workdir: values.workdir ?? './workspace',
        verbose: values.verbose ?? false,
        apiKey: values['api-key'],
        baseUrl: values['base-url'],
        model: values.model,
      });
    } catch (error) {
      logError(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    logError(`未知命令: ${command}`);
    console.log('使用 --help 查看帮助');
    process.exit(1);
  }
}

// 运行主函数
main().catch((error) => {
  logError(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
