Goal (incl. success criteria):

- Start Step 5 (evaluation regression set): define a repeatable benchmark suite for CLI agent runs,
  with stored prompts/fixtures and measurable pass/fail criteria.

Constraints/Assumptions:

- Follow AGENTS/CONTINUITY rules; keep edits ASCII unless existing file uses Unicode.
- Approval policy: never; sandbox: danger-full-access; network enabled.

Key decisions:

- Step 5 should cover core tasks and stability regressions; store prompts + expected signals.

State:

- Step 4 execution gate implemented and verified (core typecheck/build passing); inspecting existing
  eval artifacts for Step 5.

Done:

- Step 4: build+smoke execution gate in submit_result, auto-detect for
  node/python/go/rust/java/.NET, skip when no signals found; env-configurable overrides.
- Step 4 follow-up: fixed strict TS issues (exactOptionalPropertyTypes/noUncheckedIndexedAccess) and
  hardened submit_result paths (sanitize SESSION_ID/WORKER_ID/filename; validate artifacts/result
  stay in workDir).
- Found existing eval artifacts: `evals/basic.json` and `docs/evals.md`.
- `docs/evals.md` defines eval JSON format and CLI usage; `evals/basic.json` is a minimal smoke set.

Now:

- Assess `evals/basic.json` and advise whether the current eval layout fits Step 5 needs.

Next:

- Inspect existing docs/tests to decide where to place evaluation fixtures and how to run them.

Open questions (UNCONFIRMED if needed):

- UNCONFIRMED: preferred format/location for regression cases (docs/, .tachikoma/, tests/)?
- UNCONFIRMED: do we need automated runner or just curated manual prompts + expected outcomes?

Working set (files/ids/commands):

- docs/orchestrator-skills-design.md
- packages/core/src/tools/core/submit-result.ts
- evals/basic.json
- docs/evals.md
