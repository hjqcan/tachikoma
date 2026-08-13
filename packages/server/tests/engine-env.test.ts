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
