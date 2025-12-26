---
name: conditional-routing
description: |
  Define conditional routing rules for task flows. Use when execution paths depend on results,
  validations, risk gates, or dynamic constraints.
---

# Conditional Routing

## Build routing rules
- Define predicates from outputs, tests, or risk checks.
- Map each predicate to a route (next task or replan).
- Add a default fallback route.

## Routing table template
| Condition | Route | Action |
|-----------|-------|--------|
| tests_pass | proceed | continue to integration |
| tests_fail | fix | create bugfix subtask |
| risk_high  | gate | require approval |
| else       | replan | adjust plan |

## Implementation checklist
- Keep predicates explicit and deterministic.
- Avoid overlapping conditions without priority.
- Log the matched condition for traceability.
- Re-evaluate routing after major context changes.

## References
- `references/routing-patterns.md` - Predicate list and routing table templates.
