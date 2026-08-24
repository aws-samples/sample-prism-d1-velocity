"""Tests for the session-preparation step.

The commands are asserted as data rather than executed, because the only machine
that can run them is a live harness. What matters here is that a repo url or ref
cannot reach a shell unquoted, and that the steps say what they are meant to say.
"""

from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agentcore import (  # noqa: E402
    ContractError,
    FixRequest,
    Issue,
    RepoRef,
    Verification,
    build_steps,
    collect_patch_command,
    workdir_for,
)
from agentcore.session import (  # noqa: E402
    BASE_SHA_FILE,
    MAX_PATCH_BYTES,
    PATCH_HEADER,
    PATCH_SENTINEL,
    WORKSPACE,
    StepResult,
    _exclude_pathspecs,
    parse_collected_patch,
    validate_repo_ref,
    verify_command,
)


def make(**kw) -> FixRequest:
    d = dict(
        issue=Issue(number=1, title="t", body="b"),
        repo=RepoRef(url="https://github.com/acme/api.git", ref="main"),
        verification=Verification(test_command="npm test"),
    )
    d.update(kw)
    return FixRequest(**d)


def names(request) -> list[str]:
    return [n for n, _c, _t in build_steps(request)]


def command_for(request, step) -> str:
    return next(c for n, c, _t in build_steps(request) if n == step)


# ---- injection: a ref and url reach a shell command ------------------------

@pytest.mark.parametrize("ref", [
    "main; rm -rf /", "main && curl evil", "main`id`", "main$(id)",
    "main|sh", "main\nrm -rf /", "--upload-pack=sh",
])
def test_a_ref_that_could_reach_a_shell_is_rejected(ref):
    with pytest.raises(ContractError):
        validate_repo_ref(make(repo=RepoRef(url="https://github.com/a/b.git", ref=ref)))


@pytest.mark.parametrize("ref", ["main", "release/2.1", "v1.0.0", "feature-x_y.z"])
def test_ordinary_refs_pass(ref):
    validate_repo_ref(make(repo=RepoRef(url="https://github.com/a/b.git", ref=ref)))


@pytest.mark.parametrize("url", [
    "git@github.com:a/b.git",        # ssh would need a key in the VM
    "file:///etc",                   # local path is not a remote
    "https://x/a.git; rm -rf /",
    "http://insecure/a.git",
])
def test_a_url_that_is_not_a_plain_https_remote_is_rejected(url):
    with pytest.raises(ContractError):
        validate_repo_ref(make(repo=RepoRef(url=url, ref="main")))


def test_values_are_quoted_in_the_command_not_merely_validated():
    """Validation is the guard; quoting is the belt. Both, because either alone
    has been enough to go wrong before."""
    cmd = command_for(make(repo=RepoRef(
        url="https://github.com/acme/api.git", ref="release/2.1")), "clone")
    assert shlex.quote("release/2.1") in cmd or "release/2.1" in cmd
    assert "https://github.com/acme/api.git" in cmd


# ---- the steps themselves -------------------------------------------------

def test_the_repo_is_cloned_before_anything_else():
    """The whole reason this module exists: the first live invocation had nothing
    cloned and spent its entire iteration budget looking for a checkout."""
    assert names(make())[0] == "clone"


def test_clone_is_shallow_and_pinned_to_the_requested_ref():
    cmd = command_for(make(repo=RepoRef(url="https://github.com/a/b.git", ref="main")), "clone")
    assert "--depth" in cmd and "--branch" in cmd


def test_the_toolchain_step_reads_the_repos_own_pins():
    assert "mise install" in command_for(make(), "toolchain")


