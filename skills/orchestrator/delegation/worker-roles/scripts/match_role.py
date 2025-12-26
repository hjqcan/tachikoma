#!/usr/bin/env python3
"""Match worker roles to a subtask objective.

Usage:
  python3 match_role.py "Add OAuth login and update API docs" --top 3
"""

from __future__ import annotations

import argparse
import json


ROLE_KEYWORDS = {
    "frontend-specialist": ["ui", "component", "css", "styles", "layout", "accessibility"],
    "backend-specialist": ["api", "server", "database", "auth", "performance"],
    "testing-specialist": ["test", "assertion", "mock", "coverage", "e2e"],
    "devops-specialist": ["ci", "cd", "docker", "deploy", "monitoring"],
    "docs-specialist": ["docs", "readme", "guide", "spec", "api doc"],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score role matches by keywords.")
    parser.add_argument("objective", type=str, help="Subtask objective text.")
    parser.add_argument("--top", type=int, default=5, help="Number of top roles to show.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    objective = args.objective.lower()

    results = []
    for role, keywords in ROLE_KEYWORDS.items():
        score = 0
        matches = []
        for keyword in keywords:
            if keyword in objective:
                score += len(keyword)
                matches.append(keyword)
        results.append({"role": role, "score": score, "matches": matches})

    results.sort(key=lambda item: item["score"], reverse=True)
    payload = {
        "objective": args.objective,
        "matches": results[: max(1, args.top)],
    }
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
