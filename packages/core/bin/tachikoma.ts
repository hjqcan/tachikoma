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
import { createInterface } from 'node:readline/promises';
import { ConversationalRunner } from '../src/conversation/conversational-runner';
import { createSpecKitFileManager } from '../src/speckit';

// =============================================================================
// 类型定义
// =============================================================================

interface RunOptions {
  task: string;
  workdir: string;
  verbose: boolean;
  noApproval: boolean;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

interface IdeaContextOptions {
  workdir: string;
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
  const { task, workdir, verbose, noApproval, apiKey, baseUrl, model } = options;

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
  if (noApproval) {
    logWarn('审批已禁用（测试模式）');
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
    // IMPORTANT: Resolve workdir to absolute path to prevent execution in wrong directory
    const absoluteWorkDir = resolve(workdir);
    
    const runner = new ConversationalRunner({
      sessionDir: resolve(absoluteWorkDir, '.tachikoma', 'conversations'),
      workDir: absoluteWorkDir,
      llm: {
        apiKey: resolvedApiKey,
        baseUrl: baseUrl ?? process.env.OPENROUTER_BASE_URL,
        model: model ?? process.env.OPENROUTER_MODEL,
      },
      verbose,
      enableCheckpoints: false,
      noApproval,
    });

    const session = await runner.createSession();

    // =========================================================================
    // 审批流处理 (Side-channel)
    //
    // 由于后端在 waitForApproval 时会阻塞 generator，导致事件无法冒泡到 runner。
    // 我们需要通过 SessionFileManager 监控 pending_approval 文件，并通过侧通过道交互。
    // =========================================================================
    
    // 动态导入以避免循环依赖问题
    const { SessionFileManager } = await import('../src/orchestrator/session/session-file-manager');
    const sessionManager = new SessionFileManager(session.sessionId, {
      rootDir: resolve(workdir, '.tachikoma', 'conversations'),
    });
    
    // 追踪已处理的请求，避免重复弹窗
    const handledRequests = new Set<string>();

    const rl = process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : null;

    // Prompt 互斥锁：避免审批轮询和主循环同时调用 rl.question
    let isPrompting = false;
    const withPromptLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      while (isPrompting) {
        await new Promise((r) => setTimeout(r, 100));
      }
      isPrompting = true;
      try {
        return await fn();
      } finally {
        isPrompting = false;
      }
    };

    // approval polling timer
    let approvalPollTimer: ReturnType<typeof setInterval> | null = null;
    let isApproving = false; // 互斥锁，避免轮询重入

    if (rl) {
      approvalPollTimer = setInterval(async () => {
        if (isApproving || isPrompting) return; // 也检查 prompting 状态
        isApproving = true;

        try {
          const workers = await sessionManager.listPeerWorkers();

          for (const workerId of workers) {
            const pending = await sessionManager.readPendingApproval(workerId);
            
            if (pending && !handledRequests.has(pending.requestId)) {
              handledRequests.add(pending.requestId);

              // 打印告警
              console.log('');
              logWarn('🛑 关键决策需要审批');
              logInfo(`工具: ${pending.description}`);
              
              // 安全截断 details 输出（最多 2KB）
              if (pending.details) {
                const detailsStr = JSON.stringify(pending.details, null, 2);
                const truncated = detailsStr.length > 2048 
                  ? detailsStr.slice(0, 2048) + '\n... (truncated)' 
                  : detailsStr;
                console.log(`${colors.dim}${truncated}${colors.reset}`);
              }
              
              // 安全获取 riskLevel（类型保护）
              const riskLevel = pending.details?.metadata?.riskLevel;
              const riskStr = typeof riskLevel === 'string' ? riskLevel.toUpperCase() : 'UNKNOWN';
              console.log(`${colors.yellow}风险等级: ${riskStr}${colors.reset}`);
              
              // 交互询问（通过互斥锁）
              const answer = await withPromptLock(async () =>
                (await rl.question(`${colors.bold}是否批准执行? (y/N) > ${colors.reset}`)).trim()
              );

              const approved = /^(y|yes)$/i.test(answer);
              
              if (approved) {
                logSuccess('已批准');
              } else {
                logError('已拒绝');
              }

              // 写入响应
              await sessionManager.writeApprovalResponse(workerId, {
                requestId: pending.requestId,
                approved,
                respondedBy: 'human',
                respondedAt: Date.now(),
                reason: approved ? 'User approved via CLI' : 'User rejected via CLI',
              });
            }
          }
        } catch (err) {
          // 忽略轮询错误，避免刷屏
        } finally {
          isApproving = false;
        }
      }, 1000); 
    }

