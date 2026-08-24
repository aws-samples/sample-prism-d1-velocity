"""Build a FixRequest from a repository on disk, and invoke a harness with it.

Used by two callers that must agree exactly: the CI workflow, which fixes a real
issue, and the eval client, which scores fixtures. If they assembled requests
differently, an eval would measure something the workflow never sends -- which is
the failure mode this module exists to prevent.

Also the CLI the workflow calls:

    python -m agentcore.invoke --repo . --github-event /tmp/issue.json \\
        --patch-out /tmp/fix.patch --result-out /tmp/result.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from .client import BotoTransport, Transport
from .contract import (
    Attribution,
    ContractError,
    FixRequest,
    FixResponse,
    Issue,
    Outcome,
    RepoRef,
    Verification,
)


def _git(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True,
                          text=True, timeout=60, check=False)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def build_fix_request(
    repo: Path,
    cfg,
    issue: dict,
    *,
    url: str = "",
    ref: str = "",
    subdir: str = ".",
    team_id: str = "",
) -> FixRequest:
    """Assemble one invocation from a repository's own configuration.

    Guidance is read from the repository with the loader the local agent uses, so
    the harness is briefed with the prompt the repo actually ships rather than a
    copy that has drifted from it.
    """
    # Imported here rather than at module scope: system_prompt lives beside the
    # agent, and importing it eagerly would make this package unusable for a
    # caller that only has the orchestrator on its path.
    from system_prompt import collect_repo_guidance

    guidance, _sources, _warnings = collect_repo_guidance(repo)

    return FixRequest(
        issue=Issue(
            number=int(issue.get("number") or 0),
            title=str(issue.get("title") or ""),
            body=str(issue.get("body") or ""),
        ),
        repo=RepoRef(url=url, ref=ref or "HEAD", subdir=subdir),
        verification=Verification(
            test_command=cfg.test_command,
            build_command=cfg.build_command,
            lint_command=cfg.lint_command,
            max_attempts=cfg.max_attempts,
        ),
        guidance=guidance,
        attribution=Attribution(
            user=cfg.agent_email,
            team_id=team_id,
            repo_slug=url,
        ),
    )


def load_issue(event_path: Path) -> dict:
    """Read the issue from a GitHub Actions event payload."""
    try:
        event = json.loads(event_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot read {event_path}: {exc}") from exc
    issue = event.get("issue")
    if not issue:
        raise ContractError(
            "event payload has no 'issue' key; got: " + ", ".join(sorted(event))
        )
    return issue


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="agentcore.invoke",
        description="Invoke an AgentCore harness for one issue and write out its patch.",
    )
    parser.add_argument("--repo", required=True, help="Repository (or subdirectory) to fix")
    parser.add_argument("--github-event", required=True, help="GitHub event payload JSON")
    parser.add_argument("--patch-out", required=True, help="Where to write the returned patch")
    parser.add_argument("--result-out", required=True, help="Where to write the outcome JSON")
    parser.add_argument("--transcript-out", default="",
                        help="Where to write the agent's full reply "
                             "(default: alongside --result-out as .transcript.log)")
    parser.add_argument("--repo-url", default="", help="Clone URL the harness should use")
    parser.add_argument("--ref", default="", help="Ref the harness should check out")
    parser.add_argument("--subdir", default=".", help="Project directory within the repo")
    parser.add_argument("--team-id", default="", help="Team id, for cost attribution")
    parser.add_argument("--region", default="us-west-2")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from config import ConfigError, load_config

    try:
        cfg = load_config(repo)
        issue = load_issue(Path(args.github_event))
        request = build_fix_request(
            repo, cfg, issue,
            url=args.repo_url or _git(["remote", "get-url", "origin"], repo),
            ref=args.ref or _git(["rev-parse", "HEAD"], repo),
            subdir=args.subdir,
            team_id=args.team_id,
        )
        # Validated here, before any transport exists. Otherwise the first thing
        # to notice a bad request is send(), and its ContractError gets reported
        # as "the harness returned something unusable" -- sending whoever is
        # debugging to look at the harness for a fault in the caller.
        request.validate()
        transport: Transport = BotoTransport(cfg.project_type, region=args.region)
    except (ConfigError, ContractError) as exc:
        # A configuration or contract error is the caller's fault, not the
        # agent's. Reported as a distinct exit code so a workflow can tell "we
        # asked wrongly" from "the agent could not do it".
        print(f"Cannot invoke: {exc}", file=sys.stderr)
        Path(args.result_out).write_text(json.dumps(
            {"outcome": "failed", "reason": f"invocation error: {exc}"}) + "\n")
        return 2

    print(f"Harness:  {transport.arn}", file=sys.stderr)
    print(f"Repo:     {request.repo.url}@{request.repo.ref} ({request.repo.subdir})", file=sys.stderr)
    print(f"Verify:   {cfg.test_command or '(none)'}", file=sys.stderr)

    try:
        response = transport.send(request)
    except ContractError as exc:
        print(f"Harness returned something unusable: {exc}", file=sys.stderr)
        Path(args.result_out).write_text(json.dumps(
            {"outcome": "failed", "reason": f"bad response: {exc}"}) + "\n")
        return 1
    except Exception as exc:  # noqa: BLE001 -- surfaced, not swallowed
        print(f"Invocation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        Path(args.result_out).write_text(json.dumps(
            {"outcome": "failed", "reason": f"{type(exc).__name__}: {exc}"}) + "\n")
        return 1

    # The patch is written even when empty so the workflow always has a file to
    # look at, and never has to distinguish "no file" from "no change".
    Path(args.patch_out).write_text(response.patch)
    Path(args.result_out).write_text(json.dumps({
        "outcome": response.outcome.value,
        "summary": response.summary,
        "reason": response.reason,
        "verified": response.verified,
        "stop_reason": response.stop_reason,
        "added_files": response.added_files,
        "usage": {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "attempts": response.usage.attempts,
        },
    }, indent=2) + "\n")

    # Always written, even for a clean pass. `summary` is capped at 2000 characters
    # because it goes into a PR comment; a run that spends its whole iteration
    # budget needs the uncapped copy to show where the budget went.
    transcript = Path(args.transcript_out) if args.transcript_out else \
        Path(args.result_out).with_suffix(".transcript.log")
    transcript.write_text(
        f"outcome     : {response.outcome.value}\n"
        f"stop_reason : {response.stop_reason}\n"
        f"verified    : {response.verified}\n"
        f"tokens      : {response.usage.input_tokens} in / "
        f"{response.usage.output_tokens} out\n"
        f"patch bytes : {len(response.patch.encode())}\n"
        f"added files : {response.added_files or '(none)'}\n"
        f"reason      : {response.reason}\n"
        f"{'─' * 70}\n{response.full_text}\n"
    )

    print(f"Outcome:  {response.outcome.value}", file=sys.stderr)
    print(f"Stopped:  {response.stop_reason or '(not reported)'}   "
          f"verified: {response.verified}", file=sys.stderr)
    print(f"Tokens:   {response.usage.input_tokens} in / "
          f"{response.usage.output_tokens} out", file=sys.stderr)
    print(f"Transcript: {transcript}", file=sys.stderr)
    # Exit 0 for any well-formed answer, including a refusal. Declining to change
    # anything can be the correct result, and a non-zero exit would make the
    # workflow treat good judgement as a failure.
    return 0


if __name__ == "__main__":
    sys.exit(main())
