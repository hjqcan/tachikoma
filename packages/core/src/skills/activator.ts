/**
 * Skill 激活器
 *
 * 负责 Level 2 激活逻辑：判断哪些 skills 需要完整加载
 *
 * 激活触发条件：
 * 1. 显式调用：用户输入包含 $skill-name
 * 2. 自动匹配：任务描述与 skill description 高度相关
 *
 * @module skills/activator
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type {
  SkillMetadata,
  ActivatedSkill,
  SkillActivationOptions,
} from './types';
import {
  DEFAULT_AUTO_ACTIVATE_THRESHOLD,
  DEFAULT_MAX_AUTO_ACTIVATED,
  DEFAULT_MAX_ACTIVATED_TOKENS,
} from './types';
import { matchSkillsToTask, type SkillRecommendation } from './skill-matcher';
import { extractFrontmatter } from './loader';

// ============================================================================
// 显式调用解析
// ============================================================================

/**
 * 显式调用语法正则
 *
 * 支持格式：
 * - $skill-name (主要语法，不会与邮箱冲突)
 * - /skill skill-name (命令式语法)
 * 
 * 注意：移除了 @skill-name 语法以避免与邮箱、GitHub mentions 冲突
 */
const EXPLICIT_SKILL_PATTERNS = [
  // $skill-name: 需要单词边界，skill 名称必须以字母开头
  /(?:^|[\s\u4e00-\u9fa5])\$([a-z][a-z0-9-]*)(?=[\s\u4e00-\u9fa5,;:.!?]|$)/gi,
  // /skill skill-name: 命令式语法
  /\/skill\s+([a-z][a-z0-9-]*)/gi,
];

/**
 * 解析显式调用语法
 *
 * @param input - 用户输入（任务描述或消息）
 * @returns 提取的 skill 名称列表（去重）
 *
 * @example
 * parseExplicitSkillCalls('使用 $frontend-design 创建页面')
 * // => ['frontend-design']
 * 
 * parseExplicitSkillCalls('发送邮件到 user@example.com')
 * // => [] (不会误匹配邮箱)
 */
export function parseExplicitSkillCalls(input: string): string[] {
  if (!input) return [];

  const skills = new Set<string>();

  for (const pattern of EXPLICIT_SKILL_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      const skillName = match[1];
      if (skillName) {
        skills.add(skillName.toLowerCase());
      }
    }
  }

  return Array.from(skills);
}

// ============================================================================
// Skill Body 加载
// ============================================================================

/**
 * 异步加载 SKILL.md 正文
 *
 * @param skillPath - SKILL.md 文件路径
 * @returns 正文内容和 hash，或 null（如果读取失败）
 */
export async function loadSkillBodyAsync(
  skillPath: string
): Promise<{ body: string; hash: string } | null> {
  try {
    const content = await fs.promises.readFile(skillPath, 'utf-8');
    const parsed = extractFrontmatter(content);
    if (!parsed?.body) return null;
    
    const hash = computeContentHash(parsed.body);
    return { body: parsed.body, hash };
  } catch {
    return null;
  }
}

/**
 * 同步加载 SKILL.md 正文（向后兼容）
 *
 * @param skillPath - SKILL.md 文件路径
 * @returns 正文内容，或 null（如果读取失败）
 * @deprecated 建议使用 loadSkillBodyAsync
 */
export function loadSkillBody(skillPath: string): string | null {
  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const parsed = extractFrontmatter(content);
    return parsed?.body ?? null;
  } catch {
    return null;
  }
}

/**
 * 计算内容 hash（用于缓存验证）
 */
export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 估算文本 token 数
 *
 * 改进的估算方法：
 * - ASCII 字符: ~4 字符 ≈ 1 token
 * - CJK 字符: ~1.5 字符 ≈ 1 token (中日韩文字会被 BPE 拆分)
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code > 0x4e00 && code < 0x9fff) {
      // CJK Unified Ideographs
      tokens += 0.67; // ~1.5 chars per token
    } else if (code > 0x3000 && code < 0x303f) {
      // CJK Punctuation
      tokens += 0.5;
    } else if (code > 0xff00 && code < 0xffef) {
      // Fullwidth forms
      tokens += 0.5;
    } else {
      // ASCII and other
      tokens += 0.25; // ~4 chars per token
    }
  }
  return Math.ceil(tokens);
}

// ============================================================================
// 核心激活逻辑
// ============================================================================

