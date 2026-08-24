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
# Where the clone step records the commit it started from, read back by the collect
# step. A file rather than plumbed through Python state because the two steps are
# separate InvokeAgentRuntimeCommand calls sharing only a filesystem.
BASE_SHA_FILE = "/tmp/prism-base-sha"

# Each step gets its own budget. Cloning a large repo and compiling a toolchain
# have very different shapes, and one shared timeout would be wrong for both.
CLONE_TIMEOUT = 600
TOOLCHAIN_TIMEOUT = 900
DEPS_TIMEOUT = 1200
COLLECT_TIMEOUT = 120
# A suite that has not finished in ten minutes is not going to settle the question
# of whether a six-line fix works.
VERIFY_TIMEOUT = 600

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
        #
        # The base commit is recorded to a file because the patch has to be measured
        # against where the clone started, not against HEAD. The agent is instructed
        # to commit, and once it does, `git diff HEAD` reports nothing of the change
        # -- which is how a run that correctly fixed the bug returned a diff
        # containing only the `git format-patch` output the agent had generated
        # alongside it.
        ("clone",
         f"rm -rf {WORKSPACE} && git clone --depth 50 --branch {ref} {url} {WORKSPACE} "
         f"&& cd {WORKSPACE} && git rev-parse HEAD > {BASE_SHA_FILE} "
         f"&& cd {wq} && cat {BASE_SHA_FILE}",
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


# Files that describe a change rather than being one. An agent that commits its fix
# and then runs `git format-patch` leaves one of these behind, and a run did exactly
# that: the collected diff was a single new file,
# 0001-fix-validate-that-tags-array-contains-only-strings.patch, whose contents were
# the real fix. Applying it would have added a patch file to the repository and
# changed no code.
GENERATED_FILE_GLOBS = ("*.patch", "*.diff", "*.orig", "*.rej")


def _exclude_pathspecs() -> str:
    """Exclude the generated directories at any depth.

    The form matters, and getting it wrong is silent. A bare `:(exclude)dist`
    matches only `dist` relative to the pathspec's base -- so run at the clone root
    it never touched `sample-app/dist`, and the exclusion added to stop build output
    reaching the patch did nothing at all. The next run returned a 1,196,474-byte
    diff with the guard supposedly in place.

    `:(exclude,glob)**/dist/**` matches at every depth including the top level, and
    unlike `:(exclude)*dist/*` -- which also works, because `*` spans `/` without
    glob magic -- it does not swallow a directory merely named `notdist`. Verified
    against git rather than inferred from the pathspec documentation.
    """
    dirs = [f"':(exclude,glob)**/{d}/**'" for d in GENERATED_DIRS]
    files = [f"':(exclude,glob)**/{g}'" for g in GENERATED_FILE_GLOBS]
    return " ".join(dirs + files)


# The patch travels back as command stdout, and that stream has a ceiling. The
# run that returned dist/index.js hit it: 1,138,688 bytes arrived and the last
# line stopped mid-token, so the diff was structurally invalid and the source fix
# -- which sorted after `dist/` alphabetically -- never made it into the stream at
# all. Nothing in the pipeline noticed, because a truncated diff is still a
# non-empty string.
#
# So the collected patch is framed: a declared byte count before it and a sentinel
# after it. If the sentinel is missing the transfer was cut, and if the byte counts
# disagree something in between altered it. Either way the answer is a reported
# failure, never a patch.
PATCH_HEADER = "PRISM-PATCH-BYTES"
PATCH_SENTINEL = "PRISM-PATCH-END"

# A diff this large is not a fix. The agent is asked to resolve one issue, and the
# largest legitimate patch any fixture has produced is under 2 KB. Refusing early
# gives a comprehensible reason instead of a mid-line truncation for whoever has to
# work out why `git apply` rejected a megabyte of something.
MAX_PATCH_BYTES = 1_000_000


@dataclass
class CollectedPatch:
    """A patch taken from the harness, with evidence that it arrived intact."""

    patch: str = ""
    declared_bytes: int = -1
    received_bytes: int = 0
    reason: str = ""
    step: StepResult | None = None

    @property
    def ok(self) -> bool:
        return not self.reason

    @property
    def empty(self) -> bool:
        return not self.patch.strip()

    @property
    def added_files(self) -> list[str]:
        """Paths the patch creates rather than edits.

        Surfaced because a prompt rule against leaving scratch files behind is
        advisory, and one run's patch carried `sample-app/test_fix.js` -- a 51-line
        throwaway the agent used to check its own work. Naming added files is a
        deterministic signal a reviewer can act on; guessing at scratch filenames
        would mean excluding `test_*` patterns that are a legitimate convention in
        other languages.
        """
        added: list[str] = []
        lines = self.patch.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("new file mode"):
                for previous in reversed(lines[:i]):
                    if previous.startswith("diff --git a/"):
                        added.append(previous.split(" b/", 1)[-1])
                        break
        return added


def collect_patch_command(request: FixRequest) -> tuple[str, str, int]:
    """The command that extracts the agent's work as a patch.

    Diffed against the commit the clone started at, not against HEAD. The agent is
    told to commit its fix, and `git diff HEAD` measures only what is *un*committed
    -- so once it commits, the change vanishes from the diff. A run that produced a
    correct six-line fix returned instead a single new file: the `git format-patch`
    output the agent had generated beside it. Diffing from the base covers committed
    and uncommitted work alike.

    Run from the clone root, because `git diff` emits repository-root-relative
    paths whatever directory it runs in -- the convention FixResponse documents,
    and the one an earlier version of the eval client got wrong by applying at the
    subdirectory.

    Untracked files are included via `git add -N`, because an agent that creates a
    new file would otherwise have that work silently dropped. Generated
    directories and patch artifacts are excluded by pathspec, since including them
    turns a one-line fix into a megabyte of build output and -- worse -- makes an
    agent that only ran a build look like an agent that fixed something.

    The diff goes to a file first so its true size can be declared before any of it
    is streamed. Measuring it after the fact would measure whatever survived the
    stream, which is exactly the quantity in question.
    """
    excludes = _exclude_pathspecs()
    diff_file = "/tmp/prism-collected.diff"
    # Falls back to HEAD if the base file is missing, so a session prepared by an
    # older path still collects something rather than erroring on an empty revision.
    base = f'"$(cat {BASE_SHA_FILE} 2>/dev/null || echo HEAD)"'
    return (
        "collect",
        f"cd {WORKSPACE} && git add -N . {excludes} >/dev/null 2>&1; "
        f"git diff {base} -- . {excludes} > {diff_file} 2>/dev/null; "
        f"printf '{PATCH_HEADER} %s\\n' \"$(wc -c < {diff_file} | tr -d ' ')\"; "
        f"cat {diff_file}; "
        f"printf '{PATCH_SENTINEL}\\n'",
        COLLECT_TIMEOUT,
    )


def parse_collected_patch(step: StepResult) -> CollectedPatch:
    """Unwrap the framed patch, refusing anything that did not arrive whole."""
    if not step.ok:
        return CollectedPatch(
            reason=f"could not read the working tree (exit {step.exit_code})", step=step
        )

    text = step.stdout
    header, newline, rest = text.partition("\n")
    if not newline or not header.startswith(PATCH_HEADER):
        return CollectedPatch(
            reason=f"collected output did not begin with {PATCH_HEADER}; "
                   f"got {header[:80]!r}",
            step=step,
        )

    try:
        declared = int(header[len(PATCH_HEADER):].strip())
    except ValueError:
        return CollectedPatch(
            reason=f"{PATCH_HEADER} was not a number: {header[:80]!r}", step=step
        )

    if declared > MAX_PATCH_BYTES:
        return CollectedPatch(
            declared_bytes=declared,
            reason=f"the working tree holds a {declared:,}-byte diff, over the "
                   f"{MAX_PATCH_BYTES:,}-byte limit; a change this large is not a "
                   f"fix for one issue. Check whether generated output is being "
                   f"picked up, or whether the agent rewrote more than it was asked to",
            step=step,
        )

    if PATCH_SENTINEL not in rest:
        received = len(rest.encode())
        return CollectedPatch(
            declared_bytes=declared, received_bytes=received,
            reason=f"the patch was truncated in transit: {declared:,} bytes were "
                   f"produced but only {received:,} arrived, and the closing "
                   f"{PATCH_SENTINEL} marker is absent. A partial diff is not a "
                   f"patch, so this is reported as a failure rather than applied",
            step=step,
        )

    patch, _, _ = rest.rpartition(PATCH_SENTINEL)
    received = len(patch.encode())
    if received != declared:
        return CollectedPatch(
            patch=patch, declared_bytes=declared, received_bytes=received,
            reason=f"the patch changed size in transit: {declared:,} bytes were "
                   f"produced, {received:,} arrived",
            step=step,
        )

    return CollectedPatch(
        patch=patch, declared_bytes=declared, received_bytes=received, step=step
    )


def verify_command(request: FixRequest) -> tuple[str, str, int] | None:
    """Run the project's own test command against the agent's work.

    This is the independent check the ADR argued for and never got: `verified` was
    computed by looking for the words "tests pass" in the model's prose, and only on
    the branch where the model pasted a diff into its reply. Since the patch is taken
    from git instead, that branch stopped firing -- so `verified` was structurally
    False on every real run, including one whose reply said "All existing tests pass
    (50 tests)".

    Deterministic and free: InvokeAgentRuntimeCommand costs no model tokens, and an
    exit code is a fact rather than a claim.

    Returns None when the project declares no test command, in which case `verified`
    stays False and means "not checked" rather than "checked and failed".

    Run *after* the patch is collected, deliberately. A test run can emit coverage or
    build output, and collecting afterwards would fold those artifacts into the patch
    -- the failure mode that produced a 1.1 MB diff of `dist/index.js`.
    """
    command = request.verification.test_command.strip()
    if not command:
        return None
    work = shlex.quote(workdir_for(request))
    # Quoted as a single argument rather than interpolated. The command comes from
    # the repository's own config, which is more trusted than an issue body but is
    # still not something to splice into a shell unquoted.
    return (
        "verify",
        f"cd {work} && mise exec -- sh -c {shlex.quote(command)}",
        VERIFY_TIMEOUT,
    )


def verify_patch(client, harness_arn: str, session_id: str,
                 request: FixRequest) -> StepResult | None:
    """Execute the verification step, or None if the project declares none."""
    step = verify_command(request)
    if step is None:
        return None
    name, command, timeout = step
    return run_command(client, harness_arn, session_id, name, command, timeout)


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
                  request: FixRequest) -> CollectedPatch:
    """Extract the agent's changes as a unified diff, verified to have arrived whole."""
    name, command, timeout = collect_patch_command(request)
    step = run_command(client, harness_arn, session_id, name, command, timeout)
    return parse_collected_patch(step)
