/**
 * System Prompt Section Manager
 *
 * 1:1 port from Claude Code's `constants/systemPromptSections.ts`.
 *
 * Sections are either:
 * - **Cached**: computed once, memoized until clear() is called (on /clear or compact)
 * - **Uncached (DANGEROUS)**: recomputed every turn, WILL break prompt cache when value changes
 *
 * @module prompt/system-prompt/sections
 */

type ComputeFn = () => string | null | Promise<string | null>;

export type SystemPromptSection = {
  name: string;
  compute: ComputeFn;
  cacheBreak: boolean;
};

// ============================================================================
// Section Cache State
// ============================================================================

const sectionCache = new Map<string, string | null>();

function getSectionCache(): Map<string, string | null> {
  return sectionCache;
}

function setSectionCacheEntry(name: string, value: string | null): void {
  sectionCache.set(name, value);
}

// ============================================================================
// Section Constructors
// ============================================================================

/**
 * Create a memoized system prompt section.
 * Computed once, cached until clear() is called.
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false };
}

/**
 * Create a volatile system prompt section that recomputes every turn.
 * This WILL break the prompt cache when the value changes.
 * Requires a reason explaining why cache-breaking is necessary.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true };
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Resolve all system prompt sections, returning prompt strings.
 *
 * Cached sections are computed once and memoized.
 * Uncached sections are computed every call.
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSectionCache();

  return Promise.all(
    sections.map(async (s) => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null;
      }
      const value = await s.compute();
      setSectionCacheEntry(s.name, value);
      return value;
    }),
  );
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Clear all system prompt section state.
 * Called on /clear, /compact, or session reset.
 */
export function clearSystemPromptSections(): void {
  sectionCache.clear();
}