/**
 * 激活匹配的 Skills（同步版本）
 *
 * 根据任务描述和激活选项，决定哪些 skills 需要 Level 2 激活
 *
 * @param skills - 所有已加载的 skill 元数据
 * @param taskDescription - 任务描述
 * @param options - 激活选项
 * @returns 激活的 skill 列表（包含完整 body）
 *
 * @example
 * const activated = activateSkills(skills, '创建一个现代化网站首页', {
 *   autoActivate: true,
 *   explicitSkills: ['frontend-design']
 * });
 */
export function activateSkills(
  skills: SkillMetadata[],
  taskDescription: string,
  options: SkillActivationOptions = {}
): ActivatedSkill[] {
  const {
    explicitSkills = [],
    autoActivate = true,
    autoActivateThreshold = DEFAULT_AUTO_ACTIVATE_THRESHOLD,
    maxAutoActivated = DEFAULT_MAX_AUTO_ACTIVATED,
    maxActivatedTokens = DEFAULT_MAX_ACTIVATED_TOKENS,
  } = options;

  const activated: ActivatedSkill[] = [];
  const activatedNames = new Set<string>();
  let totalTokens = 0;

  // 解析任务描述中的显式调用
  const explicitFromTask = parseExplicitSkillCalls(taskDescription);
  const allExplicit = new Set([
    ...explicitSkills.map(s => s.toLowerCase()),
    ...explicitFromTask,
  ]);

  // 创建 name -> metadata 映射
  const skillMap = new Map(skills.map(s => [s.name.toLowerCase(), s]));

  // 1. 首先处理显式调用的 skills
  for (const skillName of allExplicit) {
    const metadata = skillMap.get(skillName);
    if (!metadata) {
      console.warn(`[SkillActivator] Explicit skill not found: ${skillName}`);
      continue;
    }

    if (activatedNames.has(skillName)) continue;

    const body = loadSkillBody(metadata.path);
    if (!body) {
      console.warn(`[SkillActivator] Failed to load body for: ${skillName}`);
      continue;
    }

    const bodyTokens = estimateTokens(body);
    if (totalTokens + bodyTokens > maxActivatedTokens) {
      console.warn(
        `[SkillActivator] Token budget exceeded, skipping: ${skillName}`
      );
      continue;
    }

    activated.push({
      metadata,
      body,
      reason: 'explicit',
      hash: computeContentHash(body),
    });
    activatedNames.add(skillName);
    totalTokens += bodyTokens;

    console.debug(`[SkillActivator] Explicitly activated: ${skillName}`);
  }

  // 2. 自动激活 highly-relevant skills
  if (autoActivate && taskDescription) {
    const recommendations = matchSkillsToTask(taskDescription, skills);

    // 过滤出高于阈值的推荐
    const highScoreRecs = recommendations.filter(
      (r: SkillRecommendation) => r.score >= autoActivateThreshold
    );

    let autoActivatedCount = 0;

    for (const rec of highScoreRecs) {
      if (autoActivatedCount >= maxAutoActivated) break;

      const skillName = rec.skill.name.toLowerCase();
      if (activatedNames.has(skillName)) continue;

      const body = loadSkillBody(rec.skill.path);
      if (!body) continue;

      const bodyTokens = estimateTokens(body);
      if (totalTokens + bodyTokens > maxActivatedTokens) {
        console.debug(
          `[SkillActivator] Token budget exceeded for auto-activate: ${skillName}`
        );
        break;
      }

      activated.push({
        metadata: rec.skill,
        body,
        reason: 'auto-matched',
        score: rec.score,
        hash: computeContentHash(body),
      });
      activatedNames.add(skillName);
      totalTokens += bodyTokens;
      autoActivatedCount++;

      console.debug(
        `[SkillActivator] Auto-activated: ${skillName} (score: ${rec.score})`
      );
    }
  }

  return activated;
}

/**
 * 激活匹配的 Skills（异步版本，推荐使用）
 *
 * 非阻塞版本，适合在主线程中使用
 *
 * @param skills - 所有已加载的 skill 元数据
 * @param taskDescription - 任务描述
 * @param options - 激活选项
 * @returns 激活的 skill 列表（包含完整 body 和 hash）
 */
