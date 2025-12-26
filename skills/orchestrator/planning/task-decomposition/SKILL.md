---
name: task-decomposition
description: |
  Decompose complex objectives into executable subtasks with dependencies, estimates, and complexity.
  Use when planning large goals, breaking down objectives, or generating a task DAG for an
  orchestrator.
---

# Task Decomposition

## Workflow
1. Capture the objective, constraints, and acceptance criteria.
2. Apply WBS: split into phases, then deliverables, then work packages.
3. Enforce MECE coverage with the checklist below.
4. Identify dependency types (FS, SS, FF) and mark critical paths.
5. Estimate complexity and time for each subtask.
6. Output subtasks with ids, dependencies, estimatedMinutes, and complexity.

## MECE checklist
- Keep subtasks non-overlapping.
- Ensure the union of subtasks covers the full objective.
- Isolate cross-cutting work (testing, docs, integration, migration).
- Separate unknowns into discovery spikes if needed.

## Dependency types
- Finish-to-Start (FS): A must finish before B starts.
- Start-to-Start (SS): A must start before B starts.
- Finish-to-Finish (FF): A must finish before B finishes.

## Complexity scoring
| Dimension   | Low (1-3) | Medium (4-6) | High (7-10) |
|-------------|-----------|--------------|-------------|
| Code size   | <100 LOC  | 100-500 LOC  | >500 LOC    |
| Dependencies| 0-1       | 2-3          | >3          |
| Uncertainty | clear     | partial      | high        |
| Tech risk   | known     | some new     | novel       |

Estimate time:

```
estimatedMinutes = baseMinutes * (1 + complexityScore * 0.2) * riskFactor
```

## Output template
```json
{
  "subtasks": [
    {
      "id": "auth-1",
      "objective": "Design auth API contract",
      "dependencies": [],
      "complexity": "simple",
      "estimatedMinutes": 15
    },
    {
      "id": "auth-2",
      "objective": "Implement JWT issuance/validation",
      "dependencies": ["auth-1"],
      "complexity": "moderate",
      "estimatedMinutes": 30
    }
  ]
}
```

## References
- `references/decomposition-patterns.md` - WBS/MECE, dependency types, estimation rubric.
