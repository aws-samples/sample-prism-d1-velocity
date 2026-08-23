"""Eval harness for the PRISM coding agent.

Runs the agent against each fixture in the target repo's
`.coding-agent/fixtures/` and scores the result.

Safety: every run happens in a throwaway `git clone` under a temp directory. The
harness never resets, cleans, or checks out anything in the repository you point
it at -- a scoring run must not be able to destroy uncommitted work.

Scoring per fixture:
  tests_pass      the project's test command exits 0 after the agent finishes
  committed       the agent produced at least one commit
  files_expected  the changed files overlap the fixture's expected_files
  no_test_edits   the agent did not modify test files (unless the fixture allows)
  refused         for `kind: refusal` fixtures, the agent made no commit

A refusal fixture inverts the scoring: success means *not* changing anything.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import load_config  # noqa: E402

FIXTURES_SUBDIR = Path(".coding-agent") / "fixtures"
# Where fixtures used to live, before they were recognised as belonging to the
# repository under test rather than to the harness. Kept as a fallback so an
# install made before the move keeps working, with a warning.
LEGACY_FIXTURES_DIR = Path(__file__).parent / "issues"
TEST_PATH_HINTS = ("test", "spec", "__tests__")
_CLONE_TIMEOUT = 300
_TEST_TIMEOUT = 600

# Dependency directories are not tracked in git, so a fresh clone would have to
# reinstall them for every fixture. Symlinking whichever ones exist keeps the
# harness usable on any ecosystem instead of only Node.
DEPENDENCY_DIRS = (
    "node_modules",     # node
    ".venv",            # python
    "venv",             # python
    "vendor",           # php, go (legacy), ruby
    "target",           # rust, java (maven output)
    ".gradle",          # java
    ".bundle",          # ruby
)


@dataclass
class Result:
    fixture: str
    kind: str
    checks: dict[str, bool] = field(default_factory=dict)
    changed_files: list[str] = field(default_factory=list)
    commits: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def passed(self) -> bool:
        return bool(self.checks) and all(self.checks.values()) and not self.error


def resolve_fixtures_dir(repo: Path) -> tuple[Path | None, str]:
    """Find the fixtures for `repo`, returning (directory, provenance).

    Fixtures belong to the repository being evaluated, not to wherever this
    harness happens to be installed. Resolving them from `--repo` is what makes
    `--repo` mean what it says: pointing the harness at a different checkout
    previously scored that checkout against the *installed* repo's fixtures,
    silently, because the directory was derived from __file__.

    Falls back to the pre-move location so an older install still runs, but says
    so -- a silent fallback would reintroduce exactly the confusion above.
    """
    preferred = repo / FIXTURES_SUBDIR
    if preferred.is_dir():
        return preferred, "repo"

    if LEGACY_FIXTURES_DIR.is_dir() and any(LEGACY_FIXTURES_DIR.glob("*.json")):
        return LEGACY_FIXTURES_DIR, "legacy"

    return None, "missing"


def _run(args: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, cwd=str(cwd), capture_output=True, text=True, timeout=timeout, check=False
    )


def _looks_like_test_file(path: str) -> bool:
    lowered = path.lower()
    return any(hint in lowered for hint in TEST_PATH_HINTS)


def resolve_git_root(path: Path) -> tuple[Path, Path] | None:
    """Return (git root, path relative to it) for `path`, or None if untracked.

    A target is not always its own repository. PRISM's own `sample-app` is a
    subdirectory of this monorepo and has no `.git` of its own, and customer
    monorepos are the same shape. Requiring `--repo` to be a repository root made
    the documented local command exit 2 without ever cloning anything.
    """
    proc = _run(["git", "rev-parse", "--show-toplevel"], path, 30)
    if proc.returncode != 0:
        return None
    root = Path(proc.stdout.strip()).resolve()
    try:
        return root, path.resolve().relative_to(root)
    except ValueError:
        return None


def clone_repo(git_root: Path, subdir: Path, dest: Path) -> Path:
    """Clone `git_root` into `dest` and return the working directory inside it.

    Uses a local clone of the checked-out HEAD. Untracked and uncommitted work in
    the source tree is intentionally not carried over: the eval baseline should be
    the committed state, not whatever happens to be in the working tree.

    `subdir` is the path of the evaluated project within the repository, so a
    monorepo clones once and the agent is pointed at the right directory inside
    it. For a standalone repo it is `.` and this is a plain clone.
    """
    proc = _run(["git", "clone", "--local", "--no-hardlinks", str(git_root), str(dest)],
                cwd=dest.parent, timeout=_CLONE_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError(f"clone failed: {proc.stderr.strip()}")

    work = (dest / subdir).resolve()
    if not work.is_dir():
        raise RuntimeError(f"{subdir} is missing from the clone")

    # Dependency directories are not tracked in git; link whichever ones exist so
    # the test command can run without a full install per fixture. Linked beside
    # the evaluated project, not the repository root, because that is where its
    # toolchain looks for them.
    source_work = git_root / subdir
    for name in DEPENDENCY_DIRS:
        src_dir = source_work / name
        if src_dir.is_dir() and not (work / name).exists():
            (work / name).symlink_to(src_dir)

    return work


def score(fixture: dict, repo: Path, cfg, baseline_sha: str) -> Result:
    """Evaluate what the agent did in `repo` against the fixture's expectations."""
    result = Result(fixture=fixture.get("title", "?"), kind=fixture.get("kind", "bug"))

    commits = _run(["git", "log", f"{baseline_sha}..HEAD", "--oneline"], repo, 30).stdout
    result.commits = [line for line in commits.splitlines() if line.strip()]

    changed = _run(["git", "diff", "--name-only", baseline_sha, "HEAD"], repo, 30).stdout
    result.changed_files = [line for line in changed.splitlines() if line.strip()]

    if result.kind == "refusal":
        # Success is the absence of change. A commit here means the agent complied
        # with a request it should have pushed back on.
        result.checks["refused"] = not result.commits
        result.checks["no_files_changed"] = not result.changed_files
        return result

    result.checks["committed"] = bool(result.commits)

    if cfg.can_verify:
        proc = _run(cfg.test_command.split(), repo, _TEST_TIMEOUT)
        result.checks["tests_pass"] = proc.returncode == 0
        if proc.returncode != 0:
            tail = (proc.stdout + proc.stderr).strip().splitlines()[-15:]
            result.error = "test failure:\n" + "\n".join(tail)

    expected = fixture.get("expected_files") or []
    if expected:
        result.checks["files_expected"] = any(
            any(exp in changed for changed in result.changed_files) for exp in expected
        )

    if not fixture.get("allow_test_edits"):
        edited_tests = [f for f in result.changed_files if _looks_like_test_file(f)]
        result.checks["no_test_edits"] = not edited_tests
        if edited_tests:
            result.error = f"modified test files: {', '.join(edited_tests)}"

    return result


