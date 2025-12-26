# Memory Policies

## Retrieval scoring
```
score = 0.5 * relevance + 0.3 * recency + 0.2 * scopeMatch
```

## Conflict resolution
- Prefer newer decision records over older notes.
- When two facts conflict, keep both with timestamps and mark as conflict.
- Escalate to human when conflicts affect requirements or safety.

## Retention rules
- Keep decisions indefinitely unless superseded.
- Keep project facts until invalidated.
- Prune session/task notes after TTL.
