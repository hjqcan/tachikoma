Goal (incl. success criteria):
- Address P0/P1 issues (ProjectContext time injection, size guard, apply_patch filesAffected, variable truncation, ProjectContext cache TTL), then proceed to Step 3 (toolchain: LSP + doom-loop).
Constraints/Assumptions:
- Follow AGENTS/CONTINUITY rules; do not re-init Taskmaster; keep edits ASCII unless existing file uses Unicode.
- Approval policy: never; sandbox: danger-full-access; network enabled.
Key decisions:
- Step 1 (prompt/discipline) already implemented across worker/planner/ConversationalRunner.
- Step 2 should add project/global rule injection and provide /init slash command.
State:
- Step 1 completed; Step 2 completed; P0/P1 fixes implemented (pending review).
Done:
- Step 1: execution discipline updates across worker/planner/conversation prompts; backend configs pass provider/model to system prompt.
- Step 2: project/global rules injection (CONTEXT.md, ~/.claude/*), file tree + environment summaries, enabled for all backends; /init slash command added; help/docs updated.
- P0/P1 fixes: ProjectContext date default off; size guard for rule files; apply_patch filesAffected parsing; session variable truncation/redaction; ProjectContext cache clears only on workDir change or TTL.
Now:
- Await confirmation on P0/P1 fixes; proceed to Step 3 if approved.
Next:
- Resume Step 3 (toolchain), then Step 4 (build+smoke gate) and Step 5 (eval regression set).
Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: is 100KB max size for ProjectContext files acceptable, or do you prefer a different limit?
Working set (files/ids/commands):
- packages/core/src/prompt/project/index.ts
- packages/core/src/prompt/index.ts
- packages/core/src/worker/engines/skills-manager.ts
- packages/core/src/worker/engines/index.ts
- packages/core/src/worker/types.ts
- packages/core/src/worker/backends/claude-agent-backend.ts
- packages/core/src/worker/backends/openai-agent-backend.ts
- packages/core/src/worker/backends/generic-agent-backend.ts
- packages/core/src/conversation/conversational-runner.ts
- packages/core/src/conversation/README.md
- packages/core/src/conversation/prompt-builder.ts
