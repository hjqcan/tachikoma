/**
 * 真实 API 冒烟（螺旋第一/二圈退出标准之一，见 docs/tachikoma-spiral-roadmap.md）
 *
 * 门控语义：本地存在 OPENAI_API_KEY + OPENAI_BASE_URL（bun 自动加载根 .env）时运行，
 * CI 无凭证自动跳过；设 TACHIKOMA_SKIP_REAL_API=1 可显式关闭。
 * 覆盖 mock 测不到的真实行为：流式时延与增量、真网中断、pi 工具循环端到端。
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine, resolveChatModelConfig } from '../src/chat';
import type { ChatFinishReason, ChatUsage } from '../src/chat';

const HAS_REAL_API =
  Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) &&
  process.env.TACHIKOMA_SKIP_REAL_API !== '1';

const describeReal = HAS_REAL_API ? describe : describe.skip;

interface ScenarioSummary {
  firstDeltaMs: number | null;
  deltaCount: number;
  text: string;
  finishReason: ChatFinishReason | null;
  usage: ChatUsage | null;
  errors: string[];
  toolCalls: { tool: string; callId: string }[];
  toolResults: { tool: string; isError: boolean; output: string }[];
}

async function collect(
  engine: ChatEngine,
  sessionId: string,
  prompt: string,
  onDelta?: (summary: ScenarioSummary) => void
): Promise<ScenarioSummary> {
  const started = Date.now();
  const summary: ScenarioSummary = {
    firstDeltaMs: null,
    deltaCount: 0,
    text: '',
    finishReason: null,
    usage: null,
    errors: [],
    toolCalls: [],
    toolResults: [],
  };
  const signal = AbortSignal.timeout(90_000);
  for await (const event of engine.sendMessage(sessionId, prompt, { signal })) {
    switch (event.type) {
      case 'message_delta':
        if (summary.firstDeltaMs === null) summary.firstDeltaMs = Date.now() - started;
        summary.deltaCount += 1;
        summary.text += event.text;
        onDelta?.(summary);
        break;
      case 'tool_call':
        summary.toolCalls.push({ tool: event.tool, callId: event.callId });
        break;
      case 'tool_result':
        summary.toolResults.push({
          tool: event.tool,
          isError: event.isError,
          output: event.output,
        });
        break;
      case 'message_complete':
        summary.finishReason = event.finishReason;
        summary.usage = event.usage ?? null;
        break;
      case 'error':
        summary.errors.push(event.error);
        break;
      default:
        break;
    }
  }
  return summary;
}

function makeEngine(extra: { workDir?: string } = {}): ChatEngine {
  return new ChatEngine({
    dataDir: mkdtempSync(join(tmpdir(), 'tachikoma-real-api-')),
    model: resolveChatModelConfig(),
    ...extra,
  });
}

describeReal('真实 API 冒烟（网络门控）', () => {
  test(
    '流式对话：token 级增量 + finishReason stop + usage 回传',
    async () => {
      const engine = makeEngine();
      const session = await engine.createSession();
      const summary = await collect(engine, session.sessionId, '请用一句话介绍你自己。');

      expect(summary.errors).toEqual([]);
      expect(summary.deltaCount).toBeGreaterThan(1);
      expect(summary.firstDeltaMs).not.toBeNull();
      expect(summary.text.length).toBeGreaterThan(0);
      expect(summary.finishReason).toBe('stop');
      expect(summary.usage?.totalTokens ?? 0).toBeGreaterThan(0);
    },
    120_000
  );

  test(
    '真网中断：interrupt() 停止生成，半成品持久化并打 interrupted 标记',
    async () => {
      const engine = makeEngine();
      const session = await engine.createSession();
      const summary = await collect(
        engine,
        session.sessionId,
        '请从 1 数到 500，每个数字单独一行，不要省略。',
        (progress) => {
          if (progress.deltaCount === 1) {
            expect(engine.interrupt(session.sessionId)).toBe(true);
          }
        }
      );

      expect(summary.errors).toEqual([]);
      expect(summary.finishReason).toBe('interrupted');

      const persisted = await engine.openSession(session.sessionId);
      const interruptedEntry = persisted?.transcript.some(
        (entry) => entry.message.role === 'assistant' && entry.interrupted === true
      );
      expect(interruptedEntry).toBe(true);
    },
    120_000
  );

  test(
    '工具循环端到端：真实模型调用 pi read 工具并回传文件内容',
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'tachikoma-real-tools-'));
      writeFileSync(join(workDir, 'hello.txt'), '标记：TACHIKOMA_SMOKE_MARKER_7734\n');

      const engine = makeEngine({ workDir });
      const session = await engine.createSession();
      const summary = await collect(
        engine,
        session.sessionId,
        '请读取当前工作目录下 hello.txt 的内容，并把其中的标记原样告诉我。'
      );

      expect(summary.errors).toEqual([]);
      expect(summary.toolCalls.length).toBeGreaterThan(0);
      expect(summary.toolResults.some((result) => !result.isError)).toBe(true);
      expect(summary.text).toContain('TACHIKOMA_SMOKE_MARKER_7734');
      expect(summary.finishReason).toBe('stop');
    },
    120_000
  );
});
