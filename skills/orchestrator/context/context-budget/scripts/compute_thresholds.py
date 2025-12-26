#!/usr/bin/env python3
"""Compute model-aware context thresholds.

Usage:
  python3 compute_thresholds.py 200000
  python3 compute_thresholds.py 200000 --soft 0.6 --summary 0.75 --rot 0.85 --hard 0.9
"""

from __future__ import annotations

import argparse
import json
import math


def clamp_ratio(value: float) -> float:
    return max(0.0, min(1.0, value))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compute context threshold values.")
    parser.add_argument("window", type=int, help="Context window size (tokens).")
    parser.add_argument("--soft", type=float, default=0.60, help="Soft limit ratio.")
    parser.add_argument("--summary", type=float, default=0.75, help="Summarization ratio.")
    parser.add_argument("--rot", type=float, default=0.85, help="Context rot ratio.")
    parser.add_argument("--hard", type=float, default=0.90, help="Hard limit ratio.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    window = max(1, args.window)
    soft = clamp_ratio(args.soft)
    summary = clamp_ratio(args.summary)
    rot = clamp_ratio(args.rot)
    hard = clamp_ratio(args.hard)

    thresholds = {
        "contextWindow": window,
        "softLimit": int(math.floor(window * soft)),
        "summaryLimit": int(math.floor(window * summary)),
        "rotThreshold": int(math.floor(window * rot)),
        "hardLimit": int(math.floor(window * hard)),
    }

    print(json.dumps(thresholds, indent=2))


if __name__ == "__main__":
    main()
