#!/usr/bin/env python3
"""Interactive CLI for the Task Assistant Agent.

Usage:
    python scripts/run-agent.py              # Bedrock mode (needs AWS creds)
    python scripts/run-agent.py --mock       # Mock mode (no AWS needed)
    python scripts/run-agent.py --multi      # Multi-agent orchestrator mode
"""

import argparse
import sys
import os

# Add parent dir to path so we can import the agent modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.task_assistant.agent import create_agent, run_with_metrics
from src.task_assistant.config import AgentConfig
from src.multi_agent.orchestrator import create_orchestrator


def main():
    parser = argparse.ArgumentParser(description="PRISM D1 — Task Assistant Agent")
    parser.add_argument("--mock", action="store_true", help="Use mock model (no AWS)")
    parser.add_argument("--multi", action="store_true", help="Use multi-agent orchestrator")
    parser.add_argument("--api-url", default="http://localhost:3000", help="Task API URL")
    parser.add_argument("--no-metrics", action="store_true", help="Disable EventBridge metrics")
    args = parser.parse_args()

    config = AgentConfig(
        task_api_url=args.api_url,
        emit_metrics=not args.no_metrics,
    )

    if args.multi:
        agent = create_orchestrator(config=config, mock=args.mock)
        print("PRISM D1 — Multi-Agent Orchestrator (planner + executor + reviewer)")
    else:
        agent = create_agent(config=config, mock=args.mock)
        print("PRISM D1 — Task Assistant Agent")

    mode = "mock" if args.mock else "Bedrock"
    print(f"Mode: {mode} | API: {args.api_url}")
    print("Type your request (or 'quit' to exit):\n")

    while True:
        try:
            prompt = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not prompt or prompt.lower() in ("quit", "exit", "q"):
            print("Goodbye!")
            break

        try:
            response = run_with_metrics(agent, prompt, config)
            print(f"\n{response}\n")
        except Exception as exc:
            print(f"\nError: {exc}\n")


if __name__ == "__main__":
    main()
