---
name: worker-roles
description: |
  Define worker roles and assign tasks by capability. Use when selecting workers, matching
  expertise to subtasks, or balancing load.
---

# Worker Roles

## Predefined roles
- frontend-specialist: UI, components, styling, accessibility.
- backend-specialist: APIs, databases, auth, performance.
- testing-specialist: unit/integration/E2E tests, mocks, coverage.
- devops-specialist: CI/CD, containers, deployment, monitoring.
- docs-specialist: docs, READMEs, API guides.

## Matching workflow
1. Extract keywords from the subtask objective.
2. Score roles by keyword matches (longer keywords score higher).
3. Pick the top role or split the task if scores tie.

## Assignment strategies
- role-affinity: prefer matching roles.
- least-loaded: assign to the least busy worker.
- round-robin: when tasks are uniform.
- sticky: keep related tasks on the same worker.

## Parallel allocation
- Group by role and dispatch in parallel when no dependencies.
- Prioritize critical path tasks before non-critical tasks.

## Scripts
- `scripts/match_role.py` - Score role matches by keyword hits in an objective.
  Example: `python3 scripts/match_role.py \"Add OAuth login and update API docs\" --top 3`

## References
- `references/role-keywords.md` - Role keyword lists and scoring example.
