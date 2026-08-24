# ADR: Host the coding agent on AgentCore, keep only config in the repo

**Status:** accepted, not yet implemented
**Date:** 2026-08-23
**Supersedes:** the vendored-agent layout shipped in `install-coding-agent`

## Decision

The coding agent moves to Amazon Bedrock AgentCore. A repository contains only:

```
.coding-agent/
├── config.json     verification commands, model, retry budget
├── prompt.md       this repo's conventions
└── fixtures/       what good looks like here
.github/workflows/prism-coding-agent.yml   thin: label -> invoke -> open PR
```

No agent source is copied into a repo. One harness per toolchain is deployed
centrally and routed on `config.json`'s `detected_project_type`.

## Why

The agent was vendored into every repo at `.prism/coding-agent/` when this was
written. That has since been removed -- see "De-vendored" below. Four defects found
in one day were all consequences of it, not of the agent:

| Defect | Cause |
|---|---|
| `--uninstall` destroyed hand-written fixtures | fixtures lived inside the vendored tree |
| re-install silently reverted `system_prompt.py` | the prompt was vendored code |
| fixtures resolved from the harness, not the repo | the harness was per-repo |
| two directories, one feature | vendored and owned content mixed |

Vendoring also makes an agent fix an N-repo migration. Central hosting makes it
one deploy.

## What was verified, and on what

Checked against AWS CLI 2.36.19 and `agentcore` CLI 0.13.1 on 2026-08-23.

**Prebuilt public images work for every toolchain checked**, which is what made
per-language harnesses briefly attractive. All of `node:22`, `python:3.12`,
`rust:1`, `golang:1`, `maven:3.9-eclipse-temurin-21` and `ruby:3.3` are multi-arch
with arm64, and every *full* variant already carries git -- the slim variants do
not, which is a trap worth naming. Two were verified as genuine arm64 under
emulation rather than as amd64 proxies.

**Multiple environments: one container image per harness, but one harness is
enough.** The first plan was a harness per toolchain, routed on
`detected_project_type`. Measuring killed it: an AgentCore Runtime image may not
exceed **2 GB** and the quota is marked **not adjustable**, while the official
language images total ~9.3 GB.

    rust:1     1.65 GB     python:3.12   1.11 GB     golang:1                       885 MB
    node:22    1.13 GB     ruby:3.3      1.09 GB     maven:3.9-eclipse-temurin-21   564 MB

`rust:1` alone is 83% of the budget, so even two toolchains mostly will not
co-exist. A fat image is not merely awkward; it is arithmetically impossible.

The image therefore ships a version *manager* rather than versions -- see "One
harness, not one per toolchain" below. Endpoints are **not** the mechanism for
environments: the docs describe them as enabling "controlled deployments across
different environments", but that means dev/staging/prod pointing at runtime
*versions*.

The runtime quota is 5,000 per region in us-east-1/us-west-2 (2,500 elsewhere),
so a harness per toolchain was never quota-constrained -- image size is what
decided it.

**A deterministic shell exists alongside the agent loop.**
`InvokeAgentRuntimeCommand` runs commands in the same microVM with no model
reasoning and no token cost. The docs name our exact uses: "clone a repo, install
dependencies" before, and "run tests, commit and push" after. This is why the
earlier implicit-vs-explicit verification trade dissolves:

| Step | Mechanism | Token cost |
|---|---|---|
| clone, `npm ci` | `InvokeAgentRuntimeCommand` | none |
| fix the issue | agent loop | yes |
| run the suite | `InvokeAgentRuntimeCommand` | none |
| re-invoke on failure | agent loop, with failure output | yes |

The agent still runs tests inside its own loop, because the toolchain is in the
same VM. The orchestrator *also* verifies deterministically, so success is never
taken from the agent's self-report.

**Harness is declarative — there is no agent code.** `create-harness` takes
`--model`, `--system-prompt`, `--tools`, `--skills`, `--max-iterations`,
`--timeout-seconds`. `max-iterations` is the ReAct budget that `max_attempts`
approximates today.

