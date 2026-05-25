# Eval Harness

Evaluate AI-generated code against rubrics using Amazon Bedrock. Runs per-file, calculates weighted scores client-side, and integrates with the PRISM eval gate workflow.

## Install

```bash
# Workshop mode — empty rubrics, create your own
bash prism-cli bootstrapper install-eval-harness

# Production mode — includes all 5 rubrics
bash prism-cli bootstrapper install-eval-harness --with-rubrics

# Non-interactive
bash prism-cli bootstrapper install-eval-harness --model us.anthropic.claude-haiku-4-5-20251001-v1:0 --threshold 0.82 --with-rubrics
```

This installs into your repo:
- `.prism/.prism/eval-harness/run-eval.sh` — evaluation script
- `.prism/.prism/eval-harness/eval-config.json` — model, threshold, region
- `.prism/.prism/eval-harness/rubrics/` — rubric JSON files
- `.github/workflows/prism-eval-gate.yml` — CI workflow

## Usage

```bash
# Evaluate a single file
./.prism/.prism/eval-harness/run-eval.sh .prism/.prism/eval-harness/rubrics/code-quality.json src/handler.ts

# With a spec file (for spec-compliance rubric)
./.prism/.prism/eval-harness/run-eval.sh .prism/.prism/eval-harness/rubrics/spec-compliance.json src/api.ts --spec specs/api.md
```

### Output

```
correctness: 0.9 — Handles all inputs correctly including edge cases
readability: 0.85 — Clear naming, minor style inconsistency in helper
...

Score: 0.8720
Result: PASS
Hallucinations: 0
```

Exit codes: `0` = pass, `1` = fail, `2` = error.

## Configuration

`eval-config.json`:

| Field | Description | Default |
|---|---|---|
| `pass_threshold` | Minimum score to pass (0-1) | `0.82` |
| `eval_model_id` | Bedrock model for evaluation | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `aws_region` | AWS region | `us-west-2` |
| `event_bus` | EventBridge bus name | `prism-d1-metrics` |
| `emit_to_eventbridge` | Emit events (workflow handles this) | `true` |

## Rubrics

Five production rubrics are available:

| Rubric | Auto-selected when file path matches |
|---|---|
| `code-quality.json` | Default fallback |
| `api-response-quality.json` | `api`, `handler`, `route`, `controller` |
| `agent-quality.json` | `agent`, `assistant`, `orchestrat`, `workflow`, `chain` |
| `security-compliance.json` | `auth`, `security`, `guard`, `policy`, `iam`, `crypto` |
| `spec-compliance.json` | Used when commit has `Spec-Ref:` trailer |

### Creating a Custom Rubric

```json
{
  "rubric_name": "my-rubric",
  "criteria": [
    {
      "name": "criterion_name",
      "weight": 0.30,
      "description": "What this measures",
      "scoring": "How to score 0.0-1.0"
    }
  ]
}
```

Weights must sum to 1.0. The script calculates the weighted average client-side (does not trust the LLM to do math).

## CI Workflow

The `prism-eval-gate.yml` workflow:

1. Detects commits with `AI-Origin:` trailers
2. Identifies changed source files from those commits
3. Auto-selects a rubric per file based on path
4. Runs `run-eval.sh` per file
5. Posts a PR comment with per-file scores
6. Waits for AWS Security Agent review (if installed)
7. Emits `prism.d1.eval` event to EventBridge
8. Fails the check if any file scores below threshold or Security Agent finds issues

### Requirements

- OIDC provider configured for GitHub Actions
- IAM role with `bedrock:InvokeModel` + `events:PutEvents`
- Repository secret `PRISM_METRICS_ROLE_ARN`
- `.prism/config.json` with `team_id`

## Uninstall

```bash
bash prism-cli bootstrapper install-eval-harness --uninstall
```
