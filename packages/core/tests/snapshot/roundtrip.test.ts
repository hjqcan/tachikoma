/**
 * 快照流水线离线自测 —— 不依赖任何已录制 fixture。
 *
 * 用 faux 脚本跑一遍"录制"（真引擎产出 pi 转录），把转录 token 化再喂回
 * 第二个 faux 引擎"回放"，两遍投影必须相等；篡改转录必须导致响亮差异；
 * 录制哨兵必须拒收异常形态。这条链证明 转换器/归一化/运行器 三件套，
 * 与是否录过 live 无关。
 */

import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';

import { ChatEngine } from '../../src';
import type { ChatEvent } from '../../src';
import { createFauxHarness } from '../helpers';
import type { FauxHarness } from '../helpers';
import {
  WORKSPACE_TOKEN,
  createScenarioWorkspace,
  projectScenarioEvents,
  readSessionTranscript,
  replacePaths,
  runScenarioTurns,
  transcriptToFauxSteps,
  validateRecording,
} from './support';
import type { ScenarioWorkspace, SnapshotScenario } from './support';

const SCENARIO: SnapshotScenario = {
  name: 'roundtrip-read',
  toolset: 'read-only',
  workspaceFixture: 'read-tool',
  turns: ['Read data.txt and report the marker.'],
};

function fauxEngine(harness: FauxHarness): ChatEngine {
  return new ChatEngine(
    {
      dataDir: harness.dataDir,
      model: { provider: harness.faux.provider.id, model: 'chat' },
      memory: false,
    },
    { modelRuntime: harness.modelRuntime }
  );
}

function tokenize(transcript: string, workspace: ScenarioWorkspace): string {
  return replacePaths(transcript, [
    { from: workspace.root, to: WORKSPACE_TOKEN },
    { from: workspace.rawRoot, to: WORKSPACE_TOKEN },
  ]);
}

/** 录制形态的第一遍：faux 脚本驱动，返回 token 化转录与投影 */
async function recordPass(): Promise<{ transcript: string; projected: unknown }> {
  const harness = await createFauxHarness();
  const workspace = await createScenarioWorkspace(SCENARIO);
  try {
    harness.faux.setResponses([
      fauxAssistantMessage(
        [fauxThinking('need to read the file'), fauxToolCall('read', { path: 'data.txt' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage([fauxText('The marker is TACHIKOMA-SNAPSHOT-7739.')]),
    ]);
    const events = await runScenarioTurns(fauxEngine(harness), SCENARIO, workspace.root);
    validateRecording(SCENARIO, events);
    return {
      transcript: tokenize(await readSessionTranscript(harness.dataDir), workspace),
      projected: projectScenarioEvents(events, workspace),
    };
  } finally {
    await workspace.cleanup();
    await harness.cleanup();
  }
}

/** 回放形态的第二遍：转录 → faux steps → 新工作区重跑，返回投影 */
async function replayPass(transcript: string): Promise<unknown> {
  const harness = await createFauxHarness();
  const workspace = await createScenarioWorkspace(SCENARIO);
  try {
    const steps = transcriptToFauxSteps(
      replacePaths(transcript, [{ from: WORKSPACE_TOKEN, to: workspace.root }])
    );
    harness.faux.setResponses(steps);
    const events = await runScenarioTurns(fauxEngine(harness), SCENARIO, workspace.root);
    return projectScenarioEvents(events, workspace);
  } finally {
    await workspace.cleanup();
    await harness.cleanup();
  }
}

describe('快照流水线 roundtrip 自测', () => {
  it('录制 → token 化 → 回放：两遍投影逐字节相等', async () => {
    const recorded = await recordPass();
    const replayed = await replayPass(recorded.transcript);
    expect(replayed).toEqual(recorded.projected);
  });

  it('篡改转录中的 assistant 文本 → 回放投影响亮偏离', async () => {
    const recorded = await recordPass();
    // replaceAll：转录里 marker 同时出现在 toolResult 行（回放不读，工具真实执行）
    // 与 assistant 文本行（回放脚本）——篡改必须打中后者才构成真实偏离。
    const tampered = recorded.transcript.replaceAll(
      'TACHIKOMA-SNAPSHOT-7739',
      'TAMPERED-MARKER-0000'
    );
    expect(tampered).not.toBe(recorded.transcript);
    const replayed = await replayPass(tampered);
    expect(replayed).not.toEqual(recorded.projected);
  });

  it('损坏转录行（非法 JSON）→ 转换器响亮失败', async () => {
    const recorded = await recordPass();
    const lines = recorded.transcript.trim().split('\n');
    const corrupted = [...lines.slice(0, -1), '{broken json'].join('\n');
    expect(() => transcriptToFauxSteps(corrupted)).toThrow('not valid JSON');
  });

  it('录制哨兵拒收 isError tool_result 与非 success 终结', () => {
    const base = { sessionId: 's', turnId: 't', timestamp: 0 };
    const errorResult: ChatEvent[] = [
      { ...base, type: 'tool_result', callId: 'c', tool: 'read', output: 'boom', isError: true },
    ];
    expect(() => validateRecording(SCENARIO, errorResult)).toThrow('rejected');
    expect(() =>
      validateRecording({ ...SCENARIO, allowToolErrors: true }, errorResult)
    ).not.toThrow();

    const failedComplete: ChatEvent[] = [
      {
        ...base,
        type: 'message_complete',
        messageId: 'm',
        status: 'failed',
        content: '',
        model: { provider: 'p', model: 'm' },
        stopReason: 'error',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        error: 'x',
      },
    ];
    expect(() => validateRecording(SCENARIO, failedComplete)).toThrow('rejected');
  });
});
