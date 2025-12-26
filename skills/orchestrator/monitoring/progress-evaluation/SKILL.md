---
name: progress-evaluation
description: |
  Evaluate subtask progress and trigger replans or interventions. Use after subtask completion,
  timeouts, or anomalies to support self-reflection and quality gates.
---

# Progress Evaluation

## Detect completion signals
- Explicit success message or submit_result.
- Tests or type checks passing.
- Expected files created or modified.
- Worker exits cleanly without errors.

## Detect failure signals
- Explicit error or failure status.
- Tests or build failures.
- Timeouts beyond 2x estimate.
- Repeated tool calls or loop indicators.
- Budget exhaustion (tokens/time).

## Score progress health
Compute a simple health score (0-100):
- Time ratio (30%).
- Error rate (30%).
- Tool success rate (20%).
- Loop risk (20%).

Classify:
- 70-100: healthy.
- 40-69: warning.
- 0-39: critical.

## Replan triggers
- Health < 40.
- 3 consecutive failures.
- >3x time estimate.
- Dependency changes or resource conflicts.

## Actions
- Pause and replan if critical.
- Split the task into smaller subtasks.
- Switch strategy or delegate to a specialist.
- Escalate to human approval for high-risk decisions.

## Scripts
- `scripts/score_progress.py` - Compute health score from time ratio, error count, tool success rate,
  and duplicate call count.
  Example: `python3 scripts/score_progress.py --time-ratio 1.2 --errors 1 --tool-success-rate 0.8`

## References
- `references/health-scoring.md` - Scoring formula and examples.