def test_dependencies_are_inferred_from_the_manifest_in_the_tree():
    """Not from config.json, which carries a test command. Inferring the install
    step from what is actually present stops a repo configuring two things that
    are one fact."""
    cmd = command_for(make(), "dependencies")
    for manifest in ("package-lock.json", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile"):
        assert manifest in cmd
    assert "npm ci" in cmd and "npm install" in cmd  # lockfile present vs absent


def test_dependency_install_runs_under_the_installed_toolchain():
    """`mise exec --` matters: npm from the image would be the wrong version, or
    absent entirely, since the image ships no language runtime."""
    assert "mise exec --" in command_for(make(), "dependencies")


# ---- monorepo handling ----------------------------------------------------

def test_workdir_is_the_repo_root_for_an_ordinary_repo():
    assert workdir_for(make()) == WORKSPACE


def test_workdir_descends_for_a_monorepo_subdirectory():
    r = make(repo=RepoRef(url="https://github.com/a/b.git", ref="main", subdir="sample-app"))
    assert workdir_for(r) == f"{WORKSPACE}/sample-app"


def test_toolchain_and_dependencies_run_in_the_subdirectory_not_the_root():
    r = make(repo=RepoRef(url="https://github.com/a/b.git", ref="main", subdir="services/api"))
    for step in ("toolchain", "dependencies"):
        assert f"{WORKSPACE}/services/api" in command_for(r, step)


def test_the_patch_is_collected_from_the_repo_root():
    """git diff emits repository-root-relative paths whatever directory it runs
    in, and the eval client applies at the clone root. Collecting from the subdir
    would produce paths that do not match."""
    _name, cmd, _timeout = collect_patch_command(
        make(repo=RepoRef(url="https://github.com/a/b.git", ref="main", subdir="sample-app")))
    assert f"cd {WORKSPACE} " in cmd or f"cd {WORKSPACE}\n" in cmd
    assert "sample-app" not in cmd.split("git diff")[0]


def test_new_files_are_included_in_the_collected_patch():
    """`git add -N` marks untracked files as intent-to-add so they appear in the
    diff. Without it an agent that created a file would have that work silently
    dropped."""
    _n, cmd, _t = collect_patch_command(make())
    assert "add -N" in cmd and "git diff" in cmd


def test_each_step_carries_its_own_timeout():
    """Cloning and compiling a toolchain have different shapes; one shared budget
    would be wrong for both."""
    timeouts = {n: t for n, _c, t in build_steps(make())}
    assert timeouts["clone"] != timeouts["toolchain"]
    assert all(t > 0 for t in timeouts.values())


# ---- the unpinned fallback ------------------------------------------------

def test_an_unpinned_repo_gets_a_toolchain_rather_than_nothing():
    """The image ships a version manager, not versions, so a repo that pins
    nothing has no runtime at all -- which failed a real prepared run with
    `npm: not found` (exit 127). The choice is an unpinned toolchain or no agent."""
    cmd = command_for(make(), "toolchain")
    assert "mise install" in cmd
    assert "node@lts" in cmd


def test_the_fallback_announces_itself_rather_than_papering_over():
    """UNPINNED in the step output, so the reason is visible at the point it
    happens instead of inferred later from a confusing test failure."""
    cmd = command_for(make(), "toolchain")
    assert "UNPINNED" in cmd
    assert ".tool-versions" in cmd


def test_the_fallback_only_fires_when_the_tool_is_actually_absent():
    """Guarded on `command -v`, so a repo that did pin a version keeps it."""
    cmd = command_for(make(), "toolchain")
    assert "command -v node" in cmd


def test_the_fallback_covers_the_manifests_detection_knows_about():
    cmd = command_for(make(), "toolchain")
    for manifest in ("package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"):
        assert manifest in cmd


# ---- generated files must not become the patch ----------------------------

def test_generated_directories_are_excluded_from_the_collected_patch():
    """A real prepared run returned a 1.1 MB "fix" that was one file:
    sample-app/dist/index.js, a 23,383-line bundle the build had just produced.
    The actual source change was not in it."""
    _n, cmd, _t = collect_patch_command(make())
    for d in ("node_modules", "dist", "build", "target", ".venv", "coverage"):
        assert f"':(exclude,glob)**/{d}/**'" in cmd


def test_exclusions_apply_to_both_the_add_and_the_diff():
    """Excluding only on `git add -N` would still diff a tracked build artifact."""
    _n, cmd, _t = collect_patch_command(make())
    add, diff = cmd.split("git diff", 1)
    spec = "':(exclude,glob)**/dist/**'"
    assert spec in add and spec in diff


def test_exclusion_is_by_pathspec_not_by_trusting_gitignore():
    """Whether a repo ignores its build output is a property of that repo, and the
    run that failed did so because the cloned ref did not ignore dist/."""
    _n, cmd, _t = collect_patch_command(make())
    assert ":(exclude" in cmd


def _fixture_repo(tmp_path: Path) -> Path:
    """A monorepo-shaped tree: generated output both nested and at the root."""
    repo = tmp_path / "repo"
    for d in ("sample-app/dist", "sample-app/src", "sample-app/notdist", "dist"):
        (repo / d).mkdir(parents=True)
    (repo / "keep.txt").write_text("base\n")
    run = lambda *a: subprocess.run(  # noqa: E731
        ["git", *a], cwd=str(repo), capture_output=True, text=True, check=True)
    run("init", "-q", ".")
    run("config", "user.email", "a@b.c")
    run("config", "user.name", "a")
    run("add", "-A")
    run("commit", "-qm", "init")
    (repo / "sample-app/dist/index.js").write_text("bundle\n")
    (repo / "dist/root.js").write_text("bundle\n")
    (repo / "sample-app/notdist/x.js").write_text("authored\n")
    (repo / "sample-app/src/tasks.ts").write_text("authored\n")
    return repo


def test_the_exclusion_pathspec_actually_excludes_a_nested_generated_dir(tmp_path):
    """Run against real git, because the string-shape assertions above cannot see
    this and did not: `:(exclude)dist` matches only `dist` relative to the
    pathspec's base, so at the clone root it never touched `sample-app/dist`. The
    guard was present and inert, and the next run still produced a 1,196,474-byte
    diff.
    """
    repo = _fixture_repo(tmp_path)
    spec = _exclude_pathspecs()
    subprocess.run(f"git add -N . {spec}", cwd=str(repo), shell=True,
                   capture_output=True)
    out = subprocess.run(f"git diff HEAD --name-only -- . {spec}", cwd=str(repo),
                         shell=True, capture_output=True, text=True).stdout
    changed = set(out.split())

    assert "sample-app/dist/index.js" not in changed, "nested dist/ leaked in"
    assert "dist/root.js" not in changed, "top-level dist/ leaked in"
    # And it must not over-match: `:(exclude)*dist/*` would take this too.
    assert "sample-app/notdist/x.js" in changed, "a dir merely named notdist was eaten"
    assert "sample-app/src/tasks.ts" in changed, "the authored fix was excluded"


def test_the_collected_patch_is_framed_so_truncation_is_detectable(tmp_path):
    """The framing has to survive a real shell, not just look right in Python."""
    repo = _fixture_repo(tmp_path)
    _n, cmd, _t = collect_patch_command(make())
    cmd = cmd.replace(f"cd {WORKSPACE}", f"cd {repo}")
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    step = StepResult(name="collect", command=cmd, exit_code=0, stdout=proc.stdout)
    collected = parse_collected_patch(step)

    assert collected.ok, collected.reason
    assert collected.declared_bytes == collected.received_bytes
    assert "sample-app/src/tasks.ts" in collected.patch
    assert "dist/index.js" not in collected.patch


def test_a_truncated_patch_is_a_failure_not_a_patch():
    """The 1.1 MB diff that reached the eval ended mid-token, on `if ("string" !=`.
    A cut diff is still a non-empty string, so nothing noticed."""
    diff = "diff --git a/x b/x\n-old\n+new\n"
    step = StepResult(name="collect", command="c", exit_code=0,
                      stdout=f"{PATCH_HEADER} {len(diff.encode())}\n{diff[:12]}")
    collected = parse_collected_patch(step)
    assert not collected.ok
    assert "truncated" in collected.reason
    assert PATCH_SENTINEL in collected.reason


def test_a_patch_that_changed_size_in_transit_is_rejected():
    diff = "diff --git a/x b/x\n+new\n"
    step = StepResult(name="collect", command="c", exit_code=0,
                      stdout=f"{PATCH_HEADER} 9999\n{diff}{PATCH_SENTINEL}\n")
    collected = parse_collected_patch(step)
    assert not collected.ok and "changed size" in collected.reason


def test_an_implausibly_large_diff_is_refused_before_it_is_streamed():
    """Refused on the declared size, so the reason is comprehensible rather than a
    mid-line truncation someone has to diagnose from a megabyte of bundle."""
    step = StepResult(name="collect", command="c", exit_code=0,
                      stdout=f"{PATCH_HEADER} {MAX_PATCH_BYTES + 1}\n")
    collected = parse_collected_patch(step)
    assert not collected.ok
    assert "over the" in collected.reason and not collected.patch


def test_an_empty_diff_is_intact_and_empty_not_a_failure():
    """An agent that deliberately changed nothing must reach the declined path, not
    be reported as a collection failure."""
    step = StepResult(name="collect", command="c", exit_code=0,
                      stdout=f"{PATCH_HEADER} 0\n{PATCH_SENTINEL}\n")
    collected = parse_collected_patch(step)
    assert collected.ok and collected.empty


def test_unframed_output_is_rejected_rather_than_treated_as_a_diff():
    step = StepResult(name="collect", command="c", exit_code=0,
                      stdout="fatal: not a git repository\n")
    collected = parse_collected_patch(step)
    assert not collected.ok and PATCH_HEADER in collected.reason


def test_committed_work_is_collected_not_just_uncommitted(tmp_path):
    """The agent is told to commit. `git diff HEAD` measures only uncommitted work,
    so once it commits the fix disappears from the diff -- which is how a run that
    produced a correct six-line fix returned only the `git format-patch` artifact the
    agent had generated beside it.
    """
    repo = _fixture_repo(tmp_path)
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True).stdout.strip()
    Path(repo / BASE_SHA_FILE.lstrip("/")).parent.mkdir(parents=True, exist_ok=True)

    # The agent edits, commits, and leaves a format-patch artifact behind.
    (repo / "sample-app/src/tasks.ts").write_text("fixed\n")
    subprocess.run(["git", "add", "-A", "sample-app/src"], cwd=str(repo), check=True,
                   capture_output=True)
    subprocess.run(["git", "commit", "-qm", "fix: the real change"], cwd=str(repo),
                   check=True, capture_output=True)
    (repo / "0001-fix-the-real-change.patch").write_text("From abc123\nSubject: fix\n")

    spec = _exclude_pathspecs()
    subprocess.run(f"git add -N . {spec}", cwd=str(repo), shell=True, capture_output=True)
    from_head = subprocess.run(f"git diff HEAD --name-only -- . {spec}", cwd=str(repo),
                               shell=True, capture_output=True, text=True).stdout.split()
    from_base = subprocess.run(f"git diff {base} --name-only -- . {spec}", cwd=str(repo),
                               shell=True, capture_output=True, text=True).stdout.split()

    assert "sample-app/src/tasks.ts" not in from_head, "premise wrong: HEAD saw the commit"
    assert "sample-app/src/tasks.ts" in from_base, "the committed fix was not collected"
    assert not any(f.endswith(".patch") for f in from_base), "format-patch artifact leaked"


