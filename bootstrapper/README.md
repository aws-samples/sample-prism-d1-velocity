# Bootstrapper

Artifacts teams inherit on day one: CI workflows, eval harnesses, agent configs, spec templates, and steering files.

Two kinds of thing live here, and the difference matters:

| | Delivered by | Consume it by |
|---|---|---|
| **Bundled assets** — `metric-hooks/`, `eval-harness/`, `github-workflows/`, `gitlab-workflows/` | Shipped inside the `@prism-d1/cli` npm package | Running a `prism-cli bootstrapper install-*` command |
| **Copy-me artifacts** — `claude-code/`, `spec-templates/`, `aidlc-steering/`, `agent-configs/`, `security-agent/` | Not bundled — they exist only in a clone of this repo | Copying the file into your own repo by hand |

If a `prism-cli` command installs it, you never touch this directory. If it is a copy-me artifact, you need a clone.

## Directory map

| Path | Contents |
|---|---|
| `github-workflows/` | `prism-ai-metrics.yml` (per-merge DORA facts), `prism-eval-gate-kiro.yml`, `prism-eval-gate.yml`, `prism-agent-eval.yml` |
| `gitlab-workflows/` | GitLab CI equivalents plus a root `.gitlab-ci.yml` |
| `eval-harness/` | `eval-config.json`, five Bedrock rubrics, `run-eval.sh`, and `steering/code-review.md` |
| `metric-hooks/` | `prepare-commit-msg` hook and `config.json.template` |
| `claude-code/` | Four `CLAUDE.md` templates by team archetype |
| `spec-templates/` | Five Kiro-compatible spec templates |
| `aidlc-steering/` | AI-DLC workflow and security-baseline steering files |
| `agent-configs/` | AgentCore runtime, gateway, memory, and Bedrock Guardrails JSON templates |
| `security-agent/` | `setup.sh` for AWS Continuum onboarding |

Install commands and OIDC setup for the bundled assets are in the [User Guide](../USER_GUIDE.md). The rest of this file covers the copy-me artifacts.

---

## CLAUDE.md templates

Claude Code reads `CLAUDE.md` at your repository root and uses it as persistent context, so every generation request respects the rules it encodes. It is a contract between your team and your AI tooling.

| Template | Best for |
|---|---|
| `CLAUDE-backend-api.md` | REST/GraphQL APIs, microservices, serverless functions |
| `CLAUDE-frontend.md` | React/Vue/Angular apps, component libraries, design systems |
| `CLAUDE-platform.md` | CDK/Terraform repos, shared infrastructure, platform tooling |
| `CLAUDE-agent.md` | Agentic workflows — a section to paste into an existing `CLAUDE.md` rather than a standalone file |

### Setup

```bash
cp bootstrapper/claude-code/CLAUDE-backend-api.md ./CLAUDE.md
```

Then customize and commit it to your repo root.

**Edit these sections.** Code patterns should reflect your actual stack — if you write Go, replace the TypeScript idioms. Adjust test coverage targets to your team's standards. Frontend repos should point at your real design system and token files.

**Keep these sections.** The spec-first rule is core to the PRISM D1 workflow. Eval-gate references are required by the eval workflow.

**Combining templates.** For a repo spanning multiple concerns, start from your primary template and paste in relevant sections from the others — CDK patterns from `CLAUDE-platform.md`, accessibility requirements from `CLAUDE-frontend.md`, agent rules from `CLAUDE-agent.md`.

---

## Spec templates

Every feature starts with a spec. These templates are Kiro-compatible and share a common structure.

| Template | Use when |
|---|---|
| `api-endpoint.md` | Adding a new REST API endpoint |
| `data-model.md` | Creating or modifying a database entity |
| `integration.md` | Connecting to an external service |
| `agent-workflow.md` | Building an agentic workflow (PRISM Level 3+) |
| `mcp-server.md` | Building an MCP tool integration (PRISM Level 3+) |

### With Kiro

Create a new spec, paste the template as your starting point, fill in the bracketed placeholders, then use Kiro's spec-to-code workflow.

