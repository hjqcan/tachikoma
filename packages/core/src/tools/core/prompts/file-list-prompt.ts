/**
 * file_list Tool Prompt (LLM Manual)
 *
 * @module tools/core/prompts/file-list-prompt
 */

import { GLOB_TOOL_NAME, GREP_TOOL_NAME } from '../../model-facing-names';

export function getFileListPrompt(): string {
  return `Fast file pattern matching and directory listing tool

Usage:
- Use ${GLOB_TOOL_NAME} when you need to find files by name or inspect directory structure
- Supports glob-style filename filtering via the \`pattern\` parameter
- Prefer a narrow path before enabling \`recursive\`
- Recursive listing may exclude large directories like node_modules and .git by default
- Use this tool for path discovery, not for reading file contents
- When you need content search, use ${GREP_TOOL_NAME} instead`;
}
