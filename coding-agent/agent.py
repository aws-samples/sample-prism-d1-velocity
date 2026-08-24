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
import os
import sys
import time
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


# Matches the AgentCore Harness default, so a fixture that passes locally is not
# then failed by a tighter bound in the deployed path. The harness takes
# maxIterations declaratively; locally it has to be enforced.
DEFAULT_MAX_ITERATIONS = 40
# Below the eval harness's 1800s subprocess timeout, so the agent stops itself and
# says why rather than being killed with no explanation. A run killed from outside
# loses its reason; a run that stops itself reports one.
DEFAULT_DEADLINE_SECONDS = 1500
# A single model call that has produced nothing for this long is not slow, it is
# stuck -- the observed case sat for fourteen minutes on one call at 0.2% CPU.
READ_TIMEOUT = 300
CONNECT_TIMEOUT = 15


class IterationBound:
    """Stop the agent after a fixed number of model calls, or past a deadline.

    Strands has no iteration cap in this version -- Agent takes model, messages,
    tools, system_prompt, conversation_manager, hooks, retry_strategy, and nothing
    that bounds call count. So the count is kept here off BeforeModelCallEvent, the
    one lifecycle event that fires exactly once per model call.

    Stopping uses that event's `cancel` field rather than raising. Setting it makes
    the event loop synthesise a final assistant message carrying the cancellation
    text and finish with stop_reason `end_turn`, so the run ends cleanly and the
    reason lands in the agent's own transcript instead of in a traceback. Raising
    from the hook would also stop it, but it would report a deliberate bound as a
    crash -- and the run this exists to fix had already committed a correct fix.
    """

    def __init__(self, max_iterations: int = 0, deadline_seconds: int = 0) -> None:
        self.max_iterations = max_iterations or DEFAULT_MAX_ITERATIONS
        self.deadline_seconds = deadline_seconds or DEFAULT_DEADLINE_SECONDS
        self.iterations = 0
        self.started = 0.0
        self.stopped_reason = ""

    def register_hooks(self, registry, **_: object) -> None:
        from strands.hooks import BeforeModelCallEvent

        registry.add_callback(BeforeModelCallEvent, self.before_model_call)

    @property
    def elapsed(self) -> float:
        return 0.0 if not self.started else time.monotonic() - self.started

    @property
    def stopped(self) -> bool:
        return bool(self.stopped_reason)

    def before_model_call(self, event) -> None:
        if not self.started:
            self.started = time.monotonic()

        # Checked before incrementing, so the message names the call that would have
        # been the (n+1)th rather than being off by one.
        if self.iterations >= self.max_iterations:
            return self._stop(
                event,
                f"Stopping after {self.iterations} model calls "
                f"(--max-iterations {self.max_iterations}). Work already committed "
                f"stands; the agent was still going when the bound hit, which "
                f"usually means verification never went green.",
            )

        if self.elapsed > self.deadline_seconds:
            return self._stop(
                event,
                f"Stopping after {self.elapsed:.0f}s (--deadline-seconds "
                f"{self.deadline_seconds}), on model call {self.iterations + 1}. "
                f"Work already committed stands.",
            )

        self.iterations += 1
        print(f"  [iteration {self.iterations}/{self.max_iterations} · "
              f"{self.elapsed:.0f}s/{self.deadline_seconds}s]", file=sys.stderr)

    def _stop(self, event, reason: str) -> None:
        self.stopped_reason = reason
        # `cancel` is the only writable field on this event, and a string sets the
        # cancellation message. Guarded so the bound is still usable -- and
        # testable -- without a live event object.
        if event is not None:
            event.cancel = reason


