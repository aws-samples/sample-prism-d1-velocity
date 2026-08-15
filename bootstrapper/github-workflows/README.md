# GitHub Actions Workflows

Reusable GitHub Actions workflows for PRISM D1 Velocity metric collection.

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics.yml` | PR merge to main/master | Emits per-PR **facts** — lead time, failure-fix label, review verdicts, commit SHAs. Computes no rates; the dashboard aggregates at query time. Emits `prism.d1.pr` + `prism.d1.deploy` |
| `prism-eval-gate.yml` | PR open/update | Evaluates AI-generated code per-file with auto-selected rubrics, waits for Security Agent, blocks merge on failure |
| `prism-agent-eval.yml` | PR modifying agent code | Runs agent in mock mode, evaluates output with agent-quality rubric |

## Setup

### 1. Configure AWS OIDC

```bash
bash prism-cli bootstrapper setup-github-oidc
```

This interactively creates:
- OIDC identity provider for `token.actions.githubusercontent.com`
- IAM role `GitHubActions-<repo>` with trust policy scoped to your repo
- Inline policy with `events:PutEvents` and `bedrock:InvokeModel`

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
# Optional — only if you have agents with --mock support:
cp bootstrapper/github-workflows/prism-agent-eval.yml .github/workflows/
```

## IAM Permissions

The OIDC role needs:

| Permission | Used by |
|---|---|
| `events:PutEvents` | All workflows |
| `bedrock:InvokeModel` | eval-gate, agent-eval |

## Customization

| Setting | How |
|---|---|
| Branch | Edit `branches` in each workflow |
| AWS region | Edit `aws-region` field + EventBridge commands |
| Eval threshold | Edit `.prism/.prism/eval-harness/eval-config.json` → `pass_threshold` |
| Eval model | Edit `.prism/.prism/eval-harness/eval-config.json` → `eval_model_id` |

## Events Emitted

| Detail Type | Source Workflow | Destination |
|---|---|---|
| `prism.d1.pr` | ai-metrics | EventBridge |
| `prism.d1.deploy` | ai-metrics | EventBridge |
| `prism.d1.eval` | eval-gate | EventBridge |
| `prism.d1.agent.eval` | agent-eval | EventBridge |
| `prism.d1.security.code_review` | eval-gate (Security Agent) | EventBridge |

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
