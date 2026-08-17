/**
 * 快照层基础设施：fixture = 产品自己持久化的 pi 转录（dsh 配方）。
 *
 * 录制（真 API，显式开关）把转录与归一化期望落进 fixtures/<场景>/；
 * 回放（默认离线套件）把转录的 assistant 消息喂回 faux provider，重跑整机，
 * diff 归一化投影。路径以 {{workspace}} token 落盘，回放时换成当次临时根。
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatEngine, ChatEvent, ChatSession, ChatThinkingLevel, ChatToolset } from '../../src';
import { projectEvents } from '../event-projection';
import type { ProjectedEvent, ProjectionRoot } from '../event-projection';

export const WORKSPACE_TOKEN = '{{workspace}}';
export const MODEL_TOKEN = '<model>';

export const FIXTURES_DIR = join(import.meta.dir, 'fixtures');
export const WORKSPACES_DIR = join(import.meta.dir, 'workspaces');

export interface SnapshotScenario {
  name: string;
  toolset: ChatToolset;
  thinkingLevel?: ChatThinkingLevel;
  /** tests/snapshot/workspaces/ 下的目录名；运行时整体拷贝到临时工作区 */
  workspaceFixture: string;
  /** 相对临时工作区根解析的 skill 授予路径 */
  skillGrants?: readonly string[];
  /** 工具名 → 批准与否；未列出的工具默认批准（scope 恒为 call） */
  approvals?: Readonly<Record<string, boolean>>;
  turns: readonly string[];
  /** 允许 fixture 含 isError tool_result（默认拒收 —— 录制哨兵） */
  allowToolErrors?: boolean;
}

export interface ScenarioWorkspace {
  /** canonical（realpath 后）工作区根 */
  root: string;
  /** 原始 mkdtemp 路径（macOS 上与 realpath 形态不同，token 化两个都要替换） */
  rawRoot: string;
  cleanup(): Promise<void>;
}

export async function createScenarioWorkspace(
  scenario: SnapshotScenario
): Promise<ScenarioWorkspace> {
  const rawRoot = await mkdtemp(join(tmpdir(), `tachikoma-snapshot-${scenario.name}-`));
  await cp(join(WORKSPACES_DIR, scenario.workspaceFixture), rawRoot, { recursive: true });
  return {
    root: await realpath(rawRoot),
    rawRoot,
    cleanup: async () => {
      await rm(rawRoot, { recursive: true, force: true });
    },
  };
}

/** 跑一个场景的全部回合：审批按场景表自动应答，收集全部事件 */
export async function runScenarioTurns(
  engine: ChatEngine,
  scenario: SnapshotScenario,
  workspaceRoot: string
): Promise<ChatEvent[]> {
  const session: ChatSession = await engine.createSession({
    workDir: workspaceRoot,
    toolset: scenario.toolset,
    ...(scenario.thinkingLevel ? { thinkingLevel: scenario.thinkingLevel } : {}),
    ...(scenario.skillGrants
      ? { skills: scenario.skillGrants.map((grant) => join(workspaceRoot, grant)) }
      : {}),
  });
  const events: ChatEvent[] = [];
  try {
    for (const turn of scenario.turns) {
      for await (const event of session.send(turn)) {
        events.push(event);
        if (event.type === 'tool_approval_request') {
          session.respondToApproval(event.callId, scenario.approvals?.[event.tool] ?? true);
        }
      }
    }
  } finally {
    await session.close();
  }
  return events;
}

