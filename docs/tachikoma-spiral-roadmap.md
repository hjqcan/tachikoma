# Tachikoma spiral roadmap

Tachikoma advances by completing one capability before making the next capability an architectural
fact.

## Turn 1: chatbot

The `0.2.x` line establishes a small, truthful base:

- one `ChatSession` abstraction over pi `AgentSession`;
- streaming text and reasoning with a closed terminal event;
- session-level models, thinking, interruption, retry, compaction, and JSONL recovery;
- default-on GoodMemory with visible degraded states;
- one CLI and an offline-first quality gate;
- zero tools.

Later chatbot work can add images, queue/steer UX, branch editing, model discovery UX, and stronger
live provider evidence without changing transcript ownership.

## Turn 2: tool caller

Only after the chatbot boundary is stable, expose a minimal pi-native tool set. pi remains the sole
model-to-tool loop. Tachikoma adds product policy around approvals, path and network boundaries,
observable tool results, cancellation, and security tests. It must not recreate pi's executors.

## Turn 3: coordinator

Only after one session is an excellent tool caller, introduce coordination as composition of the
same `ChatSession` contract. Scheduling, delegation, budgets, handoff, and aggregation must earn
their own operational evidence. A central coordinator class is not a prerequisite and may never be
the right product abstraction.

## Rule of progression

A later turn cannot weaken an earlier one. New capability must preserve the previous turn's event,
session, memory, interruption, security, and quality guarantees. Placeholder packages and
speculative services are not progress.

## Relationship to the desktop plan

`docs/tachikoma-desktop-plan.md` remains the master design for the desktop direction (Electron shell
↔ renderer ↔ Bun sidecar, `packages/protocol|server|desktop`, ordered WS replay over an event log,
approval escalation). Its protocol, shell, security, and packaging tracks stay valid. Its
engine-core strategy is superseded by this roadmap: the engine grows from `ChatSession`, and the
frozen turn-1 `ChatEvent` contract (sessionId/turnId on every event) is the event family the desktop
protocol package will carry. Desktop shell work starts after turn 2 stabilizes the tool-facing event
surface. The protocol package's implementation-level design lives in
`docs/tachikoma-protocol-design.md`; the package itself lands together with its first real consumer.
