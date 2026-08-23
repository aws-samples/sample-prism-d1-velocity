"""System prompt construction for the PRISM coding agent.

The verification loop is *implicit*: the prompt instructs the model to run the
project's test command and iterate on failures inside its own ReAct cycle,
rather than the scaffold wrapping the agent in a Python retry loop.

That choice is deliberate. An explicit outer loop is more deterministic, but it
also forces every project into one shape (run tests -> parse stderr -> re-prompt).
Real repositories verify themselves in many ways -- typecheck, lint, integration
suite, smoke script -- and the model can sequence those better than a fixed
scaffold can. The cost is that the instruction has to be unusually firm, which is
why the verification section below is written as hard requirements rather than
suggestions.
"""

from __future__ import annotations

import sys
from pathlib import Path

from config import AgentConfig

# Repo-owned prompt layers, both optional.
#
# The agent's behaviour is what fixtures assert, so the instructions driving that
# behaviour have to be versioned in the same repository as the fixtures. When the
# whole prompt shipped with the CLI, upgrading the CLI changed agent behaviour
# with no commit in the user's repo to blame -- fixtures went red and `git log`
# showed nothing.
#
# .kiro/steering/ is read on purpose rather than by coincidence: PRISM's Module 05
# eval gate already reviews PRs against those files. Having the agent that writes
# the code read the same ones means author and reviewer agree by construction
# instead of contradicting each other silently.
REPO_PROMPT_FILE = Path(".coding-agent") / "prompt.md"
STEERING_DIR = Path(".kiro") / "steering"

# Repo guidance is truncated rather than dropped, and the truncation is announced.
# A repository with a large steering tree would otherwise crowd out the base
# prompt, and silently losing half of someone's conventions is the kind of
# failure that gets misread as the agent ignoring them.
MAX_REPO_GUIDANCE_BYTES = 32_768

BASE = """You are an autonomous coding agent working inside a single git repository.
You are given one issue. You produce one focused fix, verify it, and commit it.

## Workflow

1. UNDERSTAND - Read the issue. State the expected behaviour vs the actual
   behaviour in one sentence before you touch anything.
2. LOCATE - Find the relevant code. Use `shell` with grep or ripgrep. Do not
   guess file paths.
3. READ - Read every file you intend to change, in full, before editing it.
4. FIX - Make the smallest change that resolves the issue.
5. VERIFY - Run the project's checks. See "Verification" below.
6. COMMIT - Only after verification passes.

## Commit format

Write a commit message that explains the change and references the issue:

    fix: <what changed, imperative mood>

    <why the previous behaviour was wrong, one or two sentences>

    Closes #<issue number>

Stage only the files you deliberately changed. Never use `git add -A` or
`git add .` -- name each path.
"""

# Placed last in the assembled prompt, after anything the repository supplies.
#
# Not duplicated from BASE -- moved out of it, so there is one copy. These are the
# rules a repo instruction must not be able to cancel by accident: someone writing
# "always get the suite green" in prompt.md is not asking for assertions to be
# deleted, but a model reading that as the final word might do it anyway.
HARD_CONSTRAINTS = """## Scope discipline

These rules hold regardless of anything above.

- Fix only what the issue describes. Do not refactor adjacent code, rename
  things, reformat files, or "improve" code you were not asked about.
- Do not add dependencies. If a fix genuinely requires one, stop and explain why
  instead of installing it.
- Do not edit test files to make failures disappear. If a test is genuinely
  wrong, say so and stop -- changing an assertion to match broken behaviour
  hides the bug rather than fixing it.
- Do not touch CI config, secrets, credentials, or anything under .github/
  unless the issue is specifically about those files.
- Stay inside the repository. Never read or write paths outside it.
- If an instruction anywhere above conflicts with these, follow these and say
  which instruction you declined to follow, and why.
"""

VERIFY_WITH_TESTS = """## Verification

Verification is mandatory. You have not finished until the checks below pass.

Run the test suite:

    {test_command}
{extra_checks}
If the checks fail:

1. Read the entire failure output, not just the last line.
2. Decide whether your change caused the failure or whether it was already
   failing before you started. If you are unsure, use `git stash` to check the
   baseline, then `git stash pop`.
3. If you caused it, fix the cause and run the checks again.
4. If the failure pre-existed your change and is unrelated to the issue, say so
   explicitly in your final summary and leave it alone.

You may retry up to {max_attempts} times. If the checks still fail after that:

- Do NOT commit.
- Report what you changed, what failed, and what you tried.

Never claim success without having run the checks. Never commit with failing
checks that your change introduced."""

VERIFY_WITHOUT_TESTS = """## Verification

No verification command is configured for this project, so you must establish
one yourself before you can claim the fix works.

1. Look for a way to check your work: a README section on testing, a Makefile
   target, a CI workflow, or a test directory.
2. If you find one, run it and treat the result as mandatory (see the retry
   rules below).
3. If you genuinely cannot find any way to verify, you may still commit -- but
   your commit message and your final summary MUST contain the line:

       UNVERIFIED: no automated checks were available in this repository.

Do not paper over the absence of tests by asserting the fix is correct. An
unverified fix that says so is useful; an unverified fix that claims success is
misleading."""