/** 录制哨兵：快照刷新是 fixture 生产，不是正确性审查——异常形态直接拒收 */
export function validateRecording(scenario: SnapshotScenario, events: readonly ChatEvent[]): void {
  const violations: string[] = [];
  for (const event of events) {
    if (event.type === 'message_complete' && event.status !== 'success') {
      violations.push(`message_complete.status=${event.status} (${event.error ?? 'no error'})`);
    }
    if (!scenario.allowToolErrors && event.type === 'tool_result' && event.isError) {
      violations.push(`isError tool_result from ${event.tool}: ${event.output.slice(0, 120)}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Recording for scenario "${scenario.name}" rejected:\n- ${violations.join('\n- ')}\n` +
        'Fix the scenario or the engine; a recording is fixture production, not correctness review.'
    );
  }
}

/** 会话转录：录制后 sessions/ 下应恰有一个 pi 转录 */
export async function readSessionTranscript(dataDir: string): Promise<string> {
  const sessionsDir = join(dataDir, 'sessions');
  const files = (await readdir(sessionsDir)).filter(
    (name) => name.endsWith('.jsonl') && !name.endsWith('.events.jsonl')
  );
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one transcript in ${sessionsDir}, found: ${files.join(', ')}`
    );
  }
  const file = files[0];
  if (!file) throw new Error('unreachable');
  return readFile(join(sessionsDir, file), 'utf8');
}

/** 文本级路径 token 化（长路径优先，双向可用） */
export function replacePaths(
  text: string,
  replacements: readonly { from: string; to: string }[]
): string {
  let result = text;
  for (const { from, to } of [...replacements].sort((a, b) => b.from.length - a.from.length)) {
    result = result.replaceAll(from, to);
  }
  return result;
}

/** 转录 → faux 回放脚本：assistant 消息按序即为逐次模型应答 */
export function transcriptToFauxSteps(transcriptText: string): AssistantMessage[] {
  const steps: AssistantMessage[] = [];
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue;
    let parsed: { type?: string; message?: { role?: string } };
    try {
      parsed = JSON.parse(line) as { type?: string; message?: { role?: string } };
    } catch (error) {
      throw new Error(`Transcript fixture line is not valid JSON: ${line.slice(0, 120)}`, {
        cause: error,
      });
    }
    if (parsed.type === 'message' && parsed.message?.role === 'assistant') {
      steps.push(parsed.message as AssistantMessage);
    }
  }
  if (steps.length === 0) {
    throw new Error('Transcript fixture contains no assistant messages.');
  }
  return steps;
}

export interface SnapshotFixture {
  transcript: string;
  expected: ProjectedEvent[];
}

export async function readFixture(name: string): Promise<SnapshotFixture> {
  const dir = join(FIXTURES_DIR, name);
  const transcript = await readFile(join(dir, 'transcript.jsonl'), 'utf8');
  const expected = JSON.parse(
    await readFile(join(dir, 'events.expected.json'), 'utf8')
  ) as ProjectedEvent[];
  return { transcript, expected };
}

export async function writeFixture(name: string, fixture: SnapshotFixture): Promise<void> {
  const dir = join(FIXTURES_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'transcript.jsonl'), fixture.transcript);
  await writeFile(
    join(dir, 'events.expected.json'),
    `${JSON.stringify(fixture.expected, null, 2)}\n`
  );
}

export async function listFixtures(): Promise<string[]> {
  try {
    return (await readdir(FIXTURES_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 事件投影的标准根表：工作区（raw + canonical 双形态）→ token */
export function projectionRoots(
  workspace: ScenarioWorkspace,
  modelName?: string
): ProjectionRoot[] {
  const roots: ProjectionRoot[] = [
    { token: WORKSPACE_TOKEN, path: workspace.root },
    { token: WORKSPACE_TOKEN, path: workspace.rawRoot },
  ];
  if (modelName) {
    roots.push({ token: MODEL_TOKEN, path: modelName });
  }
  return roots;
}

/** 场景运行 + 投影一条龙（录制与回放共用） */
export function projectScenarioEvents(
  events: readonly ChatEvent[],
  workspace: ScenarioWorkspace,
  modelName?: string
): ProjectedEvent[] {
  return projectEvents(events, { roots: projectionRoots(workspace, modelName) });
}
