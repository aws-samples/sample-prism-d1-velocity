"""PRISM coding agent — entry point.

Reads one issue, fixes it in a git repository, verifies the fix, and commits.
Optionally opens a pull request.

Local run against a JSON issue file (any git repository, any language):

    python agent.py --repo /path/to/repo \
        --issue /path/to/repo/.coding-agent/fixtures/001-my-bug.json

Read the issue from a GitHub Actions event payload and open a PR:

    python agent.py --repo . --github-event "$GITHUB_EVENT_PATH" --create-pr
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from config import ConfigError, load_config
from system_prompt import build_system_prompt, build_task_prompt


def _load_issue(args: argparse.Namespace) -> dict:
    """Resolve the issue from a fixture file, a GitHub event payload, or flags."""
    if args.issue:
        path = Path(args.issue)
        if not path.exists():
            raise SystemExit(f"Issue file not found: {path}")
        return json.loads(path.read_text())

    if args.github_event:
        path = Path(args.github_event)
        if not path.exists():
            raise SystemExit(f"GitHub event payload not found: {path}")
        event = json.loads(path.read_text())
        issue = event.get("issue")
        if not issue:
            raise SystemExit(
                "Event payload has no 'issue' key. This agent handles issue "
                "events; got keys: " + ", ".join(sorted(event))
            )
        return {
            "number": issue.get("number"),
            "title": issue.get("title", ""),
            "body": issue.get("body", ""),
        }

    if args.title:
        return {"number": args.number or 0, "title": args.title, "body": args.body or ""}

    raise SystemExit(
        "No issue supplied. Use --issue FILE, --github-event FILE, or --title TEXT."
    )


def _configure_git_identity(repo_path: Path, name: str, email: str) -> None:
    """Set the agent's commit identity locally in this repository.

    This is what makes agent commits distinguishable from human commits in PRISM:
    the author email flows through `git log --format=%ae` into the CI workflow's
    commit_authors array, then into the attribution store, and finally appears as
    its own row on the Developer Productivity dashboard.
    """
    import subprocess

    for key, value in (("user.name", name), ("user.email", email)):
        subprocess.run(
            ["git", "config", key, value],
            cwd=str(repo_path),
            check=True,
            capture_output=True,
            timeout=30,
        )


def build_agent(cfg, create_pr_enabled: bool):
    """Construct the Strands agent with its tool set.

    Imports happen here rather than at module scope so that --help and config
    validation work without the Strands SDK installed.
    """
    from strands import Agent
    from strands_tools import editor, file_read, file_write, shell

    from tools import create_pr, git_ops

    tools = [file_read, file_write, editor, shell, git_ops]
    if create_pr_enabled:
        tools.append(create_pr)

    return Agent(
        model=cfg.model_id,
        tools=tools,
        system_prompt=build_system_prompt(cfg, announce=True),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="prism-coding-agent",
        description="Fix a GitHub issue in a repository, verify, and commit.",
    )
    parser.add_argument("--repo", required=True, help="Path to the target repository")

    src = parser.add_argument_group("issue source")
    src.add_argument("--issue", help="Path to a JSON issue fixture")
    src.add_argument("--github-event", help="Path to a GitHub Actions event payload")
    src.add_argument("--title", help="Issue title (inline mode)")
    src.add_argument("--body", help="Issue body (inline mode)")
    src.add_argument("--number", type=int, help="Issue number (inline mode)")

    over = parser.add_argument_group("configuration overrides")
    over.add_argument("--test-command", help="Override the detected test command")
    over.add_argument("--build-command", help="Override the detected build command")
    over.add_argument("--lint-command", help="Lint command to run as an extra check")
    over.add_argument("--model-id", help="Bedrock model id")
    over.add_argument("--region", help="AWS region for Bedrock")
    over.add_argument("--max-attempts", type=int, help="Verification retry budget")
    over.add_argument("--agent-email", help="Git author email for agent commits")

    parser.add_argument(
        "--create-pr",
        action="store_true",
        help="Give the agent the create_pr tool so it can push and open a PR",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resolved config and system prompt, then exit",
    )

    args = parser.parse_args()

    try:
        cfg = load_config(
            Path(args.repo),
            test_command=args.test_command,
            build_command=args.build_command,
            lint_command=args.lint_command,
            model_id=args.model_id,
            region=args.region,
            max_attempts=args.max_attempts,
            agent_email=args.agent_email,
        )
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    print(f"Repository:   {cfg.repo_path}")
    print(f"Project type: {cfg.project_type} (from {cfg.source})")
    print(f"Test command: {cfg.test_command or '(none — fixes will be UNVERIFIED)'}")
    if cfg.build_command:
        print(f"Build:        {cfg.build_command}")
    if cfg.lint_command:
        print(f"Lint:         {cfg.lint_command}")
    print(f"Model:        {cfg.model_id}")
    print()

    if not cfg.can_verify:
        print(
            "WARNING: no test command resolved. The agent will be told to find "
            "one, and to label the fix UNVERIFIED if it cannot.\n",
            file=sys.stderr,
        )

    issue = _load_issue(args)

    if args.dry_run:
        print("=" * 72)
        print("SYSTEM PROMPT")
        print("=" * 72)
        print(build_system_prompt(cfg, announce=True))
        print()
        print("=" * 72)
        print("TASK PROMPT")
        print("=" * 72)
        print(build_task_prompt(issue))
        return 0

    _configure_git_identity(cfg.repo_path, cfg.agent_name, cfg.agent_email)

    agent = build_agent(cfg, create_pr_enabled=args.create_pr)

    print(f"Fixing issue #{issue.get('number', '?')}: {issue.get('title', '')}")
    print("-" * 72)

    agent(build_task_prompt(issue))
    return 0


if __name__ == "__main__":
    sys.exit(main())
