# Context Thresholds

## Model-aware thresholds
- softLimit: 0.60 * contextWindow
- summaryLimit: 0.75 * contextWindow
- rotThreshold: 0.85 * contextWindow
- hardLimit: 0.90 * contextWindow

## Action table
| Range | Action |
|-------|--------|
| < softLimit | no reduction |
| softLimit - summaryLimit | compaction |
| summaryLimit - rotThreshold | summarization |
| > rotThreshold | summarize + offload |

## Offload guidance
- Offload tool outputs > 2k tokens.
- Offload file contents already persisted on disk.
- Keep references (file paths, commands, hashes).
