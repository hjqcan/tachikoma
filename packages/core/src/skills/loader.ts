/**
 * Skill 加载器
 *
 * 负责发现和解析 SKILL.md 文件
 *
 * @module skills/loader
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type {
  SkillMetadata,
  SkillContent,
  SkillError,
  SkillLoadOutcome,
  SkillDiscoveryConfig,
  SkillType,
} from './types';

import {
  SKILL_FILENAME,
  SCRIPTS_DIR_NAME,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  NAME_PATTERN,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_SKILL_TYPE,
} from './types';

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认全局 Skills 目录
 */
export const DEFAULT_GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.tachikoma', 'skills');

/**
 * 默认项目级 Skills 目录名
 */
export const DEFAULT_PROJECT_SKILLS_DIR_NAME = '.tachikoma/skills';

// ============================================================================
// 核心加载函数
// ============================================================================

/**
 * 加载 Skills
 *
 * 扫描配置的目录，发现并解析所有 SKILL.md 文件
 *
 * @param config - 发现配置
 * @param cwd - 当前工作目录（用于解析项目级目录）
 * @returns 加载结果
 */
export function loadSkills(
  config: SkillDiscoveryConfig = {},
  cwd?: string
): SkillLoadOutcome {
  const outcome: SkillLoadOutcome = {
    skills: [],
    errors: [],
  };

  // 如果禁用，直接返回
  if (config.enabled === false) {
    return outcome;
  }

  // 收集所有搜索目录
  const searchDirs = getSearchDirs(config, cwd);
  
  // 获取忽略目录列表
  const ignoreDirs = new Set(config.ignoreDirs ?? DEFAULT_IGNORE_DIRS);

  // 遍历每个目录
  for (const dir of searchDirs) {
    discoverSkillsInDir(dir, outcome, ignoreDirs);
  }

  // 按名称排序（保持稳定）
  outcome.skills.sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    return a.path.localeCompare(b.path);
  });

  return outcome;
}

/**
 * 按 scope 加载 Skills
 *
 * 在所有搜索目录下查找指定的 scope 子目录（如 'orchestrator', 'worker'），
 * 仅加载该子目录下的 Skills。
 *
 * @param scope - 范围目录名（如 'orchestrator', 'worker', 'shared'）
 * @param config - 发现配置
 * @param cwd - 当前工作目录
 * @returns 加载结果
 *
 * @example
 * ```ts
 * // 加载 orchestrator 专用 skills
 * const outcome = loadSkillsByScope('orchestrator', config, cwd);
 * console.log(`Loaded ${outcome.skills.length} orchestrator skills`);
 * ```
 */
export function loadSkillsByScope(
  scope: string,
  config: SkillDiscoveryConfig = {},
  cwd?: string
): SkillLoadOutcome {
  const outcome: SkillLoadOutcome = {
    skills: [],
    errors: [],
  };

  // 如果禁用，直接返回
  if (config.enabled === false) {
    return outcome;
  }

  // 收集所有搜索目录
  const searchDirs = getSearchDirs(config, cwd);
  
  // 获取忽略目录列表
  const ignoreDirs = new Set(config.ignoreDirs ?? DEFAULT_IGNORE_DIRS);

  // 要搜索的子目录：指定 scope + shared（共享技能）
  const scopesToSearch = [scope, 'shared'];

  // 遍历每个目录，查找 scope 和 shared 子目录
  for (const dir of searchDirs) {
    for (const scopeDir of scopesToSearch) {
      const scopedDir = path.join(dir, scopeDir);
      // 检查 scope 目录是否存在
      if (fs.existsSync(scopedDir)) {
        try {
          const stat = fs.statSync(scopedDir);
          if (stat.isDirectory()) {
            discoverSkillsInDir(scopedDir, outcome, ignoreDirs);
          }
        } catch {
          // 忽略访问错误
        }
      }
    }
  }

  // 按名称排序（保持稳定）
  outcome.skills.sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    return a.path.localeCompare(b.path);
  });

  return outcome;
}

/**
 * 获取所有搜索目录
 *
 * @internal 内部使用，也可被外部调用以了解搜索路径
 */
export function getSearchDirs(config: SkillDiscoveryConfig, cwd?: string): string[] {
  const dirs: string[] = [];

  // 全局目录
  const globalDir = config.globalDir ?? DEFAULT_GLOBAL_SKILLS_DIR;
  dirs.push(globalDir);

  // 项目级目录
  if (cwd) {
    const projectDir = config.projectDir ?? path.join(cwd, DEFAULT_PROJECT_SKILLS_DIR_NAME);
    dirs.push(projectDir);
    
    // 根目录 skills/ (官方 Skills 库)
    // 支持 Anthropic 推荐的 skills/ 顶级目录结构
    const rootSkillsDir = path.join(cwd, 'skills');
    dirs.push(rootSkillsDir);
    
    // node_modules/@tachikoma/skills (npm 安装的官方 Skills)
    // 用户通过 npm install @tachikoma/skills 安装后自动加载
    const nodeModulesSkillsDir = path.join(cwd, 'node_modules', '@tachikoma', 'skills');
    dirs.push(nodeModulesSkillsDir);
  }

  // 额外目录
  if (config.additionalDirs) {
    dirs.push(...config.additionalDirs);
  }

  return dirs;
}

