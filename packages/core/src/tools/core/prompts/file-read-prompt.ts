/**
 * file_read Tool Prompt (LLM Manual)
 *
 * Ported from Claude Code's FileReadTool/prompt.ts.
 *
 * @module tools/core/prompts/file-read-prompt
 */

import { BASH_TOOL_NAME, FILE_READ_TOOL_NAME, GREP_TOOL_NAME } from '../../model-facing-names';

export function getFileReadPrompt(): string {
  return `Read the contents of a file from the local filesystem.

## Important Rules

1. Always read a file BEFORE editing it with Edit or Write. This is critical — never edit a file you haven't read first, as you will not have accurate content to base your edits on.
2. For large files, use \`mode: "slice"\` with \`offset\` and \`limit\` to read specific line ranges instead of the entire file.
3. The first time you read a new file, prefer reading the whole file to understand its full context.
4. Binary files (images, PDFs, etc.) are returned as base64-encoded content.

## Reading Modes

### \`full\` (default)
Reads the entire file. Best for small to medium files (< 2000 lines). Large files will be truncated.

### \`slice\`
Reads a specific line range. Use \`offset\` (1-indexed start line) and \`limit\` (max lines to return).
Example: Read lines 100-150: \`{ "path": "app.ts", "mode": "slice", "offset": 100, "limit": 50 }\`

### \`indentation\`
Smart code-aware reading. From an anchor line, expands to show the containing code block (function, class, etc.).
Example: Read function at line 42: \`{ "path": "app.ts", "mode": "indentation", "offset": 42, "limit": 100 }\`

## Output Format

- In \`slice\` and \`indentation\` modes, lines are prefixed with \`L{number}:\` by default.
- In \`full\` mode, line numbers are not shown by default. Use \`showLineNumbers: true\` to enable.
- The output includes metadata: \`totalLines\` (file length) and \`lineRange\` (which lines were returned).

## Tips

- Use \`${FILE_READ_TOOL_NAME}\` instead of \`cat\`, \`head\`, \`tail\`, or \`sed\` via ${BASH_TOOL_NAME}.
- If a file is not found, check the exact path using ${BASH_TOOL_NAME} with \`ls\` or \`find\`.
- For searching within files, prefer \`${GREP_TOOL_NAME}\` over reading and scanning manually.`;
}
