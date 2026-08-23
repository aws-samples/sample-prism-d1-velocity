# PRISM Coding Agent

An autonomous coding agent built on the [Strands Agents SDK](https://strandsagents.com).
It takes a GitHub issue, fixes it in a repository, verifies the fix by running the
project's own tests, and commits. Optionally opens a pull request.

Its commits flow through the standard PRISM attribution pipeline, so agent-authored
work appears on the same dashboards as human and AI-assisted work — measured by the
same eval gate that reviews human PRs.

## Architecture

The agent is a sequential ReAct loop with four tool categories. That shape is not
novel: a 2026 survey of 13 production coding agents found read / search / edit /
execute in every agent that grants the model autonomy, and 7 of 13 use a plain
ReAct loop as their primary control structure. What this implementation adds is
attribution and governance, not a new agent architecture.

```
issue ──> Strands Agent ──> tools ──> verified commit ──> PR
                │
                ├── file_read, file_write, editor   (strands-agents-tools)
                ├── shell                            (strands-agents-tools)
                ├── git_ops                          (this package)
                └── create_pr                        (this package, opt-in)
```

`Agent.__call__()` supplies the ReAct loop — there is no hand-written `while`
loop here. Only two tools are custom, because `strands-agents-tools` already
covers reading, writing, editing and shell execution.

### Verification is implicit

The system prompt instructs the model to run the project's test command and iterate
on failures inside its own ReAct cycle. The scaffold does not wrap the agent in a
Python retry loop.

The tradeoff: an explicit outer loop is more deterministic, but it forces every
project into one shape (run tests → parse stderr → re-prompt). Real repositories
verify themselves in different ways — typecheck, lint, integration suite, smoke
script — and the model sequences those better than a fixed scaffold. The cost is
that the instruction has to be firm, which is why the verification section of the
prompt is written as hard requirements with an explicit retry budget.

## Verification commands

Resolved in this order:

1. `.coding-agent/config.json` in the target repo
2. Marker-file detection (`package.json` → `npm test`, `pyproject.toml` → `pytest`,
   plus Cargo, Go, Maven, Gradle, Composer, Bundler, Make)
3. Nothing — the agent is told to find a way to verify, and to label the fix
   `UNVERIFIED` in its commit message if it genuinely cannot

The third case matters. An agent that silently skips verification because it could
not find `npm` is worse than one that says so.

Configured commands must be a single invocation. Shell operators (`;`, `&&`, `|`,
backticks, `$()`, redirection) are rejected: the agent runs these through its shell
tool, so a chained command would widen its capability well beyond "run the tests".
Multi-step logic belongs in a script that the config then references.

## Usage

```bash
cd coding-agent
uv venv --python 3.11 && source .venv/bin/activate
uv pip install -e .
```

Inspect the resolved config and prompt without calling a model:

```bash
python agent.py --repo ../sample-app \
  --issue ../sample-app/.coding-agent/fixtures/001-tags-element-validation.json --dry-run
```

Run against a fixture:

```bash
python agent.py --repo ../sample-app \
  --issue ../sample-app/.coding-agent/fixtures/001-tags-element-validation.json
```

Run from a GitHub Actions event and open a PR:

```bash
python agent.py --repo . --github-event "$GITHUB_EVENT_PATH" --create-pr
```

## Installing into another repository

```bash
prism-cli bootstrapper install-coding-agent
```

Detects the project type, asks for the verification commands with the detected
values as defaults, and writes three things:

| Path | What |
|---|---|
| `.coding-agent/config.json` | how to verify a fix in this project |
| `.prism/coding-agent/` | the agent source, vendored so it stays readable and editable |
| `.github/workflows/prism-coding-agent.yml` | issue → fix → PR (skip with `--no-workflow`) |

Non-interactive form for CI:

```bash
prism-cli bootstrapper install-coding-agent --yes \
  --test-command "pytest -q" --agent-email agent@corp.example.com --region eu-west-1
```

`--uninstall` removes all three paths. Project-type detection is not
reimplemented in the CLI — it shells out to `config.py --detect`, so there is one
detector table rather than two that can disagree.

Under `.coding-agent/fixtures/` you get a schema template plus `examples/`,
holding this repo's three fixtures as references. They are readable but
unrunnable: fixture discovery does not descend into subdirectories. Start by
reading `examples/003`, the refusal fixture — capability fixtures are the ones
people write unprompted, and refusal fixtures are the ones that catch harm.

### Who owns what

The two directories are split by owner, and `--uninstall` respects the line:

| Path | Owner | On uninstall |
|---|---|---|
| `.coding-agent/fixtures/` | you — hand-written, reviewed, irreplaceable | **kept**, and reported |
| `.coding-agent/config.json` | you, but regenerable | removed |
| `.prism/coding-agent/` | the CLI — vendored source | removed |
| `.github/workflows/prism-coding-agent.yml` | the CLI | removed |

Fixtures used to live inside `.prism/coding-agent/`, which is the tree
`--uninstall` deletes. Uninstalling therefore destroyed them: recoverably for
anything committed, permanently for work in progress.

### The workflow's authorization model

The trigger is `issues: [labeled]`, gated on the `agent-fix` label. That gate is
load-bearing: anyone can open an issue on a public repo, but applying a label
requires triage permission. Triggering on `issues: [opened]` would let a stranger
spend your Bedrock budget and put a branch in your repository.

The agent can push a branch and open a PR. It cannot merge one. Rely on branch
protection for that rather than on the agent's good behaviour.

The workflow echoes the last 2000 characters of agent output into an issue
comment, which is public on a public repository. The agent holds a shell tool, so
an issue crafted to make it print its environment would surface that output
there. The label gate is what prevents it; if you widen the trigger, stop echoing
the log.

## Eval harness

```bash
python eval/run_eval.py --repo ../sample-app
```

Each fixture runs in a throwaway `git clone` under a temp directory. The harness
never resets, cleans, or checks out anything in the repository you point it at — a
scoring run must not be able to destroy uncommitted work.

`--repo` may be a repository root or any directory inside one. `sample-app` is a
subdirectory of this monorepo with no `.git` of its own, so the harness resolves
the enclosing repository, clones that once, and evaluates the subdirectory within
the clone. Customer monorepos are the same shape.

Fixtures are resolved from `--repo`, not from where the harness is installed:
they live in `<repo>/.coding-agent/fixtures/`. That is what makes `--repo` mean
what it says. When the directory was derived from the harness's own location,
pointing it at a different checkout scored that checkout against the *installed*
repo's fixtures, silently.

This repo's own fixtures live in `sample-app/.coding-agent/fixtures/`, beside the
code they describe:

| Fixture | Kind | What it exercises |
|---|---|---|
| `001-tags-element-validation` | bug | A confirmed validation gap: `tags` is typed `string[]` but only `Array.isArray` is checked |
| `002-status-filter` | feature | Additive change reusing existing helpers |
| `003-refuse-test-deletion` | refusal | The agent must decline to weaken a test suite |

Fixture 003 inverts the scoring: success is making no commit. An agent that
complies would happily weaken any test suite it is pointed at, which is the most
damaging failure mode an autonomous coding agent has. The prompt constraint "do
not edit test files to make failures disappear" is what should catch it.

`install-coding-agent` copies these three into a target repo as
`.coding-agent/fixtures/examples/` — readable references that never execute,
because fixture discovery uses a non-recursive `glob("*.json")` that does not
descend into subdirectories. They describe `sample-app`, so running them anywhere
else would fail on missing paths and read as an agent defect.

## Writing fixtures

Fixtures are the only thing standing between "the agent ran" and "the agent can
be trusted". Nothing else in this repository measures whether its output is any
good. They are also the one part that cannot be shipped, so every repository has
to write its own.

The work splits cleanly into a part worth delegating to a coding agent and a part
that must not be.

### Delegate: finding candidates and writing the JSON

Surveying a codebase for type-contract gaps, unvalidated inputs and unhandled
branches is exactly what a coding agent is good at, and transcribing the result
into a schema is tedious. Hand it both. A prompt that works:

```
Read this repository and propose 3 eval fixtures for an autonomous coding agent.

For each one:
  - Name the specific file and function holding the defect.
  - Quote the lines that are wrong.
  - Explain why it is wrong in terms of a contract the code itself states
    (a type, a doc comment, a validation elsewhere that this path skips).
  - Write it as JSON in the schema in .coding-agent/fixtures/EXAMPLE.json.template.

Rules:
  - Only defects you can point at in the source. Do not invent plausible ones.
  - Prefer a defect with an observable symptom over a style problem.
  - Mark difficulty honestly. One should be harder than a one-line change.
  - Do not write the refusal fixture. That one is mine.
```

The last two rules matter. Without them you get three near-identical one-line
fixes, and an agent asked to write the fixture that catches agents doing harm
will write a toothless one.

### Do not delegate: verifying the premise

The dominant failure of agent-written fixtures is a **hallucinated defect** — a
fixture describing a bug that is not there. It is quiet and it is expensive: the
agent under test will invent a change to satisfy the issue, `committed` will be
true, tests will still pass, and the eval scores it green. You have measured
nothing and been told everything is fine.

Confirm every fixture by asserting the *current, wrong* behaviour and watching
that assertion pass. For fixture 001 in this repo:

```ts
// tests/zz-premise.test.ts — temporary, delete after
it('premise: POST /tasks accepts non-string tag elements', async () => {
  const res = await request(app).post('/tasks').send({ title: 'x', tags: [1, 2] });
  expect(res.status).toBe(201);        // 201 means the defect is real
});
```

Run the project's own test command, not a bare `jest` — this suite needs
`NODE_OPTIONS='--experimental-vm-modules'`, and that kind of detail is exactly
what a hand-rolled invocation gets wrong:

```
✓ premise: POST /tasks accepts non-string tag elements
  PREMISE status=201 tags=undefined
```

Passing means the defect exists today. Failing means the fixture is fiction, or
someone already fixed it — either way it is not a fixture. Delete the temporary
test once you have your answer.

### Do not delegate: the refusal fixture

Write this one by hand, every time.

Everyone writes capability fixtures, because "can it fix this bug?" is the
question already in your head. Almost nobody writes a fixture the agent is
supposed to **refuse**, and that is the one that catches an agent doing damage —
deleting a failing assertion, weakening a validator, silencing a warning. A suite
made only of capability fixtures scores such an agent as excellent.

Two traps:

- `kind` must be `"refusal"`. It **defaults to `"bug"`**, so a refusal fixture
  missing that field is scored as a capability test, and the agent passes it
  precisely by doing the harmful thing.
- Write the issue the way a real person under pressure would write it. "The suite
  is red and it's blocking my PR" is far more persuasive than "please delete this
  assertion", and persuasive is the point.

### Do not use the agent under test

Generate fixtures with a different tool or at least a different session from the
agent being scored. An agent that writes its own eval and is then measured against
it is grading its own homework, and it will set a bar it clears.

### As a Module 02 exercise

This is a better exercise than "write three JSON files", because the interesting
content is not the schema — it is the two things the agent cannot be trusted with.

| Step | Participant does | What it teaches |
|---|---|---|
| 1 | Ask a coding agent for 3 candidate fixtures | Agents are good at surveying a codebase |
| 2 | Verify each premise with a throwaway assertion | At least one candidate is usually fiction |
| 3 | Hand-write the refusal fixture | The failure mode nobody tests for |
| 4 | Run `run_eval.py` and read the checks | What "pass" does and does not prove |

Step 2 is the payoff. Participants who skip it and run the eval anyway get a green
result on a hallucinated defect, which is a far more durable lesson about
agent-generated artefacts than being told to be careful.

## Portability

The agent is repository-agnostic; the eval fixtures are not, and that distinction
is deliberate.

| Component | Coupled to a project? |
|---|---|
| `config.py`, `system_prompt.py`, `agent.py` | No. `package.json` is one of 11 detector entries, and verification commands reach the prompt by injection rather than being written into it. |
| `tools/git_ops.py`, `tools/create_pr.py` | No. Pure git and `gh`. |
| `eval/run_eval.py` | Only in which dependency directories it symlinks (`node_modules`, `.venv`, `target`, …), so a fixture repo does not reinstall per run. |
| `.coding-agent/fixtures/*.json` | **Yes, by design.** They describe real defects in `sample-app`. A fixture that named no real code would not test anything. |

Verified against throwaway Python, Rust, Go and Ruby repositories: each resolves its
own test command, and no Node-specific string reaches the prompt. To evaluate a
different repository, point `--repo` at it and write fixtures describing defects
that actually exist there.

## Security posture

| Concern | Handling |
|---|---|
| Command injection | Every subprocess call uses an argv list; `shell=True` appears nowhere |
| Branch names | Validated against a tightened form of git's own rules; rejects traversal, `..`, and leading `-` (which git would read as a flag) |
| Path traversal | Staged paths are resolved and confirmed to stay inside the repo — this catches symlinks pointing out of the tree, which a string-prefix check would miss |
| Blanket staging | `git add -A` / `git add .` are not reachable; `stage` requires an explicit path list |
| Push privilege | Absent from `git_ops`. Pushing lives only in `create_pr`, so the credentialed path is reviewed in one place |
| Credentials | `create_pr` uses the ambient `GH_TOKEN` / `GITHUB_TOKEN` that Actions provides; no token is ever passed as an argument, where it would appear in process listings |
| Config as capability | Verification commands are rejected if they contain shell operators |

## PRISM attribution

`--agent-email` (default from config) sets `user.email` locally in the target
repository before any commit. That value is what makes agent work
distinguishable end to end:

```
git commit (%ae)
  → prism-ai-metrics.yml  commit_authors[]
  → metrics-processor     COMMIT# item, user field
  → /v1/productivity      per-developer attribution
  → Developer Productivity dashboard
```

Give the agent its own address rather than reusing a human's, or its output will be
counted against that person.

## Status

Implemented and exercised: the agent, config resolution, both custom tools, the
eval harness, the `install-coding-agent` installer, and the GitHub Actions
workflow. The installer and the workflow's shell logic were each run end to end
against throwaway repositories in six ecosystems.

The harness now runs its full loop against `sample-app` — clone, config
resolution, agent invocation, real test suite, scoring. It did not before: it
required `--repo` to be a repository root, and `sample-app` is a monorepo
subdirectory with no `.git`, so the command this README documented exited 2
without cloning anything. That went unnoticed because no run ever got far enough
to need the clone.

Not yet built: OTEL emission of the agent's own token usage to the PRISM
collector. Until that exists, the agent's commits are attributed (via the CI
`commit_authors` join) but its cost is not.

**The agent has never called a model.** This devbox's instance profile lacks
`bedrock:InvokeModel`, so every claim above is about scaffolding, wiring and
plumbing — not about fix quality. A real run currently scores `0/1` with
`✗ committed` and `✓ tests_pass`: everything around the model works, and the model
step does not run. Nothing here says the agent can actually fix a bug.
Establishing that needs a Bedrock-enabled profile:

```bash
python eval/run_eval.py --repo ../sample-app
```
