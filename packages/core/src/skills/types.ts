/**
 * Skills 模块类型定义
 *
 * 基于 Claude Agent Skills 规范设计
 *
 * @module skills/types
 */

// ============================================================================
// Skill 类型
// ============================================================================

/**
 * Skill 类型
 * 
 * - 'executable': 可执行脚本型技能，自动转换为 Tool（现有行为）
 * - 'knowledge': 知识型技能，仅注入到 Context（Letta-Code 启发）
 */
export type SkillType = 'executable' | 'knowledge';

/** 默认技能类型（保持向后兼容） */
export const DEFAULT_SKILL_TYPE: SkillType = 'executable';

// ============================================================================
// Skill 元数据（Level 1）
// ============================================================================

/**
 * Skill 元数据
 *
 * 始终加载到 system prompt，约 100 tokens
 * 对应 SKILL.md 的 YAML frontmatter
 */
export interface SkillMetadata {
  /** 技能名称（唯一标识，kebab-case，最大 100 字符） */
  name: string;

  /** 技能描述（触发条件，LLM 用于判断是否相关，最大 1024 字符） */
  description: string;

  /** SKILL.md 文件的绝对路径 */
  path: string;

  /** 许可证信息（可选） */
  license?: string;

  /**
   * 技能类型
   * - 'executable': 可执行脚本型（有 scripts/ 目录）
   * - 'knowledge': 知识型（仅 SKILL.md 正文）
   * @default 'executable'
   */
  skillType?: SkillType;

  /**
   * 技能分类（可选）
   * 用于组织和过滤技能，如 'data-processing', 'code-generation', 'debugging'
   */
  category?: string;

  /**
   * 技能标签列表（可选）
   * 用于更细粒度的检索和匹配，如 ['python', 'pandas', 'csv']
   */
  tags?: string[];

  /**
   * 依赖的工具（可选）
   * 当所需工具不可用时，Skills 注入应被跳过
   */
  requiresTools?: string[];
}

// ============================================================================
// Skill 完整内容（Level 2）
// ============================================================================

/**
 * Skill 完整内容
 *
 * 触发时加载，<5k tokens
 */
export interface SkillContent extends SkillMetadata {
  /** SKILL.md 正文内容（frontmatter 之后的部分） */
  body: string;

  /** 依赖的资源文档路径（如 docx-js.md） */
  resources: string[];

  /** 脚本目录路径（如果存在 scripts/ 子目录） */
  scriptsDir?: string;
}

// ============================================================================
// Skill 加载结果
// ============================================================================

/**
 * Skill 加载错误
 */
export interface SkillError {
  /** 出错的文件路径 */
  path: string;

  /** 错误信息 */
  message: string;
}

/**
 * Skill 加载结果
 *
 * 包含成功加载的 skills 和错误列表
 */
export interface SkillLoadOutcome {
  /** 成功加载的 skills */
  skills: SkillMetadata[];

  /** 加载错误 */
  errors: SkillError[];
}

// ============================================================================
// Skill 发现配置
// ============================================================================

/**
 * Skill 发现路径配置
 */
export interface SkillDiscoveryConfig {
  /**
   * 全局 Skills 目录
   * @default ~/.tachikoma/skills
   */
  globalDir?: string;

  /**
   * 项目级 Skills 目录
   * @default ${cwd}/.tachikoma/skills
   */
  projectDir?: string;

  /**
   * 额外的 Skills 目录列表
   */
  additionalDirs?: string[];

  /**
   * 是否启用 Skills 发现
   * @default true
   */
  enabled?: boolean;

  /**
   * 递归扫描时忽略的目录名列表
   * @default DEFAULT_IGNORE_DIRS
   */
  ignoreDirs?: string[];

  /**
   * Skills section 最大 token 预算
   * 超过时只注入前 N 个 skill
   * @default 2000
   */
  maxSkillTokens?: number;
}

// ============================================================================
// Skill 执行相关
// ============================================================================

/**
 * Skill 脚本执行选项
 */
export interface SkillExecutionOptions {
  /** 要执行的 Skill */
  skill: SkillContent;

  /** 脚本路径（相对于 skill 目录） */
  script: string;

  /** 脚本参数 */
  args?: string[];

  /** 环境变量 */
  env?: Record<string, string>;

  /** 超时时间（毫秒） */
  timeout?: number;

  /** 工作目录 */
  cwd?: string;
}

/**
 * Skill 脚本执行结果
 */
export interface SkillExecutionResult {
  /** 是否成功（exitCode === 0） */
  success: boolean;

  /** 标准输出 */
  stdout: string;

  /** 标准错误 */
  stderr: string;

  /** 退出码 */
  exitCode: number;

  /** 执行时间（毫秒） */
  duration: number;
}

// ============================================================================
// Skill 激活相关（Level 2）
// ============================================================================

/**
 * 激活原因
 */
export type ActivationReason = 'explicit' | 'auto-matched';

/**
 * 已激活的 Skill
 *
 * 包含完整的 SKILL.md 正文，准备注入到 context
 */
export interface ActivatedSkill {
  /** Skill 元数据 */
  metadata: SkillMetadata;

  /** SKILL.md 正文内容 */
  body: string;

  /** 激活原因 */
  reason: ActivationReason;

  /** 匹配分数（仅 auto-matched 时有值） */
  score?: number;

  /** 内容 hash（用于缓存验证） */
  hash?: string;
}

/**
 * Skill 激活选项
 */
export interface SkillActivationOptions {
  /**
   * 显式激活的 skill 名称列表
   * 支持 $skill-name 或直接名称
   */
  explicitSkills?: string[];

  /**
   * 是否自动激活 highly-relevant skills
   * @default true
   */
  autoActivate?: boolean;

  /**
   * 自动激活的最低分数阈值
   * @default 80 (highly-relevant)
   */
  autoActivateThreshold?: number;

  /**
   * 激活 skills 的最大 token 预算
   * @default 8000
   */
  maxActivatedTokens?: number;

  /**
   * 最大自动激活 skill 数量
   * @default 3
   */
  maxAutoActivated?: number;
}

/**
 * Skill 渲染选项
 */
export interface SkillRenderOptions extends SkillActivationOptions {
  /**
   * Skills section 最大 token 预算（元数据列表）
   */
  maxSkillTokens?: number;

  /**
   * 当前可用工具名称（用于过滤需要特定工具的 Skills）
   */
  availableToolNames?: string[];
}

/** 激活 skills 默认最大 token 预算 */
export const DEFAULT_MAX_ACTIVATED_TOKENS = 8000;

/** 默认自动激活阈值 */
export const DEFAULT_AUTO_ACTIVATE_THRESHOLD = 80;

/** 默认最大自动激活数量 */
export const DEFAULT_MAX_AUTO_ACTIVATED = 3;

// ============================================================================
// 常量
// ============================================================================

/** Skill 文件名 */
export const SKILL_FILENAME = 'SKILL.md';

/** 脚本目录名 */
export const SCRIPTS_DIR_NAME = 'scripts';

/** name 字段最大长度 */
export const MAX_NAME_LENGTH = 100;

/** description 字段最大长度 */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** name 字段格式正则（kebab-case） */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 默认忽略的目录名 */
export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.venv',
  '__pycache__',
  'target',
  '.turbo',
];

/** Skills section 默认最大 token 预算 */
export const DEFAULT_MAX_SKILL_TOKENS = 2000;