/**
 * 在目录中发现 Skills
 *
 * 递归扫描，跳过隐藏目录、符号链接和忽略目录
 */
function discoverSkillsInDir(
  dir: string,
  outcome: SkillLoadOutcome,
  ignoreDirs: Set<string>
): void {
  // 尝试解析目录路径
  let resolvedDir: string;
  try {
    // 检查目录是否存在
    if (!fs.existsSync(dir)) {
      return;
    }

    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      return;
    }

    resolvedDir = fs.realpathSync(dir);
  } catch {
    // 目录不存在或无法访问，忽略
    return;
  }

  // 使用队列进行广度优先遍历
  const queue: string[] = [resolvedDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      // 无法读取目录，跳过
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      // 跳过隐藏目录/文件
      if (entry.name.startsWith('.')) {
        continue;
      }

      // 跳过符号链接
      if (entry.isSymbolicLink()) {
        continue;
      }

      // 如果是目录，检查是否在忽略列表中
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          queue.push(entryPath);
        }
        continue;
      }

      // 如果是 SKILL.md 文件，解析它
      if (entry.isFile() && entry.name === SKILL_FILENAME) {
        const result = parseSkillFile(entryPath);
        if ('message' in result) {
          outcome.errors.push(result);
        } else {
          outcome.skills.push(result);
        }
      }
    }
  }
}

// ============================================================================
// SKILL.md 解析
// ============================================================================

/**
 * 解析 SKILL.md 文件
 *
 * @param filePath - 文件绝对路径
 * @returns 解析后的元数据或错误
 */
export function parseSkillFile(filePath: string): SkillMetadata | SkillError {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = extractFrontmatter(content);

    if (!parsed) {
      return {
        path: filePath,
        message: 'Missing YAML frontmatter delimited by ---',
      };
    }

    const { frontmatter } = parsed;

    // 解析 YAML frontmatter
    const metadata = parseYamlFrontmatter(frontmatter);
    if ('message' in metadata) {
      return { path: filePath, message: metadata.message };
    }

    // 验证必填字段
    const validation = validateMetadata(metadata);
    if (validation) {
      return { path: filePath, message: validation };
    }

    // 规范化路径（使用正斜杠）
    const normalizedPath = filePath.replace(/\\/g, '/');

    const result: SkillMetadata = {
      name: sanitizeSingleLine(metadata.name!),
      description: sanitizeSingleLine(metadata.description!),
      path: normalizedPath,
      // 新增字段：向后兼容，无 skillType 时默认为 'executable'
      skillType: metadata.skillType ?? DEFAULT_SKILL_TYPE,
    };

    if (metadata.license) {
      result.license = metadata.license;
    }

    // 可选字段：category
    if (metadata.category) {
      result.category = sanitizeSingleLine(metadata.category);
    }

    // 可选字段：tags（解析逗号分隔或 YAML 数组）
    if (metadata.tags && metadata.tags.length > 0) {
      result.tags = metadata.tags.map(t => sanitizeSingleLine(t));
    }

    return result;
  } catch (err) {
    return {
      path: filePath,
      message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 提取 YAML frontmatter
 *
 * @param content - 文件内容
 * @returns frontmatter 和 body，或 null
 */
export function extractFrontmatter(
  content: string
): { frontmatter: string; body: string } | null {
  const lines = content.split('\n');

  // 第一行必须是 ---
  const first = lines[0];
  if (!first || first.trim() !== '---') {
    return null;
  }

  // 查找结束的 ---
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return null;
  }

  const frontmatter = lines.slice(1, endIndex).join('\n');
  const body = lines.slice(endIndex + 1).join('\n').trim();

  if (!frontmatter.trim()) {
    return null;
  }

  return { frontmatter, body };
}

/**
 * YAML frontmatter 解析结果类型
 */
interface ParsedFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  skillType?: SkillType;
  category?: string;
  tags?: string[];
}

/**
 * 简单的 YAML frontmatter 解析器
 *
 * 支持简单的 key: value 格式，以及 tags 列表
 */
