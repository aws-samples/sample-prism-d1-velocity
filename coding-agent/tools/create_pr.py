"""Push the working branch and open a pull request.

Separated from `git_ops` because this is the one privileged step: it needs a
credential and it makes the change visible outside the sandbox. Keeping it in its
own tool means the push path is reviewed once, here, instead of being reachable
from a general-purpose git tool.

Uses the `gh` CLI rather than raw REST so authentication comes from the ambient
GH_TOKEN / GITHUB_TOKEN that GitHub Actions already provides -- no token is ever
passed through an argument, where it would land in process listings and logs.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from strands import tool

_TIMEOUT_SECONDS = 120
# PR titles reach shells and logs downstream. Keep them to printable single-line
# text and let the body carry any detail.
_TITLE_MAX = 120


class PrError(RuntimeError):
    """Pushing or PR creation failed."""


def _run(args: list[str], cwd: Path) -> str:
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise PrError(f"{args[0]} timed out after {_TIMEOUT_SECONDS}s") from exc
    except FileNotFoundError as exc:
        raise PrError(f"{args[0]} is not installed or not on PATH") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise PrError(f"{' '.join(args[:2])} failed: {detail}")
    return proc.stdout.strip()


def _sanitize_title(title: str) -> str:
    title = " ".join(title.split())  # collapse newlines and runs of whitespace
    title = re.sub(r"[\x00-\x1f\x7f]", "", title)
    if not title:
        raise PrError("PR title is empty")
    return title[:_TITLE_MAX]


def _has_token() -> bool:
    return bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))


@tool
def create_pr(
    repo_path: str,
    title: str,
    body: str,
    base: str = "main",
    draft: bool = False,
) -> str:
    """Push the current branch and open a pull request against `base`.

    Call this only after your changes are committed and verification has passed.
    The commit must already exist -- this tool does not stage or commit.

    Args:
        repo_path: Absolute path to the repository working tree.
        title: One-line PR title.
        body: PR description. Explain what changed, why, and how you verified it.
            Include "Closes #<n>" so the issue closes on merge.
        base: Branch to merge into. Defaults to "main".
        draft: Open as a draft PR when the fix needs human eyes before review.

    Returns:
        The PR URL, or an ERROR line explaining what blocked it.
    """
    repo = Path(repo_path)
    if not (repo / ".git").exists():
        return f"ERROR: {repo_path} is not a git repository"

    if not _has_token():
        return (
            "ERROR: no GH_TOKEN or GITHUB_TOKEN in the environment. "
            "Cannot push or open a PR without a credential."
        )

    try:
        safe_title = _sanitize_title(title)

        branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)
        if branch == base:
            return (
                f"ERROR: refusing to open a PR from {base} into itself. "
                "Create a feature branch before committing."
            )

        # An unclean tree here means work was left uncommitted -- pushing would
        # silently omit it and the PR would not contain the fix.
        dirty = _run(["git", "status", "--porcelain=v1"], repo)
        if dirty:
            return (
                "ERROR: uncommitted changes present. Commit your work before "
                f"opening a PR:\n{dirty}"
            )

        ahead = _run(["git", "log", f"origin/{base}..HEAD", "--oneline"], repo)
        if not ahead:
            return (
                f"ERROR: no commits ahead of origin/{base}. There is nothing to "
                "open a PR for."
            )

        _run(["git", "push", "--set-upstream", "origin", branch], repo)

        args = [
            "gh", "pr", "create",
            "--title", safe_title,
            "--body", body,
            "--base", base,
            "--head", branch,
        ]
        if draft:
            args.append("--draft")

        url = _run(args, repo)
        return f"Opened PR: {url}"

    except PrError as exc:
        return f"ERROR: {exc}"
