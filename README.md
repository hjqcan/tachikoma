# Tachikoma

Tachikoma is a conversation-first chatbot runtime for Bun and TypeScript.

Version `0.2.x` follows a spiral: make chat excellent, then tools, then coordination. Turn 1 (chat)
and turn 2 (opt-in workspace tools behind per-call approvals) are implemented, along with a local
sidecar and an Electron desktop shell (walking skeleton: streaming chat, tool telemetry, approval
cards, workspace grants). There is intentionally no coordination runtime yet.

## What owns what

- `@hjqcan/tachikoma-core` exposes the stable `ChatEngine`, `ChatSession`, and `ChatEvent` product
  boundary.
- `@earendil-works/pi-coding-agent` owns model discovery and credentials, streaming, retries,
  compaction, interruption, tool execution, and append-only JSONL v3 sessions.
- `goodmemory` owns durable recall and writeback. It is enabled by default and stores local data at
  `~/.tachikoma/memory/goodmemory.sqlite`.
- `@hjqcan/tachikoma-protocol` is the renderer-safe wire contract (zod-only) for remote consumers.
- `@hjqcan/tachikoma-server` ships `tachikoma-engined`, the local sidecar: HTTP RPC plus WS event
  frames replayed from a per-session WAL.
- `@hjqcan/tachikoma-cli` is the interactive product surface.

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

The REPL supports `/new`, `/sessions`, `/resume`, `/model`, `/models`, `/thinking`, `/tools`,
`/workspace` (grant or revoke a workspace at runtime — opens a new session with the grant),
`/compact`, `/memory`, `/help`, and `/exit`. API keys are never accepted as command-line arguments.

## Custom models and endpoints

pi's `ModelRuntime` resolves models from its built-in catalog plus an optional
`<configDir>/models.json` (default: `configDir` = `dataDir` = `~/.tachikoma`, so
`~/.tachikoma/models.json`). Set `configDir` (env: `TACHIKOMA_CONFIG_DIR`) when `dataDir` is
per-workspace — one sidecar per project/book — so every workspace shares one user-level model and
credential file instead of a copy each. Use it to register OpenAI-compatible gateways or models that
are not in the catalog. `apiKey` supports `$ENV_VAR` interpolation, so no secret has to live in the
file:

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

## Workspace tools and approvals (turn 2)

Passing `workDir` to `ChatEngine` (CLI: `--workdir <dir>`) enables pi's read-only tool set (`read`,
`grep`, `find`, `ls`) scoped to that directory. A guard extension blocks any path that resolves — or
symlinks — outside the canonical workspace root. `toolset: 'coding'` (CLI: `--toolset coding`, or
implied by `--allow`) adds write/execute tools: each call emits `tool_approval_request` and waits
for `respondToApproval`; timeouts deny by default, and the guard runs before approval is ever asked.
In the interactive REPL, ungranted requests prompt `approve <tool>? [y/N]`;
`--allow write,edit,bash` pre-grants for the invocation, and `run` mode / non-TTY denies ungranted
requests immediately. Tool output streams as it happens (`tool_update`).

Skills follow the same explicit-grant shape: `skills: [<path>…]` (CLI: `--skills <path>`,
repeatable; REPL: `/skills`) loads the listed SKILL.md files or skill directories — nothing is
discovered from the environment, and zero grants means zero disk scans. A grant requires `workDir`
(pi only surfaces skills to sessions that hold the `read` tool), skill roots become read-only for
the guard (write/edit stay workspace-only), and every grant must load at least one skill or session
creation fails — a broken grant is never silently inactive. The session summary lists what actually
loaded. A session-level `skills` grant replaces the engine default; `[]` explicitly clears it. Note:
granting a single SKILL.md file makes its **parent directory** the read-only root (a skill's
references resolve against its directory), so keep each skill in its own directory.

Grants are also per-session: `createSession({ workDir, toolset })` (RPC `session.create`, desktop:
the workspace chip in the header) scopes tools to one live session, overriding the engine default.
Grants never persist — reopening a session returns to the engine default until re-granted. Without
any grant the product stays tool-free — tool enablement is an explicit grant, never an environment
default.

## Local sidecar

`tachikoma-engined` hosts one engine on `127.0.0.1` for remote consumers (the future desktop shell).
The supervising shell injects a Bearer token as the first stdin line — never via argv or env — and
reads one `listening` JSON line from stdout. Engine configuration comes from shell-controlled env
(`TACHIKOMA_DATA_DIR`, `TACHIKOMA_CONFIG_DIR` — user-level config such as models.json when the data
dir is per-workspace — `TACHIKOMA_PROVIDER`/`TACHIKOMA_MODEL`, `TACHIKOMA_WORKDIR`,
`TACHIKOMA_TOOLSET`, `TACHIKOMA_SKILLS` — skill grant paths joined with the platform PATH delimiter
— `TACHIKOMA_SYSTEM_PROMPT_FILE` — replaces the default system prompt with the file's content,
unreadable or empty fails startup; the engine always appends one factual tool-posture sentence
(zero-tool / read-only / coding) after any prompt — and `TACHIKOMA_NO_MEMORY=1`). Clients speak
`@hjqcan/tachikoma-protocol`: HTTP `POST /v1/rpc`, one-time WS tickets from
`POST /v1/auth/ws-ticket`, and `subscribe {sessionId, fromSeq}` for lossless replay over the
per-session WAL.

The sidecar also compiles to a single binary: `bun run --cwd packages/server build:bin` produces
`packages/server/dist/tachikoma-engined` (bun runtime embedded; real model turns and the GoodMemory
sqlite path verified in compiled form). The desktop shell uses it when `TACHIKOMA_ENGINED_BIN`
points at the binary — an explicit opt-in so a stale binary can never silently shadow the dev build.

## Library

```ts
import { ChatEngine } from '@hjqcan/tachikoma-core';

const engine = new ChatEngine({ memory: {} });
const session = await engine.createSession({
  model: { provider: 'anthropic', model: 'claude-sonnet-5' },
});

for await (const event of session.send('Hello. Remember that I prefer concise answers.')) {
  if (event.type === 'message_delta') process.stdout.write(event.text);
}

await session.close();
```

Sessions start with zero tools unless `workDir` is configured; credentials never appear in public
configuration or events. The `ChatEvent` union covers the user prompt (`user_message`, first event
of each turn), streaming, reasoning, retry, compaction, memory status, tool calls, approvals, and
exactly one terminal `message_complete` per turn.

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
