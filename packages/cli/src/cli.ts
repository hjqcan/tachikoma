#!/usr/bin/env bun

/**
 * Tachikoma CLI 入口
 */

import { VERSION } from './index';
import { resolve } from 'node:path';
import { ConversationalRunner, type ConversationalRunnerConfig } from '@tachikoma/core';

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
  // 兼容旧参数：当前 ConversationalRunner 会从 Orchestrator 规划结果决定 workerCount
  // 这里仅解析并移除，避免影响任务文本
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

  const runnerConfig: ConversationalRunnerConfig = {
    sessionDir: resolve(workdir, '.tachikoma', 'conversations'),
    workDir: workdir,
    llm: {
      apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? '',
      ...(baseUrl && { baseUrl }),
      ...(model && { model }),
    },
    verbose,
    enableCheckpoints: false,
  };

  if (!runnerConfig.llm.apiKey) {
    console.error('缺少 OpenAI API Key。请使用 --api-key 或设置 OPENAI_API_KEY。');
    return 2;
  }

  if (maxWorkers !== undefined && !Number.isNaN(maxWorkers)) {
    console.warn('[warn] --max-workers 当前未生效（将由规划结果决定 workerCount）');
  }

  const runner = new ConversationalRunner(runnerConfig);
  const session = await runner.createSession();

  let finalSuccess: boolean | null = null;
  for await (const evt of runner.handleMessage(session.sessionId, task)) {
    switch (evt.type) {
      case 'thinking':
        console.log(`[think] ${evt.content}`);
        break;
      case 'tool_call':
        console.log(`[tool] ${evt.tool}`);
        break;
      case 'tool_result':
        console.log(`[tool] ${evt.tool} => ${evt.success ? 'ok' : 'fail'}`);
        break;
      case 'subtask_complete':
        console.log(`[subtask] ${evt.subtaskId} => ${evt.success ? 'ok' : 'fail'}`);
        break;
      case 'need_user_input':
        console.log(`[need] ${evt.question}`);
        finalSuccess = false;
        break;
      case 'complete':
        console.log(`[done] ${evt.success ? 'success' : 'partial/fail'}: ${evt.summary}`);
        finalSuccess = evt.success;
        break;
      case 'error':
        console.error(`[error] ${evt.error}`);
        finalSuccess = false;
        break;
    }
  }

  return finalSuccess ? 0 : 1;
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