    try {
      let nextUserMessage: string | null = task;
      let lastExitCode = 0;
      while (nextUserMessage) {
        let needUserInputQuestion: string | null = null;
        let finalComplete: { success: boolean; summary: string } | null = null;
        let lastError: string | null = null;

        for await (const evt of runner.handleMessage(session.sessionId, nextUserMessage)) {
          switch (evt.type) {
            case 'thinking':
              logStep(`${colors.cyan}[Thinking] ${compactLine(evt.content, 200)}${colors.reset}`);
              break;
            case 'plan_generated': {
              const { subtasks, roles } = evt;
              console.log(`${colors.cyan}  [Plan] Generated ${subtasks.length} subtasks${colors.reset}`);
              if (roles && roles.length > 0) {
                console.log(`${colors.cyan}  [Roles] ${roles.map((r) => `${r.name} (${r.id})`).join(', ')}${colors.reset}`);
                roles.forEach(r => {
                  console.log(`${colors.dim}    - ${r.name}: ${compactLine(r.responsibilities, 100)}${colors.reset}`);
                });
              }
              subtasks.forEach((t, i) => {
                const roleInfo = t.roleId ? ` [${roles?.find(r => r.id === t.roleId)?.name ?? t.roleId}]` : '';
                console.log(`${colors.dim}    ${i + 1}. ${t.objective}${roleInfo}${colors.reset}`);
              });
              break;
            }
            case 'subtask_start':
              console.log(
                `${colors.magenta}  [Subtask Start] ${evt.subtaskId} ${
                  evt.role ? `(${evt.role})` : `[${evt.workerId}]`
                } => ${evt.subtaskObjective}${colors.reset}`
              );
              break;
            case 'tool_call':
              console.log(`${colors.yellow}  [Tool Call] ${evt.tool}${colors.reset}`);
              // 特殊处理 shell_run 命令显示，便于调试死循环
              if (evt.tool === 'shell_run' || evt.tool === 'run_command' || evt.tool === 'execute_command') {
                const cmd = (evt.input as any).command || (evt.input as any).CommandLine || (evt.input as any).cmd;
                if (cmd) {
                   console.log(`${colors.cyan}    $ ${cmd}${colors.reset}`);
                }
              }
              if (verbose) {
                console.log(`${colors.dim}    Args: ${JSON.stringify(evt.input)}${colors.reset}`);
              }
              break;
            case 'tool_result':
              console.log(
                `${colors.dim}  [Tool Result] ${evt.tool} ${
                  evt.success ? colors.green + '✓ Success' : colors.red + '✗ Failed'
                }${colors.reset}`
              );
              // 优先使用 outputPreview（已安全截断）
              if (evt.outputPreview) {
                console.log(`${colors.dim}    Preview: ${evt.outputPreview}${colors.reset}`);
              }
              if (evt.error) {
                console.log(`${colors.red}    Error: ${evt.error}${colors.reset}`);
              }
              // shell 命令特殊处理 stdout/stderr
              if (['shell_run', 'run_command', 'execute_command'].includes(evt.tool)) {
                const data = (evt.result as any)?.data;
                if (data) {
                  if (data.stdout && data.stdout.trim() && !evt.outputPreview) {
                    const out = data.stdout.trim();
                    console.log(
                      `${colors.dim}    stdout: ${
                        out.length > 500 ? out.slice(0, 500) + '...' : out
                      }${colors.reset}`
                    );
                  }
                  if (data.stderr && data.stderr.trim()) {
                    const err = data.stderr.trim();
                    console.log(
                      `${colors.red}    stderr: ${
                        err.length > 500 ? err.slice(0, 500) + '...' : err
                      }${colors.reset}`
                    );
                  }
                }
              }
              break;
            case 'subtask_output':
              // 显示 Agent 的文字输出（任务结果）
              console.log(`${colors.cyan}  [Output] ${evt.subtaskId}${colors.reset}`);
              console.log(`${colors.dim}${evt.content}${colors.reset}`);
              break;
            case 'subtask_complete':
              if (evt.success) {
                console.log(
                  `${colors.magenta}  [Subtask End] ${evt.subtaskId} Completed${colors.reset}`
                );
              } else {
                console.log(
                  `${colors.red}  [Subtask Failed] ${evt.subtaskId} ${
                    evt.error || 'Unknown error'
                  }${colors.reset}`
                );
              }
              break;
            case 'need_user_input':
              needUserInputQuestion = evt.question;
              logWarn(`需要用户输入:\n${evt.question}`);
              break;
            case 'complete':
              finalComplete = { success: evt.success, summary: evt.summary };
              lastExitCode = evt.success ? 0 : 1;
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

        if (lastError) {
          if (!rl) {
            logError('任务执行失败！');
            process.exit(1);
          }
          logWarn('发生错误，你可以继续输入新的指令/补充信息，或输入 exit 退出。');
        }

        if (needUserInputQuestion) {
          if (!rl) {
            logError('当前环境非交互式，无法继续输入。请在交互式终端运行该命令后按提示回答问题。');
            process.exit(2);
          }
          const answer = await withPromptLock(async () => 
            (await rl.question(`${colors.bold}> ${colors.reset}`)).trim()
          );
          if (!answer) {
            logError('未提供回答，已退出。');
            process.exit(2);
          }
          nextUserMessage = answer;
          continue;
        }

        if (finalComplete) {
          if (!rl) {
            if (!finalComplete.success) process.exit(1);
            logSuccess('任务执行完成！');
            return;
          }

          logInfo('请输入下一条指令/任务（或输入 exit 退出）');
          const next = await withPromptLock(async () =>
            (await rl.question(`${colors.bold}> ${colors.reset}`)).trim()
          );
          if (!next || /^(exit|quit|q)$/i.test(next)) {
            if (lastExitCode !== 0) process.exit(lastExitCode);
            return;
          }
          nextUserMessage = next;
          continue;
        }

        // 如果既没有 complete，也没有 need_user_input，也没有 error：
        // 视为正常结束（例如上游未发 complete 事件的兼容情况）
        logSuccess('任务执行完成！');
        return;
      }
    } finally {
      if (approvalPollTimer) clearInterval(approvalPollTimer);
      rl?.close();
    }
  } catch (error) {
    logError(`任务执行失败: ${error instanceof Error ? error.message : String(error)}`);
    if (verbose && error instanceof Error) {
      console.log(`${colors.dim}${error.stack}${colors.reset}`);
    }
    process.exit(1);
  }
}

// =============================================================================
// 命令: speckit
// =============================================================================

async function speckitCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'help';

