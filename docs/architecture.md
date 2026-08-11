# Current architecture

## Product boundary

Tachikoma `0.2.x` has two packages and one runtime path:

```text
@tachikoma/cli
      |
      v
@tachikoma/core: ChatEngine -> ChatSession
      |                         |
      |                         +-> GoodMemory runtime-kit
      v
pi AgentSession -> ModelRuntime + SessionManager JSONL v3
```

`ChatEngine` creates, opens, lists, and deletes sessions. A `ChatSession` sends text, aborts an
active turn, changes its own model and thinking level, compacts, and closes. Each session owns one
pi `AgentSession`; engine-wide mutable model state is forbidden.

## Sources of truth

| Concern                                        | Owner                        |
| ---------------------------------------------- | ---------------------------- |
| Model catalog and credentials                  | pi `ModelRuntime`            |
| Streaming, retry, interruption, compaction     | pi `AgentSession`            |
| Transcript, restore, model/thinking provenance | pi `SessionManager` JSONL v3 |
| Stable product events                          | Tachikoma `ChatEvent`        |
| Durable recall and writeback                   | GoodMemory `runtime-kit`     |
| Terminal UX and slash commands                 | `@tachikoma/cli`             |

Tachikoma does not translate the transcript into a second storage schema or reconstruct provider
metadata. Credentials remain private to pi and never appear in the public model reference
`{ provider, model }`.

## Event contract

The first-circle stream contains only:

- `message_start`
- `message_delta`
- `reasoning_delta`
- `retry`
- `compaction`
- `memory_status`
- `message_complete`

Every event carries `sessionId`, `turnId`, and a timestamp. Every accepted turn emits exactly one
`message_complete`, with `success`, `interrupted`, or `failed` status and the complete usage
reported by pi, including input/output, cache, reasoning, and cost fields.

GoodMemory failure is non-fatal to model chat but never silent: recall degradation and write failure
surface as `memory_status` events and CLI status lines.

## Explicitly absent

All pi sessions start with `noTools: 'all'`. The public API has no `workDir` or `customTools`, and
the event union has no tool calls or tool results. Images, branch editing, queue UX, tools,
approvals, sandboxing, services, desktop UI, and coordination belong to later spiral turns.

Pre-`0.2.0` APIs, commands, and flat JSON chat sessions are not read or migrated. Old data outside
the repository is left untouched.
