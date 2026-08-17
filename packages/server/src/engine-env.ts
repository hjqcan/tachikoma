/**
 * engined 的 env → 引擎配置组装（纯函数，可离线测试）。
 *
 * 配置经 env 而非 argv（由壳按 workspace 显式设置）；systemPrompt 走文件
 * （TACHIKOMA_SYSTEM_PROMPT_FILE）——多行/非 ASCII 友好，且不进程表泄漏。
 * 一切配置错误启动即失败，不静默降级：坏提示词文件、坏 preset、非法
 * TACHIKOMA_TOOLSET / REASONING_SUMMARY、半设的 PROVIDER/MODEL 对，一视同仁。
 *
 * preset 合并走 core 的 mergePresetConfig（与 CLI 同一实现，防两边分叉）：
 * 显式 TACHIKOMA_* > preset；TACHIKOMA_SKILLS 设为空串是显式清空（压掉 preset
 * 的 skills），未设置才回落 preset。
 */

import type { ChatEngineConfig, ChatPresetResolved } from '@hjqcan/tachikoma-core';
import { mergePresetConfig, readPromptFile, resolvePreset } from '@hjqcan/tachikoma-core';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface EnginedOptions {
  dataDir: string;
  engineConfig: ChatEngineConfig;
  sessionDefaults: {
    workDir?: string;
    toolset?: 'read-only' | 'coding';
    skills?: string[];
  };
}

export function enginedOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>
): EnginedOptions {
  const dataDir = env.TACHIKOMA_DATA_DIR ?? join(homedir(), '.tachikoma');
  const configDir = env.TACHIKOMA_CONFIG_DIR;
  // 命名 preset：解析失败即启动失败（同 systemPrompt 文件的快败姿势）。
  const preset: ChatPresetResolved = env.TACHIKOMA_PRESET
    ? resolvePreset(configDir ?? dataDir, env.TACHIKOMA_PRESET)
    : {};

  // 半设的模型对是配置错误，不许静默落到 preset/无模型（曾静默忽略）。
  if (Boolean(env.TACHIKOMA_PROVIDER) !== Boolean(env.TACHIKOMA_MODEL)) {
    throw new Error('TACHIKOMA_PROVIDER and TACHIKOMA_MODEL must be set together.');
  }
  const envModel =
    env.TACHIKOMA_PROVIDER && env.TACHIKOMA_MODEL
      ? { provider: env.TACHIKOMA_PROVIDER, model: env.TACHIKOMA_MODEL }
      : undefined;

  // 非法值必须响亮：typo（如 readonly）静默落到 preset 会反转操作者的显式限制。
  const envToolset = env.TACHIKOMA_TOOLSET;
  if (envToolset !== undefined && envToolset !== 'read-only' && envToolset !== 'coding') {
    throw new Error(`TACHIKOMA_TOOLSET must be read-only | coding, got: ${envToolset}`);
  }

  // 显式设置（含设为空串 = 清空 preset 的 skills）与未设置是两回事。
  const envSkills =
    env.TACHIKOMA_SKILLS !== undefined
      ? env.TACHIKOMA_SKILLS.split(delimiter)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : undefined;

  const promptFile = env.TACHIKOMA_SYSTEM_PROMPT_FILE;
  const systemPrompt = promptFile
    ? readPromptFile(promptFile, 'TACHIKOMA_SYSTEM_PROMPT_FILE')
    : undefined;

  const reasoningSummary = env.TACHIKOMA_REASONING_SUMMARY;
  if (
    reasoningSummary !== undefined &&
    reasoningSummary !== 'auto' &&
    reasoningSummary !== 'concise' &&
    reasoningSummary !== 'detailed'
  ) {
    throw new Error(
      `TACHIKOMA_REASONING_SUMMARY must be auto | concise | detailed, got: ${reasoningSummary}`
    );
  }

  // 合并与跨字段检查（toolset/skills 需 workDir）在共享实现里；失败即启动失败。
  const merged = mergePresetConfig(
    {
      ...(envModel ? { model: envModel } : {}),
      ...(env.TACHIKOMA_WORKDIR ? { workDir: env.TACHIKOMA_WORKDIR } : {}),
      ...(envToolset ? { toolset: envToolset } : {}),
      ...(envSkills !== undefined ? { skills: envSkills } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      memoryOff: env.TACHIKOMA_NO_MEMORY === '1',
    },
    preset
  );

  return {
    dataDir,
    engineConfig: {
      dataDir,
      ...(configDir ? { configDir } : {}),
      ...(merged.model ? { model: merged.model } : {}),
      ...(merged.workDir ? { workDir: merged.workDir } : {}),
      ...(merged.toolset ? { toolset: merged.toolset } : {}),
      ...(merged.skills ? { skills: merged.skills } : {}),
      ...(merged.systemPrompt ? { systemPrompt: merged.systemPrompt } : {}),
      ...(merged.thinkingLevel ? { thinkingLevel: merged.thinkingLevel } : {}),
      ...(reasoningSummary ? { reasoningSummary } : {}),
      memory: merged.memoryOff
        ? false
        : { ...(env.TACHIKOMA_USER_ID ? { userId: env.TACHIKOMA_USER_ID } : {}) },
    },
    sessionDefaults: {
      ...(merged.workDir ? { workDir: merged.workDir } : {}),
      ...(merged.toolset ? { toolset: merged.toolset } : {}),
      ...(merged.skills ? { skills: merged.skills } : {}),
    },
  };
}