  if (subcommand === 'help' || subcommand === '--help') {
    console.log(`
${colors.bold}Tachikoma SpecKit${colors.reset} - 面向规范开发工具

${colors.bold}用法:${colors.reset}
  tachikoma speckit <subcommand> [options]

${colors.bold}子命令:${colors.reset}
  init          初始化 SpecKit 目录结构
  help          显示帮助信息

${colors.bold}选项 (init):${colors.reset}
  --workdir, -w   工作目录 (默认: 当前目录)
  --force, -f     强制覆盖已有结构

${colors.bold}示例:${colors.reset}
  tachikoma speckit init --workdir ./my-project
`);
    return;
  }

  if (subcommand === 'init') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        workdir: { type: 'string', short: 'w', default: '.' },
        force: { type: 'boolean', short: 'f', default: false },
      },
      strict: true,
    });

    const workDir = resolve(values.workdir ?? '.');
    const fileManager = createSpecKitFileManager({ workDir });

    const isInitialized = await fileManager.isInitialized();
    if (isInitialized && !values.force) {
      logWarn(`SpecKit 已在 ${workDir} 初始化。使用 --force 可强制重新初始化。`);
      return;
    }

    if (isInitialized && values.force) {
      logWarn(`--force 已启用：将清理并重置 ${fileManager.getRootPath()}`);
      await fileManager.clean();
    }

    await fileManager.init();
    logSuccess(`SpecKit 目录结构已初始化: ${fileManager.getRootPath()}`);
    console.log(`
${colors.dim}目录结构:
  .tachikoma/speckit/
  ├── memory/           # 项目宪法
  ├── specs/            # 功能规范
  └── templates/        # 模板文件
${colors.reset}`);
    return;
  }

  logError(`未知子命令: ${subcommand}`);
  console.log('使用 tachikoma speckit help 查看帮助');
  process.exit(1);
}

