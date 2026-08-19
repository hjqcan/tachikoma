/**
 * 命名 preset：<configDir>/presets/<name>.json —— 会话组合的命名数据面。
 *
 * preset 是"机制开源、内容外置"的组合通道：开源仓库只提供解析与合并语义，
 * 垂直场景（闭源侧）以数据文件下发 提示词 + skills + 工具集 的成套组合。
 * 边缘（CLI --preset / engined TACHIKOMA_PRESET）解析后并入 ChatEngineConfig；
 * ChatEngine 本身不感知 preset。
 *
 * 语义：相对路径按 preset 文件所在目录解析（preset 目录 = 可搬运包）；
 * 全部失败响亮（缺文件列出可用名、未知键拒绝、提示词立即读、skills 逐条查存在）；
 * 不做 $ENV 插值（preset 不携密——密钥归 models.json / pi 凭证面）。
 * 合并序归调用方：显式 flag/env > preset > 环境默认。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { CHAT_REASONING_SUMMARIES, CHAT_THINKING_LEVELS } from './types.ts';
import type {
  ChatMemoryEmbeddingConfig,
  ChatMemoryModelConfig,
  ChatModelRef,
  ChatReasoningSummary,
  ChatThinkingLevel,
  ChatToolset,
} from './types.ts';

const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const KNOWN_KEYS: readonly string[] = [
  'systemPromptFile',
  'skills',
  'toolset',
  'workDir',
  'model',
  'thinkingLevel',
  'reasoningSummary',
  'memory',
];

/** preset 可组合的记忆面：仅质量档适配器（身份/库路径是部署关切，不进组合面） */
export interface ChatPresetMemoryAdapters {
  embedding?: ChatMemoryEmbeddingConfig;
  extractor?: ChatMemoryModelConfig;
}

export interface ChatPresetResolved {
  /** systemPromptFile 在解析期读出的内容（快败：不可读/空文件即抛） */
  systemPrompt?: string;
  /** 已按 preset 目录解析为绝对路径，且逐条验证存在 */
  skills?: string[];
  toolset?: ChatToolset;
  workDir?: string;
  model?: ChatModelRef;
  thinkingLevel?: ChatThinkingLevel;
  reasoningSummary?: ChatReasoningSummary;
  /**
   * false = 显式关闭记忆；对象 = 质量档适配器（embedding/extractor）。
   * 身份/库路径仍是部署关切，不进组合面；apiKeyEnv 只携环境变量名，preset 不携密。
   */
  memory?: false | ChatPresetMemoryAdapters;
}

function presetError(name: string, detail: string): Error {
  return new Error(`Preset "${name}" is invalid: ${detail}`);
}

/**
 * 读系统提示词文件，快败：不可读或空文件即抛。--system-prompt-file、
 * TACHIKOMA_SYSTEM_PROMPT_FILE、preset systemPromptFile 三个入口共用同一实现，
 * 保证同一文件在三处行为一致。label 用于报错点名调用方的入口名。
 */
