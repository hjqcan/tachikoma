# Eval Sets

This document describes how to create and run eval sets for Tachikoma.

## Eval Set Format (JSON)

An eval set is a JSON file with:

- `id` (string): unique identifier
- `name` (string, optional)
- `description` (string, optional)
- `version` (string, optional)
- `cases` (array): list of eval cases

Each case has:

- `id` (string): case identifier
- `objective` (string): the task prompt passed to the runner
- `expected` (object, optional): simple checks for pass/fail

`expected` fields:

- `success` (boolean): whether the run should succeed
- `contains` (string[]): substrings that must appear in the summary
- `notContains` (string[]): substrings that must NOT appear in the summary
- `regex` (string[]): regex patterns that must match the summary
- `minScore` (number): pass threshold (0..1), default 1.0

## Example Eval Set

See `evals/basic.json` for a minimal example.

## Fixture Workdirs (Ecosystem Smoke)

Fixtures live under `evals/fixtures/<ecosystem>`. Use `--workdir` to point at a fixture:

```bash
TACHIKOMA_EXECUTION_GATE_MODE=off \
  tachikoma eval --eval-set ./evals/ecosystem-smoke.json --workdir ./evals/fixtures/node
```

Supported fixtures:

- `evals/fixtures/node`
- `evals/fixtures/python`
- `evals/fixtures/go`
- `evals/fixtures/rust`
- `evals/fixtures/java`
- `evals/fixtures/dotnet`

Notes:

- If you want to exercise execution gate behavior, omit `TACHIKOMA_EXECUTION_GATE_MODE=off`.
- Java/.NET evals require local toolchains (mvn/dotnet). .NET also needs NuGet restore access.

## Run an Eval Set

```bash
tachikoma eval --eval-set ./evals/basic.json --workdir .
```

## Tachikoma x pi-mono Fusion Unified Suite

Fusion 计划相关用例已聚合到：

- `evals/tachikoma-pi-fusion-regression-suite.json`（18 cases）

一条命令执行：

```bash
tachikoma eval \
  --eval-set ./evals/tachikoma-pi-fusion-regression-suite.json \
  --workdir . \
  --report ./evals/reports/tachikoma-pi-fusion-report.json \
  --no-approval
```

按阶段分开执行（便于定位回归）：

- Recoverable 错误：`evals/tool-not-found-recover.json`、`evals/invalid-args-recover.json`
- Tool Profile：`evals/pi-core-profile.json`
- Mid smoke：`evals/mid-smoke-frontend-backend.json`
- Todo/Resume/FSM：`evals/todo-resume.json`、`evals/todo-fsm-illegal-transition.json`
- Compaction/Contract：`evals/long-session-compaction.json`、`evals/compaction-todo-consistency.json`
- ReplayGuard：`evals/resume-idempotency-replay.json`

说明：

- `evals/regression-suite.json` 继续用于质量飞轮（自动回流失败样本），不建议手工覆盖。

Optional flags:

```bash
tachikoma eval \
  --eval-set ./evals/basic.json \
  --workdir . \
  --report ./evals/report.json \
  --case case-file-write,case-apply-patch \
  --no-approval
```

Notes:

- `--case` takes a comma-separated list of case IDs.
- `--report` writes a JSON report to the given path.
- `--no-approval` disables approval prompts for evals.
