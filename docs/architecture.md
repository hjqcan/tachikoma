# Current architecture

## Product boundary

Tachikoma `0.2.x` has five packages and one runtime path:

```text
@hjqcan/tachikoma-cli            @hjqcan/tachikoma-server (tachikoma-engined sidecar)
      |                        |          \
      |                        |           +-> @hjqcan/tachikoma-protocol (wire schemas)
      v                        v                    ^
@hjqcan/tachikoma-core: ChatEngine -> ChatSession          |  (desktop renderer depends
      |                         |                   |   on protocol only)
      |                         +-> GoodMemory runtime-kit
      v
pi AgentSession -> ModelRuntime + SessionManager JSONL v3
```

`ChatEngine` creates, opens, lists, and deletes sessions, and lists the model catalog. A
`ChatSession` sends text, aborts an active turn, answers tool approvals, changes its own model and
thinking level, compacts, and closes. Each session owns one pi `AgentSession`; engine-wide mutable
model state is forbidden.

`@hjqcan/tachikoma-cli` talks to core in-process. `@hjqcan/tachikoma-server` is the local sidecar
for remote consumers (the desktop shell, and any machine client): HTTP RPC plus a WebSocket event
stream, speaking only the schemas in `@hjqcan/tachikoma-protocol`. The protocol package is
renderer-safe: zod-only, compiled with an empty `types` list so no bun/node API can leak in.

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
| Wire schemas, frames, RPC envelope                 | `@hjqcan/tachikoma-protocol`     |
| Event `seq`, WAL, replay, transport auth           | `@hjqcan/tachikoma-server`       |
| Terminal UX and slash commands                     | `@hjqcan/tachikoma-cli`          |

Tachikoma does not translate the transcript into a second storage schema or reconstruct provider
metadata. Credentials remain private to the engine process (pi auth, env, `models.json` `$ENV`
interpolation) and never appear in events, DTOs, or the public model reference
`{ provider, model }`.

Directory layering: `dataDir` holds workspace-scoped state (sessions, WAL, memory sqlite);
`configDir` (default = `dataDir`, env `TACHIKOMA_CONFIG_DIR`) holds user-level configuration — today
only `models.json`. Deployments that point `dataDir` into each workspace (one sidecar per project)
set `configDir` once so model/credential configuration is shared, not copied.

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
`@hjqcan/tachikoma-protocol` mirrors this union with zod schemas, enforces bidirectional type
compatibility with core at compile time, and guards its own shape with a JSON Schema snapshot.

GoodMemory failure is non-fatal to model chat but never silent: recall degradation and write failure
surface as `memory_status` events and CLI status lines. A successful recall additionally carries
`recalled` — the per-hit detail (`id`/`type`/`preview`/`score`) — so consumers can show what the
machine remembered this turn. The engine also exposes a memory-management face
(`memoryList`/`memorySearch`/`memoryForget`/`memoryClear`, RPC `memory.*`, capability
`memory-management`) built entirely on GoodMemory's public API; search is a local filter over the
exported records because recall is tuned for prompt context, not management enumeration.

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
- Skills are the same explicit-grant shape (capability `skills`): `ChatEngineConfig.skills` /
  `createSession({ skills })` list SKILL.md files or skill directories; nothing is discovered from
  the environment and zero grants means zero disk scans. A grant requires a workspace grant — pi
  only surfaces skills to sessions holding the `read` tool — and skill roots join the guard as
  read-only roots (read/grep/find/ls may read them; write/edit stay workspace-only; bash keeps
  approval as its control surface). Unusable grant paths and grants that load nothing fail session
  creation; partially dropped skills (e.g. missing `description`) are visible by absence in the
  session summary's `skills` list, which is the truth surface. A session grant replaces the engine
  default (`[]` = explicitly none), lives only in the live session, and is echoed nowhere else.
- The CLI exposes this as `--workdir`, `--toolset read-only|coding`, and `--allow write,edit,bash`
  (which implies the coding toolset), plus `/workspace <dir> [toolset]` in the REPL for runtime
  grants (a new session with the grant; `/workspace off` revokes). The interactive REPL prompts
  `approve <tool>? [y/N/a]` for ungranted requests; `run` mode and non-TTY deny them immediately.
  The desktop grants through a native folder picker (workspace chip → new session with the grant).

pi remains the sole model-to-tool loop. Tachikoma adds policy through pi extension hooks and never
reimplements executors.

## Local sidecar

`tachikoma-engined` (in `@hjqcan/tachikoma-server`) hosts one engine for remote consumers on
`127.0.0.1`: the shell injects a Bearer token as the first stdin line, the sidecar prints a single
`listening` JSON line, HTTP `/v1/rpc` carries the RPC envelope, and WebSocket subscribers replay the
per-session WAL from any `fromSeq` before receiving live frames. The server is the sole consumer of
each turn's event stream: it assigns the monotonic `seq`, appends to the WAL first, then fans out.
After a crash, an unterminated turn is completed with a synthetic `failed` frame written into the
WAL so replay cursors stay consistent.

The WAL lives at `<dataDir>/events/<sessionId>.jsonl` (never inside pi's `sessions/` directory) and
is a derived replay cache: the pi transcript is the source of truth. A ledger that is missing or has
no `user_message` frames is rebuilt from the transcript on first access, turn by turn in the live
stream's shape: `user_message`, `message_start`, text deltas, `tool_call`/`tool_result` frames with
their original call ids, and exactly one `message_complete`. Only streaming increments that the
transcript does not store (thinking deltas, `tool_update`) are not reconstructed.

## Desktop shell (walking skeleton)

`@hjqcan/tachikoma-desktop` is the Electron shell: the main process supervises `tachikoma-engined`
(token via stdin, three-stage stop: shutdown RPC → SIGTERM → SIGKILL), exposes `serverInfo` and a
native workspace picker over a context-isolated preload, and the renderer is vanilla TS that speaks
only `@hjqcan/tachikoma-protocol` — streaming, collapsible reasoning, live tool telemetry, approval
cards, and session-level workspace grants from the header. The machine voice renders a minimal safe
Markdown subset (DOM construction only, never innerHTML with model output); links open in the system
browser and the window itself never navigates. On macOS the title bar is `hiddenInset` with the
header as the drag region.

Sessions are threads: a persistent sidebar (filter, inline rename via `session.rename`, relative
timestamps), and switching away from a generating session does not abort it — the renderer keeps one
WebSocket per session, background events only drive the sidebar state dot, and switching back
replays the WAL from seq 0. The memory drawer (amber, `memory.*` RPC) lists, searches, and prunes
the GoodMemory store; recall turns show an expandable "召回 N 条记忆" line built from the
`memory_status.recalled` detail. Coding turns end with a wrap-up card aggregating the turn's
write/edit calls, and the footer carries a context-usage gauge (last turn's tokens over the model's
`contextWindow`) that turns amber past 70% and offers `session.compact`. React and packaging/signing
belong to later desktop iterations.

## Explicitly absent

Images, branch editing, queue/steer UX, MCP and network tools, desktop packaging/signing, and
coordination (turn 3) belong to later work. Pre-`0.2.0` APIs, commands, and flat JSON chat sessions
are not read or migrated. Old data outside the repository is left untouched.
