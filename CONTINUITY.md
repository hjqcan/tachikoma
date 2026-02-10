Goal (incl. success criteria):
- Improve tachikoma verification/logging so root causes (e.g., LSP/tsc failures) are surfaced clearly and reduce false failures from ESM/CJS config mismatches.
- Prevent task failure when optional tools (e.g., deep_research) are unavailable; degrade gracefully.
- Evaluate whether tool-calling architecture is the primary blocker for end-to-end task closure, and benchmark against badlogic/pi-mono.
- Produce a concrete fusion plan to deeply align tachikoma with pi-mono's minimal tool loop (`read/write/edit/bash`) and resilient tool-call lifecycle.
- Deliver the detailed fusion plan as a docs artifact under `/docs` for direct implementation handoff.

Constraints/Assumptions:
- Follow AGENTS/CONTINUITY rules; keep edits ASCII unless existing file uses Unicode.
- Approval policy: never; sandbox: danger-full-access; network enabled.
- Do not edit output directories (e.g., /Users/hjqcan/test-mvp); improve tachikoma only.

Key decisions:
- Use repo inspection to identify concrete failure causes before proposing fixes.
- Deep-research is Gemini/Google-backed; treat as optional and skip if tool not available.
- Adopt user-prioritized roadmap for integration:
- `P0` middleware hooks (`beforeToolCall` / `afterToolResult`)
- `P0` single source of truth for available tools and preflight alignment
- `P0` recoverable tool errors become synthetic `tool_result` instead of hard task aborts
- `P1` session-persistent todo tools
- `P1` shift smoke/browse verification earlier into execution (not only terminal gate)
- Treat `todo` state machine and `compaction` as complementary: todo is explicit execution state, compaction is context-budget control.

State:
- Implemented stronger BuildGate diagnostics fallback and added ESM/CJS config validation.
- Added filtering of stale LSP diagnostics and improved changed-files touch logic to avoid outdated errors.
- New run: LSP returned zero diagnostics; tsc fallback failed with 15 errors but logs lacked file-level details.
- Added tsc error logging, project-boundary checks, test framework conflict checks, and shell/apply_patch/file-validator guardrails.
- Latest run shows tsc errors (toBeInTheDocument types missing, unused locals) now surfaced in BuildGate logs.
- Added lint config guardrails and Testing Library setup checks in verification and prompts.
- Added skill metadata field for required tools, parsed from SKILL.md, and marked deep-research as requiring deep_research tool.
- Skills injected into prompts are filtered by available tool names; missing-tool skills are skipped with a log.
- Constraints now sanitize "recommended tools" hints when tools are unavailable and add a note to proceed without them.
- Worker behavior guidelines now explicitly forbid calling tools not in the available list.
- User requested deep investigation of `https://github.com/badlogic/pi-mono` as a potential solution path for tool-calling reliability.
- Completed source-level audit of `third-party/pi-mono` (commit `34878e7cc8074f42edff6c2cdcc9828aa9b6afde`) focusing on tool loop, extension interception, skills, plan mode, and todo tracking.
- Key findings: pi keeps active tool set and system prompt synchronized; tool-call failures degrade to toolResult errors instead of crashing loop; extension layer can block/modify tool calls/results.
- User requested a detailed, implementation-ready fusion plan (no code changes yet) covering architecture, migration phases, risks, and acceptance criteria.
- Re-audited tachikoma code paths for integration points:
- `WorkerExecutor` currently normalizes constraints but does not own a unified tool-call middleware pipeline.
- `GenericAgentBackend`, `OpenAIAgentsBackend`, and `ClaudeAgentSDKBackend` each implement tool execution differently (logic duplication).
- Claude path already has `beforeExecute` hook via MCP ToolBridge; OpenAI/Generic paths lack equivalent unified before/after interception.
- Tool availability exists in multiple places (`tools` array per backend, prompt formatting, skill filtering), but no single canonical runtime registry with preflight contract.
- Recoverable tool failures are partly handled (some backends return structured errors), but SDK-level "tool not found" can still hard-fail turn/task in certain paths.
- `todowrite/todoread` already exist and persist to `.tachikoma/sessions/<SESSION_ID>/shared/todo.json`, but are not enforced as first-class execution state.
- Smoke/browser verification is currently gate-driven in `ExecutionLoop`/`VerificationGate` (post-subtask, post-step, final), not explicit mid-execution checkpoints.
- Created detailed implementation document:
- `/Users/hjqcan/Documents/tachikoma/docs/tachikoma-pi-mono-fusion-plan.md`
- Document includes: architecture target, P0/P1 phased plan, interface contracts, rollout/flags, observability/SLO, eval regression set, risks/rollback, and TaskMaster-ready work breakdown.
- User edited the fusion plan and asked for review, especially on whether Todo state machine should be retained and strengthened versus pi-mono's compaction-centric memory approach.
- Fusion plan has been refined per user confirmation:
  - Added hard architecture constraints: `todo` as source of truth, conflict policy `todo_wins`, and replay idempotency.
  - Added explicit Todo FSM transitions and strict-mode rollout behavior.
  - Added compaction consistency guards (`todoSnapshotHash` + `todoRevision`) and mismatch recovery path.
  - Added P1-4 phase for Todo x Compaction contract and ReplayGuard.
  - Expanded feature flags, observability metrics, and eval cases for FSM/compaction/idempotency.

