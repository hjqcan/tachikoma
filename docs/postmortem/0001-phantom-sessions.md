# Postmortem 0001: Phantom sessions unlinked a real session's event ledger

## Executive summary

The server's per-session event ledger (WAL) originally lived in pi's `sessions/` directory as
`<id>.events.jsonl`. Core's corrupt-session scan listed those ledger files as phantom "corrupt
sessions", and deleting a phantom through the filename-fallback path unlinked the **real** session's
WAL. Data loss, single incident, during `0.2.x` sidecar development. The ledger now lives in its own
`events/` directory, the scanner explicitly excludes `.events.jsonl`, and deletion clears both
layouts idempotently.

## Timeline (approximate)

1. The sidecar's WAL was first implemented beside pi transcripts: `sessions/<id>.events.jsonl`.
2. `ChatEngine.listSessions()` scans `sessions/*.jsonl` and reports files pi's `SessionManager`
   cannot read as `status: 'corrupt'` — ledgers are not pi-shaped, so every session with a ledger
   also produced a phantom corrupt entry.
3. A phantom was deleted. `deleteSession()`'s fallback matches files by session id parsed from the
   filename; `<id>.events.jsonl` parses to the same id as the real session, so the fallback unlinked
   the live session's WAL.
4. The incident was diagnosed and the ledger was moved out of `sessions/` entirely.

## Root cause

Two subsystems shared one directory namespace, separated only by filename convention. The scanner
had no way to distinguish "not a session" from "corrupt session", and the deletion fallback matched
by id across a namespace that contained non-session files. A derived cache (the ledger) was listable
— and therefore deletable — as if it were a primary artifact.

## Guardrails

- Ledger location is now `<dataDir>/events/<sessionId>.jsonl`, a separate directory from pi's
  `sessions/` (`packages/server/src/wal.ts`, header comment:
  "必须与 pi 的 sessions/ 目录分离…（真实事故）"). Legacy files are migrated on load, and only when
  the new path does not exist — POSIX `rename` overwrites its target, so an old ledger must never
  clobber a new one (`SessionWal.load`).
- The corrupt-session scan excludes `.events.jsonl` by name even though the layout has moved, so a
  stale legacy ledger can never be listed again (`packages/core/src/chat/chat-engine.ts`,
  `listSessions()`: "绝不能被列为幻影"损坏会话"").
- `SessionWal.delete()` clears both the new and the legacy path, idempotently.

Lesson class: give each subsystem its own directory; never let a derived cache be enumerable as a
primary artifact; deletion fallbacks must be namespace-exact. See
[defensive-patterns.md](../defensive-patterns.md).
