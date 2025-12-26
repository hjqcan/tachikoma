# Decomposition Patterns

## WBS ladder
- Phase: major milestone with a clear outcome.
- Deliverable: concrete artifact or interface.
- Work package: smallest unit assignable to one worker.

## MECE checklist
- No overlapping responsibilities.
- Full coverage of the objective.
- Separate integration, testing, and documentation work.
- Isolate unknowns into discovery spikes.

## Dependency patterns
| Type | Meaning | Example |
|------|---------|---------|
| FS | A finishes before B starts | Design -> Implement |
| SS | A starts before B starts | Backend + Frontend alignment |
| FF | A finishes before B finishes | Feature + Integration test |

## Estimation rubric
- Complexity score 1-10 based on code size, dependency count, uncertainty, and risk.
- Risk factor: 1.0 (low), 1.3 (medium), 1.6 (high).
- Formula:

```
estimatedMinutes = baseMinutes * (1 + complexityScore * 0.2) * riskFactor
```

## Output example
```json
{
  "subtasks": [
    {
      "id": "auth-1",
      "objective": "Design auth API contract",
      "dependencies": [],
      "complexity": "simple",
      "estimatedMinutes": 15
    }
  ]
}
```
