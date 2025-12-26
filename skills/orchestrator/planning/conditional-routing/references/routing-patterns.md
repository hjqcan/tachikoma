# Routing Patterns

## Common predicates
- tests_passed
- build_failed
- risk_high
- dependency_changed
- budget_exceeded

## Routing table example
| Condition | Route | Action |
|-----------|-------|--------|
| tests_passed | proceed | continue to integration |
| build_failed | fix | create bugfix subtask |
| risk_high | gate | require approval |
| dependency_changed | replan | rebuild DAG |
| else | replan | adjust plan |

## Priority rules
- Evaluate in order; first match wins.
- Keep a default fallback route.
- Log the matched condition with context.