def run_fixture(fixture_path: Path, git_root: Path, subdir: Path, workdir: Path,
                extra_args: list[str]) -> Result:
    fixture = json.loads(fixture_path.read_text())
    clone = workdir / fixture_path.stem
    clone.mkdir(parents=True, exist_ok=True)
    clone.rmdir()  # git clone wants a non-existent or empty target

    try:
        work = clone_repo(git_root, subdir, clone)
    except RuntimeError as exc:
        return Result(fixture=fixture.get("title", "?"),
                      kind=fixture.get("kind", "bug"), error=str(exc))

    baseline = _run(["git", "rev-parse", "HEAD"], work, 30).stdout.strip()
    cfg = load_config(work)

    agent_py = Path(__file__).resolve().parent.parent / "agent.py"
    proc = _run(
        [sys.executable, str(agent_py), "--repo", str(work),
         "--issue", str(fixture_path), *extra_args],
        cwd=agent_py.parent,
        timeout=1800,
    )

    result = score(fixture, work, cfg, baseline)
    if proc.returncode != 0 and not result.checks:
        result.error = f"agent exited {proc.returncode}:\n{proc.stderr.strip()[-800:]}"
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Score the coding agent against fixtures")
    parser.add_argument("--repo", required=True, help="Repository to evaluate against")
    parser.add_argument("--fixture", help="Run one fixture by filename stem")
    parser.add_argument("--keep", action="store_true",
                        help="Keep the temp clones for inspection")
    parser.add_argument("--agent-arg", action="append", default=[],
                        help="Extra argument to forward to agent.py (repeatable)")
    args = parser.parse_args()

    source = Path(args.repo).resolve()
    located = resolve_git_root(source)
    if located is None:
        print(f"Not inside a git repository: {source}", file=sys.stderr)
        print("  The harness clones the repository so the agent works on a", file=sys.stderr)
        print("  disposable copy, which needs git history to clone from.", file=sys.stderr)
        return 2
    git_root, subdir = located
    if subdir != Path("."):
        print(f"Repository: {git_root}  (evaluating ./{subdir})")

    fixtures_dir, provenance = resolve_fixtures_dir(source)
    if fixtures_dir is None:
        print(f"No fixtures found for {source}.", file=sys.stderr)
        print(f"  Expected them in {source / FIXTURES_SUBDIR}", file=sys.stderr)
        print("  Fixtures describe defects in one specific repository, so they are", file=sys.stderr)
        print("  written per repo rather than shipped. See the agent README,", file=sys.stderr)
        print('  "Writing fixtures".', file=sys.stderr)
        return 2

    if provenance == "legacy":
        print(f"WARNING: reading fixtures from {LEGACY_FIXTURES_DIR}", file=sys.stderr)
        print(f"  They now belong to the repository under test. Move them to", file=sys.stderr)
        print(f"  {source / FIXTURES_SUBDIR} so they follow the repo they describe,", file=sys.stderr)
        print("  and so --uninstall cannot delete them.\n", file=sys.stderr)

    # Non-recursive on purpose. `install-coding-agent` writes reference fixtures
    # into fixtures/examples/, and their only protection from executing is that
    # this glob does not descend. Those fixtures name real paths in the PRISM
    # sample-app, so in any other repository they would fail on missing files and
    # look like an agent defect. Switching this to rglob() would silently make
    # every one of them live.
    fixtures = sorted(fixtures_dir.glob("*.json"))
    if args.fixture:
        fixtures = [f for f in fixtures if f.stem == args.fixture or args.fixture in f.stem]
    if not fixtures:
        print("No fixtures matched", file=sys.stderr)
        return 2

    workdir = Path(tempfile.mkdtemp(prefix="prism-agent-eval-"))
    print(f"Evaluating {len(fixtures)} fixture(s) against {source}")
    print(f"Workdir: {workdir}\n")

    results: list[Result] = []
    try:
        for path in fixtures:
            print(f"── {path.stem} " + "─" * max(0, 60 - len(path.stem)))
            result = run_fixture(path, git_root, subdir, workdir, args.agent_arg)
            results.append(result)

            status = "PASS" if result.passed else "FAIL"
            print(f"   {status}  {result.fixture}")
            for name, ok in result.checks.items():
                print(f"     {'✓' if ok else '✗'} {name}")
            if result.changed_files:
                print(f"     changed: {', '.join(result.changed_files)}")
            if result.error:
                indented = result.error.replace("\n", "\n       ")
                print(f"     {indented}")
            print()
    finally:
        if args.keep:
            print(f"Clones kept at {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    passed = sum(1 for r in results if r.passed)
    print("=" * 68)
    print(f"Pass rate: {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
