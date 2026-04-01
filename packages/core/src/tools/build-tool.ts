/**
 * buildTool Factory
 *
 * 1:1 port of Claude Code's `buildTool()` from `Tool.ts`.
 *
 * Provides a factory function that fills in safe defaults for commonly-stubbed
 * tool methods. All tool exports should go through this so that defaults live
 * in one place and callers never need `?.() ?? default`.
 *
 * Defaults (fail-closed where it matters):
 * - `isEnabled`          → `true`
 * - `isConcurrencySafe`  → `false` (assume not safe for parallel execution)
 * - `isReadOnly`         → `false` (assume writes / side effects)
 * - `isDestructive`      → `false`
 * - `maxResultSizeChars` → `50_000`
 *
 * @module tools/build-tool
 */

import type { Tool, ExecutionContext } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Validation result from validateInput().
 */
export type ValidationResult =
  | { result: true }
  | { result: false; message: string };

/**
 * Extended tool interface with Claude Code-style safety metadata.
 *
 * All new fields are optional to maintain backward compatibility.
 * buildTool() fills in defaults for any omitted fields.
 */
export interface ToolWithSafety extends Tool {
  /** Tool aliases for backward compatibility when renaming */
  aliases?: string[];

  /** Whether this tool is enabled */
  isEnabled?: () => boolean;

  /** Whether this tool is safe for concurrent/parallel execution */
  isConcurrencySafe?: (input?: unknown) => boolean;

  /** Whether this tool is read-only (no side effects) */
  isReadOnly?: (input?: unknown) => boolean;

  /** Whether this tool performs irreversible/destructive operations */
  isDestructive?: (input?: unknown) => boolean;

  /** Maximum result size in characters before truncation/offload */
  maxResultSizeChars?: number;

  /** One-line search hint for ToolSearch keyword matching */
  searchHint?: string;

  /**
   * Input validation (called before execute).
   * Used for rules like "read before edit".
   */
  validateInput?: (
    input: unknown,
    context: ExecutionContext & { readFileState?: ReadFileStateInterface },
  ) => Promise<ValidationResult> | ValidationResult;

  /**
   * Tool usage manual for the LLM.
   *
   * This is Claude Code's core design: each tool has an independent,
   * detailed usage manual written for the AI. Replaces the short `description`.
   * Contains usage rules, caveats, examples, etc.
   */
  prompt?: () => string | Promise<string>;
}

/**
 * Interface for ReadFileState (avoid circular dependency).
 */
export interface ReadFileStateInterface {
  has(filePath: string): boolean;
}

// ============================================================================
// Defaults
// ============================================================================

/**
 * Tool safety defaults (fail-closed design).
 *
 * If a tool author forgets to declare a safety attribute,
 * the system assumes the worst case:
 * - NOT safe for concurrent execution
 * - HAS write side effects
 * - NOT destructive (this is opt-in)
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  maxResultSizeChars: 50_000,
} as const;

export type ToolDefaults = typeof TOOL_DEFAULTS;

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a complete Tool from a partial definition, filling in safe defaults.
 *
 * All tool exports should go through this so that:
 * 1. Defaults live in one place
 * 2. Safety metadata is always present
 * 3. Callers never need `?.() ?? default`
 *
 * @example
 * ```ts
 * export const fileReadTool = buildTool({
 *   name: 'file_read',
 *   isReadOnly: () => true,
 *   isConcurrencySafe: () => true,
 *   prompt: () => `Reads a file from the filesystem...`,
 *   // ... other fields
 * });
 * ```
 */
export function buildTool<T extends ToolWithSafety>(def: T): T & ToolDefaults {
  return {
    ...TOOL_DEFAULTS,
    ...def,
  } as T & ToolDefaults;
}

/**
 * 获取传给 LLM 的工具说明文本。
 *
 * 优先使用 Claude Code 风格的 `prompt()` 手册；如果不存在或返回异步值，
 * 回退到短描述 `description`。
 */
export function getToolPromptText(
  tool: Pick<ToolWithSafety, 'description' | 'prompt'>,
): string {
  if (typeof tool.prompt === 'function') {
    const promptValue = tool.prompt();
    if (typeof promptValue === 'string' && promptValue.trim().length > 0) {
      return promptValue.trim();
    }
  }

  return tool.description?.trim() ?? '';
}

/**
 * Check if a tool matches a given name (primary name or alias).
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

/**
 * Find a tool by name or alias from a list.
 */
export function findToolByName<T extends { name: string; aliases?: string[] }>(
  tools: T[],
  name: string,
): T | undefined {
  return tools.find(t => toolMatchesName(t, name));
}