// =============================================================================
// 命令: idea (可选工作流，不扰动对话链)
// =============================================================================

function showIdeaHelp(): void {
  console.log(`
${colors.bold}Tachikoma CLI${colors.reset} - idea 工作流（可选，不走对话链）

${colors.bold}用法:${colors.reset}
  tachikoma idea <subcommand> [options]

${colors.bold}子命令:${colors.reset}
  spec        研究报告 → 生成 specs/ (PRD/架构/任务)
  tasks       读取/更新 tasks.md
  plan        基于 specs/ 生成实现计划（LLM）
  help        显示帮助信息

${colors.bold}示例:${colors.reset}
  bun run packages/core/bin/tachikoma.ts idea spec \\
    --report "./report.md" \\
    --project-name "calculator" \\
    --workdir ./my-project
`);
}

function buildIdeaExecutionContext(opts: IdeaContextOptions) {
  const workDir = resolve(opts.workdir);
  const env = {
    ...(process.env as Record<string, string>),
  };
  if (opts.apiKey) {
    // 优先级：CLI 参数 > 环境变量
    env.OPENROUTER_API_KEY = opts.apiKey;
  }
  if (opts.baseUrl) {
    env.OPENROUTER_BASE_URL = opts.baseUrl;
  }
  if (opts.model) {
    env.OPENROUTER_MODEL = opts.model;
  }

  return {
    taskId: `idea-${Date.now()}`,
    agentId: 'tachikoma-cli',
    traceId: `trace-${Date.now()}`,
    workDir,
    env,
  };
}

async function ideaCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showIdeaHelp();
    return;
  }

  if (subcommand === 'spec') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        report: { type: 'string' },
        'project-name': { type: 'string' },
        workdir: { type: 'string', short: 'w', default: './workspace' },
        'output-dir': { type: 'string', default: 'specs' },
        language: { type: 'string', default: 'zh-CN' },
        'api-key': { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
      },
      strict: true,
    });

    if (!values.report || !values['project-name']) {
      logError('缺少 --report 或 --project-name 参数');
      console.log('使用 tachikoma idea help 查看帮助');
      process.exit(1);
    }

    const context = buildIdeaExecutionContext({
      workdir: values.workdir ?? './workspace',
      apiKey: values['api-key'],
      baseUrl: values['base-url'],
      model: values.model,
    });

    // 动态导入：避免把可选工作流工具打进默认对话链路
    const { researchToSpecTool } = await import('../src/tools/core/research-to-spec');

    const result = await researchToSpecTool.execute(
      {
        report: values.report,
        projectName: values['project-name'],
        outputDir: values['output-dir'],
        language: values.language,
        llm: {
          provider: 'openai',
          apiKey: context.env.OPENROUTER_API_KEY || context.env.OPENAI_API_KEY,
          baseUrl: context.env.OPENROUTER_BASE_URL,
          model: context.env.OPENROUTER_MODEL,
        },
      },
      context as any
    );

    if (!result.success) {
      logError(result.error ?? 'research_to_spec failed');
      process.exit(1);
    }

    logSuccess(result.data?.summary ?? 'Generated specs');
    if (result.data) {
      console.log(`${colors.dim}Outputs:${colors.reset}
  - ${result.data.specFile}
  - ${result.data.archFile}
  - ${result.data.taskFile}`);
    }
    return;
  }

  if (subcommand === 'tasks') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        action: { type: 'string' },
        workdir: { type: 'string', short: 'w', default: './workspace' },
        'task-file': { type: 'string' },
        'task-id': { type: 'string' },
        'task-content': { type: 'string' },
      },
      strict: true,
    });

    const action = values.action as string | undefined;
    if (!action) {
      logError('缺少 --action 参数 (read_next|mark_complete|list_all|add_task)');
      process.exit(1);
    }

    const context = buildIdeaExecutionContext({ workdir: values.workdir ?? './workspace' });
    const { taskManagerTool } = await import('../src/tools/core/task-manager');

    const taskId = values['task-id'] ? Number(values['task-id']) : undefined;
    const result = await taskManagerTool.execute(
      {
        action,
        taskFile: values['task-file'],
        ...(taskId !== undefined && Number.isFinite(taskId) ? { taskId } : {}),
        ...(values['task-content'] ? { taskContent: values['task-content'] } : {}),
      },
      context as any
    );

    if (!result.success) {
      logError(result.error ?? 'task_manager failed');
      process.exit(1);
    }

    console.log(result.data?.message ?? 'OK');
    if (result.data?.task) console.log(result.data.task);
    if (result.data?.tasks) console.log(result.data.tasks);
    return;
  }

  if (subcommand === 'plan') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        task: { type: 'string' },
        workdir: { type: 'string', short: 'w', default: './workspace' },
        'context-dir': { type: 'string', default: 'specs' },
        'api-key': { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
      },
      strict: true,
    });

    if (!values.task) {
      logError('缺少 --task 参数');
      process.exit(1);
    }

    const context = buildIdeaExecutionContext({
      workdir: values.workdir ?? './workspace',
      apiKey: values['api-key'],
      baseUrl: values['base-url'],
      model: values.model,
    });

    const { codePlannerTool } = await import('../src/tools/core/code-planner');
    const result = await codePlannerTool.execute(
      {
        task: values.task,
        contextDir: values['context-dir'],
        llm: {
          provider: 'openai',
          apiKey: context.env.OPENROUTER_API_KEY || context.env.OPENAI_API_KEY,
          baseUrl: context.env.OPENROUTER_BASE_URL,
          model: context.env.OPENROUTER_MODEL,
        },
      },
      context as any
    );

    if (!result.success) {
      logError(result.error ?? 'code_planner failed');
      process.exit(1);
    }

    console.log(JSON.stringify(result.data?.plan, null, 2));
    return;
  }

  logError(`未知 idea 子命令: ${subcommand}`);
  console.log('使用 tachikoma idea help 查看帮助');
  process.exit(1);
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
  speckit     面向规范开发工具
  idea        idea 工作流（可选）
  help        显示帮助信息

