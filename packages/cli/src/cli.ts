#!/usr/bin/env bun

/**
 * Tachikoma CLI 入口
 */

import { VERSION } from './index';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  ChatEngine,
  ConversationalRunner,
  loadEvalSet,
  resolveChatModelConfig,
  runEvalSet,
  type ConversationalRunnerConfig,
  type EvalRunOptions,
} from '@tachikoma/core';

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
Tachikoma CLI v${VERSION}

使用方式:
  tachikoma <command> [options]

命令:
  run         用 pi-mono 编码工具运行任务
  orchestrate 运行旧多智能体编排器
  eval        运行评估集
  help        显示帮助信息

选项:
  -v, --version   显示版本号
  -h, --help      显示帮助信息
  --workdir       指定工作目录
  --provider      anthropic | openai | openai-compatible
  --api-key       指定 API Key
  --base-url      指定 API Base URL
  --model         指定模型
                  run 的 --workdir 是 pi 工具 cwd，目前不是沙盒边界
  --eval-set      评估集 JSON 路径 (eval)
  --report        评估报告输出路径 (eval)
  --case          仅运行指定用例 ID（逗号分隔）(eval)
  --no-approval   禁用审批流程 (orchestrate/eval)

示例:
  tachikoma run "实现用户认证功能"
  tachikoma run --workdir . "为这个仓库跑一遍测试并修复失败"
  tachikoma orchestrate --workdir . "让旧多智能体编排器规划并执行任务"
  tachikoma eval --eval-set ./evals/basic.json --workdir .
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

function compactLine(text: string, maxLength = 240): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}

async function runTask(args: CLIArgs): Promise<number> {
  const workdir = resolve(parseFlagValue(args, '--workdir') ?? process.cwd());
  const provider = parseFlagValue(args, '--provider');
  const apiKey = parseFlagValue(args, '--api-key');
  const baseUrl = parseFlagValue(args, '--base-url');
  const model = parseFlagValue(args, '--model');
  const verbose = hasFlag(args, '--verbose');

  let remaining = args;
  for (const flag of ['--workdir', '--provider', '--api-key', '--base-url', '--model']) {
    remaining = removeFlagWithValue(remaining, flag);
  }
  remaining = removeFlag(remaining, '--verbose');

  const task = remaining.join(' ').trim();
  if (!task) {
    console.error('缺少任务描述。用法：tachikoma run [options] "任务描述"');
    return 2;
  }

  const modelConfig = resolveChatModelConfig({
    ...(provider && { provider }),
    ...(apiKey && { apiKey }),
    ...(baseUrl && { baseUrl }),
    ...(model && { model }),
  });
  const engine = new ChatEngine({
    dataDir: resolve(workdir, '.tachikoma', 'chats'),
    model: modelConfig,
    workDir: workdir,
  });
  const session = await engine.createSession();

  console.log(`[run] ${modelConfig.provider}/${modelConfig.model} @ ${workdir}`);
  let lineOpen = false;
  let failed = false;
  let finishReason: string | undefined;
  const closeLine = (): void => {
    if (!lineOpen) return;
    process.stdout.write('\n');
    lineOpen = false;
  };

  for await (const event of engine.sendMessage(session.sessionId, task)) {
    switch (event.type) {
      case 'message_delta':
        process.stdout.write(event.text);
        lineOpen = true;
        break;
      case 'reasoning_delta':
        if (verbose) {
          closeLine();
          console.log(`[think] ${event.text}`);
        }
        break;
      case 'tool_call':
        closeLine();
        console.log(`[tool] ${event.tool} ${JSON.stringify(event.input)}`);
        break;
      case 'tool_result':
        closeLine();
        console.log(
          `[tool] ${event.tool} => ${event.isError ? 'fail' : 'ok'}${
            verbose || event.isError ? `: ${compactLine(event.output)}` : ''
          }`
        );
        break;
      case 'error':
        closeLine();
        console.error(`[error] ${event.error}`);
        failed = true;
        break;
      case 'message_complete':
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }
  closeLine();

  if (failed || finishReason !== 'stop') {
    if (!failed) console.error(`[error] 任务未正常完成（${finishReason ?? '无完成事件'}）`);
    return 1;
  }
  return 0;
}

async function runOrchestration(args: CLIArgs): Promise<number> {
  const workdir = parseFlagValue(args, '--workdir') ?? process.cwd();
  const verbose = hasFlag(args, '--verbose');
  const noApproval = hasFlag(args, '--no-approval');
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
  remaining = removeFlag(remaining, '--no-approval');

  const task = remaining.join(' ').trim();
  if (!task) {
    console.error('缺少任务描述。用法：tachikoma orchestrate [options] "任务描述"');
    return 2;
  }
  if (noApproval && process.env.NODE_ENV === 'production') {
    console.error('生产环境禁止使用 --no-approval。');
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
    noApproval,
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

async function runEval(args: CLIArgs): Promise<number> {
  const evalSetPath = parseFlagValue(args, '--eval-set');
  if (!evalSetPath) {
    console.error('缺少评估集路径。用法：tachikoma eval --eval-set <path>');
    return 2;
  }

  const workdir = parseFlagValue(args, '--workdir') ?? process.cwd();
  const verbose = hasFlag(args, '--verbose');
  const apiKey = parseFlagValue(args, '--api-key');
  const baseUrl = parseFlagValue(args, '--base-url');
  const model = parseFlagValue(args, '--model');
  const reportPath = parseFlagValue(args, '--report');
  const caseIdsRaw = parseFlagValue(args, '--case');
  const noApproval = hasFlag(args, '--no-approval');

  const caseIds = caseIdsRaw
    ? caseIdsRaw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : undefined;

  const runnerOptions: EvalRunOptions = {
    sessionDir: resolve(workdir, '.tachikoma', 'evals'),
    workDir: workdir,
    llm: {
      apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? '',
      ...(baseUrl && { baseUrl }),
      ...(model && { model }),
    },
    verbose,
    noApproval,
  };

  if (!runnerOptions.llm.apiKey) {
    console.error('缺少 OpenAI API Key。请使用 --api-key 或设置 OPENAI_API_KEY。');
    return 2;
  }

  const evalSetFile = resolve(workdir, evalSetPath);
  const evalSet = await loadEvalSet(evalSetFile);
  const report = await runEvalSet(evalSet, {
    ...runnerOptions,
    ...(caseIds ? { caseIds } : {}),
  });

  console.log(
    `[eval] ${report.name ?? report.evalId} ` +
      `${report.passed}/${report.total} passed, avg=${report.averageScore.toFixed(2)}`
  );

  for (const result of report.results) {
    const status = result.passed ? 'ok' : 'fail';
    console.log(`[case] ${result.caseId} => ${status} (${result.score.toFixed(2)})`);
    if (!result.passed && result.errors.length > 0) {
      console.log(`  - ${result.errors[0]}`);
    }
  }

  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[eval] report saved to ${reportPath}`);
  }

  return report.failed === 0 ? 0 : 1;
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

  if (command === 'orchestrate') {
    runOrchestration(args.slice(1))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
    return;
  }

  if (command === 'eval') {
    runEval(args.slice(1))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
    return;
  }

  console.error(`未知命令 "${command}"。使用 tachikoma help 查看帮助。`);
  process.exitCode = 2;
}

main();