export function readPromptFile(path: string, label: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `${label} is not readable: ${path} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
  if (!content.trim()) {
    throw new Error(`${label} is empty: ${path}`);
  }
  return content;
}

/** 解析 <configDir>/presets/<name>.json；一切失败响亮，绝不静默降级 */
export function resolvePreset(configDir: string, name: string): ChatPresetResolved {
  if (!PRESET_NAME.test(name)) {
    throw new Error(
      `Invalid preset name: ${JSON.stringify(name)} (allowed: letters, digits, ".", "_", "-")`
    );
  }
  const presetsDir = join(resolve(configDir), 'presets');
  const path = join(presetsDir, `${name}.json`);
  if (!existsSync(path)) {
    let available: string[] = [];
    try {
      available = readdirSync(presetsDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .sort();
    } catch {
      // presets/ 目录本身不存在：available 留空。
    }
    throw new Error(
      `Preset not found: ${path}${available.length > 0 ? ` (available: ${available.join(', ')})` : ''}`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw presetError(
      name,
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw presetError(name, 'top level must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw presetError(name, `unknown key "${key}" (known: ${KNOWN_KEYS.join(', ')})`);
    }
  }

  const baseDir = dirname(path);
  const resolveEntry = (value: string): string =>
    isAbsolute(value) ? value : resolve(baseDir, value);
  const resolved: ChatPresetResolved = {};

  if (record.systemPromptFile !== undefined) {
    if (typeof record.systemPromptFile !== 'string' || record.systemPromptFile.length === 0) {
      throw presetError(name, 'systemPromptFile must be a non-empty string');
    }
    try {
      resolved.systemPrompt = readPromptFile(
        resolveEntry(record.systemPromptFile),
        'systemPromptFile'
      );
    } catch (error) {
      throw presetError(name, error instanceof Error ? error.message : String(error));
    }
  }

  if (record.skills !== undefined) {
    if (
      !Array.isArray(record.skills) ||
      record.skills.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
      throw presetError(name, 'skills must be an array of non-empty strings');
    }
    const skills = (record.skills as string[]).map(resolveEntry);
    for (const skill of skills) {
      if (!existsSync(skill)) {
        throw presetError(name, `skills path does not exist: ${skill}`);
      }
    }
    resolved.skills = skills;
  }

  if (record.toolset !== undefined) {
    if (record.toolset !== 'read-only' && record.toolset !== 'coding') {
      throw presetError(
        name,
        `toolset must be "read-only" | "coding", got: ${String(record.toolset)}`
      );
    }
    resolved.toolset = record.toolset;
  }

  if (record.workDir !== undefined) {
    if (typeof record.workDir !== 'string' || record.workDir.length === 0) {
      throw presetError(name, 'workDir must be a non-empty string');
    }
    const workDir = resolveEntry(record.workDir);
    if (!existsSync(workDir)) {
      throw presetError(name, `workDir does not exist: ${workDir}`);
    }
    resolved.workDir = workDir;
  }

  if (record.model !== undefined) {
    const model = record.model as { provider?: unknown; model?: unknown } | null;
    if (
      !model ||
      typeof model !== 'object' ||
      typeof model.provider !== 'string' ||
      typeof model.model !== 'string' ||
      Object.keys(model).length !== 2
    ) {
      throw presetError(name, 'model must be { "provider": string, "model": string }');
    }
    resolved.model = { provider: model.provider, model: model.model };
  }

  if (record.thinkingLevel !== undefined) {
    if (
      typeof record.thinkingLevel !== 'string' ||
      !(CHAT_THINKING_LEVELS as readonly string[]).includes(record.thinkingLevel)
    ) {
      throw presetError(
        name,
        `thinkingLevel must be one of ${CHAT_THINKING_LEVELS.join(' | ')}, got: ${String(record.thinkingLevel)}`
      );
    }
    resolved.thinkingLevel = record.thinkingLevel as ChatThinkingLevel;
  }

  if (record.reasoningSummary !== undefined) {
    if (
      typeof record.reasoningSummary !== 'string' ||
      !(CHAT_REASONING_SUMMARIES as readonly string[]).includes(record.reasoningSummary)
    ) {
      throw presetError(
        name,
        `reasoningSummary must be one of ${CHAT_REASONING_SUMMARIES.join(' | ')}, got: ${String(record.reasoningSummary)}`
      );
    }
    resolved.reasoningSummary = record.reasoningSummary as ChatReasoningSummary;
  }

  if (record.memory !== undefined) {
    resolved.memory = parsePresetMemory(name, record.memory);
  }

  return resolved;
}

/** memory 适配器条目校验：model 必填非空；baseUrl/apiKeyEnv 可选非空；未知键拒绝 */
function parsePresetMemoryAdapter(
  name: string,
  field: 'embedding' | 'extractor',
  value: unknown,
  extraKeys: readonly string[]
): { model: string; baseUrl?: string; apiKeyEnv?: string; dimensions?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw presetError(name, `memory.${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const known = ['model', 'baseUrl', 'apiKeyEnv', ...extraKeys];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      throw presetError(name, `memory.${field} unknown key "${key}" (known: ${known.join(', ')})`);
    }
  }
  if (typeof record.model !== 'string' || record.model.length === 0) {
    throw presetError(name, `memory.${field}.model must be a non-empty string`);
  }
  for (const key of ['baseUrl', 'apiKeyEnv'] as const) {
    const entry = record[key];
    if (entry !== undefined && (typeof entry !== 'string' || entry.length === 0)) {
      throw presetError(name, `memory.${field}.${key} must be a non-empty string`);
    }
  }
  if (
    record.dimensions !== undefined &&
    (typeof record.dimensions !== 'number' ||
      !Number.isInteger(record.dimensions) ||
      record.dimensions <= 0)
  ) {
    throw presetError(name, `memory.${field}.dimensions must be a positive integer`);
  }
  return {
    model: record.model,
    ...(record.baseUrl !== undefined ? { baseUrl: record.baseUrl as string } : {}),
    ...(record.apiKeyEnv !== undefined ? { apiKeyEnv: record.apiKeyEnv as string } : {}),
    ...(record.dimensions !== undefined ? { dimensions: record.dimensions } : {}),
  };
}

