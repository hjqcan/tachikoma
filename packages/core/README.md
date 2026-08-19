# @hjqcan/tachikoma-core

The Tachikoma chat runtime. It condenses `@earendil-works/pi-coding-agent` — models, streaming,
retries, compaction, tool execution, and the append-only JSONL session lifecycle — into a thin,
stable product API: `ChatEngine`, `ChatSession`, and the `ChatEvent` stream.

## Install

```bash
bun add @hjqcan/tachikoma-core
```

Requires Bun 1.3.14 or newer.

## Use

```ts
import { ChatEngine } from '@hjqcan/tachikoma-core';

const engine = new ChatEngine({
  model: { provider: 'anthropic', model: 'claude-sonnet-5' },
});
const session = await engine.createSession();

for await (const event of session.send('hello')) {
  if (event.type === 'message_delta') {
    process.stdout.write(event.text);
  }
}

await session.close();
```

`ChatEngine` creates, opens, lists, and deletes sessions, lists the model catalog, and exposes
memory management (`memoryList`/`memorySearch`/`memoryForget`/`memoryClear`). Each `ChatSession`
owns one pi `AgentSession` and provides `send`, `abort`, `respondToApproval`, `setModel`,
`setThinkingLevel`, `rename`, `compact`, and `close`.

The public model reference is only `{ provider, model }`. Credentials stay inside pi (env,
credential store, `models.json` `$ENV` interpolation) and never appear in Tachikoma configuration,
session objects, or events.

## Sessions and events

pi `SessionManager`'s append-only JSONL v3 is the single source of truth for transcripts, restore,
model changes, thinking levels, and compaction records; it lives under `~/.tachikoma/sessions` by
default. `send()` returns an async stream of `ChatEvent`:

- `user_message` — the turn's first event (the prompt text)
- `message_start`, `message_delta`, `reasoning_delta`
- `retry`, `compaction`, `memory_status`
- `tool_call`, `tool_update`, `tool_result`
- `tool_approval_request`, `tool_approval_resolved`
- `message_complete` — exactly one per turn, with `success` | `interrupted` | `failed` and pi's
  complete usage

The union evolves additively only; consumers must tolerate unknown event types.

## Tools and approvals

The default product has zero tools. Tool enablement is an explicit grant, never an environment
default:

- `workDir` enables pi's read-only set (`read`, `grep`, `find`, `ls`), scoped by a guard that blocks
  any path resolving — or symlinking — outside the canonical workspace root.
- `toolset: 'coding'` adds `write`, `edit`, `bash`; each call emits `tool_approval_request` and
  blocks until `respondToApproval` (a configurable timeout denies by default).
- `skills: [<path>…]` grants SKILL.md files or skill directories (requires a workspace grant;
  nothing is discovered from the environment).
- Grants are engine-level (`ChatEngineConfig`) or per live session
  (`createSession({ workDir, toolset, skills })`); session grants never persist across reopen.
  `workDir: null` explicitly revokes the engine default for that session; `skills: []` explicitly
  clears it.

Named presets bundle a session composition as data: `resolvePreset(configDir, name)` reads
`<configDir>/presets/<name>.json` and `mergePresetConfig(overrides, preset)` applies
explicit-over-preset merge semantics. The engine itself never reads presets — resolution belongs to
the edges (CLI, sidecar).

## GoodMemory

Durable memory is on by default (SQLite at `~/.tachikoma/memory/goodmemory.sqlite`); pass
`memory: false` to disable. Recall or writeback failure never interrupts chat — degradation surfaces
through `memory_status` events and the `session.memoryStatus` snapshot.

## Boundaries

- Text-only input; images and coordination runtimes are out of scope for `0.2.x`.
- pi remains the sole model-to-tool loop; this package adds policy, never executors.
- No compatibility with pre-`0.2.0` APIs or session files.
