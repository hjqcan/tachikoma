#!/usr/bin/env bun

/**
 * Tachikoma CLI 入口
 */

import { VERSION } from './index';
import { runMVP, type MVPRunnerConfig } from '@tachikoma/core';

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
Tachikoma CLI v${VERSION}

使用方式:
  tachikoma <command> [options]

命令:
  init        初始化新项目
  run         运行智能体任务
  status      查看任务状态
  help        显示帮助信息

选项:
  -v, --version   显示版本号
  -h, --help      显示帮助信息

示例:
  tachikoma init my-project
  tachikoma run "实现用户认证功能"
  tachikoma run --workdir . --verbose "为这个仓库跑一遍测试并修复失败"
`);
}

/**
 * 显示版本
 */
function showVersion() {
  console.log(`Tachikoma CLI v${VERSION}`);
}

type CLIArgs = string[];

function parseFlagValue(args: CLIArgs, name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: CLIArgs, name: string): boolean {
  return args.includes(name);
}

function removeFlagWithValue(args: CLIArgs, name: string): CLIArgs {
  const idx = args.indexOf(name);
  if (idx === -1) return args;
  const copy = [...args];
  copy.splice(idx, 2);
  return copy;
}

function removeFlag(args: CLIArgs, name: string): CLIArgs {
  const idx = args.indexOf(name);
  if (idx === -1) return args;
  const copy = [...args];
  copy.splice(idx, 1);
  return copy;
}

async function runTask(args: CLIArgs): Promise<number> {
  const workdir = parseFlagValue(args, '--workdir') ?? process.cwd();
  const verbose = hasFlag(args, '--verbose');
  const maxWorkersRaw = parseFlagValue(args, '--max-workers');
  const maxWorkers = maxWorkersRaw ? Number(maxWorkersRaw) : undefined;

  const apiKey = parseFlagValue(args, '--api-key');
  const baseUrl = parseFlagValue(args, '--base-url');
  const model = parseFlagValue(args, '--model');

  let remaining = args;
  for (const flag of ['--workdir', '--max-workers', '--api-key', '--base-url', '--model']) {
    remaining = removeFlagWithValue(remaining, flag);
  }
  remaining = removeFlag(remaining, '--verbose');

  const task = remaining.join(' ').trim();
  if (!task) {
    console.error('缺少任务描述。用法：tachikoma run [options] "任务描述"');
    return 2;
  }

  const config: MVPRunnerConfig = {
    task,
    workdir,
    ...(maxWorkers !== undefined && !Number.isNaN(maxWorkers) && { maxWorkers }),
    verbose,
    ...(apiKey || baseUrl || model
      ? {
          llm: {
            ...(apiKey && { apiKey }),
            ...(baseUrl && { baseUrl }),
            ...(model && { model }),
          },
        }
      : {}),
  };

  const metrics = await runMVP(config, {
    onPlanStart: () => {
      console.log('[plan] start');
    },
    onPlanComplete: (subtasks) => {
      console.log(`[plan] ok: ${subtasks.length} subtasks`);
      for (const s of subtasks) {
        console.log(`  - ${s.id}: ${s.objective}`);
      }
    },
    onWorkerStart: (workerId, subtask) => {
      console.log(`[worker] ${workerId} start: ${subtask.id}`);
    },
    onWorkerThinking: (workerId, content) => {
      if (!verbose) return;
      const line = content.trim().split('\n')[0] ?? '';
      if (line) console.log(`[think] ${workerId}: ${line}`);
    },
    onToolCall: (workerId, tool, _args) => {
      console.log(`[tool] ${workerId}: ${tool}`);
    },
    onToolResult: (workerId, tool, success) => {
      console.log(`[tool] ${workerId}: ${tool} => ${success ? 'ok' : 'fail'}`);
    },
    onComplete: (success, m) => {
      console.log(
        `[done] ${success ? 'success' : 'partial/fail'} ` +
          `subtasks=${m.subtasksCompleted}/${m.subtasksTotal} ` +
          `tokens=${m.tokensUsed} tools=${m.toolCallsTotal} ` +
          `time=${m.totalDuration}ms`
      );
    },
  });

  const success = metrics.subtasksFailed === 0;
  return success ? 0 : 1;
}

/**
 * 主入口
 */
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    showHelp();
    return;
  }

  if (command === '-v' || command === '--version') {
    showVersion();
    return;
  }

  if (command === 'run') {
    runTask(args.slice(1))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
    return;
  }

  // TODO: 实现 init/status 等命令
  console.log(`命令 "${command}" 尚未实现。使用 tachikoma help 查看帮助。`);
}

main();
