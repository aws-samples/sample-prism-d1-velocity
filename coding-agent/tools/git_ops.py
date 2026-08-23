"""Git operations exposed to the agent as a single Strands tool.

Every git invocation goes through `subprocess.run` with an argv list and never
`shell=True`. The agent supplies branch names and commit messages, so treating
them as shell strings would let a crafted issue body run arbitrary commands.

`push` is deliberately absent. Pushing is a privileged step that belongs to the
PR-creation path where credentials live, not to a general-purpose git tool the
model can call at will.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from strands import tool

# Branch names: git's own rules, tightened. No leading/trailing dots or slashes,
# no '..', no characters git rejects, nothing that could be read as a flag.
_BRANCH_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")
_TIMEOUT_SECONDS = 60


class GitError(RuntimeError):
    """A git command failed or was rejected before running."""


def _run(args: list[str], cwd: Path) -> str:
    """Run a git command and return stdout, raising GitError on failure."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]} timed out after {_TIMEOUT_SECONDS}s") from exc
    except FileNotFoundError as exc:
        raise GitError("git is not installed or not on PATH") from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise GitError(f"git {' '.join(args)} failed: {detail}")
    return proc.stdout.strip()


def _validate_branch(name: str) -> str:
    name = name.strip()
    if not _BRANCH_OK.match(name) or ".." in name or name.endswith((".", "/", ".lock")):
        raise GitError(
            f"Invalid branch name {name!r}. Use letters, digits, dot, dash, "
            "underscore and slash; start with a letter or digit."
        )
    return name


def _validate_paths(paths: list[str], repo_path: Path) -> list[str]:
    """Resolve each path and confirm it stays inside the repository.

    Rejects absolute paths, traversal, and symlinks that point outside the repo.
    """
    resolved: list[str] = []
    repo_real = repo_path.resolve()
    for raw in paths:
        candidate = (repo_real / raw).resolve()
        try:
            candidate.relative_to(repo_real)
        except ValueError as exc:
            raise GitError(f"Path escapes the repository: {raw!r}") from exc
        if not candidate.exists():
            raise GitError(f"Path does not exist: {raw!r}")
        resolved.append(str(candidate.relative_to(repo_real)))
    return resolved


@tool
def git_ops(
    action: str,
    repo_path: str,
    branch: str | None = None,
    message: str | None = None,
    paths: list[str] | None = None,
) -> str:
    """Perform a git operation in the target repository.

    Use this to create a working branch, inspect what you have changed, stage
    specific files, and commit. Pushing is handled separately by create_pr.

    Args:
        action: One of "status", "diff", "current_branch", "create_branch",
            "stage", "commit", "log".
        repo_path: Absolute path to the repository working tree.
        branch: Branch name. Required for "create_branch".
        message: Commit message. Required for "commit".
        paths: Repository-relative file paths. Required for "stage". Name each
            file explicitly; there is no "stage everything" option.

    Returns:
        Command output, or a short confirmation for actions with no output.
    """
    repo = Path(repo_path)
    if not (repo / ".git").exists():
        return f"ERROR: {repo_path} is not a git repository"

    try:
        if action == "status":
            out = _run(["status", "--porcelain=v1"], repo)
            return out or "(working tree clean)"

        if action == "diff":
            out = _run(["diff", "--stat", "HEAD"], repo)
            return out or "(no changes against HEAD)"

        if action == "current_branch":
            return _run(["rev-parse", "--abbrev-ref", "HEAD"], repo)

        if action == "log":
            return _run(["log", "--oneline", "-10"], repo)

        if action == "create_branch":
            if not branch:
                return "ERROR: create_branch requires a branch name"
            safe = _validate_branch(branch)
            _run(["checkout", "-b", safe], repo)
            return f"Created and switched to branch {safe}"

        if action == "stage":
            if not paths:
                return (
                    "ERROR: stage requires an explicit list of paths. "
                    "Name each file you changed."
                )
            safe_paths = _validate_paths(paths, repo)
            _run(["add", "--", *safe_paths], repo)
            return f"Staged {len(safe_paths)} file(s): {', '.join(safe_paths)}"

        if action == "commit":
            if not message or not message.strip():
                return "ERROR: commit requires a non-empty message"
            staged = _run(["diff", "--cached", "--name-only"], repo)
            if not staged:
                return "ERROR: nothing staged. Stage your changed files first."
            # -m takes the message as a separate argv element, so newlines and
            # quotes in the message are data, not shell syntax.
            _run(["commit", "-m", message], repo)
            sha = _run(["rev-parse", "HEAD"], repo)
            return f"Committed {sha[:8]} with files:\n{staged}"

        return (
            f"ERROR: unknown action {action!r}. Valid actions: status, diff, "
            "current_branch, create_branch, stage, commit, log"
        )

    except GitError as exc:
        return f"ERROR: {exc}"
