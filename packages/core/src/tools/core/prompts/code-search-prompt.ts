/**
 * code_search Tool Prompt (LLM Manual)
 *
 * @module tools/core/prompts/code-search-prompt
 */

import { AGENT_TOOL_NAME, BASH_TOOL_NAME, GREP_TOOL_NAME } from '../../model-facing-names';

export function getCodeSearchPrompt(): string {
  return `A powerful search tool built on ripgrep

Usage:
- ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with \`fileTypes\` (e.g., ".ts", ".tsx") to narrow results
- Use this tool for finding definitions, references, imports, TODOs, and repeated code patterns
- Prefer literal search when regex is unnecessary
- For open-ended searches that may require multiple rounds, prefer ${AGENT_TOOL_NAME}`;
}
