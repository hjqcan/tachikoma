/**
 * System Prompt Module
 *
 * Provides Claude Code-style system prompt assembly with:
 * - 7 static sections (cacheable across sessions)
 * - N dynamic sections (per-session, with memoization)
 * - Cache boundary marker for API-level prompt caching
 *
 * @module prompt/system-prompt
 */

// Core builder
export {
  getSystemPrompt,
  getSystemPromptString,
  clearSystemPromptSections,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type SystemPromptConfig,
} from './builder';

// Section management
export {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
  type SystemPromptSection,
} from './sections';

// Static sections (for testing / customization)
export {
  getIntroSection,
  getSystemSection,
  getDoingTasksSection,
  getActionsSection,
  getUsingToolsSection,
  getToneAndStyleSection,
  getOutputEfficiencySection,
  prependBullets,
} from './static-sections';

// Dynamic sections
export {
  buildDynamicSections,
  type DynamicSectionConfig,
} from './dynamic-sections';

// Environment info
export {
  collectEnvironmentInfo,
  formatEnvironmentSection,
  type EnvironmentInfo,
} from './env-info';
