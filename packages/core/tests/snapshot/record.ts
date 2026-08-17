/**
 * 快照录制脚本（唯一可触网的一环，显式开关）：
 *
 *   TACHIKOMA_RUN_LIVE_TESTS=1 TACHIKOMA_LIVE_PROVIDER=… TACHIKOMA_LIVE_MODEL=… \
 *     bun run snapshot:record [场景名…]
 *
 * 对每个场景：临时 dataDir 真跑全部回合 → 录制哨兵验收（非 success 终结、
 * 未声明的 isError tool_result 一律拒收）→ 转录路径 token 化落
 * fixtures/<场景>/transcript.jsonl → 归一化期望落 events.expected.json。
 *
 * 录完后：把场景从 STAGED_SCENARIOS 移入 SNAPSHOT_SCENARIOS，并人工审查
 * fixture diff —— 快照刷新是 fixture 生产，不是正确性审查。
 */

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../../src';
import { SNAPSHOT_SCENARIOS, STAGED_SCENARIOS, findScenario } from './scenarios';
import { realpath } from 'node:fs/promises';

import {
  WORKSPACE_TOKEN,
  createScenarioWorkspace,
  projectScenarioEvents,
  readSessionTranscript,
  replacePaths,
  runScenarioTurns,
  validateRecording,
  writeFixture,
} from './support';

/** 与 eval:chat 同一约定：LIVE_* 缺省回落 TACHIKOMA_PROVIDER/MODEL；开关必须显式 */
function liveGate(): { provider: string; model: string } {
  const enabled = process.env.TACHIKOMA_RUN_LIVE_TESTS === '1';
  const provider = process.env.TACHIKOMA_LIVE_PROVIDER ?? process.env.TACHIKOMA_PROVIDER;
  const model = process.env.TACHIKOMA_LIVE_MODEL ?? process.env.TACHIKOMA_MODEL;
  if (!enabled || !provider || !model) {
    console.error(
      'snapshot:record needs the explicit live opt-in: TACHIKOMA_RUN_LIVE_TESTS=1 plus ' +
        'TACHIKOMA_LIVE_PROVIDER/TACHIKOMA_LIVE_MODEL (or TACHIKOMA_PROVIDER/TACHIKOMA_MODEL). ' +
        'A credential in .env alone is not enough.'
    );
    process.exit(1);
  }
  return { provider, model };
}

async function recordScenario(name: string, model: { provider: string; model: string }) {
  const scenario = findScenario(name);
  if (!scenario) {
    throw new Error(`Unknown snapshot scenario: ${name}`);
  }
  const dataDir = await mkdtemp(join(tmpdir(), `tachikoma-snapshot-record-`));
  const modelsJson =
    process.env.TACHIKOMA_LIVE_MODELS_JSON ?? join(homedir(), '.tachikoma', 'models.json');
  if (existsSync(modelsJson)) {
    await copyFile(modelsJson, join(dataDir, 'models.json'));
  }
  const workspace = await createScenarioWorkspace(scenario);
  try {
    const engine = new ChatEngine({ dataDir, model, memory: false });
    const events = await runScenarioTurns(engine, scenario, workspace.root);
    validateRecording(scenario, events);
    // dataDir 也 token 化：转录 session 行的 cwd 会带上它；回放不读该行，
    // 但 fixture 落盘不得携带任何录制机的绝对路径。
    const transcript = replacePaths(await readSessionTranscript(dataDir), [
      { from: workspace.root, to: WORKSPACE_TOKEN },
      { from: workspace.rawRoot, to: WORKSPACE_TOKEN },
      { from: await realpath(dataDir), to: '{{data}}' },
      { from: dataDir, to: '{{data}}' },
    ]);
    await writeFixture(scenario.name, {
      transcript,
      expected: projectScenarioEvents(events, workspace),
    });
    console.log(`recorded: ${scenario.name}`);
  } finally {
    await workspace.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const model = liveGate();
const requested = process.argv.slice(2);
const names =
  requested.length > 0
    ? requested
    : [...SNAPSHOT_SCENARIOS, ...STAGED_SCENARIOS].map((scenario) => scenario.name);
for (const name of names) {
  await recordScenario(name, model);
}
console.log(
  '\nReview the fixture diffs before committing — a recording is fixture production, not\n' +
    'correctness review. Newly recorded scenarios must move from STAGED_SCENARIOS into\n' +
    'SNAPSHOT_SCENARIOS (tests/snapshot/scenarios.ts) so replay picks them up.'
);
