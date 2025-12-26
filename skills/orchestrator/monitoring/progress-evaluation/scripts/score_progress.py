#!/usr/bin/env python3
"""Compute progress health score from execution metrics.

Usage:
  python3 score_progress.py --time-ratio 1.2 --errors 1 --tool-success-rate 0.8 --duplicates 0
"""

from __future__ import annotations

import argparse
import json


def clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, value))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score progress health.")
    parser.add_argument("--time-ratio", type=float, required=True, help="elapsed/estimated.")
    parser.add_argument("--errors", type=int, default=0, help="Error count.")
    parser.add_argument(
        "--tool-success-rate",
        type=float,
        default=1.0,
        help="Tool success rate between 0 and 1.",
    )
    parser.add_argument("--duplicates", type=int, default=0, help="Duplicate tool call count.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    time_ratio = max(0.0, args.time_ratio)

    time_score = 100.0 if time_ratio <= 1.0 else clamp(100.0 - (time_ratio - 1.0) * 50.0)
    error_score = clamp(100.0 - args.errors * 20.0)
    tool_score = clamp(args.tool_success_rate * 100.0)
    loop_score = clamp(100.0 - args.duplicates * 30.0)

    score = (
        0.30 * time_score
        + 0.30 * error_score
        + 0.20 * tool_score
        + 0.20 * loop_score
    )

    status = "healthy" if score >= 70 else "warning" if score >= 40 else "critical"

    payload = {
        "score": round(score, 2),
        "status": status,
        "components": {
            "timeScore": round(time_score, 2),
            "errorScore": round(error_score, 2),
            "toolScore": round(tool_score, 2),
            "loopScore": round(loop_score, 2),
        },
    }

    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
