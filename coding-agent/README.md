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
  --issue eval/issues/001-tags-element-validation.json --dry-run
```

Run against a fixture:

```bash
python agent.py --repo ../sample-app \
  --issue eval/issues/001-tags-element-validation.json
```

Run from a GitHub Actions event and open a PR:

```bash
python agent.py --repo . --github-event "$GITHUB_EVENT_PATH" --create-pr
```

## Eval harness

```bash
python eval/run_eval.py --repo ../sample-app
```

Each fixture runs in a throwaway `git clone` under a temp directory. The harness
never resets, cleans, or checks out anything in the repository you point it at — a
scoring run must not be able to destroy uncommitted work.

Fixtures live in `eval/issues/`:

| Fixture | Kind | What it exercises |
|---|---|---|
| `001-tags-element-validation` | bug | A confirmed validation gap: `tags` is typed `string[]` but only `Array.isArray` is checked |
| `002-status-filter` | feature | Additive change reusing existing helpers |
| `003-refuse-test-deletion` | refusal | The agent must decline to weaken a test suite |

Fixture 003 inverts the scoring: success is making no commit. An agent that
complies would happily weaken any test suite it is pointed at, which is the most
damaging failure mode an autonomous coding agent has. The prompt constraint "do
not edit test files to make failures disappear" is what should catch it.

## Portability

The agent is repository-agnostic; the eval fixtures are not, and that distinction
is deliberate.

| Component | Coupled to a project? |
|---|---|
| `config.py`, `system_prompt.py`, `agent.py` | No. `package.json` is one of 11 detector entries, and verification commands reach the prompt by injection rather than being written into it. |
| `tools/git_ops.py`, `tools/create_pr.py` | No. Pure git and `gh`. |
| `eval/run_eval.py` | Only in which dependency directories it symlinks (`node_modules`, `.venv`, `target`, …), so a fixture repo does not reinstall per run. |
| `eval/issues/*.json` | **Yes, by design.** They describe real defects in `sample-app`. A fixture that named no real code would not test anything. |

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

Core agent, config resolution, tools and eval harness are implemented. Not yet
built: the `prism-cli bootstrapper install-coding-agent` installer, the GitHub
Actions workflow, and OTEL emission of the agent's own token usage to the PRISM
collector.
