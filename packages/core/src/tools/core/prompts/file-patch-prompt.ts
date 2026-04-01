/**
 * apply_patch Tool Prompt (LLM Manual)
 *
 * Ported from Claude Code's FileEditTool/prompt.ts.
 *
 * @module tools/core/prompts/file-patch-prompt
 */

import {
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
} from '../../model-facing-names';

export function getFilePatchPrompt(): string {
  return `Apply incremental patches to an existing file. This is the PREFERRED tool for editing files — use it instead of ${FILE_WRITE_TOOL_NAME} when modifying existing content.

## Important Rules

1. You MUST read the file (with ${FILE_READ_TOOL_NAME}) BEFORE using this tool. Never edit a file you haven't read. The tool may reject your request if the file hasn't been read first.
2. Be precise with search strings in patches — they must match the file content EXACTLY, including whitespace and indentation.
3. Prefer small, targeted patches over rewriting large sections of code.
4. When making multiple changes to the same file, combine them into a single apply_patch call.

## Mode 1: Search/Replace (patches)

Exact text search and replace. Best for simple, targeted edits.

\`\`\`json
{
  "path": "app.js",
  "patches": [
    { "search": "const old = 1;", "replace": "const new = 2;" }
  ]
}
\`\`\`

Rules:
- \`search\` must match EXACTLY (including whitespace)
- Use \`occurrence: 0\` to replace all occurrences
- Use \`occurrence: N\` to replace only the Nth occurrence (default: 1)

## Mode 2: Freeform Context Diff (freeform) ⭐ Recommended

Context-based diff format. Best for multi-line changes.

\`\`\`
{
  "path": "app.js",
  "freeform": "@@ function foo @@\\n-  const old = 1;\\n+  const new = 2;"
}
\`\`\`

Syntax:
- \`@@ context line @@\` — locates where to apply the change (must be a unique line)
- \`-line\` — remove this line
- \`+line\` — add this line

Rules:
- The context line should be unique in the file (e.g., a function signature)
- Removed lines (\`-\`) must match the actual file content exactly
- Changes are applied relative to the context line (modifications happen on lines immediately after it)

## Common Mistakes

- Using ${FILE_EDIT_TOOL_NAME} on a file you haven't read → read it first with ${FILE_READ_TOOL_NAME}
- Incorrect whitespace in search strings → copy exact text from the file
- Ambiguous context line → use a more specific, unique line
- Editing the wrong occurrence → specify the occurrence number`;
}
