---
name: collaboration-protocols
description: |
  Establish collaboration protocols across agents. Use when coordinating multiple workers,
  sharing context, or resolving conflicts in shared artifacts.
---

# Collaboration Protocols

## Shared artifacts
- Maintain a shared blackboard for decisions, constraints, and file maps.
- Write short status updates after each subtask.

## Message conventions
- Use consistent headers: Objective, Findings, Changes, Blockers, Next.
- Keep handoff messages under 10 lines.

## Conflict resolution
- Detect overlapping file edits before merge.
- Assign a single owner for shared files.
- Serialize conflicting tasks and re-run checks after merge.

## Escalation
- Escalate to orchestrator when blockers persist beyond a threshold.
- Request human approval for high-risk changes.

## References
- `references/handoff-template.md` - Handoff message template.
