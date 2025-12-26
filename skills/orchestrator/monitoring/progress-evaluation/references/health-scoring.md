# Progress Health Scoring

## Scoring formula
```
score =
  0.30 * timeScore +
  0.30 * errorScore +
  0.20 * toolScore +
  0.20 * loopScore
```

## Component hints
- timeScore: 100 when on time, decay 50 points per 1x overrun.
- errorScore: 100 minus 20 per error (floor at 0).
- toolScore: successRate * 100.
- loopScore: 100 minus 30 per detected duplicate (floor at 0).

## Example
- timeScore 60, errorScore 80, toolScore 70, loopScore 100
- score = 0.30*60 + 0.30*80 + 0.20*70 + 0.20*100 = 78
