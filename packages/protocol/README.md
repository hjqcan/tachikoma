# @tachikoma/protocol

Renderer-safe wire contract for the Tachikoma engine: zod schemas for the `ChatEvent` stream,
session/memory DTOs, the RPC envelope and method table, and the capability list. Pure types + zod —
no bun/node APIs — so browser/renderer processes can depend on it directly.

Consumed by remote clients of `tachikoma-engined` (see `@tachikoma/server`). The contract evolves
additively only; consumers must tolerate unknown event types.

Part of [Tachikoma](https://github.com/hjqcan/tachikoma). MIT licensed.
