Goal (incl. success criteria):
- Diagnose tachikoma output quality for test-mvp task, explain why result isn't runnable, compare with opencode, and propose fixes/logging to make outputs runnable.

Constraints/Assumptions:
- Follow AGENTS/CONTINUITY rules; keep edits ASCII unless existing file uses Unicode.
- Approval policy: never; sandbox: danger-full-access; network enabled.
- Avoid sudo unless explicitly required; root-owned output may block reruns.

Key decisions:
- Clone opencode into repo-local `thrid-party/opencode` unless user prefers absolute `/thrid-party`.
- No code changes yet; focus on analysis and suggested fixes/logging.

State:
- Tachikoma run not reproducible due to root-owned `test-mvp` from prior sudo run.
- Output inspection completed; opencode prompts inspected for build/verify guidance.

Done:
- Attempted `sudo -E bun run ...` (failed due to no TTY password prompt).
- Attempted non-sudo run (failed with EACCES creating `test-mvp/.tachikoma`).
- Inspected `test-mvp` output; key issues:
  - Frontend compile issues: `src/hooks/useApi.ts` imports missing `./api`/`./mockApi` (should be `src/services/*`), and uses `apiService` directly.
  - Types missing: `src/types/music.ts` lacks `Artist`/`Album` used by `src/services/api.ts`.
  - Tailwind build config missing (`postcss.config.js`, autoprefixer), so `src/index.css` @tailwind directives won't compile.
  - Material icons not loaded (`index.html`) but used in `src/pages/MusicPage.tsx`.
  - Tests fail: Jest APIs used under Vitest; import paths wrong (e.g., `src/App.test.tsx`).
  - README/start scripts cover backend only; no unified FE+BE run.
- Logs show tests failing and timing out; tasks still marked done:
  - `test-mvp/.tachikoma/conversations/sessions/conv-0ff28da9/conversation/session.json` contains `run_tests` failures (missing deps, jest not defined, timeouts).
- Cloned `https://github.com/sst/opencode` to `thrid-party/opencode` and inspected prompts:
  - Plan/build split in `packages/opencode/src/session/prompt.ts`.
  - Provider prompts emphasize build/test verification (e.g., `packages/opencode/src/session/prompt/gemini.txt`, `codex.txt`).

Now:
- Produce analysis of why output is not runnable, why quality is low, and how to fix.

Next:
- Propose enforcement changes (treat failed tools/tests as failures; add validation stage; better scaffolding), and optional logging additions.

Open questions (UNCONFIRMED if needed):
- UNCONFIRMED: Should opencode be cloned to absolute `/thrid-party` instead of repo-local `thrid-party/`?

Working set (files/ids/commands):
- CONTINUITY.md
- test-mvp/ (README.md, package.json, src/hooks/useApi.ts, src/services/api.ts, src/types/music.ts, src/pages/MusicPage.tsx, index.html)
- test-mvp/.tachikoma/conversations/sessions/conv-0ff28da9/conversation/session.json
- packages/core/src/worker/worker-executor.ts
- packages/core/src/tools/core/run-tests.ts
- packages/core/src/worker/prompts/system-prompt.ts
- thrid-party/opencode/packages/opencode/src/session/prompt.ts
- thrid-party/opencode/packages/opencode/src/session/prompt/gemini.txt