Done:
- Loaded CONTINUITY.md per instructions.
- Inspected /Users/hjqcan/test-mvp App.tsx and tsconfig; confirmed missing pages and noUnusedLocals.
- Reviewed BuildGate and ExecutionLoop verification/auto-fix flow.
- Added parallel-step LLM fix flow and ESLint auto-fix guards in execution-loop.
- Ran tsc (no errors) and eslint (fails: no config) in /Users/hjqcan/test-mvp.
- Updated BuildGate LSP diagnostics handling to log details and ignore lint sources.
- Updated ProjectDetector ESLint detection for v9 flat-config requirement.
- Updated lint gate to skip when ESLint config is missing/incompatible.
- Checked vite-project index.html and entry files; found leftover Vite main.ts scaffold and ESLint config mismatch with v9.
- Identified tests mocking ../../services/api causing withErrorHandling to be undefined.
- Added entrypoint consistency checks and ts/tsx conflict detection in VerificationGate.
- Added Vite scaffold hygiene and module mock integrity guidance in planner/worker prompts.
- Added per-layer error formatting for fix tasks and improved fix instructions for test/smoke/entrypoint issues.
- Added BuildGate fallback error emission when tsc output is unparsed; included generic TS error parsing.
- Downgraded TS80001 CommonJS-module diagnostic to warning and added fix guidance for ESM/CJS config mismatches.
- Added file-validator rule blocking CommonJS config (*.config.js with module.exports/require) in ESM packages.
- Observed LSP error pointing to PlayerExample.tsx despite current content including missing fields; suspect stale diagnostics and limited touched files.
- Updated BuildGate to normalize changed files for LSP, touch more changed files, and ignore diagnostics for missing/out-of-scope files.
- Observed my-react-app output with duplicate test suffixes and __tests__ folder (suggests file-creation validation bypass via shell/apply_patch).
- Observed strict tsconfig (noUnusedLocals) likely turning unused React imports into errors.
- Added tsc parsed diagnostics logging in BuildGate for fallback visibility.
- Added apply_patch validation to block __tests__/duplicate suffix and enforce file-validator content rules.
- Added shell_run post-checks for forbidden test paths (duplicate suffix / __tests__) after mutating commands.
- Added file-validator rules for mixed Jest/Vitest configs, Jest config in Vitest projects, and unused React imports under react-jsx.
- Added verification-gate project boundary enforcement and test framework consistency checks.
- Added verification-gate detailed error logging per failed layer.
- Updated worker behavior guidelines and planner prompts to enforce Vitest-only and React auto-runtime rules.
- Observed TypeScript errors in tests indicating missing jest-dom types and unused locals under strict tsconfig.
- Added ESLint CJS config validation to block `export default` in `.eslintrc.cjs`.
- Added verification-gate check for Testing Library setup when toBeInTheDocument is used.
- Added execution-loop guidance for jest-dom setup and ESLint config syntax errors.
- Added behavior/planner prompt guidance for ESLint CJS config rules.
- Added file-validator check to require jest-dom import in test-setup files.
- Latest run fails before work starts: deep_research tool not available in worker; auto-activation triggers ModelBehaviorError and blocks task execution.
- Added requiresTools support in skills loader/types and deep-research frontmatter.
- Filtered skill injection by available tools and passed tool names from backends.
- Sanitized recommended-tool constraint hints when tools are missing.
- Added tool-availability guidance to worker behavior prompt.
- Cloned `third-party/pi-mono` and audited:
  - `packages/agent/src/agent-loop.ts` (tool execution loop and error handling)
  - `packages/coding-agent/src/core/agent-session.ts` (active tool registry and system prompt rebuild)
  - `packages/coding-agent/src/core/extensions/wrapper.ts` and `runner.ts` (tool_call / tool_result interception)
  - `packages/coding-agent/examples/extensions/plan-mode/index.ts` (read-only plan mode + command allowlist + DONE markers)
  - `packages/coding-agent/examples/extensions/todo.ts` (todo tool with session-persistent state via tool result details)
  - `packages/coding-agent/src/core/resource-loader.ts` (AGENTS/CLAUDE context loading)
