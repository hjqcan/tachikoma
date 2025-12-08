#!/usr/bin/env bun
/**
 * Tachikoma CLI 入口
 *
 * MVP 命令行工具，支持任务执行与观测
 *
 * Usage:
 *   bun run packages/core/bin/tachikoma.ts run --task "任务描述" --workdir ./project
 */

import { parseArgs } from 'util';
import { runMVP, type ProgressCallback, type RunMetrics } from '../src/mvp';
import type { SubTask } from '../src/orchestrator/types';

// =============================================================================
// 类型定义
// =============================================================================

interface RunOptions {
  task: string;
  workdir: string;
  workers: number;
  verbose: boolean;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

// =============================================================================
// 命令: run
// =============================================================================

async function runCommand(options: RunOptions): Promise<void> {
  const { task, workdir, workers, verbose } = options;

  console.log(`
${colors.bold}${colors.cyan}╔════════════════════════════════════════════════════════════╗
║                    🤖 Tachikoma MVP                         ║
╚════════════════════════════════════════════════════════════╝${colors.reset}
`);

  logInfo(`任务: ${colors.bold}${task}${colors.reset}`);
  logInfo(`工作目录: ${workdir}`);
  logInfo(`Worker 数量: ${workers}`);

  if (verbose) {
    logInfo('详细模式已启用');
  }

  console.log('');

  // 检查环境变量
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logError('未设置 OPENROUTER_API_KEY 或 OPENAI_API_KEY 环境变量');
    logWarn('请在 .env 文件中配置 API Key');
    process.exit(1);
  }

  logSuccess('环境变量检查通过');
  console.log('');

  // 创建进度回调
  const callbacks: ProgressCallback = {
    onPlanStart: () => {
      logStep('📋 规划任务...');
    },

    onPlanComplete: (subtasks: SubTask[]) => {
      console.log('');
      subtasks.forEach((st, i) => {
        const prefix = i === subtasks.length - 1 ? '└─' : '├─';
        console.log(`${colors.dim}  ${prefix} 子任务 ${i + 1}: ${st.objective}${colors.reset}`);
      });
      console.log('');
      logStep('🚀 执行中...');
      console.log('');
    },

    onWorkerStart: (workerId: string, subtask: SubTask) => {
      console.log(`${colors.cyan}  [${workerId}] 开始: ${subtask.objective}${colors.reset}`);
    },

    onWorkerThinking: (workerId: string, content: string) => {
      if (verbose) {
        const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;
        console.log(`${colors.dim}  [${workerId}] 思考: ${preview}${colors.reset}`);
      }
    },

    onToolCall: (workerId: string, tool: string, args: unknown) => {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? argsStr.substring(0, 50) + '...' : argsStr;
      console.log(`${colors.yellow}  [${workerId}] 工具: ${tool}(${preview})${colors.reset}`);
    },

    onToolResult: (workerId: string, tool: string, success: boolean) => {
      const status = success ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
      console.log(`${colors.dim}  [${workerId}] ${tool} ${status}${colors.reset}`);
    },

    onWorkerComplete: (workerId: string, success: boolean) => {
      if (success) {
        console.log(`${colors.green}  [${workerId}] ✅ 完成${colors.reset}`);
      } else {
        console.log(`${colors.red}  [${workerId}] ❌ 失败${colors.reset}`);
      }
      console.log('');
    },

    onComplete: (success: boolean, metrics: RunMetrics) => {
      console.log('');
      logStep('📊 执行结果');
      console.log('');

      const statusColor = success ? colors.green : colors.red;
      const statusText = success ? 'success' : 'failed';

      console.log(`${colors.dim}  ├─ 状态: ${statusColor}${statusText}${colors.dim}`);
      console.log(`  ├─ 总耗时: ${formatDuration(metrics.totalDuration)}`);
      console.log(`  ├─ 规划耗时: ${formatDuration(metrics.planningDuration)}`);
      console.log(`  ├─ 执行耗时: ${formatDuration(metrics.executionDuration)}`);
      console.log(`  ├─ Token 使用: ${formatNumber(metrics.tokensUsed)}`);
      console.log(`  ├─ 子任务: ${metrics.subtasksCompleted}/${metrics.subtasksTotal} 完成`);
      console.log(`  ├─ 工具调用: ${formatNumber(metrics.toolCallsTotal)} 次`);
      console.log(`  └─ 产出: ${workdir}${colors.reset}`);
      console.log('');
    },

    onError: (error: Error) => {
      logError(`执行错误: ${error.message}`);
      if (verbose) {
        console.log(`${colors.dim}${error.stack}${colors.reset}`);
      }
    },
  };

  try {
    // 运行 MVP
    await runMVP(
      {
        task,
        workdir,
        maxWorkers: workers,
        verbose,
      },
      callbacks
    );

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
  --workers       最大 Worker 数 (默认: 3)
  --verbose, -v   详细输出

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
          workers: { type: 'string', default: '3' },
          verbose: { type: 'boolean', short: 'v', default: false },
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
        workers: parseInt(values.workers ?? '3', 10),
        verbose: values.verbose ?? false,
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
