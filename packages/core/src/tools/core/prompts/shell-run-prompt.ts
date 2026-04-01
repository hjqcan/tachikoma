/**
 * shell_run Tool Prompt (LLM Manual)
 *
 * Ported from Claude Code's BashTool/prompt.ts.
 * This is the detailed usage manual that the LLM reads to understand
 * how to use the shell_run tool correctly.
 *
 * @module tools/core/prompts/shell-run-prompt
 */

import {
  BASH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
} from '../../model-facing-names';

export function getShellRunPrompt(): string {
  return `Execute a shell command in the user's environment.

## Important Rules

1. You MUST use this tool to run shell commands. NEVER output shell commands as text for the user to manually execute — the user expects you to run them.
2. Prefer dedicated tools (${FILE_READ_TOOL_NAME}, ${FILE_EDIT_TOOL_NAME}, ${FILE_WRITE_TOOL_NAME}, ${GREP_TOOL_NAME}) over shell commands when available. Only use ${BASH_TOOL_NAME} when no dedicated tool exists.
3. Do NOT run commands that produce unbounded output. Always limit output (e.g. use \`head\`, \`tail\`, or redirect to a file).
4. Do NOT start interactive programs (e.g. \`vim\`, \`python\` REPL without \`-c\`). They will hang.
5. For long-running processes (dev servers, watchers), use \`background: true\`.

## Timeout Behavior

- Default timeout: 30 seconds (configurable via TACHIKOMA_BASH_TIMEOUT)
- Build/install commands automatically get extended timeouts (up to 15 minutes)
- Background commands run indefinitely until explicitly stopped

## Git Safety

When using git commands:
- Always check \`git status\` before \`git add\` or \`git commit\`
- Never force-push without explicit user confirmation
- Use \`--no-verify\` only when the user explicitly asks
- Never amend published commits without confirmation

## Command Patterns

Good patterns:
- \`ls -la src/\` — list directory
- \`cat package.json | head -50\` — read file with limit
- \`git diff --stat\` — check changes
- \`npm test -- --testPathPattern="auth"\` — run specific test
- \`grep -rn "TODO" src/ --include="*.ts" | head -20\` — search with limit

Bad patterns:
- \`vim file.txt\` — interactive, will hang
- \`find / -name "*.ts"\` — unbounded output
- \`npm run dev\` without background — blocks forever
- \`cat very-large-file.log\` — no output limit

## Session Management

Commands can be run in persistent sessions using \`session_id\`:
- Subsequent commands in the same session share environment variables
- Useful for workflows that depend on prior \`export\` or \`source\` commands
- Each session is independent`;
}
