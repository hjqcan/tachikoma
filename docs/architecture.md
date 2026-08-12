# Current architecture

## Product boundary

Tachikoma `0.2.x` has four packages and one runtime path:

```text
@tachikoma/cli            @tachikoma/server (tachikoma-engined sidecar)
      |                        |          \
      |                        |           +-> @tachikoma/protocol (wire schemas)
      v                        v                    ^
@tachikoma/core: ChatEngine -> ChatSession          |  (desktop renderer depends
      |                         |                   |   on protocol only)
      |                         +-> GoodMemory runtime-kit
      v
pi AgentSession -> ModelRuntime + SessionManager JSONL v3
```

`ChatEngine` creates, opens, lists, and deletes sessions, and lists the model catalog. A
`ChatSession` sends text, aborts an active turn, answers tool approvals, changes its own model and
thinking level, compacts, and closes. Each session owns one pi `AgentSession`; engine-wide mutable
model state is forbidden.

`@tachikoma/cli` talks to core in-process. `@tachikoma/server` is the local sidecar for remote
consumers (the future desktop shell): HTTP RPC plus a WebSocket event stream, speaking only the
schemas in `@tachikoma/protocol`. The protocol package is renderer-safe: zod-only, compiled with an
empty `types` list so no bun/node API can leak in.

## Sources of truth

| Concern                                            | Owner                            |
| -------------------------------------------------- | -------------------------------- |
| Model catalog and credentials                      | pi `ModelRuntime`                |
| Streaming, retry, interruption, compaction         | pi `AgentSession`                |
| Tool execution (read/grep/find/ls/write/edit/bash) | pi tools                         |
| Transcript, restore, model/thinking provenance     | pi `SessionManager` JSONL v3     |
| Stable product events                              | Tachikoma `ChatEvent`            |
| Workspace path boundary and approval policy        | core `workspace-guard` extension |
| Durable recall and writeback                       | GoodMemory `runtime-kit`         |
| Wire schemas, frames, RPC envelope                 | `@tachikoma/protocol`            |
| Event `seq`, WAL, replay, transport auth           | `@tachikoma/server`              |
| Terminal UX and slash commands                     | `@tachikoma/cli`                 |

Tachikoma does not translate the transcript into a second storage schema or reconstruct provider
metadata. Credentials remain private to the engine process (pi auth, env, `models.json` `$ENV`
interpolation) and never appear in events, DTOs, or the public model reference
`{ provider, model }`.

## Event contract

The frozen stream union (turns 1 and 2):

- `user_message` (the turn's first event: the user's prompt text, so WAL replay reconstructs both
  sides of the conversation)
- `message_start`, `message_delta`, `reasoning_delta`
- `retry`, `compaction`, `memory_status`
- `tool_call`, `tool_update`, `tool_result`
- `tool_approval_request`, `tool_approval_resolved`
- `message_complete`

Every event carries `sessionId`, `turnId`, and a timestamp. Every accepted turn emits exactly one
`message_complete`, with `success`, `interrupted`, or `failed` status and the complete usage
reported by pi, including input/output, cache, reasoning, and cost fields.

The contract evolves additively only: new event types and optional fields may be added; existing
semantics never change. Consumers must tolerate unknown event types. On the wire,
`@tachikoma/protocol` mirrors this union with zod schemas, enforces bidirectional type compatibility
with core at compile time, and guards its own shape with a JSON Schema snapshot.

GoodMemory failure is non-fatal to model chat but never silent: recall degradation and write failure
surface as `memory_status` events and CLI status lines.

## Tools and approvals (turn 2)

The default product has zero tools: without `workDir`, sessions start with `noTools: 'all'` and an
assertion enforces the empty set. Tool enablement is a per-invocation grant, never ambient:

- `workDir` enables pi's read-only set (`read`, `grep`, `find`, `ls`), approval-free.
- `toolset: 'coding'` adds `write`, `edit`, `bash`; each call emits `tool_approval_request` and
  blocks until `respondToApproval`, a configurable timeout denies by default, and abort denies and
  interrupts.
- The workspace guard runs before approval: paths that resolve — or symlink — outside the canonical
  workspace root are blocked without ever asking. bash has no path analysis; approval itself is its
  control surface, so the request carries the full command for the user to judge.
- bash timeout policy (guard-level, mutate-in-hook): a call without `timeout` gets 120s; explicit
  values are clamped to 600s. The approval request already shows the clamped value — what you
  approve is what runs.
- Grants are engine-level (`ChatEngineConfig.workDir`/`toolset`) or session-level
  (`createSession({ workDir, toolset })`, RPC `session.create`, capability `session-workspace`).
  Session grants are live-session state: they never persist, and a reopened session returns to the
  engine default until re-granted.
- The CLI exposes this as `--workdir`, `--toolset read-only|coding`, and `--allow write,edit,bash`
  (which implies the coding toolset), plus `/workspace <dir> [toolset]` in the REPL for runtime
  grants (a new session with the grant; `/workspace off` revokes). The interactive REPL prompts
  `approve <tool>? [y/N/a]` for ungranted requests; `run` mode and non-TTY deny them immediately.
  The desktop grants through a native folder picker (workspace chip → new session with the grant).

pi remains the sole model-to-tool loop. Tachikoma adds policy through pi extension hooks and never
reimplements executors.

## Local sidecar

`tachikoma-engined` (in `@tachikoma/server`) hosts one engine for remote consumers on `127.0.0.1`:
the shell injects a Bearer token as the first stdin line, the sidecar prints a single `listening`
JSON line, HTTP `/v1/rpc` carries the RPC envelope, and WebSocket subscribers replay the per-session
WAL from any `fromSeq` before receiving live frames. The server is the sole consumer of each turn's
event stream: it assigns the monotonic `seq`, appends to the WAL first, then fans out. After a
crash, an unterminated turn is completed with a synthetic `failed` frame written into the WAL so
replay cursors stay consistent.

The WAL lives at `<dataDir>/events/<sessionId>.jsonl` (never inside pi's `sessions/` directory) and
is a derived replay cache: the pi transcript is the source of truth. A ledger that is missing or has
no `user_message` frames is rebuilt from the transcript on first access (text turns only — tool-call
frames are not reconstructed).

## Desktop shell (walking skeleton)

`@tachikoma/desktop` is the Electron shell: the main process supervises `tachikoma-engined` (token
via stdin, three-stage stop: shutdown RPC → SIGTERM → SIGKILL), exposes `serverInfo` and a native
workspace picker over a context-isolated preload, and the renderer is vanilla TS that speaks only
`@tachikoma/protocol` — streaming, collapsible reasoning, live tool telemetry, approval cards, and
session-level workspace grants from the header. React, packaging/signing, and a compiled sidecar
binary belong to later desktop iterations.

## Explicitly absent

Images, branch editing, queue/steer UX, MCP and network tools, desktop packaging/signing, and
coordination (turn 3) belong to later work. Pre-`0.2.0` APIs, commands, and flat JSON chat sessions
are not read or migrated. Old data outside the repository is left untouched.