${colors.bold}选项 (run 命令):${colors.reset}
  --task, -t        任务描述 (必需)
  --workdir, -w     工作目录 (默认: ./workspace)
  --verbose, -v     详细输出
  --auto-approve    自动批准所有操作（测试模式，生产环境禁用）
  --no-approval     --auto-approve 的别名
  --api-key         API Key（或设置 OPENROUTER_API_KEY/OPENAI_API_KEY）
  --base-url        自定义端点（可选）
  --model           模型名称（可选）

${colors.bold}示例:${colors.reset}
  bun run packages/core/bin/tachikoma.ts run \\
    --task "帮我实现一个网易云音乐的网站" \\
    --workdir ./my-project

  bun run packages/core/bin/tachikoma.ts speckit init --workdir ./my-project

  bun run packages/core/bin/tachikoma.ts idea spec \\
    --report "./report.md" \\
    --project-name "calculator" \\
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
          'no-approval': { type: 'boolean', default: false },
          'auto-approve': { type: 'boolean', default: false }, // 别名
          'api-key': { type: 'string' },
          'base-url': { type: 'string' },
          model: { type: 'string' },
        },
        strict: true,
      });

      // 合并 --no-approval 和 --auto-approve
      const autoApprove = values['no-approval'] || values['auto-approve'];

      // 生产环境保护
      if (autoApprove && process.env.NODE_ENV === 'production') {
        logError('在生产环境中禁止使用 --no-approval/--auto-approve');
        process.exit(1);
      }

      if (!values.task) {
        logError('缺少 --task 参数');
        console.log('使用 --help 查看帮助');
        process.exit(1);
      }

      await runCommand({
        task: values.task,
        workdir: values.workdir ?? './workspace',
        verbose: values.verbose ?? false,
        noApproval: autoApprove,
        apiKey: values['api-key'],
        baseUrl: values['base-url'],
        model: values.model,
      });
    } catch (error) {
      logError(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else if (command === 'speckit') {
    await speckitCommand(args.slice(1));
  } else if (command === 'idea') {
    await ideaCommand(args.slice(1));
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
