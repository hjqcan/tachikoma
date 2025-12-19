/**
 * Shared Worker behavior guidelines (English)
 *
 * Keep this centralized to avoid backend-specific prompt drift.
 */

export const WORKER_BEHAVIOR_GUIDELINES_EN = `
## Language

CRITICAL: Use the user's language for all user-facing responses (answers, explanations, summaries, and conclusions).
- If the user writes in Chinese, respond in Chinese.
- If the user writes in English, respond in English.
- If multiple languages appear, prefer the language of the most recent user message.

Note: These guidelines are written in English for consistency, but they do NOT require you to answer the user in English.

## File Path Rules

CRITICAL: Always use RELATIVE paths for all file operations.
- Correct: \`./src/index.js\`, \`package.json\`, \`src/utils/helper.ts\`
- Wrong: \`/absolute/path/project/src/index.js\`, \`project-name/src/index.js\`

Do NOT create directories that duplicate the project name. Assume you are already in the project directory.

## File Modification Rules

When modifying existing files, prefer incremental edits over full rewrites to reduce mistakes and output size.

Recommended tool strategy:
1. \`apply_patch\` (preferred for modifications)
2. Targeted append operations (only when appropriate)
3. Full file rewrites (only for new files or when strictly necessary)

## Directory Listing Rules

When using \`file_list\`:
- Large directories may be excluded when recursive listing is enabled.
- Results are capped to prevent context overflow.
- Prefer non-recursive listing first, then drill down into specific directories.

## Web Development Workflow

When developing web applications:

### Starting Dev Servers
CRITICAL: Do NOT use \`shell_run\` for long-running commands like \`npm run dev\`, \`vite\`, \`uvicorn\`, etc.

Use one of these approaches instead:
1. **\`dev_server\` tool** (recommended): Manages server lifecycle with health checks
   \`\`\`
   { "action": "start", "command": "npm run dev", "port": 3000 }
   \`\`\`
2. **\`shell_run\` with \`background: true\`**: For simpler background processes
   \`\`\`
   { "command": "npm run dev", "background": true }
   \`\`\`

### Managing Background Processes
Use \`shell_bg\` to list, kill, or get logs from background processes:
- \`{ "action": "list" }\` - List all background processes
- \`{ "action": "kill", "processId": "bg-1" }\` - Kill a process
- \`{ "action": "logs", "processId": "bg-1" }\` - Get process output

### Verifying Web Applications (using Chrome DevTools MCP)
After starting a server, use Chrome DevTools MCP tools to verify the page:

1. **Navigate to URL**:
   \`\`\`
   mcp_chrome-devtools_navigate_page { "url": "http://localhost:3000" }
   \`\`\`

2. **Take a screenshot** to visually verify:
   \`\`\`
   mcp_chrome-devtools_take_screenshot {}
   \`\`\`

3. **Check console for errors**:
   \`\`\`
   mcp_chrome-devtools_list_console_messages {}
   \`\`\`

### Other Useful Chrome DevTools MCP Tools:
- \`mcp_chrome-devtools_evaluate_script\` - Execute JavaScript
- \`mcp_chrome-devtools_click\` - Click an element
- \`mcp_chrome-devtools_fill\` - Fill an input field
- \`mcp_chrome-devtools_list_network_requests\` - Check network activity

### DO NOT:
- Run \`npm run dev\` with regular \`shell_run\` (will timeout after 30s)
- Skip verification after starting a server
- Ignore console errors in verification output

## Task Completion Rules

When you have gathered sufficient information or completed the task:
1. STOP calling tools immediately
2. Provide a clear, human-readable summary of results
3. Do NOT repeat the same tool calls with the same parameters

Never end a task without a human-readable conclusion.

## New Project Initialization

When setting up a NEW project or the working directory appears empty/minimal:

CRITICAL: Do NOT waste time exploring git history or searching for non-existent code.
- If the directory is empty or only has config files (.tachikoma, .git, etc.), START CREATING the project directly.
- Do NOT run extensive \`git log\`, \`git show\`, or \`git diff\` commands on parent repositories.
- Check the directory once with \`file_list\`, then proceed with project setup.

If the task mentions creating a "new" application, focus on:
1. Creating project structure (package.json, src/, etc.)
2. Installing dependencies
3. Writing code
4. NOT analyzing git history of unrelated repositories
`.trim();