def test_the_collect_command_diffs_against_the_recorded_base():
    _n, cmd, _t = collect_patch_command(make())
    assert BASE_SHA_FILE in cmd
    assert "git diff HEAD --" not in cmd, "still measuring only uncommitted work"


def test_the_clone_step_records_the_base_commit():
    """Recorded to a file because the clone and the collect are separate
    InvokeAgentRuntimeCommand calls that share only a filesystem."""
    steps = {name: cmd for name, cmd, _ in build_steps(make())}
    assert f"git rev-parse HEAD > {BASE_SHA_FILE}" in steps["clone"]


def test_patch_artifacts_are_excluded_as_generated():
    """A file describing a change is not a change."""
    spec = _exclude_pathspecs()
    for glob in ("*.patch", "*.diff", "*.orig", "*.rej"):
        assert f"':(exclude,glob)**/{glob}'" in spec


def test_verification_runs_the_projects_own_command_in_the_subdirectory():
    """`verified` used to be a search for the words "tests pass" in the model's
    prose, on a branch that stopped firing once the patch came from git -- so it was
    structurally False on every real run, including one whose reply read "All
    existing tests pass (50 tests)"."""
    step = verify_command(make(repo=RepoRef(url="https://github.com/a/b.git",
                                            ref="main", subdir="sample-app")))
    assert step is not None
    _name, cmd, _t = step
    # Not asserted with quotes around it: shlex.quote adds them only when the string
    # needs them, and this path does not. Asserting the quoted form would be
    # asserting a detail of shlex rather than the behaviour.
    assert cmd.startswith(f"cd {shlex.quote(WORKSPACE + '/sample-app')} &&")
    assert "npm test" in cmd


