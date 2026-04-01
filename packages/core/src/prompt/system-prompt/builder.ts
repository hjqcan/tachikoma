/**
 * System Prompt Builder
 *
 * 1:1 port of Claude Code's `getSystemPrompt()` from `constants/prompts.ts`.
 *
 * Assembles the complete system prompt as a string array:
 *   [static sections...] + [BOUNDARY] + [dynamic sections...]
 *
 * The boundary marker separates cacheable (cross-session) content from
 * per-session/per-turn content. API-level caching can use the boundary
 * to set scope: 'global' on everything before it.
 *
 * @module prompt/system-prompt/builder
 */

import {
  resolveSystemPromptSections,
} from './sections';
import {
  getIntroSection,
  getSystemSection,
  getDoingTasksSection,
  getActionsSection,
  getUsingToolsSection,
  getToneAndStyleSection,
  getOutputEfficiencySection,
} from './static-sections';
import { buildDynamicSections } from './dynamic-sections';

// ============================================================================
// Constants
// ============================================================================

/**
 * Boundary marker separating static (cacheable) content from dynamic content.
 *
 * Everything BEFORE this marker in the system prompt array can use
 * scope: 'global' for API-level prompt caching.
 * Everything AFTER contains user/session-specific content.
 *
 * WARNING: Do not remove or reorder this marker without updating cache logic.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

// ============================================================================
// Types
// ============================================================================

export interface SystemPromptConfig {
  /** Current working directory */
  cwd: string;
  /** LLM model name */
  model?: string | undefined;
  /** LLM provider name */
  provider?: string | undefined;
  /** Set of enabled tool names (for Using Tools section) */
  enabledToolNames?: Set<string> | undefined;
  /** User language preference */
  language?: string | undefined;
  /** Memory/TACHIKOMA.md content */
  memoryContent?: string | undefined;
  /** Agent identity (coreMemory) */
  identityContext?: string | undefined;
  /** Skills section content */
  skillsContent?: string | undefined;
  /** MCP instructions */
  mcpInstructions?: string | undefined;
  /** Extra system prompt (user-provided) */
  extraSystemPrompt?: string | undefined;
  /** Whether to include the cache boundary marker (default: true) */
  includeCacheBoundary?: boolean | undefined;
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Build the complete system prompt.
 *
 * Returns a string array where each element is a prompt section.
 * The caller can join them with '\n\n' or handle them individually
 * for API-level cache control.
 *
 * Architecture (from Claude Code):
 * ```
 * [Intro]              ← static, cacheable
 * [System]             ← static, cacheable
 * [Doing Tasks]        ← static, cacheable
 * [Actions]            ← static, cacheable
 * [Using Tools]        ← static, cacheable
 * [Tone & Style]       ← static, cacheable
 * [Output Efficiency]  ← static, cacheable
 * [BOUNDARY]           ← cache boundary marker
 * [Env Info]           ← dynamic, per-session
 * [Language]           ← dynamic, per-session
 * [Memory]             ← dynamic, per-session
 * [Identity]           ← dynamic, per-session
 * [Skills]             ← dynamic, per-session
 * [MCP Instructions]   ← dynamic, per-turn (uncached!)
 * [Extra Prompt]       ← dynamic, per-session
 * ```
 */
export async function getSystemPrompt(config: SystemPromptConfig): Promise<string[]> {
  const includeBoundary = config.includeCacheBoundary ?? true;

  // Build dynamic section definitions
  const dynamicSectionDefs = buildDynamicSections({
    cwd: config.cwd,
    ...(config.model !== undefined && { model: config.model }),
    ...(config.provider !== undefined && { provider: config.provider }),
    ...(config.language !== undefined && { language: config.language }),
    ...(config.memoryContent !== undefined && { memoryContent: config.memoryContent }),
    ...(config.identityContext !== undefined && { identityContext: config.identityContext }),
    ...(config.skillsContent !== undefined && { skillsContent: config.skillsContent }),
    ...(config.mcpInstructions !== undefined && { mcpInstructions: config.mcpInstructions }),
    ...(config.extraSystemPrompt !== undefined && { extraSystemPrompt: config.extraSystemPrompt }),
  });

  // Resolve dynamic sections (respects caching)
  const resolvedDynamicSections = await resolveSystemPromptSections(dynamicSectionDefs);

  return [
    // --- Static content (cacheable across sessions) ---
    getIntroSection(),
    getSystemSection(),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingToolsSection(config.enabledToolNames),
    getToneAndStyleSection(),
    getOutputEfficiencySection(),

    // === CACHE BOUNDARY MARKER ===
    ...(includeBoundary ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),

    // --- Dynamic content (per-session, managed by section cache) ---
    ...resolvedDynamicSections,
  ].filter((s): s is string => s !== null && s !== undefined);
}

/**
 * Build system prompt as a single string.
 *
 * Convenience wrapper for callers that don't need per-section control.
 * Joins all sections with double newlines.
 */
export async function getSystemPromptString(config: SystemPromptConfig): Promise<string> {
  const sections = await getSystemPrompt(config);

  // Filter out the boundary marker from the joined string
  return sections
    .filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join('\n\n')
    .trim();
}

/**
 * Clear all cached prompt sections.
 *
 * Call this on /clear, /compact, or session reset so that
 * cached dynamic sections are recomputed on the next turn.
 */
export { clearSystemPromptSections } from './sections';
