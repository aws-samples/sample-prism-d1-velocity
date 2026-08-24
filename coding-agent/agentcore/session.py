"""Prepare a harness session before the agent loop runs, and collect its patch after.

The first real invocation burned all forty iterations hunting for a repository
that was never cloned, and returned `max_iterations_exceeded`. Nothing had put the
code in the microVM. This module is that missing step.

`InvokeAgentRuntimeCommand` runs shell in the same microVM as the agent, with no
model reasoning and no token cost, and the AgentCore docs name these exact uses:
"clone a repo, install dependencies" beforehand, and "run tests, commit and push"
after. Doing the clone here rather than in the agent loop is not only cheaper --
it is more reliable, because a deterministic step either succeeds or reports a
non-zero exit, whereas an agent asked to clone can decide to do something else.

The session id ties the two together: commands and the subsequent InvokeHarness
call share one `runtimeSessionId`, so they see the same filesystem.
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field

from .contract import ContractError, FixRequest

WORKSPACE = "/workspace/repo"

# Each step gets its own budget. Cloning a large repo and compiling a toolchain
# have very different shapes, and one shared timeout would be wrong for both.
CLONE_TIMEOUT = 600
TOOLCHAIN_TIMEOUT = 900
DEPS_TIMEOUT = 1200
COLLECT_TIMEOUT = 120

# A ref reaches a shell command. Validated as an allowlist rather than escaped,
# because git refs have a narrow legal alphabet anyway and an allowlist cannot be
# outsmarted by quoting subtleties the way a denylist can.
_SAFE_REF = re.compile(r"^[A-Za-z0-9._/-]{1,255}$")
_SAFE_URL = re.compile(r"^https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$")


@dataclass
class StepResult:
    name: str
    command: str
    exit_code: int
    status: str = ""
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and self.status != "TIMED_OUT"


@dataclass
class PrepareResult:
    steps: list[StepResult] = field(default_factory=list)
    workdir: str = ""

    @property
    def ok(self) -> bool:
        return bool(self.steps) and all(s.ok for s in self.steps)

    @property
    def failure(self) -> StepResult | None:
        return next((s for s in self.steps if not s.ok), None)


def validate_repo_ref(request: FixRequest) -> None:
    """Reject a url or ref that could not safely reach a shell command."""
    if not _SAFE_URL.match(request.repo.url):
        raise ContractError(
            f"repo.url must be an https URL with no shell metacharacters: "
            f"{request.repo.url!r}"
        )
    if not _SAFE_REF.match(request.repo.ref):
        raise ContractError(
            f"repo.ref must match {_SAFE_REF.pattern}: {request.repo.ref!r}"
        )


def workdir_for(request: FixRequest) -> str:
    """Where the evaluated project lives inside the clone."""
    subdir = request.repo.subdir.strip("/")
    return f"{WORKSPACE}/{subdir}" if subdir and subdir != "." else WORKSPACE


def build_steps(request: FixRequest) -> list[tuple[str, str, int]]:
    """The deterministic commands to run before the agent starts.

    Returns (name, command, timeout) triples. Kept as data so they can be asserted
    in a test without a harness, which is the only way most of this is testable
    from a machine that cannot reach AgentCore.
    """
    validate_repo_ref(request)
    work = workdir_for(request)
    ref = shlex.quote(request.repo.ref)
    url = shlex.quote(request.repo.url)
    wq = shlex.quote(work)

    steps: list[tuple[str, str, int]] = [
        # A shallow clone at a named ref. Depth is bounded because the agent needs
        # the tree, not the history, and a deep clone of a busy repo is minutes of
        # dead time before any work starts.
        ("clone",
         f"rm -rf {WORKSPACE} && git clone --depth 50 --branch {ref} {url} {WORKSPACE} "
         f"&& cd {wq} && git rev-parse --short HEAD",
         CLONE_TIMEOUT),
        # mise reads the repo's own .tool-versions, .nvmrc and friends. When the
        # repo pins nothing that is a no-op -- and a no-op leaves the image with no
        # language runtime at all, because it ships a version manager rather than
        # versions.
        #
        # That is not hypothetical: the first prepared run failed with
        # `npm: not found` (exit 127), because the cloned ref declared no toolchain.
        # So there is a fallback, and it is deliberately loud. install-coding-agent
        # writes .tool-versions precisely so this path is not taken, and a repo
        # relying on the fallback gets whatever is current rather than what it was
        # built with.
        ("toolchain",
         f"cd {wq} && mise install 2>&1; {_fallback_toolchain_command()} "
         f"mise ls --current 2>&1 | head -20",
         TOOLCHAIN_TIMEOUT),
    ]

    install = _dependency_command(request)
    if install:
        steps.append(("dependencies", f"cd {wq} && mise exec -- {install}", DEPS_TIMEOUT))

    return steps


def _fallback_toolchain_command() -> str:
    """Install a current toolchain when the repository pinned none.

    Only reached when `mise install` found nothing, which means the repo declares
    no version. The alternative is that nothing runs at all -- the image carries a
    version manager, not versions -- so the choice is between an unpinned
    toolchain and no agent.

    It announces itself with UNPINNED so the reason shows up in the step output
    rather than being inferred later from a confusing test failure. The right fix
    is a pin in the repository, which install-coding-agent writes.
    """
    checks = [
        ("package.json", "node", "node@lts"),
        ("pyproject.toml", "python", "python@3.12"),
        ("requirements.txt", "python", "python@3.12"),
        ("go.mod", "go", "go@latest"),
        ("Cargo.toml", "cargo", "rust@latest"),
        ("Gemfile", "ruby", "ruby@3.3"),
    ]
    branches = " ".join(
        f'if [ -f {manifest} ] && ! command -v {binary} >/dev/null 2>&1; then '
        f'echo "UNPINNED: {manifest} present but no {binary}; installing {spec}. '
        f'Pin it in .tool-versions to make this reproducible."; '
        f'mise use --global {spec} >/dev/null 2>&1 || mise install {spec}; fi;'
        for manifest, binary, spec in checks
    )
    return f"sh -c '{branches}';"


def _dependency_command(request: FixRequest) -> str:
    """Infer the install command from the project's manifest.

    Deliberately not taken from config.json: that file carries a *test* command,
    and inferring the install step from what is actually in the tree keeps a repo
    from having to configure two things that are really one fact. The `||` fallback
    exists because `npm ci` requires a lockfile and fails without one.
    """
    return (
        "sh -c '"
        "if [ -f package-lock.json ]; then npm ci; "
        "elif [ -f package.json ]; then npm install; "
        "elif [ -f requirements.txt ]; then pip install -r requirements.txt; "
        "elif [ -f pyproject.toml ]; then pip install -e . || true; "
        "elif [ -f go.mod ]; then go mod download; "
        "elif [ -f Cargo.toml ]; then cargo fetch; "
        "elif [ -f Gemfile ]; then bundle install; "
        "else echo \"no recognised manifest\"; fi'"
    )


# Directories that are generated, not authored. Excluded from the collected patch
# by pathspec rather than trusted to .gitignore, because whether a repo ignores
# them is a property of that repo -- and the first prepared run returned a 1.1 MB
# "fix" consisting of one file, sample-app/dist/index.js, a 23,383-line bundle the
# build had just produced. The real source change was not in it.
GENERATED_DIRS = (
    "node_modules", "dist", "build", "out", "target", "vendor",
    ".venv", "venv", "__pycache__", ".gradle", ".next", "coverage",
)


def collect_patch_command(request: FixRequest) -> tuple[str, str, int]:
    """The command that extracts the agent's work as a patch.

    Run from the clone root, because `git diff` emits repository-root-relative
    paths whatever directory it runs in -- the convention FixResponse documents,
    and the one an earlier version of the eval client got wrong by applying at the
    subdirectory.

    Untracked files are included via `git add -N`, because an agent that creates a
    new file would otherwise have that work silently dropped. Generated
    directories are excluded by pathspec, since including them turns a one-line fix
    into a megabyte of build output and -- worse -- makes an agent that only ran a
    build look like an agent that fixed something.
    """
    excludes = " ".join(f"':(exclude){d}'" for d in GENERATED_DIRS)
    return (
        "collect",
        f"cd {WORKSPACE} && git add -N . {excludes} >/dev/null 2>&1; "
        f"git diff HEAD -- . {excludes}",
        COLLECT_TIMEOUT,
    )


def run_command(client, harness_arn: str, session_id: str, name: str,
                command: str, timeout: int) -> StepResult:
    """Run one shell command in the harness session and collect its result."""
    response = client.invoke_agent_runtime_command(
        agentRuntimeArn=harness_arn,
        runtimeSessionId=session_id,
        body={"command": command, "timeout": timeout},
    )

    out: list[str] = []
    err: list[str] = []
    exit_code = -1
    status = ""

    for event in response.get("stream", []):
        chunk = event.get("chunk", {})
        if "contentDelta" in chunk:
            delta = chunk["contentDelta"]
            if delta.get("stdout"):
                out.append(delta["stdout"])
            if delta.get("stderr"):
                err.append(delta["stderr"])
        elif "contentStop" in chunk:
            stop = chunk["contentStop"]
            exit_code = int(stop.get("exitCode", -1))
            status = str(stop.get("status") or "")
        for failure in ("accessDeniedException", "validationException",
                        "resourceNotFoundException", "throttlingException",
                        "internalServerException", "runtimeClientError",
                        "serviceQuotaExceededException"):
            if failure in event:
                raise ContractError(
                    f"{name}: {failure}: {event[failure].get('message')}"
                )

    return StepResult(name=name, command=command, exit_code=exit_code,
                      status=status, stdout="".join(out), stderr="".join(err))


def prepare_environment(client, harness_arn: str, session_id: str,
                        request: FixRequest) -> PrepareResult:
    """Clone the repo and install its toolchain and dependencies.

    Stops at the first failing step rather than pressing on: an agent turned loose
    on a half-prepared tree produces confusing work, and the failure it would
    report would be about the environment rather than the issue.
    """
    result = PrepareResult(workdir=workdir_for(request))
    for name, command, timeout in build_steps(request):
        step = run_command(client, harness_arn, session_id, name, command, timeout)
        result.steps.append(step)
        if not step.ok:
            break
    return result


def collect_patch(client, harness_arn: str, session_id: str,
                  request: FixRequest) -> StepResult:
    """Extract the agent's changes as a unified diff."""
    name, command, timeout = collect_patch_command(request)
    return run_command(client, harness_arn, session_id, name, command, timeout)
