/**
 * Dynamic System Prompt Sections
 *
 * These sections are placed AFTER the cache boundary marker.
 * They contain per-session/per-turn data and are managed by the
 * section caching system (systemPromptSection / DANGEROUS_uncachedSystemPromptSection).
 *
 * @module prompt/system-prompt/dynamic-sections
 */

import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  type SystemPromptSection,
} from './sections';
import { collectEnvironmentInfo, formatEnvironmentSection } from './env-info';

// ============================================================================
// Types
// ============================================================================

export interface DynamicSectionConfig {
  /** Current working directory */
  cwd: string;
  /** LLM model name */
  model?: string | undefined;
  /** LLM provider name */
  provider?: string | undefined;
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
}

// ============================================================================
// Individual Dynamic Section Factories
// ============================================================================

function getLanguageSection(language: string | undefined): string | null {
  if (!language) return null;

  return `# Language
Always respond in ${language}. Use ${language} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`;
}

function getMemorySection(memoryContent: string | undefined): string | null {
  if (!memoryContent?.trim()) return null;

  return `# Project Memory (TACHIKOMA.md)
${memoryContent.trim()}`;
}

function getIdentitySection(identityContext: string | undefined): string | null {
  if (!identityContext?.trim()) return null;

  return `# Agent Identity
The following represents your learned preferences, work patterns, and principles from past interactions:
${identityContext.trim()}`;
}

function getSkillsSection(skillsContent: string | undefined): string | null {
  if (!skillsContent?.trim()) return null;
  return skillsContent.trim();
}

function getMcpInstructionsSection(mcpInstructions: string | undefined): string | null {
  if (!mcpInstructions?.trim()) return null;
  return mcpInstructions.trim();
}

function getExtraPromptSection(extraPrompt: string | undefined): string | null {
  if (!extraPrompt?.trim()) return null;
  return extraPrompt.trim();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build the list of dynamic sections from configuration.
 *
 * These are resolved lazily via the section caching system.
 * Cached sections are computed once per session (reset on /clear or compact).
 * DANGEROUS_uncached sections recompute every turn.
 */
export function buildDynamicSections(config: DynamicSectionConfig): SystemPromptSection[] {
  return [
    // Environment info — cached (stable within a session)
    systemPromptSection('env_info', () =>
      formatEnvironmentSection(collectEnvironmentInfo(config.cwd, {
        model: config.model,
        provider: config.provider,
      })),
    ),

    // Language — cached
    systemPromptSection('language', () =>
      getLanguageSection(config.language),
    ),

    // Memory (TACHIKOMA.md) — cached
    systemPromptSection('memory', () =>
      getMemorySection(config.memoryContent),
    ),

    // Identity — cached
    systemPromptSection('identity', () =>
      getIdentitySection(config.identityContext),
    ),

    // Skills — cached
    systemPromptSection('skills', () =>
      getSkillsSection(config.skillsContent),
    ),

    // MCP instructions — UNCACHED because MCP servers can connect/disconnect between turns
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () => getMcpInstructionsSection(config.mcpInstructions),
      'MCP servers connect/disconnect between turns',
    ),

    // Extra system prompt — cached
    systemPromptSection('extra_prompt', () =>
      getExtraPromptSection(config.extraSystemPrompt),
    ),
  ];
}