export async function activateSkillsAsync(
  skills: SkillMetadata[],
  taskDescription: string,
  options: SkillActivationOptions = {}
): Promise<ActivatedSkill[]> {
  const {
    explicitSkills = [],
    autoActivate = true,
    autoActivateThreshold = DEFAULT_AUTO_ACTIVATE_THRESHOLD,
    maxAutoActivated = DEFAULT_MAX_AUTO_ACTIVATED,
    maxActivatedTokens = DEFAULT_MAX_ACTIVATED_TOKENS,
  } = options;

  const activated: ActivatedSkill[] = [];
  const activatedNames = new Set<string>();
  let totalTokens = 0;

  // 解析任务描述中的显式调用
  const explicitFromTask = parseExplicitSkillCalls(taskDescription);
  const allExplicit = new Set([
    ...explicitSkills.map(s => s.toLowerCase()),
    ...explicitFromTask,
  ]);

  // 创建 name -> metadata 映射
  const skillMap = new Map(skills.map(s => [s.name.toLowerCase(), s]));

  // 1. 首先处理显式调用的 skills
  for (const skillName of allExplicit) {
    const metadata = skillMap.get(skillName);
    if (!metadata) {
      console.warn(`[SkillActivator] Explicit skill not found: ${skillName}`);
      continue;
    }

    if (activatedNames.has(skillName)) continue;

    // eslint-disable-next-line no-await-in-loop -- Sequential to respect token budget
    const result = await loadSkillBodyAsync(metadata.path);
    if (!result) {
      console.warn(`[SkillActivator] Failed to load body for: ${skillName}`);
      continue;
    }

    const { body, hash } = result;
    const bodyTokens = estimateTokens(body);
    if (totalTokens + bodyTokens > maxActivatedTokens) {
      console.warn(
        `[SkillActivator] Token budget exceeded, skipping: ${skillName}`
      );
      continue;
    }

    activated.push({
      metadata,
      body,
      reason: 'explicit',
      hash,
    });
    activatedNames.add(skillName);
    totalTokens += bodyTokens;

    console.debug(`[SkillActivator] Explicitly activated: ${skillName}`);
  }

  // 2. 自动激活 highly-relevant skills
  if (autoActivate && taskDescription) {
    const recommendations = matchSkillsToTask(taskDescription, skills);

    // 过滤出高于阈值的推荐
    const highScoreRecs = recommendations.filter(
      (r: SkillRecommendation) => r.score >= autoActivateThreshold
    );

    let autoActivatedCount = 0;

    for (const rec of highScoreRecs) {
      if (autoActivatedCount >= maxAutoActivated) break;

      const skillName = rec.skill.name.toLowerCase();
      if (activatedNames.has(skillName)) continue;

      // eslint-disable-next-line no-await-in-loop -- Sequential to respect token budget
      const result = await loadSkillBodyAsync(rec.skill.path);
      if (!result) continue;

      const { body, hash } = result;
      const bodyTokens = estimateTokens(body);
      if (totalTokens + bodyTokens > maxActivatedTokens) {
        console.debug(
          `[SkillActivator] Token budget exceeded for auto-activate: ${skillName}`
        );
        break;
      }

      activated.push({
        metadata: rec.skill,
        body,
        reason: 'auto-matched',
        score: rec.score,
        hash,
      });
      activatedNames.add(skillName);
      totalTokens += bodyTokens;
      autoActivatedCount++;

      console.debug(
        `[SkillActivator] Auto-activated: ${skillName} (score: ${rec.score})`
      );
    }
  }

  return activated;
}

// ============================================================================
// 渲染辅助
// ============================================================================

/**
 * 渲染激活的 Skill 到 prompt 格式
 *
 * @param activatedSkill - 已激活的 skill
 * @returns 格式化的 prompt 片段
 */
export function renderActivatedSkill(activatedSkill: ActivatedSkill): string {
  const { metadata, body, reason: _reason, score: _score } = activatedSkill;

  const lines: string[] = [];

  // 标题
  lines.push(`## 🔧 Active Skill: ${metadata.name}`);
  lines.push('');

  // 激活原因（仅用于 debug，不输出到 prompt）
  // lines.push(`_Activated by: ${_reason}${_score ? ` (score: ${_score})` : ''}_`);

  // 正文内容
  lines.push(body);

  // 分隔线
  lines.push('');
  lines.push('---');

  return lines.join('\n');
}

/**
 * 渲染所有激活的 Skills
 *
 * @param activatedSkills - 激活的 skill 列表
 * @returns 完整的 prompt 片段
 */
export function renderActivatedSkills(
  activatedSkills: ActivatedSkill[]
): string | null {
  if (activatedSkills.length === 0) return null;

  const lines: string[] = [];

  lines.push('# Active Skills');
  lines.push('');
  lines.push(
    'The following skills have been activated for this task. ' +
    'Follow their instructions carefully.'
  );
  lines.push('');

  for (const skill of activatedSkills) {
    lines.push(renderActivatedSkill(skill));
  }

  return lines.join('\n');
}