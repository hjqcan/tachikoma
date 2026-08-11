#!/usr/bin/env bun
/**
 * 对话质量 eval（螺旋第一圈退出标准，见 docs/tachikoma-spiral-roadmap.md）
 *
 * 维度：指令遵循 / 语言一致性 / 记忆准确度（跨会话真实闭环）。
 * 全部确定性判分——不依赖裁判模型；显式运行、真实网络：
 *   bun run eval:chat
 * 模型来源：TACHIKOMA_LIVE_PROVIDER/TACHIKOMA_LIVE_MODEL（缺省回落
 * TACHIKOMA_PROVIDER/TACHIKOMA_MODEL）；自定义端点经 TACHIKOMA_LIVE_MODELS_JSON
 * （缺省 ~/.tachikoma/models.json）拷入临时 dataDir，绝不触碰真实用户数据。
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatModelRef, ChatSession } from '../src';

interface CaseResult {
  dimension: string;
  name: string;
  pass: boolean;
  detail: string;
}

function evalModel(): ChatModelRef {
  const provider = process.env.TACHIKOMA_LIVE_PROVIDER ?? process.env.TACHIKOMA_PROVIDER;
  const model = process.env.TACHIKOMA_LIVE_MODEL ?? process.env.TACHIKOMA_MODEL;
  if (!provider || !model) {
    throw new Error(
      '需要 TACHIKOMA_LIVE_PROVIDER/TACHIKOMA_LIVE_MODEL（或 TACHIKOMA_PROVIDER/TACHIKOMA_MODEL）。'
    );
  }
  return { provider, model };
}

async function evalDataDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const source =
    process.env.TACHIKOMA_LIVE_MODELS_JSON ?? join(homedir(), '.tachikoma', 'models.json');
  try {
    await copyFile(source, join(dataDir, 'models.json'));
  } catch {
    // 无自定义模型文件时走 pi 内建 catalog。
  }
  return dataDir;
}

async function answer(session: ChatSession, prompt: string): Promise<string> {
  let content = '';
  for await (const event of session.send(prompt, { signal: AbortSignal.timeout(90_000) })) {
    if (event.type === 'message_complete') {
      if (event.status !== 'success') {
        throw new Error(`回合未成功：${event.status}${event.error ? ` (${event.error})` : ''}`);
      }
      content = event.content;
    }
  }
  return content;
}

function cjkRatio(text: string): number {
  const chars = [...text.replace(/\s/gu, '')];
  if (chars.length === 0) return 0;
  const cjk = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  return cjk / chars.length;
}

async function runInstructionCases(model: ChatModelRef): Promise<CaseResult[]> {
  const dataDir = await evalDataDir('tachikoma-eval-instr-');
  const results: CaseResult[] = [];
  try {
    const engine = new ChatEngine({ dataDir, model, memory: false });
    const cases: { name: string; prompt: string; check: (text: string) => [boolean, string] }[] = [
      {
        name: '精确输出约束',
        prompt: '回复中只输出这四个字：确认收到。不要任何其他内容。',
        check: (text) => {
          const trimmed = text.trim().replace(/[。.!！]$/u, '');
          return [trimmed === '确认收到', `got=${JSON.stringify(text.trim())}`];
        },
      },
      {
        name: '数量与格式约束',
        prompt: '列出恰好三个中国城市，每行一个，不要编号，不要任何解释或其他文字。',
        check: (text) => {
          const lines = text
            .trim()
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          const clean = lines.every((line) => line.length <= 12 && !/^\d|^[-*•]/u.test(line));
          return [lines.length === 3 && clean, `lines=${JSON.stringify(lines)}`];
        },
      },
      {
        name: '指定语言与简短性',
        prompt: 'Answer in English with the city name only: what is the capital of France?',
        check: (text) => {
          const trimmed = text.trim();
          return [
            /paris/iu.test(trimmed) && trimmed.split(/\s+/u).length <= 3,
            `got=${JSON.stringify(trimmed)}`,
          ];
        },
      },
    ];
    for (const testCase of cases) {
      const session = await engine.createSession();
      try {
        const text = await answer(session, testCase.prompt);
        const [pass, detail] = testCase.check(text);
        results.push({ dimension: '指令遵循', name: testCase.name, pass, detail });
      } catch (error) {
        results.push({
          dimension: '指令遵循',
          name: testCase.name,
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await session.close();
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  return results;
}

async function runLanguageCases(model: ChatModelRef): Promise<CaseResult[]> {
  const dataDir = await evalDataDir('tachikoma-eval-lang-');
  const results: CaseResult[] = [];
  try {
    const engine = new ChatEngine({ dataDir, model, memory: false });
    const cases: { name: string; prompt: string; check: (text: string) => [boolean, string] }[] = [
      {
        name: '中文问题得中文回答',
        prompt: '用两三句话介绍一下什么是垃圾回收。',
        check: (text) => {
          const ratio = cjkRatio(text);
          return [ratio > 0.3, `cjkRatio=${ratio.toFixed(2)}`];
        },
      },
      {
        name: '英文问题得英文回答',
        prompt: 'In one sentence, explain what garbage collection is.',
        check: (text) => {
          const ratio = cjkRatio(text);
          return [ratio < 0.05, `cjkRatio=${ratio.toFixed(2)}`];
        },
      },
    ];
    for (const testCase of cases) {
      const session = await engine.createSession();
      try {
        const text = await answer(session, testCase.prompt);
        const [pass, detail] = testCase.check(text);
        results.push({ dimension: '语言一致性', name: testCase.name, pass, detail });
      } catch (error) {
        results.push({
          dimension: '语言一致性',
          name: testCase.name,
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await session.close();
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  return results;
}

async function runMemoryCases(model: ChatModelRef): Promise<CaseResult[]> {
  const dataDir = await evalDataDir('tachikoma-eval-mem-');
  const results: CaseResult[] = [];
  try {
    // 隔离的记忆库与 userId——绝不写入真实 ~/.tachikoma 记忆。
    const engine = new ChatEngine({
      dataDir,
      model,
      memory: {
        databasePath: join(dataDir, 'memory', 'eval.sqlite'),
        userId: `eval-${Math.random().toString(36).slice(2, 10)}`,
      },
    });

    const teach = await engine.createSession();
    try {
      await answer(teach, '请记住两件事：我最喜欢的编辑器是 Neovim；我的项目代号是 Tachikoma。');
    } finally {
      await teach.close();
    }

    const probes: { name: string; prompt: string; expect: RegExp }[] = [
      {
        name: '跨会话事实回忆（编辑器）',
        prompt: '我最喜欢的编辑器是什么？直接告诉我名字。',
        expect: /neovim/iu,
      },
      {
        name: '跨会话事实回忆（项目代号）',
        prompt: '我的项目代号是什么？直接告诉我。',
        expect: /tachikoma/iu,
      },
    ];
    for (const probe of probes) {
      const session = await engine.createSession();
      try {
        const text = await answer(session, probe.prompt);
        results.push({
          dimension: '记忆准确度',
          name: probe.name,
          pass: probe.expect.test(text),
          detail: `got=${JSON.stringify(text.slice(0, 60))}`,
        });
      } catch (error) {
        results.push({
          dimension: '记忆准确度',
          name: probe.name,
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await session.close();
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  return results;
}

const model = evalModel();
const started = Date.now();
const results = [
  ...(await runInstructionCases(model)),
  ...(await runLanguageCases(model)),
  ...(await runMemoryCases(model)),
];

const dimensions = new Map<string, { pass: number; total: number }>();
for (const result of results) {
  const entry = dimensions.get(result.dimension) ?? { pass: 0, total: 0 };
  entry.total += 1;
  if (result.pass) entry.pass += 1;
  dimensions.set(result.dimension, entry);
}

console.log(
  `\n对话质量 eval —— ${model.provider}/${model.model}（${((Date.now() - started) / 1000).toFixed(1)}s）\n`
);
for (const result of results) {
  console.log(
    `  ${result.pass ? '✅' : '❌'} [${result.dimension}] ${result.name}  ${result.pass ? '' : result.detail}`
  );
}
console.log('');
let overallPass = 0;
for (const [dimension, { pass, total }] of dimensions) {
  console.log(`  ${dimension}: ${pass}/${total}`);
  overallPass += pass;
}
console.log(`  总计: ${overallPass}/${results.length}\n`);

const reportDir = join(import.meta.dir, 'reports');
await mkdir(reportDir, { recursive: true });
const reportPath = join(
  reportDir,
  `chat-quality-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`
);
await writeFile(
  reportPath,
  JSON.stringify(
    {
      model,
      finishedAt: new Date().toISOString(),
      dimensions: Object.fromEntries(dimensions),
      results,
    },
    null,
    2
  )
);
console.log(`报告：${reportPath}`);
