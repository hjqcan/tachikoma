---
name: parallel-execution
description: |
  Design safe parallel execution plans and fan-out/fan-in flows. Use when subtasks are
  independent, when speeding up throughput, or when coordinating concurrent workers.
---

# Parallel Execution

## Identify parallel candidates
- Select subtasks without dependencies.
- Isolate shared resources (files, services, env).
- Split large tasks to increase parallelism.

## Concurrency rules
- Set maxConcurrency based on worker budget.
- Gate high-risk tools behind approvals.
- Serialize tasks that touch the same files or services.

## Fan-out / fan-in
1. Fan-out: dispatch independent subtasks.
2. Fan-in: collect results and validate consistency.
3. Resolve conflicts before continuing.

## Critical path
- Execute critical path tasks first.
- Use remaining workers to fill gaps with non-critical tasks.

## References
- `references/concurrency-checklist.md` - Parallel safety checklist.