- Ran `bun x tsc -p packages/core/tsconfig.json --noEmit`; existing unrelated errors remain in eval/observability modules.
- Fixed one new typing issue from current branch in `packages/core/src/worker/worker-executor.ts` (regex capture narrowing).
- Reviewed additional tachikoma sources to anchor the fusion plan:
- `packages/core/src/worker/backends/openai-agent-backend.ts`
- `packages/core/src/worker/backends/generic-agent-backend.ts`
- `packages/core/src/worker/backends/claude-agent-backend.ts`
- `packages/core/src/mcp/tool-bridge.ts`
- `packages/core/src/orchestrator/runner/execution-loop.ts`
- `packages/core/src/orchestrator/services/verification-gate.ts`
- `packages/core/src/orchestrator/services/smoke-gate.ts`
- `packages/core/src/tools/core/todo.ts`
- Re-checked pi-mono reference implementations:
- `third-party/pi-mono/packages/agent/src/agent-loop.ts`
- `third-party/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts`
- `third-party/pi-mono/packages/coding-agent/examples/extensions/todo.ts`
- `third-party/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts`
- Wrote the final fusion plan doc to:
- `docs/tachikoma-pi-mono-fusion-plan.md` (344 lines).
- Updated `docs/tachikoma-pi-mono-fusion-plan.md` with hardened Todo/Compaction contract and rollout safeguards:
  - Design principles now include state layering, conflict arbitration, and idempotent recovery.
  - New phase `P1-4` added.
  - Added flags: `todoFsm.strictMode`, `compaction.todoGuard.enabled`, `resume.replayGuard.enabled`.
  - Added metrics: invalid transitions, compaction mismatches, replay idempotency.
  - Added evals: FSM illegal transition, compaction-todo consistency, replay idempotency.

Now:
- Fusion plan refinement completed; ready to decompose into implementation tasks and start coding P0/P1 in sequence.

Next:
- If requested, convert updated plan into TaskMaster-ready execution tickets and start with P0-1 runtime middleware/Event Stream work.

Open questions (UNCONFIRMED if needed):
- Should deep_research be fully disabled if GEMINI/GOOGLE API keys are missing, or only skipped when tool capability is off?
- Is tool-calling the dominant root cause vs. planning quality and verification gating policy (to be validated via pi-mono comparison)?
- Should todo state transitions be hard-gated (strict FSM validation) or soft-gated (warn + auto-correct) during rollout?

Working set (files/ids/commands):
- CONTINUITY.md
- .tachikoma/skills/deep-research/SKILL.md
- packages/core/src/skills/types.ts
- packages/core/src/skills/loader.ts
- packages/core/src/skills/renderer.ts
- packages/core/src/worker/prompts/behavior-guidelines.ts
- packages/core/src/worker/engines/skills-manager.ts
- packages/core/src/worker/worker-executor.ts
- packages/core/src/worker/backends/openai-agent-backend.ts
- packages/core/src/worker/backends/claude-agent-backend.ts
- packages/core/src/worker/backends/generic-agent-backend.ts
- packages/core/src/mcp/tool-bridge.ts
- packages/core/src/orchestrator/runner/execution-loop.ts
- packages/core/src/orchestrator/services/verification-gate.ts
- packages/core/src/orchestrator/services/smoke-gate.ts
- packages/core/src/tools/core/todo.ts
- third-party/pi-mono (local clone for research)
