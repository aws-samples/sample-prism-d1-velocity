#!/usr/bin/env python3
"""Non-interactive demo — runs canned scenarios to showcase the agent.

Usage:
    python scripts/run-demo.py              # Bedrock mode
    python scripts/run-demo.py --mock       # Mock mode (no AWS needed)
    python scripts/run-demo.py --multi      # Multi-agent demo
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.task_assistant.agent import create_agent, run_with_metrics
from src.task_assistant.config import AgentConfig
from src.multi_agent.orchestrator import create_orchestrator

# --- Demo scenarios ---

SINGLE_AGENT_SCENARIOS = [
    "Create a high-priority task to fix the login bug, tag it as critical and backend",
    "Create a task to write API documentation",
    "Create a task to add unit tests for the auth module, tag it as testing",
    "Show me all tasks",
    "Search for anything related to testing",
    "Mark the documentation task as in-progress",
    "Give me a summary of what we have",
]

MULTI_AGENT_SCENARIOS = [
    "Move all todo tasks to in-progress and create a summary of what's being worked on",
    "Find all tasks tagged as critical, prioritize them, and create a tracking task",
]


def run_scenarios(agent, scenarios: list[str], config: AgentConfig):
    """Run a list of scenarios against the agent."""
    for i, scenario in enumerate(scenarios, 1):
        print(f"\n{'='*60}")
        print(f"Scenario {i}: {scenario}")
        print(f"{'='*60}\n")

        try:
            response = run_with_metrics(agent, scenario, config)
            print(response)
        except Exception as exc:
            print(f"Error: {exc}")

        print()


def main():
    parser = argparse.ArgumentParser(description="PRISM D1 — Agent Demo")
    parser.add_argument("--mock", action="store_true", help="Use mock model")
    parser.add_argument("--multi", action="store_true", help="Run multi-agent scenarios")
    parser.add_argument("--api-url", default="http://localhost:3000", help="Task API URL")
    args = parser.parse_args()

    config = AgentConfig(
        task_api_url=args.api_url,
        emit_metrics=False,  # Don't emit metrics during demo
    )

    mode = "mock" if args.mock else "Bedrock"
    print(f"\nPRISM D1 Velocity — Agent Demo")
    print(f"Mode: {mode} | API: {args.api_url}")

    if args.multi:
        print("Running multi-agent scenarios...\n")
        agent = create_orchestrator(config=config, mock=args.mock)
        run_scenarios(agent, MULTI_AGENT_SCENARIOS, config)
    else:
        print("Running single-agent scenarios...\n")
        agent = create_agent(config=config, mock=args.mock)
        run_scenarios(agent, SINGLE_AGENT_SCENARIOS, config)

    print("\nDemo complete!")


if __name__ == "__main__":
    main()
