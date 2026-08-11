# CLAUDE.md

Use [`AGENTS.md`](AGENTS.md) as the repository guide.

The current architecture is deliberately small: `@tachikoma/cli` is the only executable product,
`@tachikoma/core` exposes `ChatEngine` and `ChatSession`, pi-mono owns the model/session runtime,
and GoodMemory owns durable memory. There is no legacy coordination runtime, tool runtime, gateway,
sandbox, or compatibility path in `0.2.x`.

The canonical verification command is:

```bash
bun run verify
```

Default tests must never access the network. Live tests require the explicit opt-in documented in
[`docs/testing.md`](docs/testing.md).
