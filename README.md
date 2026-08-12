# Tachikoma

Tachikoma is a conversation-first chatbot runtime for Bun and TypeScript.

Version `0.2.x` is the first clean turn of a spiral: make chat excellent before introducing tools,
and make tools excellent before introducing coordination. It intentionally contains no tool calls,
coordination runtime, HTTP service, or desktop application.

## What owns what

- `@tachikoma/core` exposes the stable `ChatEngine`, `ChatSession`, and `ChatEvent` product
  boundary.
- `@earendil-works/pi-coding-agent` owns model discovery and credentials, streaming, retries,
  compaction, interruption, tool execution, and append-only JSONL v3 sessions.
- `goodmemory` owns durable recall and writeback. It is enabled by default and stores local data at
  `~/.tachikoma/memory/goodmemory.sqlite`.
- `@tachikoma/protocol` is the renderer-safe wire contract (zod-only) for remote consumers.
- `@tachikoma/server` ships `tachikoma-engined`, the local sidecar: HTTP RPC plus WS event frames
  replayed from a per-session WAL.
- `@tachikoma/cli` is the interactive product surface.

Tachikoma does not carry a second provider catalog, retry loop, transcript format, or legacy session
reader.

## Requirements

- Bun `1.3.14` or newer in the `1.3` line
- A credential supported by pi's `ModelRuntime`, supplied through the provider's environment
  variable or pi credential store

```bash
bun install --frozen-lockfile
cp .env.example .env
```

## CLI

```bash
# Interactive chat; both forms enter the same REPL.
bun run packages/cli/src/cli.ts
bun run packages/cli/src/cli.ts chat

# One turn through the same ChatSession runtime.
bun run packages/cli/src/cli.ts run "Explain why append-only sessions help recovery"

# Disable durable memory explicitly for one invocation.
bun run packages/cli/src/cli.ts chat --no-memory
```

The REPL supports `/new`, `/sessions`, `/resume`, `/model`, `/thinking`, `/compact`, `/memory`,
`/help`, and `/exit`. API keys are never accepted as command-line arguments.

## Custom models and endpoints

pi's `ModelRuntime` resolves models from its built-in catalog plus an optional
`<dataDir>/models.json` (default `~/.tachikoma/models.json`). Use it to register OpenAI-compatible
gateways or models that are not in the catalog. `apiKey` supports `$ENV_VAR` interpolation, so no
secret has to live in the file:

```json
{
  "providers": {
    "my-gateway": {
      "name": "My Gateway",
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$OPENAI_API_KEY",
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Select it with `tachikoma --provider my-gateway --model my-model`, or `/model my-gateway/my-model`
inside the REPL. Set `"reasoning": true` on models that support thinking so `--thinking` and
`/thinking` levels take effect.

## Read-only workspace tools (turn 2)

Passing `workDir` to `ChatEngine` enables pi's read-only tool set (`read`, `grep`, `find`, `ls`)
scoped to that directory. A guard extension blocks any path that resolves — or symlinks — outside
the canonical workspace root. Without `workDir` the product stays tool-free: the turn-1 default is
unchanged. Write/execute tools and approvals are later turn-2 increments.

## Local sidecar

`tachikoma-engined` hosts one engine on `127.0.0.1` for remote consumers (the future desktop shell).
The supervising shell injects a Bearer token as the first stdin line — never via argv or env — and
reads one `listening` JSON line from stdout. Engine configuration comes from shell-controlled env
(`TACHIKOMA_DATA_DIR`, `TACHIKOMA_PROVIDER`/`TACHIKOMA_MODEL`, `TACHIKOMA_WORKDIR`,
`TACHIKOMA_TOOLSET`, `TACHIKOMA_NO_MEMORY=1`). Clients speak `@tachikoma/protocol`: HTTP
`POST /v1/rpc`, one-time WS tickets from `POST /v1/auth/ws-ticket`, and
`subscribe {sessionId, fromSeq}` for lossless replay over the per-session WAL.

## Library

```ts
import { ChatEngine } from '@tachikoma/core';

const engine = new ChatEngine({ memory: {} });
const session = await engine.createSession({
  model: { provider: 'anthropic', model: 'claude-sonnet-5' },
});

for await (const event of session.send('Hello. Remember that I prefer concise answers.')) {
  if (event.type === 'message_delta') process.stdout.write(event.text);
}

await session.close();
```

All first-circle sessions start pi with `noTools: 'all'`. Public configuration does not expose a
working directory, custom tools, or credentials, and `ChatEvent` has no tool event variants.

## Development

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:package
bun run test:pack
bun run audit
```

Normal tests are structurally offline. See [`docs/testing.md`](docs/testing.md) before running the
explicit live suite.

More detail: [`docs/architecture.md`](docs/architecture.md) and
[`docs/tachikoma-spiral-roadmap.md`](docs/tachikoma-spiral-roadmap.md).
