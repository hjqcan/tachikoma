# Postmortems

A postmortem records an incident whose interesting part is why our process let it through, not the
one-line fix. Admission requires all three:

- **Subtle** — a careful engineer would have to re-derive the failure the hard way.
- **Systemic** — the escape exposes a gap in tests, tooling, or conventions, not a typo.
- **Costly** — rediscovering it would burn real time or real data.

Structure: Executive summary (absorbable in thirty seconds), Timeline (approximate is fine), Root
cause, Guardrails (the code that now prevents recurrence, with file pointers). Postmortems are
frozen history once written; guardrail pointers may be refreshed when code moves, the narrative may
not be rewritten.
