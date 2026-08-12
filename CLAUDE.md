# CLAUDE.md

Use [`AGENTS.md`](AGENTS.md) as the repository guide.

The current architecture is deliberately small: `@tachikoma/cli` is the interactive product and
`tachikoma-engined` (in `@tachikoma/server`) is the machine-facing sidecar; `@tachikoma/core`
exposes `ChatEngine` and `ChatSession`; `@tachikoma/protocol` is the renderer-safe wire contract;
pi-mono owns the model/session/tool runtime; GoodMemory owns durable memory. Tools are opt-in per
invocation with per-call approval for write/edit/bash. There is no legacy coordination runtime,
self-built tool runtime, gateway, sandbox, or compatibility path in `0.2.x`.

The canonical verification command is:

```bash
bun run verify
```

Default tests must never access the network. Live tests require the explicit opt-in documented in
[`docs/testing.md`](docs/testing.md).
