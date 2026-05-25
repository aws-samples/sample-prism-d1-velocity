# GitHub Actions Workflows

Reusable GitHub Actions workflows for PRISM D1 Velocity metric collection.

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics.yml` | PR merge to main | Calculates AI-to-merge ratio, token usage, lead time. Emits `prism.d1.pr` + `prism.d1.deploy` events |
| `prism-eval-gate.yml` | PR open/update | Evaluates AI-generated code per-file with auto-selected rubrics, waits for Security Agent, blocks merge on failure |
| `prism-agent-eval.yml` | PR modifying agent code | Runs agent in mock mode, evaluates output with agent-quality rubric |
| `prism-dora-weekly.yml` | Weekly (Monday 09:00 UTC) | Calculates DORA + AI-DORA metrics, emits to EventBridge + CloudWatch |

## Setup

### 1. Configure AWS OIDC

```bash
bash prism-cli bootstrapper setup-github-oidc
```

This interactively creates:
- OIDC identity provider for `token.actions.githubusercontent.com`
- IAM role `GitHubActions-<repo>` with trust policy scoped to your repo
- Inline policy with `events:PutEvents` and `bedrock:InvokeModel`

For the weekly workflow, manually add `cloudwatch:PutMetricData` to the role policy.

### 2. Set Repository Secret

In GitHub: Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `PRISM_METRICS_ROLE_ARN` | ARN printed by `setup-github-oidc` |

### 3. Install Git Hooks + Config

```bash
bash prism-cli bootstrapper install-git-hooks
```

Creates `.prism/config.json` with your team ID (read by all workflows).

### 4. Install Eval Harness

```bash
# Workshop mode — bring your own rubric
bash prism-cli bootstrapper install-eval-harness

# Production mode — includes all 5 rubrics
bash prism-cli bootstrapper install-eval-harness --with-rubrics
```

This copies `.prism/eval-harness/`, `eval-config.json`, rubrics, and the `prism-eval-gate.yml` workflow.

### 5. Copy Remaining Workflows

```bash
mkdir -p .github/workflows
cp bootstrapper/github-workflows/prism-ai-metrics.yml .github/workflows/
cp bootstrapper/github-workflows/prism-dora-weekly.yml .github/workflows/
# Optional — only if you have agents with --mock support:
cp bootstrapper/github-workflows/prism-agent-eval.yml .github/workflows/
```

## IAM Permissions

The OIDC role needs:

| Permission | Used by |
|---|---|
| `events:PutEvents` | All workflows |
| `bedrock:InvokeModel` | eval-gate, agent-eval |
| `cloudwatch:PutMetricData` | dora-weekly |

## Customization

| Setting | How |
|---|---|
| Branch | Edit `branches` in each workflow |
| AWS region | Edit `aws-region` field + EventBridge commands |
| Eval threshold | Edit `.prism/.prism/eval-harness/eval-config.json` → `pass_threshold` |
| Eval model | Edit `.prism/.prism/eval-harness/eval-config.json` → `eval_model_id` |
| Weekly schedule | Edit cron in `prism-dora-weekly.yml` (default: `0 9 * * 1`) |

## Events Emitted

| Detail Type | Source Workflow | Destination |
|---|---|---|
| `prism.d1.pr` | ai-metrics | EventBridge |
| `prism.d1.deploy` | ai-metrics | EventBridge |
| `prism.d1.eval` | eval-gate | EventBridge |
| `prism.d1.agent.eval` | agent-eval | EventBridge |
| `prism.d1.assessment` | dora-weekly | EventBridge |
| `prism.d1.security.code_review` | eval-gate (Security Agent) | EventBridge |
| `AIAdoptionRate`, `SpecCoverage`, tool counts | dora-weekly | CloudWatch |

All EventBridge events use source `prism.d1.velocity` and bus `prism-d1-metrics`.

## Troubleshooting

| Issue | Solution |
|---|---|
| OIDC auth fails | Verify trust policy `sub` matches `repo:org/repo:*` |
| EventBridge put fails | Check `events:PutEvents` on bus ARN |
| Eval gate always skips | Ensure commits have `AI-Origin:` trailers (install git hooks) |
| Weekly not running | Workflow must exist on default branch; test with `workflow_dispatch` |
| Agent eval skips | No `agent/main.py` found — add `--mock` support to your agent |
| Security Agent timeout | Agent takes 2+ min to start; workflow waits up to 12 min total |