### Manually

```bash
mkdir -p specs
cp bootstrapper/spec-templates/api-endpoint.md specs/create-order-endpoint.md
```

Fill in every section, replacing the `_[italicized placeholder]_` notes with real content, then reference the spec from your commit:

```
git commit -m "Add create-order endpoint

Spec-Ref: specs/create-order-endpoint.md"
```

### Structure

| Section | Purpose |
|---|---|
| **Summary** | One-paragraph overview |
| **Requirements** | Numbered, testable requirements |
| **Acceptance Criteria** | Given/When/Then scenarios |
| **Design Constraints** | Architectural boundaries and rules |
| **Dependencies** | Internal, external, and data dependencies |
| **Metrics to Emit** | PRISM events this feature should generate |
| **Eval Criteria** | What the eval gate checks |

### Writing good specs

- **Requirements should be testable.** If you cannot write a test for it, rewrite the requirement.
- **Acceptance criteria should be specific.** Avoid "should handle errors gracefully" — specify what happens for each error type.
- **Include edge cases.** Given/When/Then makes it easy to enumerate: happy path, validation failures, auth failures, not found, concurrent access, timeouts.
- **Reference metrics.** Identify which PRISM events the feature emits; this feeds the delivery dashboards.
- **Reference eval rubrics.** Point at the rubric files in `.prism/eval-harness/rubrics/` so the eval gate knows what to check.

### How spec metrics reach a dashboard

Each template has a "Metrics to Emit" section. Those events flow through:

1. **`prism-ai-metrics.yml`** emits `prism.d1.pr` and `prism.d1.deploy` on every merge — PR cycle time, revert rate, and revert turnaround are derived from these at query time.
2. **The eval-gate workflows** emit `prism.d1.eval` and security findings.
3. **codeburn attribution** supplies AI-vs-human origin, tokens, and cost independently of CI. This is the source for every AI-specific metric.
4. **EventBridge** routes all of it to the metrics processor, which writes DynamoDB and CloudWatch for the dashboards.

The spec is the source of truth for what a feature should produce. During review, verify the implementation emits what the spec lists.

---

## AI-DLC steering files

Structured development workflow rules adapted from the [AWS AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) and extended with PRISM metric emission. They guide an AI coding agent through an inception → construction → quality gate workflow.

| File | Purpose |
|---|---|
| `development-workflow.md` | The three-phase workflow with PRISM metric emission points |
| `security-baseline.md` | Security rules enforced during generation — encryption, input validation, least privilege, logging |

### Setup

No `prism-cli` command installs these; copy them from a clone of this repo.

**Kiro IDE**

```bash
mkdir -p .kiro/steering
cp bootstrapper/aidlc-steering/development-workflow.md .kiro/steering/prism-aidlc.md
```

**Amazon Q Developer**

```bash
mkdir -p .amazonq/rules
cp bootstrapper/aidlc-steering/development-workflow.md .amazonq/rules/prism-aidlc.md
```

**Claude Code** — reference the file from your `CLAUDE.md` rather than copying it:

```markdown
See bootstrapper/aidlc-steering/development-workflow.md for the AI-DLC workflow.
```

### Relationship to AWS AI-DLC

This is a lightweight adaptation focused on PRISM metric emission at each workflow stage, spec-driven development using the templates above, eval gates as the quality-gate phase, and session continuity via `.prism/session-state.json`. For the full methodology see [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows).

---

## A note on commit trailers

Older revisions of these templates instructed you to add `AI-Origin:`, `AI-Model:`, and token/cost trailers to every commit, injected by the `metric-hooks/prepare-commit-msg` hook. **AI attribution no longer depends on trailers** — codeburn correlates commits to LLM API calls directly, which is both more accurate and hook-free. See [git hooks](../USER_GUIDE.md#git-hooks-deprecated) in the User Guide.

`Spec-Ref:` remains useful as a human-readable pointer from a commit to the spec that motivated it, which is why the example above keeps it.
