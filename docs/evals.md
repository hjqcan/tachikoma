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

## Run an Eval Set

```bash
tachikoma eval --eval-set ./evals/basic.json --workdir .
```

Optional flags:

```bash
tachikoma eval \
  --eval-set ./evals/basic.json \
  --workdir . \
  --report ./evals/report.json \
  --case case-hello,case-files \
  --no-approval
```

Notes:

- `--case` takes a comma-separated list of case IDs.
- `--report` writes a JSON report to the given path.
- `--no-approval` disables approval prompts for evals.
