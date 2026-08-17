/**
 * 快照回放 —— 默认离线套件的整机行为回归。
 *
 * 对每个已录制场景：fixture 转录喂回 faux provider，真引擎重跑全部回合
 * （工具真实执行、审批按场景表应答），归一化投影与 events.expected.json 深比对。
 * 场景表与 fixtures/ 目录必须双向一致：录了没入表、入表没录，都响亮失败——
 * 没有静默跳过。
 */

import { describe, expect, it } from 'bun:test';

import { ChatEngine } from '../../src';
import { createFauxHarness } from '../helpers';
import { SNAPSHOT_SCENARIOS } from './scenarios';
import {
  WORKSPACE_TOKEN,
  createScenarioWorkspace,
  listFixtures,
  projectScenarioEvents,
  readFixture,
  replacePaths,
  runScenarioTurns,
  transcriptToFauxSteps,
} from './support';

describe('快照回放', () => {
  it('场景表与 fixtures 目录双向一致（录了才入表，入表必有录）', async () => {
    const recorded = await listFixtures();
    const listed = [...SNAPSHOT_SCENARIOS].map((scenario) => scenario.name).sort();
    expect(recorded).toEqual(listed);
  });

  it('每个已录制场景回放后投影与期望一致', async () => {
    for (const scenario of SNAPSHOT_SCENARIOS) {
      const fixture = await readFixture(scenario.name);
      const harness = await createFauxHarness();
      const workspace = await createScenarioWorkspace(scenario);
      try {
        harness.faux.setResponses(
          transcriptToFauxSteps(
            replacePaths(fixture.transcript, [{ from: WORKSPACE_TOKEN, to: workspace.root }])
          )
        );
        const engine = new ChatEngine(
          {
            dataDir: harness.dataDir,
            model: { provider: harness.faux.provider.id, model: 'chat' },
            memory: false,
          },
          { modelRuntime: harness.modelRuntime }
        );
        const events = await runScenarioTurns(engine, scenario, workspace.root);
        const projected = projectScenarioEvents(events, workspace);
        // 逐场景断言；失败信息带场景名，方便定位是哪个 fixture 漂移。
        expect({ scenario: scenario.name, projected }).toEqual({
          scenario: scenario.name,
          projected: fixture.expected,
        });
      } finally {
        await workspace.cleanup();
        await harness.cleanup();
      }
    }
  });
});
