# Tachikoma Repository Guide

Tachikoma follows a spiral product sequence: first a top-tier chatbot, then a top-tier tool caller,
then a top-tier coordinator. Do not make later stages an architectural prerequisite for the current
one.

## Current product boundary

- Bun `1.3.14` is the canonical runtime and package manager.
- The only workspaces are `@tachikoma/core` and `@tachikoma/cli`.
- pi-mono owns models, credentials, streaming, retry, compaction, transcript persistence, and the
  session lifecycle.
- GoodMemory owns durable user memory and is enabled by default.
- The current `0.2.x` product has no tools, orchestration, HTTP server, or desktop application.
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
- Never expose API keys through public configuration, events, logs, or CLI flags.
- The first-circle event contract contains no tool events. Do not add tools before the next spiral
  explicitly starts.
- Add focused diagnostics for genuinely complex runtime chains, but do not add speculative defensive
  layers or verbose commentary for impossible states.
- Do not commit runtime data under `.tachikoma/`, generated `dist/`, coverage, or local reference
  repositories under `third-party/`.

See [`docs/architecture.md`](docs/architecture.md) for ownership boundaries and
[`docs/tachikoma-spiral-roadmap.md`](docs/tachikoma-spiral-roadmap.md) for sequencing.
