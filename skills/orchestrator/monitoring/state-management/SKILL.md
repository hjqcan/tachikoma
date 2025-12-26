---
name: state-management
description: |
  Manage orchestrator state transitions, checkpoints, and resumability. Use when tracking
  task lifecycle, persisting progress, or coordinating multi-worker state.
---

# State Management

## State model
- pending -> in_progress -> done
- pending -> blocked -> pending
- in_progress -> failed -> replan

## Track state fields
- status
- owner/worker
- startedAt/updatedAt
- dependencies
- artifacts (files, outputs)

## Checkpoint triggers
- Phase completion.
- High-risk operations.
- Periodic timer (e.g., every 10 minutes).

## Resume procedure
1. Load latest valid checkpoint.
2. Verify artifact integrity.
3. Rehydrate worker contexts.
4. Reconcile pending vs completed subtasks.

## References
- `references/checkpoint-schema.md` - Checkpoint JSON schema example.
