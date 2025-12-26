---
name: memory-management
description: |
  Plan, store, retrieve, and prune long-term memory for orchestrator workflows. Use when
  tasks require cross-session recall, project knowledge retention, or memory governance.
---

# Memory Management

## Capture policy
- Record durable decisions, assumptions, and tradeoffs.
- Store stable facts: architecture, APIs, constraints, and risk notes.
- Skip ephemeral logs and transient tool output.

## Memory scopes
- Project: reusable for all tasks in the repo.
- Session: valid for the current run.
- Task: only for a single objective.

## Retrieval strategy
- Rank by relevance, recency, and scope match.
- Prefer summaries over raw logs.
- Merge duplicate facts and resolve conflicts.

## Write format
Include:
- title
- summary (1-3 sentences)
- tags (feature, decision, risk)
- references (files or URLs)
- timestamp

Example entry:
```
Title: Auth token format
Summary: JWT uses RS256 with key rotation every 90 days; refresh tokens stored in Redis.
Tags: decision, auth, security
Refs: packages/auth/jwt.ts, docs/security.md
```

## Pruning rules
- Remove entries older than TTL unless tagged "decision".
- Collapse repeated operational notes into one summary.
- Keep only top-K per scope when memory grows.

## References
- `references/memory-policies.md` - Retrieval scoring and retention rules.
