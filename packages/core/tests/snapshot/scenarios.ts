/**
 * 快照场景表。**入表条件 = 已录制**：replay.test 断言场景表与 fixtures/ 目录
 * 双向一致，没有静默跳过。新场景先加进 STAGED_SCENARIOS，跑
 * `bun run snapshot:record <name>` 录制并人工审查 fixture diff 后移入正式表。
 */

import type { SnapshotScenario } from './support';

/** 已录制、参与默认离线回放的场景 */
export const SNAPSHOT_SCENARIOS: readonly SnapshotScenario[] = [
  {
    name: 'text-reasoning',
    toolset: 'read-only',
    thinkingLevel: 'low',
    workspaceFixture: 'plain',
    turns: ['用一句话解释 write-ahead log 是什么。'],
  },
  {
    name: 'read-tool',
    toolset: 'read-only',
    workspaceFixture: 'read-tool',
    turns: ['Read data.txt and report the exact marker line it contains.'],
  },
  {
    name: 'approval-grant-deny',
    toolset: 'coding',
    workspaceFixture: 'plain',
    approvals: { write: true, bash: false },
    allowToolErrors: true,
    turns: [
      'Create a file named note.txt containing exactly the text APPROVED-OK.',
      'Run the shell command `echo done`. If the call is denied, say so and stop.',
    ],
  },
  {
    name: 'skills-catalog',
    toolset: 'read-only',
    workspaceFixture: 'skills-catalog',
    skillGrants: ['skills/demo'],
    turns: ['Use the demo skill to find the workspace marker, then report it.'],
  },
];

/** 待录制的场景定义（录制脚本可见；不参与回放断言） */
export const STAGED_SCENARIOS: readonly SnapshotScenario[] = [];

export function findScenario(name: string): SnapshotScenario | undefined {
  return [...SNAPSHOT_SCENARIOS, ...STAGED_SCENARIOS].find((scenario) => scenario.name === name);
}
