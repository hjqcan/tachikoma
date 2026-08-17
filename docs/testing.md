# Testing

## Offline gate

The default suite must be deterministic and unable to call the network:

```bash
bun run test
```

It uses pi's faux provider, temporary JSONL session directories, and temporary GoodMemory SQLite
files. Tests under `tests/live/` are excluded by path, not merely skipped after credentials are
loaded. The preload guard poisons credentials and blocks external egress; loopback
(`127.0.0.1`/`localhost`) stays reachable because the sidecar under test in `packages/server/tests`
is itself a local server.

The offline matrix covers stream and reasoning deltas, one terminal event per turn, complete usage,
retry, overflow compaction, restore, interruption, per-session model isolation, JSONL corruption
reporting, GoodMemory recall/writeback/degradation, zero tools by default plus exact allowlist
activation, workspace escape and symlink blocking, approval grant/deny/timeout/abort, protocol
round-trips with snapshot and core type-compat guards, sidecar auth/frames/WAL replay/crash
synthesis, CLI commands, signals, exit codes, and built package imports.

## Snapshot replay

`packages/core/tests/snapshot/` is the whole-engine regression layer between unit tests and live
tests. The fixture is the product's own persisted pi transcript: `snapshot:record` runs a scenario
against a real model once (explicit opt-in below), tokenizes recording-machine paths to
`{{workspace}}`/`{{data}}`, and stores the transcript plus a normalized expected event projection
under `tests/snapshot/fixtures/<scenario>/`. The default offline suite replays the transcript's
assistant messages through the faux provider, re-runs the full engine (tools execute for real
against a checked-in workspace fixture, approvals answered from the scenario table), and diffs the
normalized projection. `roundtrip.test.ts` proves the converter/normalizer/runner pipeline without
any fixture, including a tamper test.

Recording discipline: a snapshot refresh is fixture production, not correctness review. The recorder
rejects non-success turn endings and undeclared `isError` tool results (the sentinel that keeps a
regression from being committed as a new expectation); the resulting fixture diff must still be
reviewed by a human. Scenario listing and the fixtures directory must agree in both directions —
replay fails loudly instead of skipping.

```bash
TACHIKOMA_RUN_LIVE_TESTS=1 bun run snapshot:record [scenario…]
```

Model selection follows `eval:chat`: `TACHIKOMA_LIVE_PROVIDER`/`TACHIKOMA_LIVE_MODEL`, falling back
to `TACHIKOMA_PROVIDER`/`TACHIKOMA_MODEL`; custom endpoints via `TACHIKOMA_LIVE_MODELS_JSON`
(falling back to `~/.tachikoma/models.json`).

## Live gate

Live tests are opt-in and are never run for pull requests:

```bash
TACHIKOMA_RUN_LIVE_TESTS=1 bun run test:live
```

They test only text chat streaming, usage, and interruption. They do not call tools or write inside
a project. A credential existing in `.env` is insufficient to enable this suite.

## Machine-face smoke

`bun run eval:engined` (`packages/server/evals/engined-smoke.ts`) is a real-network pass through the
**spawned** sidecar binary: stdin token handshake, `engine.hello`, a read turn over WS frames, a
write turn approved over RPC and verified on disk, a full `fromSeq: 0` replay, and a bounded
shutdown. Protocol mechanics stay covered offline by `packages/server/tests`; this adds the one
thing they cannot — the real engine behind the real binary. Same model-selection convention as
`eval:chat`; not part of `verify`; pass/fail only, no baseline.

## Full local verification

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:package
bun run test:pack
bun run audit
```

`test:pack` installs the generated Core and CLI tarballs into a clean temporary consumer. It checks
workspace-version rewriting, package contents, the CLI bin and shebang, public imports,
`--help`/`--version`, and the packed dependency audit.

Release evidence must report each command separately. A successful build or faux test is not proof
that a live provider was exercised.
