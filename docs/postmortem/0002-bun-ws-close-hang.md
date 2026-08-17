# Postmortem 0002: Server-side WebSocket close hangs `server.stop(true)` under Bun

## Executive summary

`session.delete` originally closed the deleted session's subscriber WebSockets from inside the RPC
handler. Under Bun, a server-initiated `close()` issued from a fetch-handler context makes a later
`server.stop(true)` hang forever — engined never exits, tests never finish. Observed empirically
(实测); the exact Bun internals were not root-caused. The fix is ownership, not sequencing: the
server only removes sockets from its subscriber set and never closes them; socket lifecycle belongs
to the client.

## Timeline (approximate)

1. `session.delete` was implemented as: close the live session, close each subscribed WebSocket,
   destroy the WAL.
2. Shutdown tests began hanging: `server.stop(true)` never resolved after a delete had run.
3. Bisection isolated the server-side `socket.close()` call inside the RPC handler as the trigger.
   Removing the close (leaving sockets open, merely unsubscribed) made `stop(true)` reliable again.
4. The workaround was promoted to the design: the server never initiates WS closure.

## Root cause

Unproven at the Bun-internals level. The observed contract violation: after a handler-initiated
close, Bun's `server.stop(true)` (which waits for active connections) waits forever, as if the
closed socket were never settled in its accounting. Rather than depending on a fix or on fragile
sequencing, the server stopped owning that lifecycle entirely.

## Guardrails

- `packages/server/src/server.ts`, `session.delete` handler: "只摘订阅、不主动 close：Bun 里从 RPC
  handler 服务端关 WS 会让 server.stop(true) 永久挂起（实测）；死订阅收不到任何帧，socket 生命周期归客户端。"
  Dead subscriptions receive no frames (the subscriber set is the only fan-out path), so an unclosed
  socket is inert, not a leak of events.
- Shutdown quiescence is owned elsewhere: `stop()` closes sessions, awaits all in-flight WAL pumps
  (`Promise.allSettled([...pumps])`), then calls `server.stop(true)`.

Lesson class: dispose must reach quiescence, and when a platform primitive cannot prove quiescence,
do not own that lifecycle at all — leave closure to the peer and make orphaned resources inert. See
[defensive-patterns.md](../defensive-patterns.md).
