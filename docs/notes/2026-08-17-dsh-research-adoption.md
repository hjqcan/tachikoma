# Adoptions and rejections from the deepseek-harness research

Date: 2026-08-17. Source: deep-dive into `deepseek-ai/deepseek-harness` (dsh, released 2026-08-13),
an "everything is a plugin" agent harness built on Cordis — the same problem as Tachikoma with the
opposite philosophy. Full report: claude.ai artifact `4fb5efd0-a30b-4bbb-9992-188f71ba6910`.

## Adopted

- **Keyless snapshot replay tests** (`packages/core/tests/snapshot/`): fixture = the product's own
  persisted pi transcript; record once against a real API, replay offline through the faux provider.
  Sentinel rule from dsh's postmortem 0002: a snapshot refresh is fixture production, not
  correctness review — recording rejects unexpected tool errors.
- **Postmortems + defensive patterns** (`docs/postmortem/`, `docs/defensive-patterns.md`): only
  incidents that are subtle, systemic, and costly; patterns only with in-repo evidence.
- **Model-experience discipline** (`docs/model-experience.md`): model-visible surfaces are a
  documented API; changes state token and cache impact.
- **Loop reminder guard** (`packages/core/src/chat/loop-guard.ts`): escalating advisory on repeated
  identical tool calls; denied calls count; advisory only, never a block.
- **WAL⟷history consistency test**: Tachikoma's version of dsh's log-reconstruction invariant, as a
  test rather than runtime code — two derivations of one truth must agree.
- **ACP adapter spike** (`tachikoma-acp` bin): editor frontends for free via the Zed/JetBrains
  standard; foreign wire shapes stay at the edge, out of `@hjqcan/tachikoma-protocol`.
- **Named presets** (`<configDir>/presets/<name>.json`): dsh's per-session preset idea reduced to a
  data file resolved at the edges; the open repo ships the mechanism, closed verticals ship content.
- **eval:engined smoke**: dsh's "benchmark posture = product machine face" — one real-network pass
  through the spawned sidecar binary.

## Rejected

- **Plugin architecture / capability seams / Cordis**: dsh needs a platform ecosystem and pays for
  it (219 packages, vendored framework with hand-patched lifecycle gaps, silent PENDING plugins
  needing startup asserts). Tachikoma's extension model is explicit grants; every line stays
  auditable. 极简主义 holds.
- **dsh's gate dosage** (per-file 100% coverage, 31 doc gates, bilingual blob-hash pairing): built
  for unbudgeted agent labor on a 200-package repo; `bun run verify` is the right dose here.
- **Self-modification tools and model-written orchestration**: demo value, not product value.
- **Runtime log-reconstruction assertion**: dsh asserts before every model request; we take the
  test-only form. Runtime cost and code for a two-source drift that a test catches equally well.

## Alternatives considered

- Adopt a Cordis-style plugin layer for downstream extensibility — rejected: the sidecar boundary
  plus presets-as-data already give external consumers composition without opening an in-process
  plugin surface.
- Proxy ACP through engined to dogfood the sidecar — rejected: ACP is stdio-subprocess by design;
  in-process ChatEngine is the honest shape, and the engined face gets its own smoke eval instead.
- Skip snapshot tests, extend faux unit tests — rejected: inline scripts assert properties;
  committed fixtures diff the whole behavioral stream and catch drift no one thought to assert.
