/**
 * enginedOptionsFromEnv 单元测试 —— engined 的 env → 配置组装（离线）。
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { enginedOptionsFromEnv } from '../src/engine-env';

describe('enginedOptionsFromEnv', () => {
  it('空 env 落默认：~/.tachikoma、无模型、记忆开启、无授予', () => {
    const options = enginedOptionsFromEnv({});
    expect(options.dataDir.endsWith('.tachikoma')).toBeTrue();
    expect(options.engineConfig.model).toBeUndefined();
    expect(options.engineConfig.memory).toEqual({});
    expect(options.engineConfig.workDir).toBeUndefined();
    expect(options.engineConfig.skills).toBeUndefined();
    expect(options.engineConfig.systemPrompt).toBeUndefined();
    expect(options.engineConfig.configDir).toBeUndefined();
    expect(options.sessionDefaults).toEqual({});
  });

  it('TACHIKOMA_CONFIG_DIR 进 configDir（用户级 models.json 与 workspace 数据分离）', () => {
    const options = enginedOptionsFromEnv({
      TACHIKOMA_DATA_DIR: '/books/one/.tachikoma',
      TACHIKOMA_CONFIG_DIR: '/home/user/.tachikoma',
    });
    expect(options.engineConfig.dataDir).toBe('/books/one/.tachikoma');
    expect(options.engineConfig.configDir).toBe('/home/user/.tachikoma');
  });

  it('workDir/toolset/skills 同时进引擎配置与 sessionDefaults；skills 按 PATH 分隔符切分', () => {
    const options = enginedOptionsFromEnv({
      TACHIKOMA_DATA_DIR: '/data',
      TACHIKOMA_WORKDIR: '/books/one',
      TACHIKOMA_TOOLSET: 'coding',
      TACHIKOMA_SKILLS: ['/skills/a', ' /skills/b ', ''].join(delimiter),
    });
    expect(options.engineConfig).toMatchObject({
      dataDir: '/data',
      workDir: '/books/one',
      toolset: 'coding',
      skills: ['/skills/a', '/skills/b'],
    });
    expect(options.sessionDefaults).toEqual({
      workDir: '/books/one',
      toolset: 'coding',
      skills: ['/skills/a', '/skills/b'],
    });
  });

  it('TACHIKOMA_SKILLS 无 TACHIKOMA_WORKDIR 时启动即失败——不允许健康启动后逐请求报错', () => {
    expect(() => enginedOptionsFromEnv({ TACHIKOMA_SKILLS: '/skills/a' })).toThrow(
      'Skills require a workspace'
    );
  });

  it('TACHIKOMA_REASONING_SUMMARY 进引擎配置；非法值启动即失败', () => {
    const options = enginedOptionsFromEnv({ TACHIKOMA_REASONING_SUMMARY: 'detailed' });
    expect(options.engineConfig.reasoningSummary).toBe('detailed');
    expect(enginedOptionsFromEnv({}).engineConfig.reasoningSummary).toBeUndefined();
    expect(() => enginedOptionsFromEnv({ TACHIKOMA_REASONING_SUMMARY: 'verbose' })).toThrow(
      'TACHIKOMA_REASONING_SUMMARY'
    );
  });

  it('TACHIKOMA_NO_MEMORY=1 关记忆；USER_ID 透传', () => {
    expect(enginedOptionsFromEnv({ TACHIKOMA_NO_MEMORY: '1' }).engineConfig.memory).toBeFalse();
    expect(enginedOptionsFromEnv({ TACHIKOMA_USER_ID: 'alice' }).engineConfig.memory).toEqual({
      userId: 'alice',
    });
  });

  it('TACHIKOMA_SYSTEM_PROMPT_FILE 读入 systemPrompt；缺文件/空文件启动即失败', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tachikoma-prompt-'));
    const promptFile = join(dir, 'persona.md');
    await writeFile(promptFile, '你是一个专业写作助手。\n多行内容 OK。\n');

    const options = enginedOptionsFromEnv({ TACHIKOMA_SYSTEM_PROMPT_FILE: promptFile });
    expect(options.engineConfig.systemPrompt).toContain('专业写作助手');

    expect(() =>
      enginedOptionsFromEnv({ TACHIKOMA_SYSTEM_PROMPT_FILE: join(dir, 'missing.md') })
    ).toThrow('TACHIKOMA_SYSTEM_PROMPT_FILE is not readable');

    const empty = join(dir, 'empty.md');
    await writeFile(empty, '   \n');
    expect(() => enginedOptionsFromEnv({ TACHIKOMA_SYSTEM_PROMPT_FILE: empty })).toThrow(
      'TACHIKOMA_SYSTEM_PROMPT_FILE is empty'
    );
  });
});

describe('enginedOptionsFromEnv + TACHIKOMA_PRESET', () => {
  async function makePresetDir(): Promise<{ configDir: string; workDir: string }> {
    const configDir = await mkdtemp(join(tmpdir(), 'tachikoma-env-preset-'));
    const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-env-preset-ws-'));
    const presetsDir = join(configDir, 'presets');
    await import('node:fs/promises').then((fs) => fs.mkdir(presetsDir, { recursive: true }));
    await writeFile(join(presetsDir, 'demo.prompt.md'), 'Preset persona.\n');
    await writeFile(
      join(presetsDir, 'demo.json'),
      JSON.stringify({
        systemPromptFile: './demo.prompt.md',
        toolset: 'coding',
        workDir,
        model: { provider: 'preset-p', model: 'preset-m' },
        thinkingLevel: 'low',
        memory: false,
      })
    );
    return { configDir, workDir };
  }

  it('preset 字段进引擎配置与 sessionDefaults；未被 env 覆盖的原样生效', async () => {
    const { configDir, workDir } = await makePresetDir();
    const options = enginedOptionsFromEnv({
      TACHIKOMA_DATA_DIR: '/data',
      TACHIKOMA_CONFIG_DIR: configDir,
      TACHIKOMA_PRESET: 'demo',
    });
    expect(options.engineConfig.model).toEqual({ provider: 'preset-p', model: 'preset-m' });
    expect(options.engineConfig.workDir).toBe(workDir);
    expect(options.engineConfig.toolset).toBe('coding');
    expect(options.engineConfig.systemPrompt).toBe('Preset persona.\n');
    expect(options.engineConfig.thinkingLevel).toBe('low');
    expect(options.engineConfig.memory).toBeFalse();
    expect(options.sessionDefaults.workDir).toBe(workDir);
    expect(options.sessionDefaults.toolset).toBe('coding');
  });

  it('显式 TACHIKOMA_* 覆盖 preset 字段（与 CLI 合并序同构）', async () => {
    const { configDir } = await makePresetDir();
    const options = enginedOptionsFromEnv({
      TACHIKOMA_DATA_DIR: '/data',
      TACHIKOMA_CONFIG_DIR: configDir,
      TACHIKOMA_PRESET: 'demo',
      TACHIKOMA_PROVIDER: 'env-p',
      TACHIKOMA_MODEL: 'env-m',
      TACHIKOMA_WORKDIR: '/explicit/ws',
      TACHIKOMA_TOOLSET: 'read-only',
    });
    expect(options.engineConfig.model).toEqual({ provider: 'env-p', model: 'env-m' });
    expect(options.engineConfig.workDir).toBe('/explicit/ws');
    expect(options.engineConfig.toolset).toBe('read-only');
  });

  it('preset 的 workDir 满足 env 提供的 skills（跨字段检查在合并后）', async () => {
    const { configDir } = await makePresetDir();
    const skillDir = await mkdtemp(join(tmpdir(), 'tachikoma-env-skill-'));
    const options = enginedOptionsFromEnv({
      TACHIKOMA_CONFIG_DIR: configDir,
      TACHIKOMA_PRESET: 'demo',
      TACHIKOMA_SKILLS: skillDir,
    });
    expect(options.engineConfig.skills).toEqual([skillDir]);
    expect(options.engineConfig.workDir).toBeDefined();
  });

  it('坏 preset 启动即败（不静默降级）', () => {
    expect(() =>
      enginedOptionsFromEnv({ TACHIKOMA_CONFIG_DIR: '/nonexistent', TACHIKOMA_PRESET: 'ghost' })
    ).toThrow('Preset not found');
  });
});

describe('enginedOptionsFromEnv 快败与合并语义（评审修复）', () => {
  it('非法 TACHIKOMA_TOOLSET 启动即败——typo 不得静默落到 preset 反转显式限制', () => {
    expect(() => enginedOptionsFromEnv({ TACHIKOMA_TOOLSET: 'readonly' })).toThrow(
      'TACHIKOMA_TOOLSET must be read-only | coding'
    );
  });

  it('半设的 TACHIKOMA_PROVIDER/MODEL 启动即败——不静默忽略', () => {
    expect(() => enginedOptionsFromEnv({ TACHIKOMA_PROVIDER: 'p' })).toThrow(
      'must be set together'
    );
    expect(() => enginedOptionsFromEnv({ TACHIKOMA_MODEL: 'm' })).toThrow('must be set together');
  });

  it('preset 提供 toolset 而全局无 workDir：启动即败，与 CLI 同一行为（不静默零工具）', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'tachikoma-env-toolset-'));
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(configDir, 'presets'), { recursive: true })
    );
    await writeFile(join(configDir, 'presets', 'toolsonly.json'), '{"toolset":"coding"}');
    expect(() =>
      enginedOptionsFromEnv({ TACHIKOMA_CONFIG_DIR: configDir, TACHIKOMA_PRESET: 'toolsonly' })
    ).toThrow('requires a workspace');
  });

  it("TACHIKOMA_SKILLS='' 是显式清空：压掉 preset 的 skills，不回落", async () => {
    const { configDir, workDir } = await (async () => {
      const configDir = await mkdtemp(join(tmpdir(), 'tachikoma-env-clear-'));
      const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-env-clear-ws-'));
      const presetsDir = join(configDir, 'presets');
      const skillDir = join(presetsDir, 'skills');
      await import('node:fs/promises').then((fs) => fs.mkdir(skillDir, { recursive: true }));
      await writeFile(
        join(presetsDir, 'withskills.json'),
        JSON.stringify({ workDir, skills: ['./skills'] })
      );
      return { configDir, workDir };
    })();
    const options = enginedOptionsFromEnv({
      TACHIKOMA_CONFIG_DIR: configDir,
      TACHIKOMA_PRESET: 'withskills',
      TACHIKOMA_SKILLS: '',
    });
    expect(options.engineConfig.skills).toBeUndefined();
    expect(options.sessionDefaults.skills).toBeUndefined();
    expect(options.engineConfig.workDir).toBe(workDir);
  });
});
