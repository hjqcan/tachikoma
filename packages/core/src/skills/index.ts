/**
 * Skills 模块
 *
 * 提供 Claude Agent Skills 兼容的技能发现、加载和执行功能
 *
 * ## 核心概念
 *
 * Skills 是可复用的领域专业知识包，采用渐进披露机制：
 * - **Level 1**：元数据（name, description）始终注入 system prompt (~100 tokens)
 * - **Level 2**：SKILL.md 正文，按需加载 (<5k tokens)
 * - **Level 3**：脚本和资源，通过 Sandbox 执行
 *
 * ## 目录结构
 *
 * ```
 * skill-name/
 * ├── SKILL.md           # 主入口（YAML frontmatter + Markdown 正文）
 * ├── resource.md        # 可选：额外参考文档
 * └── scripts/           # 可选：可执行脚本
 *     ├── main.py
 *     └── utils.py
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { loadSkills, renderSkillsSection, loadSkillContent } from '@tachikoma/core/skills';
 *
 * // 1. 发现并加载 Skills 元数据
 * const outcome = loadSkills({ enabled: true });
 *
 * // 2. 渲染到 system prompt
 * const section = renderSkillsSection(outcome.skills);
 *
 * // 3. 按需加载完整内容
 * const content = await loadSkillContent(skill);
 * ```
 *
 * @module skills
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  SkillMetadata,
  SkillContent,
  SkillError,
  SkillLoadOutcome,
  SkillDiscoveryConfig,
  SkillExecutionOptions,
  SkillExecutionResult,
  SkillType,
} from './types';

export {
  SKILL_FILENAME,
  SCRIPTS_DIR_NAME,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  NAME_PATTERN,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_MAX_SKILL_TOKENS,
  DEFAULT_MAX_ACTIVATED_TOKENS,
  DEFAULT_AUTO_ACTIVATE_THRESHOLD,
  DEFAULT_MAX_AUTO_ACTIVATED,
  DEFAULT_SKILL_TYPE,
} from './types';

export type {
  ActivationReason,
  ActivatedSkill,
  SkillActivationOptions,
  SkillRenderOptions,
} from './types';

// ============================================================================
// 加载器导出
// ============================================================================

export {
  loadSkills,
  parseSkillFile,
  extractFrontmatter,
  loadSkillContent,
  DEFAULT_GLOBAL_SKILLS_DIR,
  DEFAULT_PROJECT_SKILLS_DIR_NAME,
} from './loader';

// ============================================================================
// 渲染器导出
// ============================================================================

export {
  renderSkillsSection,
  renderSkillsSectionWithRecommendations,
  renderSkillsSectionWithActivation,
  renderSkillContentPrompt,
  estimateSkillsSectionTokens,
} from './renderer';

// ============================================================================
// 执行器导出
// ============================================================================

export {
  executeSkillScript,
  hasExecutableScripts,
  listSkillScripts,
} from './executor';

// ============================================================================
// 技能匹配器导出
// ============================================================================

export {
  matchSkillsToTask,
  getHighlyRelevantSkills,
  getRelevantSkills,
} from './skill-matcher';

export type {
  SkillRelevance,
  SkillRecommendation,
} from './skill-matcher';

// ============================================================================
// 激活器导出
// ============================================================================

export {
  activateSkills,
  activateSkillsAsync,
  parseExplicitSkillCalls,
  loadSkillBody,
  loadSkillBodyAsync,
  computeContentHash,
  renderActivatedSkill,
  renderActivatedSkills,
} from './activator';

// ============================================================================
// Memory Block 导出
// ============================================================================

export {
  SKILL_MEMORY_BLOCK_LABELS,
  SKILL_READ_ONLY_BLOCKS,
  EMPTY_LOADED_SKILLS_PLACEHOLDER,
  SKILL_CONTENT_SEPARATOR,
  SkillBlockManager,
  getGlobalSkillBlockManager,
  resetGlobalSkillBlockManager,
} from './blocks';

export type {
  SkillMemoryBlockLabel,
  MemoryBlock,
  SkillBlockState,
} from './blocks';

// ============================================================================
// Learning 模块导出
// ============================================================================

export {
  TrajectoryReflector,
  createTrajectoryReflector,
  thinkingRecordToTrajectory,
  actionRecordToTrajectory,
  SkillCreator,
  createSkillCreator,
} from './learning';

export type {
  TrajectoryRecord,
  ExecutionFeedback,
  IdentifiedPattern,
  FailureMode,
  ReflectionResult,
  ReflectionConfig,
  SkillCreationConfig,
  SkillCreationInput,
  SkillCreationResult,
  LearnedSkill,
  LearnSkillConfig,
  LearnSkillResult,
} from './learning';

export { learnSkillFromTrajectory } from './learning';