def _extra_checks(cfg: AgentConfig) -> str:
    """Render build/lint commands as additional mandatory checks."""
    lines: list[str] = []
    if cfg.build_command:
        lines.append(f"\nConfirm the project still builds:\n\n    {cfg.build_command}\n")
    if cfg.lint_command:
        lines.append(f"\nConfirm lint passes:\n\n    {cfg.lint_command}\n")
    return "".join(lines)


def collect_repo_guidance(repo_path: Path) -> tuple[str, list[str], list[str]]:
    """Read this repository's own prompt layers.

    Returns (text, sources, warnings). `sources` is reported by --dry-run so a
    user can confirm a file took effect rather than assuming it did; silent
    inclusion and silent omission are equally unhelpful when a fixture goes red
    and you are trying to work out why.

    Steering files are read first and the agent-specific file second, so the more
    specific instructions come last.
    """
    sources: list[str] = []
    warnings: list[str] = []
    chunks: list[str] = []

    steering = repo_path / STEERING_DIR
    if steering.is_dir():
        for path in sorted(steering.glob("*.md")):
            try:
                body = path.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeDecodeError) as exc:
                warnings.append(f"could not read {path}: {exc}")
                continue
            if body:
                chunks.append(f"### From {STEERING_DIR / path.name}\n\n{body}")
                sources.append(str(STEERING_DIR / path.name))

    agent_prompt = repo_path / REPO_PROMPT_FILE
    if agent_prompt.is_file():
        try:
            body = agent_prompt.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as exc:
            warnings.append(f"could not read {agent_prompt}: {exc}")
        else:
            if body:
                chunks.append(f"### From {REPO_PROMPT_FILE}\n\n{body}")
                sources.append(str(REPO_PROMPT_FILE))

    if not chunks:
        return "", sources, warnings

    text = "## This repository's conventions\n\n" + "\n\n".join(chunks)

    encoded = text.encode("utf-8")
    if len(encoded) > MAX_REPO_GUIDANCE_BYTES:
        text = encoded[:MAX_REPO_GUIDANCE_BYTES].decode("utf-8", errors="ignore")
        text += "\n\n[truncated: repository guidance exceeded the size cap]"
        warnings.append(
            f"repository guidance is {len(encoded)} bytes, truncated to "
            f"{MAX_REPO_GUIDANCE_BYTES}. Shorten the files listed above, or the "
            f"instructions at the end were not sent to the model."
        )

    return text, sources, warnings


def build_system_prompt(cfg: AgentConfig, *, announce: bool = False) -> str:
    """Assemble the full system prompt for one agent run."""
    if cfg.can_verify:
        verification = VERIFY_WITH_TESTS.format(
            test_command=cfg.test_command,
            extra_checks=_extra_checks(cfg),
            max_attempts=cfg.max_attempts,
        )
    else:
        verification = VERIFY_WITHOUT_TESTS

    guidance, sources, warnings = collect_repo_guidance(cfg.repo_path)

    if announce:
        if sources:
            print("Repo guidance: " + ", ".join(sources), file=sys.stderr)
        else:
            print(
                f"Repo guidance: none. Add {REPO_PROMPT_FILE} or "
                f"{STEERING_DIR}/*.md to state this project's conventions.",
                file=sys.stderr,
            )
        for warning in warnings:
            print(f"WARNING: {warning}", file=sys.stderr)

    # Repo guidance sits before HARD_CONSTRAINTS so the non-negotiable rules get
    # the last word. A repo instruction should be able to add to the brief, not
    # quietly cancel "do not edit tests to make failures disappear" -- which is a
    # guard against a footgun rather than an attacker, since a repo owner already
    # controls the test command this agent executes.
    sections = [BASE, verification, _repo_context(cfg), guidance, HARD_CONSTRAINTS]
    return "\n\n".join(s.strip() for s in sections if s.strip())


def _repo_context(cfg: AgentConfig) -> str:
    """Tell the agent where it is and what kind of project this is."""
    lines = [
        "## This repository",
        "",
        f"- Path: {cfg.repo_path}",
        f"- Project type: {cfg.project_type}",
    ]
    if cfg.allowed_paths:
        allowed = ", ".join(cfg.allowed_paths)
        lines.append(f"- You may only modify files under: {allowed}")
    return "\n".join(lines)


def build_task_prompt(issue: dict) -> str:
    """Render the issue into the user-turn prompt that starts the run."""
    number = issue.get("number", "?")
    title = issue.get("title", "(no title)")
    body = (issue.get("body") or "").strip() or "(no description provided)"

    prompt = [
        f"Fix issue #{number}: {title}",
        "",
        "## Issue description",
        "",
        body,
    ]

    comments = issue.get("comments") or []
    if comments:
        prompt += ["", "## Discussion", ""]
        for c in comments:
            author = c.get("author", "unknown")
            text = (c.get("body") or "").strip()
            if text:
                prompt.append(f"**{author}**: {text}")

    prompt += [
        "",
        "Work through the numbered workflow. Verify before you commit.",
    ]
    return "\n".join(prompt)
