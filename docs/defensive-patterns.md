# Defensive patterns

Each pattern below is a defect class that actually shipped or nearly shipped here, stated as the
rule that prevents its recurrence, with the code that embodies it. Add a pattern only with such
evidence; keep this file under ~500 words.

**Validate per grant, not in aggregate.** Aggregate emptiness checks let a good grant shield a bad
one: a dead skill directory would silently load nothing while its parent had already entered the
read-only roots. Every grant must individually prove it took effect
(`packages/core/src/chat/chat-engine.ts`, skill-grant loop: "聚合判空会让好授予掩护坏授予").

**Fail loud before partial effect.** Preconditions run before per-item IO: skills without a
workspace would silently never reach the model ("零工具会话的授予会静默失效" → throws
`skills require a workspace grant`); an unusable `workDir` throws instead of degrading.

**Assert owned invariants at construction.** The active tool set must equal the allowed set exactly;
on mismatch the session is disposed and creation fails (`chat-engine.ts`:
"激活工具集必须与允许集完全一致"). An invariant you own is asserted where you construct it, not
trusted downstream.

**Judge outcomes by structured signals, not rendered text.** GoodMemory renders framing headers even
on an empty store, so "recall hit something" must inspect buckets/metadata, never non-empty text
(`packages/core/src/chat/memory.ts`, `recallHasHits`).

**Widen capability by allow-list only.** Skill roots are readable only by the four known read-only
tools; a future path-taking tool defaults to the workspace root and never silently gains skill-root
access (`packages/core/src/chat/workspace-guard.ts`, `READ_ROOT_TOOLS`).

**Preserve cursors through unknown data.** Frames written by a future version still advance the WAL
`seq` cursor while staying out of the known-frame list — replay positions survive vocabulary growth
(`packages/server/src/wal.ts`).

**Cache the promise, not the result.** Concurrent `subscribe` and `send` on a cold session must
share one WAL load; caching the resolved value creates two instances and loses a whole turn for the
late registrant. Promise caching is natural single-flight (`packages/server/src/server.ts`,
`wal()`).

**Derived caches are never authority.** The event ledger is a projection of pi's transcript; when
the ledger is missing or lacks the user side, it is rebuilt from `ChatEngine.history()` — never the
reverse ("转录是唯一事实源，账本只是派生缓存").

**Do not own lifecycles you cannot settle.** Server-initiated WebSocket close hangs Bun's
`server.stop(true)`; the server therefore only unsubscribes and leaves closure to the client, making
orphaned sockets inert ([postmortem 0002](postmortem/0002-bun-ws-close-hang.md)).

**Separate namespaces per subsystem.** Filename conventions inside a shared directory are not a
boundary: the event ledger living beside pi transcripts produced phantom corrupt sessions whose
deletion unlinked real data ([postmortem 0001](postmortem/0001-phantom-sessions.md)).
