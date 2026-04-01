/**
 * code_search Tool Prompt (LLM Manual)
 *
 * @module tools/core/prompts/code-search-prompt
 */

export function getCodeSearchPrompt(): string {
  return `A powerful search tool built on ripgrep

Usage:
- ALWAYS use this tool for search tasks. NEVER invoke \`grep\` or \`rg\` as a shell_run command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with \`fileTypes\` (e.g., ".ts", ".tsx") to narrow results
- Use this tool for finding definitions, references, imports, TODOs, and repeated code patterns
- Prefer literal search when regex is unnecessary
- For open-ended searches that may require multiple rounds, prefer the subagent tool`;
}
