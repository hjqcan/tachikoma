/**
 * file_write Tool Prompt (LLM Manual)
 *
 * Ported from Claude Code's FileWriteTool/prompt.ts.
 *
 * @module tools/core/prompts/file-write-prompt
 */

import {
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
} from '../../model-facing-names';

export function getFileWritePrompt(): string {
  return `Write content to a file on the local filesystem. Creates the file if it doesn't exist, including any parent directories.

## Important Rules

1. For EDITING existing files, prefer \`${FILE_EDIT_TOOL_NAME}\` over \`${FILE_WRITE_TOOL_NAME}\`. ${FILE_EDIT_TOOL_NAME} makes targeted changes while ${FILE_WRITE_TOOL_NAME} replaces the entire file.
2. Use \`${FILE_WRITE_TOOL_NAME}\` for:
   - Creating new files
   - Small configuration files where full replacement is simpler
   - Generated content (e.g., build artifacts)
   - Append mode (\`append: true\`) for logs or growing files
3. NEVER use ${FILE_WRITE_TOOL_NAME} to modify a file you haven't read first — you risk losing content you don't know about.
4. Use \`${FILE_WRITE_TOOL_NAME}\` instead of \`cat\` with heredoc or \`echo\` redirection via Bash.

## Parameters

- \`path\` (required): File path relative to the working directory
- \`content\` (required): The complete file content to write
- \`append\` (optional, default: false): If true, appends to the file instead of overwriting
- \`validateAfterEdit\` (optional, default: false): If true, runs type checking after write and auto-rolls back on failure

## Validation

When \`validateAfterEdit: true\`:
- The tool runs type checking (via LSP) after writing
- If type errors are found, the write is automatically rolled back
- The error details are returned so you can fix them
- Use this for critical edits where correctness must be verified

## LSP Diagnostics

After successful writes, the tool automatically checks for errors via the LSP:
- Type errors, syntax errors, and lint issues are returned as diagnostics
- Review these diagnostics and fix any issues before moving on

## Tips

- Always include complete, working code — never use placeholders or ellipses
- For test files, name them \`Component.test.tsx\`, NOT in \`__tests__/\` directories
- If you're replacing a large file, consider whether ${FILE_EDIT_TOOL_NAME} would be more appropriate.
- If this is an existing file, you MUST use ${FILE_READ_TOOL_NAME} first.`;
}
