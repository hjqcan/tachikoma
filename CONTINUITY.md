Goal (incl. success criteria):

- Execute Step 3 (toolchain: LSP + doom-loop + todo tools) after P0/P1 fixes; deliver stable LSP
  integration and doom-loop safeguards, add todowrite/todoread tools in worker.
  Constraints/Assumptions:
- Follow AGENTS/CONTINUITY rules; do not re-init Taskmaster; keep edits ASCII unless existing file
  uses Unicode.
- Approval policy: never; sandbox: danger-full-access; network enabled. Key decisions:
- Step 1 (prompt/discipline) already implemented across worker/planner/ConversationalRunner.
- Step 2 should add project/global rule injection and provide /init slash command. State:
- Step 1 completed; Step 2 completed; P0/P1 fixes implemented; Step 3 implemented (LSP + todo
  tools + doom-loop guard) and patched after review; core build/typecheck verified; LSP crash
  handling added and doom-loop helper deduped. Done:
- Step 1: execution discipline updates across worker/planner/conversation prompts; backend configs
  pass provider/model to system prompt.
- Step 2: project/global rules injection (CONTEXT.md, ~/.claude/\*), file tree + environment
  summaries, enabled for all backends; /init slash command added; help/docs updated.
- P0/P1 fixes: ProjectContext date default off; size guard for rule files; apply_patch filesAffected
  parsing; session variable truncation/redaction; ProjectContext cache clears only on workDir change
  or TTL.
- Step 3: added opencode-style LSP module + lsp/lsp_diagnostics tools; added todowrite/todoread
  tools + prompt hint; doom-loop policy/approval guards in OpenAI/Claude/generic backends; base loop
  guard relaxed to allow approval gating.
- Step 3 review fixes: LSP URL/path handling + gopls args; todo tool typing + safe sessionId;
  approval file-protocol timeout bug; SDK backends tool_result success attribution + tracker wiring;
  MCP bridge effectiveCwd persistence; core build/typecheck passed; installed missing deps
  (vscode-jsonrpc, vscode-languageserver-types) via bun install.
Now:
- Review Step 3 implementation after user edits: confirm features are present and assess risks.
Next:
- Provide review findings; decide if any fixes are required.
Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: any specific regressions you already fixed that I should focus on?
- UNCONFIRMED: user expects 15+ LSP servers parity with opencode? which languages required?
- UNCONFIRMED: is 100KB max size for ProjectContext files acceptable, or do you prefer a different
  limit?
Working set (files/ids/commands):
- packages/core/src/prompt/project/index.ts
- packages/core/src/prompt/index.ts
- packages/core/src/worker/engines/skills-manager.ts
- packages/core/src/worker/engines/index.ts
- packages/core/src/worker/types.ts
- packages/core/src/worker/backends/claude-agent-backend.ts
- packages/core/src/worker/backends/openai-agent-backend.ts
- packages/core/src/worker/backends/generic-agent-backend.ts
- packages/core/src/worker/tool-call-tracker.ts
- packages/core/src/conversation/conversational-runner.ts
- packages/core/src/conversation/README.md
- packages/core/src/conversation/prompt-builder.ts
- packages/core/src/tools/core
- packages/core/src/lsp
- packages/core/src/lsp/client.ts
- packages/core/src/lsp/index.ts
- packages/core/src/lsp/server.ts
- packages/core/src/mcp/tool-bridge.ts
- packages/core/src/tools/index.ts
- packages/core/src/tools/core/todo.ts
- packages/core/src/worker/prompts/system-prompt.ts
- packages/core/src/worker/backends/base-backend.ts
- packages/core/src/worker/backends/claude-agent-backend.ts
- packages/core/src/worker/backends/openai-agent-backend.ts
- packages/core/src/conversation/prompt-builder.ts
- bun.lock
- packages/core/package.json