function parsePresetMemory(name: string, value: unknown): false | ChatPresetMemoryAdapters {
  if (value === false) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw presetError(
      name,
      'memory accepts false or { embedding?, extractor? } (identity and database path are deployment concerns, not preset composition)'
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'embedding' && key !== 'extractor') {
      throw presetError(
        name,
        `memory unknown key "${key}" (known: embedding, extractor; identity and database path are deployment concerns)`
      );
    }
  }
  const adapters: ChatPresetMemoryAdapters = {};
  if (record.embedding !== undefined) {
    adapters.embedding = parsePresetMemoryAdapter(name, 'embedding', record.embedding, [
      'dimensions',
    ]);
  }
  if (record.extractor !== undefined) {
    const { model, baseUrl, apiKeyEnv } = parsePresetMemoryAdapter(
      name,
      'extractor',
      record.extractor,
      []
    );
    adapters.extractor = {
      model,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    };
  }
  if (!adapters.embedding && !adapters.extractor) {
    throw presetError(name, 'memory object must configure embedding and/or extractor');
  }
  return adapters;
}

/** 边缘的显式覆盖面（flag / TACHIKOMA_* 变量）；skills 的 [] 是显式清空，undefined 是缺席 */
export interface ChatPresetOverrides {
  model?: ChatModelRef;
  workDir?: string;
  toolset?: ChatToolset;
  skills?: readonly string[];
  systemPrompt?: string;
  thinkingLevel?: ChatThinkingLevel;
  reasoningSummary?: ChatReasoningSummary;
  memoryOff?: boolean;
}

export interface ChatPresetMerged {
  model?: ChatModelRef;
  workDir?: string;
  toolset?: ChatToolset;
  /** 恒为非空数组或缺席（显式清空与缺席在合并后同样表现为无授予） */
  skills?: string[];
  systemPrompt?: string;
  thinkingLevel?: ChatThinkingLevel;
  reasoningSummary?: ChatReasoningSummary;
  memoryOff: boolean;
  /** preset 的质量档适配器；显式关闭（memoryOff）时被压掉 */
  memory?: ChatPresetMemoryAdapters;
}

/**
 * preset 合并的唯一实现：CLI 与 engined 共用，防两边各写一份后分叉。
 * 逐字段 显式 > preset；skills 区分「显式清空（[]）」与「缺席（undefined）」——
 * 前者压掉 preset 的 skills，后者才回落。跨字段检查在合并后跑（preset 的
 * workDir 可满足显式的 skills，反之亦然），报错文案中立，不点名单一入口。
 */
export function mergePresetConfig(
  overrides: ChatPresetOverrides,
  preset: ChatPresetResolved
): ChatPresetMerged {
  const model = overrides.model ?? preset.model;
  const workDir = overrides.workDir ?? preset.workDir;
  const toolset = overrides.toolset ?? preset.toolset;
  const skills = overrides.skills !== undefined ? [...overrides.skills] : preset.skills;
  const systemPrompt = overrides.systemPrompt ?? preset.systemPrompt;
  const thinkingLevel = overrides.thinkingLevel ?? preset.thinkingLevel;
  const reasoningSummary = overrides.reasoningSummary ?? preset.reasoningSummary;
  // 报错点名各入口的归属：TACHIKOMA_WORKDIR 只在 engined 生效，CLI 刻意不读它——
  // 不加归属的并列会给 CLI 用户指一条死路。
  if (toolset && !workDir) {
    throw new Error(
      'A toolset requires a workspace: grant workDir (CLI --workdir, engined TACHIKOMA_WORKDIR, or preset workDir)'
    );
  }
  if (skills?.length && !workDir) {
    throw new Error(
      'Skills require a workspace: grant workDir (CLI --workdir, engined TACHIKOMA_WORKDIR, or preset workDir)'
    );
  }
  return {
    ...(model ? { model } : {}),
    ...(workDir ? { workDir } : {}),
    ...(toolset ? { toolset } : {}),
    ...(skills?.length ? { skills } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    memoryOff: overrides.memoryOff === true || preset.memory === false,
    ...(overrides.memoryOff !== true && preset.memory !== undefined && preset.memory !== false
      ? { memory: preset.memory }
      : {}),
  };
}
