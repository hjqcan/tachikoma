/**
 * Skills 通道测试 —— 全程零网络
 *
 * 覆盖：显式授予注入系统提示（渐进披露头）、summary 真相面（session.skills）、
 * 授予不改变工具集、无 workDir 拒绝、坏路径快败、全部无效快败、
 * 工作区外 skill 根 read 放行 / write 拦截、会话授予替换引擎默认、[] 显式清空。
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../src';
import type { ChatEvent } from '../src';
import { WORKSPACE_TOOLS } from '../src/chat/workspace-guard';
import { createFauxHarness } from './helpers';
import type { FauxHarness } from './helpers';

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'tachikoma-skill-ws-'));
}

/** 建一个含单个 skill 的目录；description 传 null 时省略（pi 会丢弃该 skill） */
async function makeSkillDir(
  name: string,
  description: string | null = `${name.toUpperCase()}_DESCRIPTION_MARKER`
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'tachikoma-skill-'));
  const skillDir = join(base, name);
  await mkdir(skillDir);
  const frontmatter =
    description === null
      ? `---\nname: ${name}\n---\n`
      : `---\nname: ${name}\ndescription: ${description}\n---\n`;
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `${frontmatter}\n${name.toUpperCase()}_BODY_MARKER\n`
  );
  return base;
}

function buildEngine(
  harness: FauxHarness,
  config: { workDir?: string; toolset?: 'read-only' | 'coding'; skills?: string[] } = {}
): ChatEngine {
  return new ChatEngine(
    {
      dataDir: harness.dataDir,
      model: { provider: harness.faux.provider.id, model: 'chat' },
      memory: false,
      ...config,
    },
    { modelRuntime: harness.modelRuntime }
  );
}

describe('Skills 通道：显式授予', () => {
  it('授予 + workDir：skills 进系统提示，session.skills 为真相面，工具集不变', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const skillBase = await makeSkillDir('demo-skill');
    try {
      let systemPrompt = '';
      harness.faux.setResponses([
        (context) => {
          systemPrompt = context.systemPrompt ?? '';
          return fauxAssistantMessage('ok');
        },
      ]);
      const engine = buildEngine(harness, { workDir, skills: [skillBase] });
      const session = await engine.createSession();

      expect(session.skills).toEqual([
        { name: 'demo-skill', description: 'DEMO-SKILL_DESCRIPTION_MARKER' },
      ]);
      // skills 不是工具：只读四件套保持不变
      expect([...session.activeTools].sort()).toEqual([...WORKSPACE_TOOLS].sort());

      await collect(session.send('hi'));
      expect(systemPrompt).toContain('<available_skills>');
      expect(systemPrompt).toContain('DEMO-SKILL_DESCRIPTION_MARKER');
      // 只读根声明进了提示词，模型才不会拒读工作区外的 skill 文件
      expect(systemPrompt).toContain('Skill files under');
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(skillBase, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('无 workDir 的授予被拒绝——静默失效违背显式授予哲学', async () => {
    const harness = await createFauxHarness();
    const skillBase = await makeSkillDir('demo-skill');
    try {
      const engine = buildEngine(harness, { skills: [skillBase] });
      await expect(engine.createSession()).rejects.toThrow(
        'skills require a workspace grant (workDir)'
      );
    } finally {
      await rm(skillBase, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('不存在的授予路径快败', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    try {
      const engine = buildEngine(harness, { workDir });
      await expect(
        engine.createSession({ skills: [join(workDir, 'no-such-skill')] })
      ).rejects.toThrow('skills path is not usable');
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('授予存在但无效（缺 description）快败并携带 pi 诊断', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const skillBase = await makeSkillDir('broken-skill', null);
    try {
      const engine = buildEngine(harness, { workDir });
      await expect(engine.createSession({ skills: [skillBase] })).rejects.toThrow(
        'Skill grant loaded no skills'
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(skillBase, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('逐授予快败：好授予不掩护坏授予', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const goodSkill = await makeSkillDir('good-skill');
    const brokenSkill = await makeSkillDir('broken-skill', null);
    try {
      const engine = buildEngine(harness, { workDir });
      const error = await engine
        .createSession({ skills: [goodSkill, brokenSkill] })
        .then(() => null)
        .catch((caught: unknown) => caught);
      expect(String(error)).toContain('Skill grant loaded no skills');
      expect(String(error)).toContain(brokenSkill);
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(goodSkill, { recursive: true, force: true });
      await rm(brokenSkill, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('工作区外 skill 根：read 放行，write 仍拦截（只读根语义）', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const skillBase = await makeSkillDir('demo-skill');
    // 模型从系统提示里拿到的是 canonical 路径（引擎对授予 realpath 过）
    const canonicalBase = await realpath(skillBase);
    const skillFile = join(canonicalBase, 'demo-skill', 'SKILL.md');
    try {
      harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read', { path: skillFile })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(
          [fauxToolCall('write', { path: join(canonicalBase, 'x.txt'), content: 'x' })],
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage('done'),
      ]);
      const engine = buildEngine(harness, { workDir, toolset: 'coding', skills: [skillBase] });
      const session = await engine.createSession();
      const events = await collect(session.send('读 skill 然后试着写入'));

      const results = events.filter((event) => event.type === 'tool_result');
      expect(results).toHaveLength(2);
      const [readResult, writeResult] = results;
      expect(readResult).toMatchObject({ tool: 'read', isError: false });
      if (readResult?.type === 'tool_result') {
        expect(readResult.output).toContain('DEMO-SKILL_BODY_MARKER');
      }
      expect(writeResult).toMatchObject({ tool: 'write', isError: true });
      if (writeResult?.type === 'tool_result') {
        expect(writeResult.output).toContain('outside the workspace');
      }
      await session.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(skillBase, { recursive: true, force: true });
      await harness.cleanup();
    }
  });

  it('会话授予替换引擎默认；[] 显式清空', async () => {
    const harness = await createFauxHarness();
    const workDir = await makeWorkspace();
    const engineSkill = await makeSkillDir('engine-skill');
    const sessionSkill = await makeSkillDir('session-skill');
    try {
      const engine = buildEngine(harness, { workDir, skills: [engineSkill] });

      const inherited = await engine.createSession();
      expect(inherited.skills?.map((s) => s.name)).toEqual(['engine-skill']);

      const replaced = await engine.createSession({ skills: [sessionSkill] });
      expect(replaced.skills?.map((s) => s.name)).toEqual(['session-skill']);

      const cleared = await engine.createSession({ skills: [] });
      expect(cleared.skills).toBeNull();

      await inherited.close();
      await replaced.close();
      await cleared.close();
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(engineSkill, { recursive: true, force: true });
      await rm(sessionSkill, { recursive: true, force: true });
      await harness.cleanup();
    }
  });
});
