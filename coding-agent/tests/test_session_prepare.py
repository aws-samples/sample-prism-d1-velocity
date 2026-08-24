"""Tests for the session-preparation step.

The commands are asserted as data rather than executed, because the only machine
that can run them is a live harness. What matters here is that a repo url or ref
cannot reach a shell unquoted, and that the steps say what they are meant to say.
"""

from __future__ import annotations

import shlex
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
from agentcore.session import WORKSPACE, validate_repo_ref  # noqa: E402


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
        assert f"':(exclude){d}'" in cmd


def test_exclusions_apply_to_both_the_add_and_the_diff():
    """Excluding only on `git add -N` would still diff a tracked build artifact."""
    _n, cmd, _t = collect_patch_command(make())
    add, diff = cmd.split("git diff", 1)
    assert "':(exclude)dist'" in add and "':(exclude)dist'" in diff


def test_exclusion_is_by_pathspec_not_by_trusting_gitignore():
    """Whether a repo ignores its build output is a property of that repo, and the
    run that failed did so because the cloned ref did not ignore dist/."""
    _n, cmd, _t = collect_patch_command(make())
    assert ":(exclude)" in cmd
