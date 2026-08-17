/**
 * 命名 preset 解析测试 —— 全程零网络
 *
 * 覆盖：完整字段解析、相对路径按 preset 目录解析（可搬运包）、
 * 全部 fail-loud 规则（坏名字、缺文件列可用名、坏 JSON、未知键、
 * 提示词不可读/为空、skills 路径不存在、memory 只许 false）。
 */

import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergePresetConfig, resolvePreset } from '../src';

async function makeConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'tachikoma-preset-'));
  await mkdir(join(configDir, 'presets'), { recursive: true });
  return configDir;
}

async function writePreset(configDir: string, name: string, body: unknown): Promise<void> {
  await writeFile(
    join(configDir, 'presets', `${name}.json`),
    typeof body === 'string' ? body : JSON.stringify(body)
  );
}

describe('命名 preset', () => {
  it('完整字段解析；相对路径按 preset 目录解析并立即验证', async () => {
    const configDir = await makeConfigDir();
    try {
      const presetsDir = join(configDir, 'presets');
      await writeFile(join(presetsDir, 'demo.prompt.md'), 'You are the demo persona.\n');
      await mkdir(join(presetsDir, 'skills', 'demo'), { recursive: true });
      await writeFile(join(presetsDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nx');
      const workDir = await mkdtemp(join(tmpdir(), 'tachikoma-preset-ws-'));
      await writePreset(configDir, 'demo', {
        systemPromptFile: './demo.prompt.md',
        skills: ['./skills/demo'],
        toolset: 'coding',
        workDir,
        model: { provider: 'openai', model: 'gpt-5.2' },
        thinkingLevel: 'medium',
        memory: false,
      });

      const resolved = resolvePreset(configDir, 'demo');
      expect(resolved.systemPrompt).toBe('You are the demo persona.\n');
      expect(resolved.skills).toEqual([join(presetsDir, 'skills', 'demo')]);
      expect(resolved.toolset).toBe('coding');
      expect(resolved.workDir).toBe(workDir);
      expect(resolved.model).toEqual({ provider: 'openai', model: 'gpt-5.2' });
      expect(resolved.thinkingLevel).toBe('medium');
      expect(resolved.memory).toBeFalse();
      await rm(workDir, { recursive: true, force: true });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('空 preset（{}）合法：全部字段可选', async () => {
    const configDir = await makeConfigDir();
    try {
      await writePreset(configDir, 'empty', {});
      expect(resolvePreset(configDir, 'empty')).toEqual({});
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('坏名字拒绝（路径拼接安全）', async () => {
    const configDir = await makeConfigDir();
    try {
      expect(() => resolvePreset(configDir, '../escape')).toThrow('Invalid preset name');
      expect(() => resolvePreset(configDir, '')).toThrow('Invalid preset name');
      expect(() => resolvePreset(configDir, 'a/b')).toThrow('Invalid preset name');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('缺文件列出可用名', async () => {
    const configDir = await makeConfigDir();
    try {
      await writePreset(configDir, 'alpha', {});
      await writePreset(configDir, 'beta', {});
      expect(() => resolvePreset(configDir, 'missing')).toThrow('available: alpha, beta');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('坏 JSON、非对象顶层、未知键：响亮拒绝', async () => {
    const configDir = await makeConfigDir();
    try {
      await writePreset(configDir, 'broken', '{nope');
      expect(() => resolvePreset(configDir, 'broken')).toThrow('not valid JSON');
      await writePreset(configDir, 'arr', '[1]');
      expect(() => resolvePreset(configDir, 'arr')).toThrow('top level must be a JSON object');
      await writePreset(configDir, 'unknown', { systemprompt: 'typo' });
      expect(() => resolvePreset(configDir, 'unknown')).toThrow('unknown key "systemprompt"');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('提示词文件不可读/为空、skills 路径不存在、workDir 不存在：解析期即败', async () => {
    const configDir = await makeConfigDir();
    try {
      await writePreset(configDir, 'noprompt', { systemPromptFile: './missing.md' });
      expect(() => resolvePreset(configDir, 'noprompt')).toThrow('not readable');

      await writeFile(join(configDir, 'presets', 'blank.md'), '  \n');
      await writePreset(configDir, 'blankprompt', { systemPromptFile: './blank.md' });
      expect(() => resolvePreset(configDir, 'blankprompt')).toThrow('is empty');

      await writePreset(configDir, 'noskill', { skills: ['./skills/none'] });
      expect(() => resolvePreset(configDir, 'noskill')).toThrow('does not exist');

      await writePreset(configDir, 'nowork', { workDir: './missing-ws' });
      expect(() => resolvePreset(configDir, 'nowork')).toThrow('workDir does not exist');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('枚举与形状校验：toolset/thinkingLevel/model/memory', async () => {
    const configDir = await makeConfigDir();
    try {
      await writePreset(configDir, 'badtool', { toolset: 'yolo' });
      expect(() => resolvePreset(configDir, 'badtool')).toThrow('toolset must be');
      await writePreset(configDir, 'badthink', { thinkingLevel: 'ultra' });
      expect(() => resolvePreset(configDir, 'badthink')).toThrow('thinkingLevel must be');
      await writePreset(configDir, 'badmodel', { model: { provider: 'p' } });
      expect(() => resolvePreset(configDir, 'badmodel')).toThrow('model must be');
      await writePreset(configDir, 'badmem', { memory: true });
      expect(() => resolvePreset(configDir, 'badmem')).toThrow('memory only accepts false');
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('mergePresetConfig（CLI 与 engined 的唯一合并实现）', () => {
  it('逐字段 显式 > preset；memoryOff 任一侧关闭即关闭', () => {
    const merged = mergePresetConfig(
      { toolset: 'read-only', workDir: '/explicit', memoryOff: false },
      {
        toolset: 'coding',
        workDir: '/preset',
        model: { provider: 'p', model: 'm' },
        thinkingLevel: 'low',
        memory: false,
      }
    );
    expect(merged.toolset).toBe('read-only');
    expect(merged.workDir).toBe('/explicit');
    expect(merged.model).toEqual({ provider: 'p', model: 'm' });
    expect(merged.thinkingLevel).toBe('low');
    expect(merged.memoryOff).toBeTrue();
  });

  it('skills：[] 是显式清空（压掉 preset），undefined 才回落', () => {
    const preset = { workDir: '/w', skills: ['/preset/skill'] };
    expect(mergePresetConfig({ skills: [] }, preset).skills).toBeUndefined();
    expect(mergePresetConfig({}, preset).skills).toEqual(['/preset/skill']);
    expect(mergePresetConfig({ skills: ['/mine'] }, preset).skills).toEqual(['/mine']);
  });

  it('跨字段检查：toolset/skills 无 workDir 一律抛（文案中立，不点名单一入口）', () => {
    expect(() => mergePresetConfig({}, { toolset: 'coding' })).toThrow('requires a workspace');
    expect(() => mergePresetConfig({ skills: ['/s'] }, {})).toThrow('require a workspace');
  });
});
