"""CLI entry point for the multi-agent orchestrator.

Usage:
    python -m src.multi_agent.cli               # Bedrock mode
    python -m src.multi_agent.cli --mock         # Mock mode
    python -m src.multi_agent.cli --mock --verbose
"""

import argparse
import sys

try:
    import gnureadline  # noqa: F401 — improves input() in some terminals
except ImportError:
    import readline  # noqa: F401 — ensure readline support is active

from ..task_assistant.agent import run_with_metrics
from ..task_assistant.config import AgentConfig
from .orchestrator import create_orchestrator


def main():
    parser = argparse.ArgumentParser(description="Multi-Agent Orchestrator")
    parser.add_argument("--mock", action="store_true", help="Use mock model (no AWS)")
    parser.add_argument("--verbose", action="store_true", help="Show reasoning trace")
    parser.add_argument("--api-url", default="http://localhost:3000", help="Task API URL")
    parser.add_argument("--no-metrics", action="store_true", help="Disable metrics")
    args = parser.parse_args()

    config = AgentConfig(
        agent_name="orchestrator",
        task_api_url=args.api_url,
        emit_metrics=not args.no_metrics,
    )

    agent = create_orchestrator(config=config, mock=args.mock)

    mode = "mock" if args.mock else "Bedrock"
    print(f"Multi-Agent Orchestrator | Mode: {mode} | API: {args.api_url}")
    print("Agents: Planner + Executor + Reviewer")
    if args.verbose:
        print("Verbose mode: reasoning traces enabled")
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
