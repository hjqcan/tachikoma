#!/usr/bin/env python3
"""Allocate time/token budgets across phases.

Input JSON (stdin or --input file):
{
  "totalMinutes": 120,
  "tokenBudget": 50000,
  "phases": [
    {"name": "plan", "percent": 10},
    {"name": "build", "percent": 60},
    {"name": "test", "percent": 20},
    {"name": "docs", "percent": 10}
  ]
}

Usage:
  python3 allocate_budget.py --input plan.json
  cat plan.json | python3 allocate_budget.py
"""

from __future__ import annotations

import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Allocate budgets by phase percentages.")
    parser.add_argument("--input", type=str, help="Path to JSON input file.")
    return parser.parse_args()


def read_input(path: str | None) -> dict:
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    if not sys.stdin.isatty():
        return json.load(sys.stdin)
    raise SystemExit("Provide --input or pipe JSON via stdin.")


def main() -> None:
    args = parse_args()
    payload = read_input(args.input)

    total_minutes = float(payload.get("totalMinutes", 0))
    token_budget = float(payload.get("tokenBudget", 0))
    phases = payload.get("phases", [])

    percent_sum = sum(float(phase.get("percent", 0)) for phase in phases)
    scale = 100.0 / percent_sum if percent_sum > 0 else 0.0

    allocations = []
    for phase in phases:
        name = phase.get("name")
        percent = float(phase.get("percent", 0)) * scale
        minutes = round(total_minutes * percent / 100.0, 2)
        tokens = round(token_budget * percent / 100.0, 2)
        allocations.append({
            "name": name,
            "percent": round(percent, 2),
            "minutes": minutes,
            "tokens": tokens,
        })

    output = {
        "totalMinutes": total_minutes,
        "tokenBudget": token_budget,
        "allocations": allocations,
    }

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
