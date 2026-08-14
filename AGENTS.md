# Tachikoma Repository Guide

Tachikoma follows a spiral product sequence: first a top-tier chatbot, then a top-tier tool caller,
then a top-tier coordinator. Do not make later stages an architectural prerequisite for the current
one.

## Current product boundary

- Bun `1.3.14` is the canonical runtime and package manager.
- Workspaces: `@hjqcan/tachikoma-core`, `@hjqcan/tachikoma-protocol`, `@hjqcan/tachikoma-server`,
  `@hjqcan/tachikoma-cli`.
- pi-mono owns models, credentials, streaming, retry, compaction, transcript persistence, the
  session lifecycle, and tool execution.
- GoodMemory owns durable user memory and is enabled by default.
- Tools are opt-in per invocation (turn 2): `workDir` enables the read-only set; the coding toolset
  adds write/edit/bash behind per-call approval with timeout-deny. The default product has zero
  tools.
- `tachikoma-engined` is the local sidecar for remote consumers (HTTP RPC + WS frames over a WAL),
  speaking only `@hjqcan/tachikoma-protocol`. No desktop shell exists yet; coordination (turn 3) has
  not started.
- There is no compatibility promise for pre-`0.2.0` APIs, commands, or session files.

## Commands

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run audit
```

Run live model tests only with the explicit opt-in command documented in
[`docs/testing.md`](docs/testing.md). Normal tests must stay offline even when `.env` contains real
credentials.

## Working rules

- Prefer deletion and one source of truth over compatibility shims or duplicated runtimes.
- Keep `ChatEngine` and `ChatSession` as product boundaries, not alternate implementations of pi.
- Never expose API keys through public configuration, events, logs, CLI flags, or the wire.
- The event contract evolves additively only; consumers must tolerate unknown event types. Tool
  enablement stays an explicit grant — per invocation or per live session, never an ambient
  environment default, and session grants never persist across reopen. The workspace guard runs
  before approval; write/edit/bash always require approval.
- Add focused diagnostics for genuinely complex runtime chains, but do not add speculative defensive
  layers or verbose commentary for impossible states.
- Do not commit runtime data under `.tachikoma/`, generated `dist/`, coverage, or local reference
  repositories under `third-party/`.

See [`docs/architecture.md`](docs/architecture.md) for ownership boundaries and
[`docs/tachikoma-spiral-roadmap.md`](docs/tachikoma-spiral-roadmap.md) for sequencing.

架构和代码始终秉持极简主义，不要过度设计。
