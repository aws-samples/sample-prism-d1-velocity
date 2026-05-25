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
- **AWS-native only** — no third-party observability dependencies (CloudWatch, QuickSight, DynamoDB, EventBridge)
- **Spec-driven development** — all features start with a Kiro-compatible spec before implementation
- **Enhanced DORA metrics** — traditional DORA + AI-native dimensions (acceptance rate, AI-to-merge ratio, eval gate pass rate)

## Repository Structure

```
workshop/           — 7 instructor-led modules (00-06)
  02-agent-development/ — Agent dev with Strands SDK, MCP, AgentCore
infra/              — AWS CDK stacks (metrics pipeline, dashboards, API)
docs/reference/                     — Reference implementations (not deployed)
dashboards/         — Dashboard-as-code (CloudWatch JSON, QuickSight templates)
bootstrapper/       — What teams inherit post-workshop (templates, hooks, workflows)
  agent-configs/    — AgentCore Runtime, Memory, Gateway templates
  mcp-servers/      — Reference MCP server implementations
sample-app/         — Hands-on workshop target application
  agent/            — Strands-based task assistant agent (Python)
  src/mcp/          — MCP server exposing task API as tools (TypeScript)
docs/               — GitHub Pages site + leader guide
```

## Development Workflow

### When implementing features in this repo:

1. **Always start with a spec** — Write or reference a spec in `specs/` before coding
2. **Emit metadata** — Any new component must emit structured events via the metrics schema
3. **Tag AI origin** — Use `ai-origin: claude-code` or `ai-origin: kiro` in commit trailers
4. **Run eval gates** — Bedrock Evaluations must pass before merging to main

### Spec-Driven Development Flow:

```
1. Write spec (Kiro format) → specs/<feature-name>.md
2. Claude Code implements against spec
3. AI metrics auto-collected via git hooks
4. CI emits enhanced DORA event to EventBridge
5. Bedrock Eval gate validates output quality
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
| CloudWatch | Team-level dashboards, alarms |
| QuickSight | Executive readout dashboards (Jellyfish/Swarmia-like) |
| CodePipeline | CI/CD with eval gates |
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

Each module in `workshop/` contains:
- `README.md` — Instructor guide with timing
- `exercises/` — Hands-on exercises
- `solutions/` — Reference implementations
- `checkpoints/` — Validation scripts

Workshop is designed for **4-hour delivery** with optional deep-dive extensions.

## Bootstrapper Usage (Post-Workshop)

Teams fork the `bootstrapper/` directory into their own repos:

```bash
# Copy bootstrapper into your project
cp -r bootstrapper/ ~/your-project/.prism/

# Install git hooks
cd ~/your-project
.prism/metric-hooks/install.sh

# Copy GitHub workflows
cp .prism/github-workflows/*.yml .github/workflows/

# Set up Claude Code config
cp .prism/claude-code/CLAUDE.md ./CLAUDE.md
```

## Key Conventions

- TypeScript for all CDK and Lambda code
- Node.js 20.x runtime for Lambdas
- CDK v2 with constructs library
- GitHub Actions for CI/CD (with reusable workflows)
- All dashboard definitions are JSON (infrastructure-as-code)
- Metric event names follow pattern: `prism.d1.<category>.<action>`
