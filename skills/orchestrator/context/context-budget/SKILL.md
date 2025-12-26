---
name: context-budget
description: |
  Manage context window budgets and decide when to compact, summarize, or offload context.
  Use when context grows, tokens are tight, or planning large tasks that risk context rot.
---

# Context Budget Management

## Budget thresholds
- Comfort zone: under softLimit.
- Compaction trigger: softLimit to summaryLimit.
- Summarization trigger: summaryLimit to rotThreshold.
- Rot threshold: performance drops; force summarization/offload.
- Hard limit: do not exceed; stop and recover.

## Allocation targets
| Segment         | Orchestrator | Worker |
|----------------|--------------|--------|
| System prompt   | 5-10%        | 5-10%  |
| Task/constraints| 10-15%       | 10-15% |
| Plan/state      | 15-20%       | 0-5%   |
| Tool history    | 20-30%       | 15-20% |
| Code/context    | 10-20%       | 40-50% |
| Buffer          | 10-15%       | 10-15% |

## Reduction decision
- Prefer compaction when information may be needed later.
- Prefer summarization when history is long and low-value.
- Offload large artifacts (logs, big files, long tool output) to files and keep references.

## Retention priority
1. Current objective and constraints.
2. Recent tool calls and outcomes.
3. Open blockers and decisions.
4. Modified files and key diffs.
5. Historical summaries.
6. Old tool output details.

## Offload candidates
- Outputs over a few thousand tokens.
- Large file contents already saved to disk.
- Completed subtask details no longer referenced.

## Metrics to track
- totalTokens, utilizationPercent.
- compactionCount, summarizationCount, offloadCount.
- tokensSavedByCompaction, tokensSavedBySummarization.

## Scripts
- `scripts/compute_thresholds.py` - Compute soft/summary/rot/hard limits for a context window.
  Example: `python3 scripts/compute_thresholds.py 200000`

## References
- `references/context-thresholds.md` - Threshold formulas and action table.
