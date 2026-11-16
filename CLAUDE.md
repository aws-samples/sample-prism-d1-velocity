# PRISM D1: Velocity — AI Development Lifecycle Workshop

## Project Overview

This is the **D1 Velocity pillar** of the PRISM (Progressive Readiness Index for Scalable Maturity) framework.
It provides a workshop-style GitHub repo with bootstrapper code for AI-native software development lifecycle (AI-DLC).

**Primary tool**: Claude Code (backed by Amazon Bedrock)
**IDE companion**: Kiro (for spec-driven development)
**Target**: Startup engineering teams (20-200 engineers, Series A-D)

## Architecture Principles

- **Claude Code is the primary driver** — all AI-assisted development flows through Claude Code pointing to Bedrock
- **Metadata-first** — every AI-assisted action emits structured events to the metrics pipeline
- **AWS-native only** — no third-party observability dependencies (CloudWatch, DynamoDB, EventBridge)
- **Spec-driven development** — all features start with a Kiro-compatible spec before implementation
- **Enhanced DORA metrics** — traditional DORA + AI-native dimensions (AI-to-merge ratio, post-merge defect rate, eval gate pass rate), each reported against an attribution coverage denominator

## Repository Structure

```
infra/              — AWS CDK stacks (metrics pipeline with the CloudWatch dashboards, API, Security Agent)
cli/                — prism-cli (@prism-d1/cli on npm): codewatch, the local dashboard, MCP server, security and AWS commands
bootstrapper/       — What teams inherit post-workshop (templates, hooks, workflows)
  agent-configs/    — AgentCore Runtime, Memory, Gateway templates
coding-agent/       — Autonomous coding agent (AgentCore harness, issue -> PR workflow)
editor-extension/   — PRISM extension for VS Code, Kiro IDE and Cursor
kirocrew-app/       — PRISM app for Kiro Crew
claude-plugin/      — PRISM plugin for Claude Code (this repo is its marketplace)
assessment/         — Assessment guide and customer onboarding
sample-app/         — Hands-on workshop target application
  agent/            — Strands-based task assistant agent (Python)
  src/mcp/          — MCP server exposing task API as tools (TypeScript)
docs/               — Leader guide, data architecture, CLI reference, design notes
```

## Development Workflow

### When implementing features in this repo:

1. **Always start with a spec** — Write or reference a spec in `specs/` before coding
2. **Emit metadata** — Any new component must emit structured events via the metrics schema
3. **AI origin is automatic** — codeburn attribution records it; commit trailers are retired, so do not add `AI-Origin` trailers by hand
4. **Run eval gates** — the CI eval gate (kiro-cli review, gitleaks, Security Agent) must pass before merging to main

### Spec-Driven Development Flow:

```
1. Write spec (Kiro format) → specs/<feature-name>.md
2. Claude Code implements against spec
3. AI metrics collected by codeburn attribution (no git hook)
4. CI emits enhanced DORA event to EventBridge
5. Eval gate (kiro-cli review, gitleaks, Security Agent) validates the PR
6. Dashboard updates automatically
```

## Metrics Schema

All events follow this structure:

```json
{
  "source": "prism.d1.velocity",
  "detail-type": "<metric-type>",
  "detail": {
    "team_id": "string",
    "repo": "string",
    "timestamp": "ISO8601",
    "prism_level": "1-5",
    "metric": {
      "name": "string",
      "value": "number",
      "unit": "string"
    },
    "ai_context": {
      "tool": "claude-code|kiro|q-developer",
      "model": "string",
      "session_id": "string",
      "origin": "ai-assisted|ai-generated|human"
    },
    "dora": {
      "deployment_frequency": "number|null",
      "lead_time_seconds": "number|null",
      "change_failure_rate": "number|null",
      "mttr_seconds": "number|null"
    },
    "ai_dora": {
      "ai_acceptance_rate": "number|null",
      "ai_to_merge_ratio": "number|null",
      "spec_to_code_hours": "number|null",
      "post_merge_defect_rate": "number|null",
      "eval_gate_pass_rate": "number|null",
      "ai_test_coverage_delta": "number|null"
    }
  }
}
```

## AWS Services Used

| Service | Purpose |
|---------|---------|
| Amazon Bedrock | LLM inference (Claude via Bedrock), Evaluations, Guardrails |
| EventBridge | Metric event bus |
| Lambda | Event processing, enrichment, normalization |
| DynamoDB | Raw event storage (`prism-d1-events` table), team metadata, PRISM assessment scores |
| API Gateway | Metric ingestion endpoint |
| CloudWatch | All four dashboards (Team Velocity, Executive Readout, CISO Compliance, Developer Productivity) + alarms |
| CloudTrail | Audit trail for AI actions |
| S3 | Spec storage, eval artifacts |

## CDK Commands

```bash
cd infra
npm install
npx cdk synth          # Synthesize CloudFormation
npx cdk deploy --all   # Deploy all stacks
npx cdk diff           # Preview changes
```

## Workshop Facilitation

The workshop modules are hosted on AWS Workshop Studio, not in this repo (link and module table in
`README.md`). It runs about 5 hours (modules 01–06 plus prerequisites) with optional extensions.

## Bootstrapper Usage (Post-Workshop)

Teams install the bundled assets with prism-cli and copy the rest from `bootstrapper/` by hand (see `bootstrapper/README.md`):

```bash
cd ~/your-project

# CI workflows and the eval gate (GitHub; use install-gitlab-workflows for GitLab)
prism-cli bootstrapper install-github-workflows --region us-west-2
prism-cli bootstrapper install-eval-harness

# Local git hooks: gitleaks pre-commit and a report-only AI review on push
prism-cli enable codewatch

# Claude Code config: copy the template for your team's archetype
cp <path-to>/sample-prism-d1-velocity/bootstrapper/claude-code/CLAUDE-backend-api.md ./CLAUDE.md
```

The old `prepare-commit-msg` trailer hook is retired; do not install it. Every command: `docs/CLI-REFERENCE.md`.

## Key Conventions

- TypeScript for all CDK and Lambda code
- Node.js 22.x runtime for Lambdas
- CDK v2 with constructs library
- GitHub Actions for CI/CD (with reusable workflows)
- All dashboard definitions are JSON (infrastructure-as-code)
- Metric event names follow pattern: `prism.d1.<category>.<action>`
