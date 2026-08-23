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

The agent is currently vendored into every repo at `.prism/coding-agent/`. Four
defects found in one day were all consequences of that, not of the agent:

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

## Not verified

Nothing in this document has been deployed. This devbox's instance profile is
denied both `bedrock:InvokeModel` and `bedrock-agentcore:ListAgentRuntimes`, so
every claim here comes from the service API shape and documentation, not from a
running harness.
