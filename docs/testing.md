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

## Live gate

Live tests are opt-in and are never run for pull requests:

```bash
TACHIKOMA_RUN_LIVE_TESTS=1 bun run test:live
```

They test only text chat streaming, usage, and interruption. They do not call tools or write inside
a project. A credential existing in `.env` is insufficient to enable this suite.

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
