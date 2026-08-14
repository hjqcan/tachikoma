/**
 * engined 的 env → 引擎配置组装（纯函数，可离线测试）。
 *
 * 配置经 env 而非 argv（由壳按 workspace 显式设置）；systemPrompt 走文件
 * （TACHIKOMA_SYSTEM_PROMPT_FILE）——多行/非 ASCII 友好，且不进程表泄漏。
 * 设置了但读不到的提示词文件是配置错误：启动即失败，不静默回退默认。
 */

import type { ChatEngineConfig } from '@hjqcan/tachikoma-core';
import { readFileSync } from 'node:fs';
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
  const provider = env.TACHIKOMA_PROVIDER;
  const model = env.TACHIKOMA_MODEL;
  const workDir = env.TACHIKOMA_WORKDIR;
  const toolset = env.TACHIKOMA_TOOLSET === 'coding' ? ('coding' as const) : undefined;
  const skills = env.TACHIKOMA_SKILLS?.split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (skills?.length && !workDir) {
    // 与 CLI 的解析期校验、提示词文件的启动期快败同一姿势：配置错误不允许
    // "健康"启动后每个 session.create 才在运行期报错。
    throw new Error('TACHIKOMA_SKILLS requires TACHIKOMA_WORKDIR (skills need the read tool).');
  }

  let systemPrompt: string | undefined;
  const promptFile = env.TACHIKOMA_SYSTEM_PROMPT_FILE;
  if (promptFile) {
    let content: string;
    try {
      content = readFileSync(promptFile, 'utf8');
    } catch (error) {
      throw new Error(
        `TACHIKOMA_SYSTEM_PROMPT_FILE is not readable: ${promptFile} (${
          error instanceof Error ? error.message : String(error)
        })`,
        { cause: error }
      );
    }
    if (!content.trim()) {
      throw new Error(`TACHIKOMA_SYSTEM_PROMPT_FILE is empty: ${promptFile}`);
    }
    systemPrompt = content;
  }

  const reasoningSummary = env.TACHIKOMA_REASONING_SUMMARY;
  if (
    reasoningSummary !== undefined &&
    reasoningSummary !== 'auto' &&
    reasoningSummary !== 'concise' &&
    reasoningSummary !== 'detailed'
  ) {
    // 同 systemPrompt 的姿势：配置错误启动即失败，不静默降级
    throw new Error(
      `TACHIKOMA_REASONING_SUMMARY must be auto | concise | detailed, got: ${reasoningSummary}`
    );
  }

  return {
    dataDir,
    engineConfig: {
      dataDir,
      ...(configDir ? { configDir } : {}),
      ...(provider && model ? { model: { provider, model } } : {}),
      ...(workDir ? { workDir } : {}),
      ...(toolset ? { toolset } : {}),
      ...(skills?.length ? { skills } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(reasoningSummary ? { reasoningSummary } : {}),
      memory:
        env.TACHIKOMA_NO_MEMORY === '1'
          ? false
          : { ...(env.TACHIKOMA_USER_ID ? { userId: env.TACHIKOMA_USER_ID } : {}) },
    },
    sessionDefaults: {
      ...(workDir ? { workDir } : {}),
      ...(toolset ? { toolset } : {}),
      ...(skills?.length ? { skills } : {}),
    },
  };
}
