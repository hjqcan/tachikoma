# Decision notes

A note records a decision that affects this codebase — the why and what we gave up, the parts code
cannot carry. One file per decision: `docs/notes/YYYY-MM-DD-topic.md`.

Rules, deliberately few:

- Write one for any decision you would otherwise re-litigate in a future session: architecture
  boundaries, format/wire choices, adopted or rejected external practices, testing strategy.
- **`## Alternatives considered` is mandatory.** A decision recorded without what it beat invites
  re-litigation.
- Notes are living documents for facts (update paths and names in place when code moves) but the
  decision itself is not rewritten — a reversed decision gets a new note linking the old one.