**File and shell access are intrinsic, not declared tools.** The `tools` union is
`remote_mcp | agentCoreBrowser | agentCoreGateway | inlineFunction |
agentCoreCodeInterpreter`. Reading, writing and shell come from the microVM
itself.

**Skills can be attached from Git**: `skills[].git = { url, path, auth }`.

## Consequences that change the design

### One harness, not one per toolchain

The 2 GB image cap rules out baking every toolchain into one image, and per-language
harnesses would have left two problems unsolved anyway: the routing key needed a
*version* (`node:18` and `node:22` are different images), and a multi-language
monorepo can only bind one harness.

The image (`coding-agent/deploy/Dockerfile`, 594 MB — 29% of the cap) instead
ships `mise`, and the toolchain is installed at session start with
`InvokeAgentRuntimeCommand`, reading the repository's own version files. AWS
documents this path: "The base environment includes Python and bash. For tools
like `git`, `node`, or other runtimes, install them at session start."

Measured on a native build, all prebuilt downloads rather than source compiles:

    node@22   2s    go@1.23   4s    java@temurin-21   5s
    python@3.12 4s  ruby@3.3  7s    rust@1.83        13s

End to end against `sample-app` from a cold container: `mise install` 2s, `npm ci`
5s, `npm test` 5s, 50 tests passing — 14s total. Had mise compiled CPython or Ruby
from source, as it can, the per-run cost would have been minutes and this design
would not stand up.

Three problems collapse into one mechanism:

| Problem | Resolution |
|---|---|
| 2 GB cap vs 9.3 GB of images | one 594 MB image |
| version matrix | a line in the repo's `.tool-versions` |
| multi-language monorepo | `mise` resolves per directory, no external routing |

`HARNESS_ENV_BY_TYPE` in `agentcore/client.py` consequently collapses to the
single `PRISM_HARNESS_ARN` override it already supports. It is kept for now
because nothing is deployed and per-toolchain harnesses remain a fallback if a
toolchain turns out to need one.