function parseYamlFrontmatter(
  yaml: string
): ParsedFrontmatter | { message: string } {
  const result: ParsedFrontmatter = {};

  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let isParsingList = false;

  const flushKey = () => {
    if (currentKey && currentValue.length > 0) {
      const value = currentValue.join(' ').trim();
      if (currentKey === 'name') {
        result.name = value;
      } else if (currentKey === 'description') {
        result.description = value;
      } else if (currentKey === 'license') {
        result.license = value;
      } else if (currentKey === 'skillType') {
        // 验证 skillType 值
        if (value === 'executable' || value === 'knowledge') {
          result.skillType = value;
        }
        // 无效值时保持 undefined，使用默认值
      } else if (currentKey === 'category') {
        result.category = value;
      }
      // tags 由列表解析逻辑处理
    }
    currentKey = null;
    currentValue = [];
    isParsingList = false;
  };

  for (const line of lines) {
    // 检查是否是 YAML 列表项 (- value)
    if (isParsingList && line.match(/^\s+-\s+(.*)$/)) {
      const listMatch = line.match(/^\s+-\s+(.*)$/);
      if (listMatch && listMatch[1]) {
        const listValue = listMatch[1].trim();
        // 移除引号
        if ((listValue.startsWith('"') && listValue.endsWith('"')) ||
            (listValue.startsWith("'") && listValue.endsWith("'"))) {
          result.tags = result.tags || [];
          result.tags.push(listValue.slice(1, -1));
        } else {
          result.tags = result.tags || [];
          result.tags.push(listValue);
        }
        continue;
      }
    }

    // 检查是否是新键
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch && keyMatch[1] && keyMatch[2] !== undefined) {
      flushKey();
      currentKey = keyMatch[1];
      const inlineValue = keyMatch[2].trim();

      // 检查是否是列表开始 (tags:)
      if (currentKey === 'tags' && !inlineValue) {
        isParsingList = true;
        continue;
      }

      // 处理 tags 的内联数组格式 [tag1, tag2, tag3]
      if (currentKey === 'tags' && inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
        const arrayContent = inlineValue.slice(1, -1);
        result.tags = arrayContent
          .split(',')
          .map(t => t.trim())
          .filter(t => t.length > 0)
          .map(t => {
            // 移除引号
            if ((t.startsWith('"') && t.endsWith('"')) ||
                (t.startsWith("'") && t.endsWith("'"))) {
              return t.slice(1, -1);
            }
            return t;
          });
        currentKey = null;
        continue;
      }

      // 处理 YAML 多行字符串 (|-  或 |)
      if (inlineValue === '|-' || inlineValue === '|' || inlineValue === '>-' || inlineValue === '>') {
        // 多行模式，值在后续行
      } else if (inlineValue.startsWith('"') && inlineValue.endsWith('"')) {
        // 带引号的字符串
        currentValue.push(inlineValue.slice(1, -1));
      } else if (inlineValue.startsWith("'") && inlineValue.endsWith("'")) {
        currentValue.push(inlineValue.slice(1, -1));
      } else if (inlineValue) {
        currentValue.push(inlineValue);
      }
    } else if (currentKey && line.startsWith('  ') && !isParsingList) {
      // 多行值的延续
      currentValue.push(line.trim());
    }
  }

  flushKey();

  return result;
}

/**
 * 验证元数据
 *
 * @returns 错误信息，或 null 表示验证通过
 */
function validateMetadata(metadata: {
  name?: string;
  description?: string;
}): string | null {
  // 检查必填字段
  if (!metadata.name || !metadata.name.trim()) {
    return 'Missing required field: name';
  }

  if (!metadata.description || !metadata.description.trim()) {
    return 'Missing required field: description';
  }

  // 检查长度限制
  const name = sanitizeSingleLine(metadata.name);
  const description = sanitizeSingleLine(metadata.description);

  if (name.length > MAX_NAME_LENGTH) {
    return `Field 'name' exceeds maximum length of ${MAX_NAME_LENGTH} characters`;
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return `Field 'description' exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`;
  }

  // 检查 name 格式（kebab-case，但只警告不拒绝）
  // 注：为了兼容性，非 kebab-case 名称只输出警告不报错
  if (!NAME_PATTERN.test(name)) {
    console.warn(
      `[SkillLoader] Skill name "${name}" is not in kebab-case format. ` +
      'Consider using lowercase letters, numbers, and hyphens only (e.g., "my-skill").'
    );
  }

  return null;
}

/**
 * 清理字符串为单行
 *
 * 将多行内容合并为单行，去除多余空白
 */
function sanitizeSingleLine(str: string): string {
  return str.split(/\s+/).join(' ').trim();
}

// ============================================================================
// Level 2 加载
// ============================================================================

/**
 * 加载 Skill 完整内容
 *
 * 读取 SKILL.md body 和相关资源
 *
 * @param metadata - Skill 元数据
 * @returns 完整内容
 */
export async function loadSkillContent(metadata: SkillMetadata): Promise<SkillContent> {
  const content = fs.readFileSync(metadata.path, 'utf-8');
  const parsed = extractFrontmatter(content);

  const body = parsed?.body ?? '';
  const skillDir = path.dirname(metadata.path);

  // 发现资源文件（同目录下的 .md 文件，排除 SKILL.md）
  const resources: string[] = [];
  try {
    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        entry.name !== SKILL_FILENAME
      ) {
        resources.push(path.join(skillDir, entry.name));
      }
    }
  } catch {
    // 忽略读取错误
  }

  // 检查是否有 scripts 目录
  const scriptsDirPath = path.join(skillDir, SCRIPTS_DIR_NAME);
  const hasScriptsDir = fs.existsSync(scriptsDirPath) && fs.statSync(scriptsDirPath).isDirectory();

  const result: SkillContent = {
    ...metadata,
    body,
    resources,
  };

  if (hasScriptsDir) {
    result.scriptsDir = scriptsDirPath;
  }

  return result;
}