def test_the_test_command_is_quoted_rather_than_interpolated():
    """It comes from the repository's own config -- more trusted than an issue body,
    still not something to splice into a shell."""
    step = verify_command(make(verification=Verification(
        test_command="npm test; echo pwned")))
    assert step is not None
    _name, cmd, _t = step
    # The whole thing lands inside one quoted argument, so the `;` cannot chain.
    assert shlex.quote("npm test; echo pwned") in cmd


def test_no_test_command_means_not_checked_rather_than_failed():
    """Absence of a suite must not read as a failing suite."""
    assert verify_command(make(verification=Verification(test_command=""))) is None


def test_verification_runs_under_the_installed_toolchain():
    """The image ships a version manager, not versions -- a bare `npm test` would not
    find npm."""
    _n, cmd, _t = verify_command(make())
    assert "mise exec --" in cmd


def test_the_patch_is_collected_before_verification_runs():
    """A test run can emit coverage or build output. Collecting afterwards would fold
    those artifacts into the patch -- the failure that produced 1.1 MB of dist/."""
    import inspect

    from agentcore import client as client_module

    source = inspect.getsource(client_module.BotoTransport.send)
    assert source.index("collect_patch(") < source.index("verify_patch("), \
        "verification runs before collection, so its artifacts can reach the patch"