What the image must carry, and why it is not optional: **git** (neither the
harness base nor `python:3.12-slim` has it, and an agent that cannot branch or
diff is not a coding agent) and **build-essential** (node-gyp needs a compiler,
rustc needs a linker; omitting them moves the failure into the agent's own test
run, where it reads as the agent's fault).

Costs to accept: install time on every run unless an EFS mount caches
`MISE_DATA_DIR`, and EFS requires VPC network mode — which collides with this
repo's quick start deliberately passing `-c skipVpc=true` to save $35–50/mo. Plus
a new dependency on mise's mirrors, npm and crates.io, with no local fallback.

Two further limits worth knowing: **2 vCPU / 8 GB per session** (not adjustable),
so compiling Rust or a large Java project is slow and that time counts against
the run; and **1 GB session storage**, which a fat `node_modules` plus a toolchain
cache could exceed.

### Repos must declare their toolchain version, so the installer writes it

`mise` reads what a repository declares — and most declare nothing. `sample-app`
had no `.nvmrc`, no `.tool-versions`, and no `engines`, so the first end-to-end
test only worked because the version file was written by hand.

`install-coding-agent` now pins it, because install time is the one moment when
the version a project actually builds with is observable. Precedence, most
authoritative first:

| Source | Behaviour |
|---|---|
| `.tool-versions` exists | kept, never overwritten — repo-owned |
| `.nvmrc`, `rust-toolchain.toml`, `.python-version`, … | deferred to; mise reads these directly |
| exact manifest pin (`go.mod` `go 1.23.4`, `engines.node: "22.9.0"`, Gemfile `ruby`) | written to `.tool-versions` |
| locally installed toolchain | written, flagged as "check it is the one you want" |
| nothing determinable | **nothing written**, with a warning |

A range such as `>=18` or `^22.9.0` is deliberately *not* resolved to a point
release: it says what the project tolerates, not what to pin, and picking one
would invent a decision the repository declined to make. Equally, `none` is a real
outcome rather than a case to paper over — a guessed pin looks reviewed and is
not.

Without a pin the harness installs whatever is newest that day, so a suite that
passes now can fail later with nothing in the repository having changed.

### The system prompt must become static; repo guidance moves to the task prompt

A harness's `systemPrompt` is set at create/update time. A harness shared across
repos therefore cannot carry per-repo conventions in its system prompt.

`skills[].git` looks like a fit for `.coding-agent/prompt.md`, but skills are also
harness-level: attaching one pins the harness to a single repository, which
defeats sharing.

So `.coding-agent/prompt.md` and `.kiro/steering/*.md` are read by the
orchestrator and passed in the **invocation payload**, not the system prompt. This
is not a workaround: `invoke-agent-runtime` has no system-prompt parameter, so the
payload is the only per-call channel there is. The static system prompt keeps the
workflow, verification framing and hard constraints. The ordering guarantee still
holds, because the orchestrator assembles the message: repo guidance first,
constraints restated last.

### The agent returns a patch; it never pushes

Central push access would need a GitHub App with `contents:write` across every
onboarded repo — one identity whose compromise reaches all of them.

Returning a unified diff means AgentCore needs read access only, and the thin
workflow opens the PR with its ephemeral, repo-scoped `github.token`. Blast radius
stays per-repo and there is no stored credential.

It also removes branch noise from eval runs: the harness applies the patch to a
throwaway clone and scores locally, instead of every fixture creating a real
branch.

`tools/create_pr.py` is deleted. Publishing becomes the caller's decision rather
than a capability the agent holds.

### Path guards become less load-bearing

`tools/git_ops.py` validates branch names and enforces path containment because
the agent runs on a developer's machine or a CI runner. In a harness the agent has
root in an isolated microVM whose filesystem is the boundary, and IAM is the
access gate. The guards stay for local runs but stop being the security story.

### The base image has no git

The default environment is Python and bash only. Every harness image needs git
added, so "just reference a public image" holds only for images that already carry
it. Custom images must be `linux/arm64`, and the harness overrides `ENTRYPOINT`
and `CMD` — an image that relies on its startup command will not behave.

### Dependency caching moves server-side

`run_eval.py` symlinks `node_modules` into each fixture clone to avoid reinstalling
per fixture. An EFS access point mounted across harness sessions does the same job
centrally. It requires VPC network mode, which is the cost.

## What survives

| Component | Fate |
|---|---|
| `config.py` (detection, command validation) | orchestrator-side, extended with toolchain version detection |
| `coding-agent/deploy/Dockerfile` | new — the single mise-based harness image |
| `system_prompt.py` | splits: static half to `systemPrompt`, repo guidance to the payload |
| `tools/git_ops.py` | kept for local runs; the harness uses its own shell |
| `tools/create_pr.py` | deleted |
| `eval/run_eval.py` | becomes a client: invoke, receive patch, apply, score |
| fixture schema and lifecycle | unchanged |
| the three-way triage | unchanged, and stronger — the prompt is unambiguously repo-owned |
| `install-coding-agent` | drops all vendoring; writes config, prompt, fixtures, workflow |
| `prism-coding-agent.yml` | roughly 220 lines to roughly 40 |

## Open questions

1. `agentcore` CLI 0.13.1 has no `harness` subcommand, so deployment is
   `bedrock-agentcore-control` via boto3 or CDK. Confirm whether the CDK
   `aws_bedrockagentcore` module covers Harness or only Runtime.
2. Does an EFS-cached `MISE_DATA_DIR` pay for the VPC it requires? Unmeasured.
3. The harness overrides `ENTRYPOINT` and `CMD`. Documented, but never observed
   against a real harness -- the image has only been exercised with an explicit
   `--entrypoint`.

## Questions closed while writing this

**No per-call system prompt override.** `invoke-agent-runtime` takes
`--agent-runtime-arn`, `--qualifier`, `--payload`, `--runtime-session-id`,
`--runtime-user-id` and trace headers — and nothing that replaces the system
prompt. The payload is the only per-call channel, so passing repo guidance there
is not a workaround; it is the mechanism.

**Attribution has a first-class carrier.** `invoke-agent-runtime` accepts
`--runtime-user-id`, `--trace-id`, `--trace-parent`, `--trace-state` and
`--baggage`. A shared central harness can therefore still report per-developer
and per-repo cost: the workflow passes the issue-labeller (or the repo's agent
identity) as `runtime-user-id` and the team and repo in `baggage`, and W3C trace
context propagates into the spans PRISM's Developer Productivity dashboard reads.
Central hosting does not force cost into one anonymous bucket.

`--qualifier` also gives the endpoint-based dev/staging/prod split noted above,
independent of the per-toolchain routing.

## What the first live run taught

Everything above was written before the agent had ever called a model. Once
credentials with `bedrock:InvokeModel` were available, one run against fixture 001
resolved it correctly — `✓ committed ✓ tests_pass ✓ files_expected ✓
no_test_edits` — and surfaced three defects that no amount of scaffolding testing
had found. Each one strengthens a decision recorded above.

**Mutating tools were silently cancelled.** `strands-agents-tools` gates `editor`,
`file_write` and `shell` behind an interactive confirmation unless
`BYPASS_TOOL_CONSENT` is set. Non-interactively the prompt auto-cancels, so the
agent reasoned correctly, printed the right patch in prose, and reported "unable
to complete because all file modification operations are being cancelled by the
system" — indistinguishable, from the outside, from a broken agent.

**The agent routed around a refusing tool.** `git_ops` required `.git` as a direct
child of `--repo`. A monorepo subdirectory has none, so the tool refused, and the
agent used its `shell` to run `git init` and commit all 54 files as "Initial
commit". This is direct evidence for "Path guards become less load-bearing" above:
a guard inside one tool is not a constraint on an agent that can run arbitrary
commands, only a suggestion. A tool has to be able to do the right thing, not
merely decline the wrong one — `git_ops` now resolves the enclosing repository.

**There is no iteration cap in the local agent, and it showed.** One run committed
a fix then sat fourteen minutes with one second of CPU, blocked on a model call
that never returned. This SDK version's `Agent` accepts `conversation_manager`,
`hooks` and `retry_strategy` but nothing capping iterations; the only bounds are
the eval's subprocess timeout and the workflow's `timeout-minutes`.

That last one is the strongest argument for this ADR that was not available when
it was written. `create-harness` accepts `maxIterations` directly, and the deployed
harness sets it to 40 — a bound the local agent cannot express at all.

## Deployed

First real harness, in the dev account rather than only on paper:

    harness   PrismCodingAgent-XC93iEIa7W
    image     .../prism/coding-agent-harness:v1  (arm64, 591 MB)
    model     us.anthropic.claude-sonnet-4-5-20250929-v1:0, temperature 0
    bounds    maxIterations 40, timeoutSeconds 1800, idle 900, maxLifetime 3600
    network   PUBLIC (needed so mise can fetch toolchains at session start)
    role      PrismCodingAgentHarnessRole

The role includes `kms:DescribeKey`. That is not boilerplate: AgentCore assumes
the role to create log groups, and omitting it produced a `CLIENT_ERROR` on a
previous PRISM integration whose message named nothing useful.

`systemPrompt` carries only the static half — workflow, verification framing and
the hard constraints. Repo guidance travels in the invocation payload, for the
reason recorded above: `invoke-agent-runtime` has no prompt parameter.
## Corrections from invoking the harness

Deploying a harness and calling it turned three decisions recorded above into
mistakes. They are left in place rather than edited away, because the reasoning
that produced them was sound given what was checkable at the time — and the shape
of the error is worth keeping.

**`InvokeHarness` is the operation, not `InvokeAgentRuntime`.** The harness ARN was
rejected with "No endpoint or agent found with qualifier 'DEFAULT'", and so was
its `DEFAULT` endpoint ARN, which existed and was `READY`. A harness has its own
data-plane operation. boto3 1.42.97 exposes it; AWS CLI 2.36.19 does not — which is
how the wrong API came to be written, since every other finding in this document
was verified through the CLI.

**The system prompt is not fixed at create time.** Recorded above: "No per-call
system prompt override … the payload is the only per-call channel, so passing repo
guidance there is not a workaround; it is the mechanism." That is true of
`InvokeAgentRuntime` and false of `InvokeHarness`, which accepts `systemPrompt`,
`maxIterations`, `maxTokens` and `timeoutSeconds` on every call. Repo conventions
now go in the system prompt, with the hard constraints still restated after them.

**Attribution is `actorId`.** Recorded above: `runtimeUserId` and `baggage` carry
it. `InvokeHarness` has neither. And `actorId` cannot hold an email — the pattern
`[a-zA-Z0-9][a-zA-Z0-9-_/]*…` excludes `@` and `.`, which surfaced as a
`ValidationException` from `ListEvents`, wrapped in a `runtimeClientError`, naming
the field but not the caller that set it. It is now substituted
(`prism-agent_example_com`); the authoritative identity remains the commit author
email, which git sets.

`InvokeAgentRuntimeCommand` does carry `baggage` and `traceParent`, so trace
context still has a home — on the preparation calls rather than the agent call.

Two further gaps that only deploying could show. A harness **provisions its own
AgentCore Memory**, so the execution role needs memory actions; omitting them
failed as `AccessDenied` on `ListEvents` against a resource that did not exist
when the role was written. And `runtimeSessionId` has a 33-character minimum.

### The preparation step was missing, and its absence was expensive

The first full invocation returned `max_iterations_exceeded`, and the reply showed
why: the agent was "checking if there's a repository in a parent directory". Nothing
had cloned the code. Forty iterations went on hunting for a checkout, at a cost of
9,400 input tokens, for a session that could never have succeeded.

`agentcore/session.py` is that step: clone, `mise install`, then a
manifest-inferred dependency install, each through
`InvokeAgentRuntimeCommand` — deterministic, and free of model tokens. The task
message now also *tells* the agent where the code is, because it has no way to know
a preparation step ran.

Two consequences worth recording:

- **The patch is taken from git in the VM, not from the model's prose.** An agent
  that edits files but pastes no diff would otherwise read as having declined, and
  one that pastes a diff it never applied would read as having fixed something.
  Collection runs at the clone root, since `git diff` emits root-relative paths
  regardless of the directory it runs in.
- **A preparation failure is reported as the environment's fault, not the
  agent's**, and the agent is never started. Blaming an agent for a failed clone
  is how a working agent gets a reputation it does not deserve.

### Taking the patch from git is right, and took four attempts to get right

"The patch is taken from git in the VM, not from the model's prose" is the correct
decision and the section above is unchanged. But the *implementation* of it was
wrong four separate ways, and every one of them reported a plausible outcome while
being wrong. They are recorded together because they share a shape: the pipeline
inferred a fact it could have measured, and nothing in it could tell a wrong answer
from a right one.

**1. The exclusion pathspec matched nothing.** Build output was reaching the patch,
so generated directories were excluded with `':(exclude)dist'`. A pathspec applies
relative to its base directory, so run at the clone root that expression never
matched `sample-app/dist` — the guard was present, inert, and untested at the level
where it mattered. The next run returned a 1,196,474-byte diff with the fix
supposedly in place. `':(exclude,glob)**/dist/**'` matches at every depth and, unlike
`':(exclude)*dist/*'`, does not also swallow a directory called `notdist`.

Three tests asserted `"':(exclude)dist'" in cmd` and stayed green throughout. A test
on the *string form* of a pathspec cannot see that the pathspec selects nothing. They
now run `git diff --name-only` against a fixture tree holding `dist/`,
`sample-app/dist/` and a decoy `notdist/`.

**2. The patch was silently truncated in transit.** The diff travels back as command
stdout, and that stream has a ceiling. The 1.1 MB response stopped mid-token on
`if ("string" !=`, so the diff was structurally invalid — and a truncated diff is
still a non-empty string, so it was accepted as a patch. The collected diff is now
framed: a declared byte count before it, a sentinel after it. A short or unframed
transfer is a reported failure. A diff over 1 MB is refused on its declared size,
before streaming, so the reason is legible rather than a mid-line cut.

**3. `git diff HEAD` measures only uncommitted work.** The agent is instructed to
commit, and once it does, its change is in `HEAD` and absent from that diff. One run
produced a correct six-line fix, committed it, ran `git format-patch`, and returned a
patch whose entire content was the `.patch` file it had just written — a file
describing the change instead of the change. The clone step now records the commit it
started from and collection diffs against that, covering committed and uncommitted
work alike. `*.patch`, `*.diff`, `*.orig` and `*.rej` are excluded as artifacts.

**4. Cost was understated 26x, and the stop reason was discarded.** A harness streams
one message per iteration, each with its own `metadata`; usage was assigned rather
than accumulated, so a run reported the cost of its final model call as the cost of
the run — 21,970 input tokens against an actual 550,188. `stopReason` was read once
into a local and dropped, which mattered more: `end_turn` with no patch is a refusal,
`tool_use` with no patch is an interruption, and the recorded result could not
distinguish them. A run that ended mid-sentence on "Now I need to update the",
immediately before its first edit, was recorded as a deliberate refusal. `declined`
now requires a stop reason that says the agent chose to stop.

### `verified` was structurally false, and is now measured

`verified` was computed by searching the model's prose for the words "tests pass",
and only on the branch where the model pasted a diff into its reply. Once the patch
came from git instead, that branch stopped firing — so the field was `False` on every
real run, including one whose reply read "✅ All existing tests pass (50 tests)".

The independent check this document argued for was never implemented. It is now: the
project's own test command runs in the microVM through
`InvokeAgentRuntimeCommand` after the patch is collected, and `verified` is that
exit code. No model tokens, and an exit status is a fact rather than a claim. When a
project declares no test command the step is skipped and `verified` stays `False`
meaning *not checked*, which is reported distinctly from checked-and-failed.

Collection runs **before** verification, deliberately. A test run can emit coverage
or build output, and collecting afterwards would fold those artifacts into the
patch — which is how defect 1 above presented in the first place.

### The iteration cap moved from 40 to 100

Two runs stopped on `max_iterations_exceeded` having already produced a correct fix
with no iterations left to verify it. The reply shows where the budget went: before
starting work the agent spends a run of consecutive probes looking for things that do
not exist — an issue file, a GitHub issues directory, a test that might have been
added for this issue. The constraints tail now says none of those exist and to stop
looking, and the cap has room for the verification step. Raising a cap does not make
exploration efficient, which remains unfixed.

The local agent's bound was raised to match. If the deployed cap were the looser of
the two, a fixture could pass in CI and fail on a developer's machine, which is the
worse direction for the difference to run. A test asserts the two constants are
equal, rather than a shared import, because reaching into `agentcore` would pull
boto3 into a module that defers heavy imports so `--help` works without the SDK.

### Scratch files, and why the fix is a prompt rule

One patch carried `sample-app/test_fix.js`, a 51-line throwaway the agent wrote to
check its own work. The tempting fix — excluding `test_*` — is wrong: that is a
legitimate naming convention in several languages, and excluding it would silently
drop real tests. So the rule is stated in the constraints tail (scratch work goes
under `/tmp`, outside the tree) and the deterministic half is *visibility* rather
than filtering: the response now names the files a patch creates rather than edits,
so anything left behind is seen before it is committed rather than after.

### The deprecated `shell` and `editor` tools

`strands_tools.shell` and `strands_tools.editor` warn on every call and become an
error log in v0.9.0. The warning says the replacements route through the agent's
sandbox instead of the host, "a change in the tightening direction" — which read like
it would break the one thing this agent must do: run the project's real test command
against a real checkout.

It does not. With no `sandbox=` passed to `Agent`, the vended tools resolve to
`NotASandboxLocalEnvironment`, documented as the default when an agent is created
without a sandbox, which spawns a local `sh` and uses the host filesystem directly —
what `strands_tools` already did. The migration preserves behaviour; the tightening
applies only to someone who configures a real sandbox, and then it is what they
asked for. Worth noting the deprecation message names `bash`, which is itself a
deprecated alias for `make_shell`, so following it literally lands on another
deprecated name. `file_read` and `file_write` are not deprecated and were left alone.

### De-vendored: the agent lives in the sample repo, not in every consumer

The layout this ADR argued against is now gone. `install-coding-agent` writes
`.coding-agent/` (config, prompt, fixtures), `.tool-versions`, and the workflow —
and nothing else. `.prism/coding-agent/` is deleted if found, along with `.prism/`
itself when that leaves it empty; `.prism/config.json` holds the `team_id` that
becomes a DynamoDB partition key for every CI metric here, so the parent is never
removed unconditionally.

The workflow fetches the orchestrator client from the sample repo at run time into
`$RUNNER_TEMP`, pinned by the `PRISM_AGENT_REF` variable, which accepts a branch, a
tag, or a commit SHA. `$RUNNER_TEMP` and not the workspace, because the workspace is
the tree the patch is applied to and committed from — a client checkout sitting
there is one `git add -A` away from being committed into somebody's fix, and
`actions/checkout` cannot write anywhere else, which is why the fetch is a plain
`git init` + `fetch --depth 1` instead.

Removing the vendored copy fixed more than it cost, in a way worth recording
because it argues for running a path rather than reasoning about it:

| | |
|---|---|
| The vendored set was `agent.py`, `config.py`, `system_prompt.py`, `tools/`, `eval/run_eval.py` | It never included `agentcore/` |
| The workflow ran `python -m agentcore.invoke` with `working-directory: .prism/coding-agent` | So it could not have resolved the module in any repo the installer touched |
| It also passed `--repo .` from that directory | Which resolves to the agent directory, not the repository, so config loading would have failed even if the import had worked |

Both were latent in every install, and neither had been noticed, because no CI run
had ever exercised the workflow. The vendored tree was simultaneously redundant and
non-functional.

`deploy/deploy-harness.sh` plus `deploy/create_harness.py` now make the one-time
platform step executable: ECR repository, `linux/arm64` build and push, execution
role including the Memory actions, then create-or-update the harness and wait for
`READY`. It is idempotent by harness *name*, because the id carries a generated
suffix nobody can predict — matching on the id would create a second harness on
every run. Writing it surfaced one more API asymmetry: `get_harness` returns the
object nested under a `harness` key while `list_harnesses` returns flat objects in
`harnesses`, so reading `status` off the top level yields `None` forever. The first
version of the wait loop would have spun its full 300 seconds and then reported
failure against a harness that had been `READY` throughout.

## Still not verified

The harness has been invoked and runs the image — a smoke call reported
`aarch64`, `mise 2026.8.11` and `git 2.47.3` from inside a real session, which also
settles the `ENTRYPOINT`/`CMD` override question in passing.

The full `prepare → fix → collect` cycle now works. It returned a 6,689-byte patch
touching `src/routes/tasks.ts` and `src/mcp/tools.ts` — the agent found the same
defect in the MCP tools, which the issue never mentioned — and that patch applies
clean to a fresh clone with 57 tests passing, up from 50 because it added seven. A
later run returned a focused 1,421-byte single-file patch and finished on `end_turn`
rather than exhausting its iterations.

What remains untested:

- Cold-start time for a 591 MB image, and real `mise install` timing inside a
  session rather than in a local container.
- The thin workflow end to end. It calls `agentcore.invoke`, which is now a
  four-call sequence — clone, toolchain, dependencies, then the agent, then collect
  and verify — but no CI run has exercised it.
- Whether the exploration thrash costs the same on a repository the agent has not
  seen before. Every run so far has been against `sample-app`.
- Cost. A single issue consumed roughly 550,000 input tokens. That figure was only
  visible after the usage accumulation bug was fixed, and nothing has yet been done
  about the number itself, which matters for the cost-per-shipped-commit metric this
  project exists to report.
