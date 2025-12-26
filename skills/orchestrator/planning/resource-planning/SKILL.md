---
name: resource-planning
description: |
  Plan resource budgets (time, tokens, workers, tools) for orchestrator execution. Use when
  estimating cost, limiting concurrency, or enforcing budget constraints.
---

# Resource Planning

## Budget dimensions
- Time (minutes or phases).
- Token budget (per call and total).
- Worker budget (max workers, max concurrency).
- Tool budget (max tool calls, high-risk approvals).

## Planning steps
1. Estimate base effort per phase from task decomposition.
2. Assign buffers for risk and integration.
3. Set caps: maxWorkers, maxConcurrent, maxTokens, maxToolCalls.
4. Allocate budgets per phase and track burn rate.
5. Trigger downgrades when budgets are exceeded.

## Budget table example
| Phase | Time (min) | Tokens | Workers | Notes |
|------|------------|--------|---------|-------|
| Plan | 15         | 6k     | 1       | prompt + parsing |
| Build| 90         | 30k    | 3       | parallel tasks |
| Test | 30         | 10k    | 1       | regression |

## Degradation rules
- Reduce concurrency when tool failures rise.
- Switch to summaries when token burn spikes.
- Defer non-critical subtasks to stay within budget.

## Scripts
- `scripts/allocate_budget.py` - Allocate time/token budgets by phase percentages from JSON input.
  Example: `cat plan.json | python3 scripts/allocate_budget.py`

## References
- `references/budget-templates.md` - Budget tables, caps, downgrade triggers.
