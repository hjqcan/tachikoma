# Resource Planning Templates

## Budget table
| Phase | Time (min) | Tokens | Workers | Notes |
|------|------------|--------|---------|-------|
| Plan | 15         | 6k     | 1       | planning + parsing |
| Build| 90         | 30k    | 3       | parallel tasks |
| Test | 30         | 10k    | 1       | regression |

## Caps and defaults
- maxWorkers: 3-5 for medium tasks.
- maxConcurrency: min(maxWorkers, independentTasks).
- maxTokensPerCall: 4k-16k depending on model.
- maxToolCalls: 50-150 depending on task size.

## Downgrade triggers
- Token burn rate > 2x expected: summarize and reduce tool calls.
- Tool failure rate > 30%: serialize and reduce concurrency.
- Time overrun > 2x: split or defer non-critical subtasks.