def build_agent(cfg, create_pr_enabled: bool, bound: "IterationBound | None" = None):
    """Construct the Strands agent with its tool set.

    Imports happen here rather than at module scope so that --help and config
    validation work without the Strands SDK installed.
    """
    # strands-agents-tools gates every mutating tool -- editor, file_write, shell
    # -- behind an interactive confirmation dialog unless BYPASS_TOOL_CONSENT is
    # set. There is nobody to answer it here: the agent runs in CI or in a
    # disposable microVM, so the prompt is auto-cancelled and every write silently
    # fails while the model keeps reasoning.
    #
    # The symptom is badly misleading. The agent diagnoses the bug correctly,
    # writes out the right patch in prose, then reports "unable to complete
    # because all file modification operations are being cancelled by the system"
    # -- which reads as a broken agent rather than a missing environment variable.
    #
    # Safe to set here because the boundary is the sandbox, not the prompt: the
    # eval harness gives the agent a throwaway clone, and the AgentCore harness
    # gives it an isolated microVM. Consent dialogs are for a developer's own
    # working tree, which this agent is never pointed at.
    os.environ.setdefault("BYPASS_TOOL_CONSENT", "true")

    from botocore.config import Config as BotocoreConfig
    from strands import Agent
    from strands.agent.conversation_manager import SlidingWindowConversationManager
    from strands.models import BedrockModel
    from strands_tools import editor, file_read, file_write, shell

    from tools import create_pr, git_ops

    tools = [file_read, file_write, editor, shell, git_ops]
    if create_pr_enabled:
        tools.append(create_pr)

    # Two different runaways were observed, and they need two different bounds --
    # which is why one number is not enough:
    #
    #   * One run kept working long after it had committed a correct fix, until an
    #     external `timeout` killed it at 1200s. A genuine pass was recorded as a
    #     failure. That is too many iterations, and IterationBound stops it.
    #
    #   * Another committed, made one more model call, and sat for fourteen minutes
    #     with one second of CPU at 0.2% -- blocked inside a single call that never
    #     returned. An iteration cap cannot help: the count never advanced. Only a
    #     socket-level read timeout ends that, which is why the model is built with
    #     an explicit boto config rather than passed as a bare id string.
    #
    # A sliding window bounds how much context each call carries. It bounds neither
    # of the above, and this SDK version has no max_turns or max_iterations on
    # Agent (checked: model, messages, tools, system_prompt, conversation_manager,
    # hooks, retry_strategy -- nothing caps calls). So the cap is built here from
    # the BeforeModelCallEvent hook, which is the seam the SDK does offer.
    model = BedrockModel(
        model_id=cfg.model_id,
        boto_client_config=BotocoreConfig(
            connect_timeout=CONNECT_TIMEOUT,
            read_timeout=READ_TIMEOUT,
            # Retries at the client layer, so a dropped connection costs one retry
            # rather than one lost run. Kept low because each attempt burns wall
            # clock against the deadline.
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )

    return Agent(
        model=model,
        tools=tools,
        system_prompt=build_system_prompt(cfg, announce=True),
        conversation_manager=SlidingWindowConversationManager(
            window_size=max(20, cfg.max_attempts * 12),
        ),
        hooks=[bound or IterationBound()],
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

    bounds = parser.add_argument_group("bounds")
    bounds.add_argument(
        "--max-iterations", type=int, default=DEFAULT_MAX_ITERATIONS,
        help=f"Stop after this many model calls (default {DEFAULT_MAX_ITERATIONS}, "
             f"matching the AgentCore Harness default)",
    )
    bounds.add_argument(
        "--deadline-seconds", type=int, default=DEFAULT_DEADLINE_SECONDS,
        help=f"Stop once a run has taken this long (default {DEFAULT_DEADLINE_SECONDS})",
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

    bound = IterationBound(max_iterations=args.max_iterations,
                           deadline_seconds=args.deadline_seconds)
    agent = build_agent(cfg, create_pr_enabled=args.create_pr, bound=bound)

    print(f"Fixing issue #{issue.get('number', '?')}: {issue.get('title', '')}")
    print(f"Bounds:       {bound.max_iterations} model calls, "
          f"{bound.deadline_seconds}s")
    print("-" * 72)

    agent(build_task_prompt(issue))

    # Exit 0 either way. The bound firing is not the agent failing -- one observed
    # run had a correct feature implementation in the tree when it ran away, and
    # calling that a failure discarded a real result. The eval scores the tree, not
    # this exit code. The reason goes to stderr so it reaches the transcript.
    if bound.stopped:
        print(f"\nBOUND REACHED: {bound.stopped_reason}", file=sys.stderr)
    print(f"  model calls: {bound.iterations}/{bound.max_iterations}   "
          f"elapsed: {bound.elapsed:.0f}s/{bound.deadline_seconds}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
