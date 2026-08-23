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

**Multiple environments: yes, one container image per harness.** Deploy one
harness per toolchain and route on `detected_project_type`. The runtime quota is
5,000 per region in us-east-1/us-west-2 (2,500 elsewhere), so this is not
constrained. Prebuilt public images can be referenced directly rather than
maintained — the documented example is `public.ecr.aws/docker/library/node:slim`.

Endpoints are **not** the mechanism for this. The docs describe endpoints as
enabling "controlled deployments across different environments", but that means
dev/staging/prod pointing at runtime *versions*.

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
| `config.py` (detection, command validation) | orchestrator-side, unchanged |
| `system_prompt.py` | splits: static half to `systemPrompt`, repo guidance to the payload |
| `tools/git_ops.py` | kept for local runs; the harness uses its own shell |
| `tools/create_pr.py` | deleted |
| `eval/run_eval.py` | becomes a client: invoke, receive patch, apply, score |
| fixture schema and lifecycle | unchanged |
| the three-way triage | unchanged, and stronger — the prompt is unambiguously repo-owned |
| `install-coding-agent` | drops all vendoring; writes config, prompt, fixtures, workflow |
| `prism-coding-agent.yml` | roughly 220 lines to roughly 40 |

## Open questions

1. Do prebuilt public images exist and behave as harness environments for Rust,
   Java and Go the way `node:slim` is documented to? Only Node is confirmed.
2. `agentcore` CLI 0.13.1 has no `harness` subcommand, so deployment is
   `bedrock-agentcore-control` via boto3 or CDK. Confirm whether the CDK
   `aws_bedrockagentcore` module covers Harness or only Runtime.

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
