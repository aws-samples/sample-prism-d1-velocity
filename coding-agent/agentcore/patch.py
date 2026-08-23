"""Apply a harness-produced patch to a working tree, and say precisely what failed.

This step is new. When the agent committed directly there was nothing to apply;
now a patch crosses a boundary and can fail in ways that must not be confused with
each other:

  MALFORMED    not a diff the tool understands
  CONFLICT     a valid diff that does not apply to this tree
  ESCAPED      touches paths outside the repository
  APPLIED      landed cleanly

Collapsing these into "the fix did not work" would mean a stale patch and a broken
agent read identically in an eval report.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

_TIMEOUT = 120


class ApplyStatus(str, Enum):
    APPLIED = "applied"
    MALFORMED = "malformed"
    CONFLICT = "conflict"
    ESCAPED = "escaped"


@dataclass
class ApplyResult:
    status: ApplyStatus
    files: list[str] = field(default_factory=list)
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status is ApplyStatus.APPLIED


def _git(args: list[str], cwd: Path, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), input=stdin, capture_output=True,
        text=True, timeout=_TIMEOUT, check=False,
    )


def changed_paths(patch: str, repo: Path) -> tuple[list[str], str]:
    """List the paths a patch touches, using git's own parser.

    `--numstat` is used rather than a hand-rolled scan of `+++` lines because
    those can be quoted, renamed, or `/dev/null`, and a parser that disagrees with
    the tool doing the applying is worse than no parser.
    """
    proc = _git(["apply", "--numstat", "-z", "-"], repo, stdin=patch)
    if proc.returncode != 0:
        return [], (proc.stderr or proc.stdout).strip()

    fields = [f for f in proc.stdout.split("\0") if f]
    paths: list[str] = []
    # numstat -z emits added, removed, path as tab-separated records; renames add
    # two extra NUL-separated fields after an empty path.
    for record in fields:
        parts = record.split("\t")
        if len(parts) >= 3 and parts[2]:
            paths.append(parts[2])
        elif len(parts) >= 3:
            continue  # rename: the following two fields carry old and new paths
        elif record and "/" in record or record.endswith((".py", ".ts", ".js")):
            paths.append(record)
    return paths, ""


def apply_patch(patch: str, repo: Path) -> ApplyResult:
    """Apply `patch` inside `repo`, refusing anything that reaches outside it."""
    if not patch.strip():
        return ApplyResult(ApplyStatus.MALFORMED, detail="patch is empty")

    paths, parse_error = changed_paths(patch, repo)
    if parse_error:
        return ApplyResult(ApplyStatus.MALFORMED, detail=parse_error)
    if not paths:
        return ApplyResult(ApplyStatus.MALFORMED, detail="patch touches no files")

    # git apply already rejects paths outside the tree, but checking first turns a
    # generic failure into a named one -- and the distinction matters, because an
    # escape attempt is a finding about the agent while a conflict is not.
    repo_real = repo.resolve()
    for raw in paths:
        if raw.startswith("/") or ".." in Path(raw).parts:
            return ApplyResult(ApplyStatus.ESCAPED, paths, f"path leaves the repository: {raw}")
        try:
            (repo_real / raw).resolve().relative_to(repo_real)
        except ValueError:
            return ApplyResult(ApplyStatus.ESCAPED, paths, f"path resolves outside the repository: {raw}")

    check = _git(["apply", "--check", "-"], repo, stdin=patch)
    if check.returncode != 0:
        return ApplyResult(ApplyStatus.CONFLICT, paths, (check.stderr or check.stdout).strip())

    applied = _git(["apply", "-"], repo, stdin=patch)
    if applied.returncode != 0:
        # --check passed and the apply did not: report it as a conflict rather
        # than claiming success, and carry git's message.
        return ApplyResult(ApplyStatus.CONFLICT, paths, (applied.stderr or applied.stdout).strip())

    return ApplyResult(ApplyStatus.APPLIED, paths)


def commit_applied(repo: Path, message: str, author: str, email: str) -> str:
    """Commit whatever the patch changed, and return the new sha.

    The orchestrator commits rather than the harness, so the harness needs no
    write credential and the commit carries the agent identity this repository
    configured -- which is what makes the work attributable on the PRISM
    dashboards.
    """
    _git(["add", "-A"], repo)
    proc = _git(
        ["-c", f"user.name={author}", "-c", f"user.email={email}",
         "commit", "-m", message],
        repo,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"commit failed: {(proc.stderr or proc.stdout).strip()}")
    return _git(["rev-parse", "HEAD"], repo).stdout.strip()
