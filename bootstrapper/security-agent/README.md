# AWS Continuum Integration

Connects AWS Continuum (formerly AWS Security Agent) to the PRISM D1 metrics pipeline for proactive security scanning across the AI-DLC lifecycle.

## What It Does

| Phase | Trigger | What Gets Scanned | How It Works |
|---|---|---|---|
| Design Review | Manual (web console) | Architecture decisions, data flows, auth design | Web-console-only -- not automatable via CLI |
| Code Review | PR opened/updated | Source code diff via S3 upload | `StartCodeReviewJob` API with diff patch file |
| Pen Testing | Manual or on deploy | Running application (OWASP Top 10, business logic) | CLI-automatable via `create-pentest` + `start-pentest-job` |

Findings flow into the PRISM pipeline where they're:
- Correlated with AI vs human code origin (via git trailer analysis)
- Mapped to severity by CWE ID for dashboard reporting
- Surfaced in Team, Executive, and CISO dashboards
- Used to block the eval gate when **CRITICAL or HIGH** findings are present

## Setup

### Option 1: CLI Command (Recommended)

Deploys the CDK stack with Continuum enabled, creates the Code Review resource, and attaches the CI scan IAM policy:

```bash
prism-cli securityagent setup --profile your-profile --region us-west-2
```

This handles:
1. `cdk deploy --all --context enableSecurityAgent=true`
2. Creates a Continuum Code Review resource (or finds existing)
3. Attaches the `prism-d1-continuum-ci-scan` managed policy to the OIDC role

After running, verify the SSM parameters are populated:

```bash
aws ssm get-parameter --name /prism/continuum/agent-space-id --query Parameter.Value --output text
```

### Option 2: Setup Script

For forwarding findings to the PRISM API independently:

```bash
/path/to/bootstrapper/security-agent/setup.sh \
  --api-url https://your-api.execute-api.us-west-2.amazonaws.com/v1 \
  --api-key your-prism-api-key \
  --team-id your-team-name
```

This creates `.prism/security-agent.json` with scan configuration.

**Full step-by-step guide:** [SETUP-GUIDE.md](SETUP-GUIDE.md) — covers console setup, domain verification, GitHub connection, security policies, and end-to-end verification.

## How Findings Are Collected

Code review findings are collected by the **eval gate workflow** (`prism-eval-gate.yml`) using the Continuum API:
1. `StartCodeReviewJob` — submit the diff for scanning
2. `ListFindings` — retrieve structured results with `riskLevel` (CRITICAL/HIGH/MEDIUM/LOW)
3. Gate blocks if CRITICAL or HIGH findings exist
4. All findings forwarded to EventBridge for metrics

Pen tests are triggered manually via CLI.

## Eval Gate Integration

The eval gate (`prism-eval-gate.yml`) integrates Continuum as a deterministic security scan:

1. Uploads the PR diff to S3 as a `.patch` file
2. Calls `StartCodeReviewJob` with the diff S3 URI
3. Polls `BatchGetCodeReviewJobs` until COMPLETED (5-15 min)
4. Calls `ListFindings` to get structured results with risk levels
5. Fails the gate if any CRITICAL or HIGH findings exist
6. Forwards findings to EventBridge for dashboard reporting

No GitHub App polling or comment parsing needed — fully API-driven and deterministic.

## Dashboards

Continuum findings appear in:
- **Team Velocity** → "Security Findings" section
- **Executive Readout** → "Security & Compliance" section
- **CISO Compliance** → dedicated dashboard with AI risk profile, shift-left, SLA tracking

## Important Limitations

- **Code reviews require the `securityagent` CLI subcommands** — AWS CLI v2.36+ needed
- **Code Review resources are per-repo** — must run `prism-cli securityagent setup` or create via API before first scan
- **Design reviews are web-console-only** — not automatable via CLI or GitHub Actions
- **Pen tests take hours** — not suitable for blocking CI pipelines
- **Scans take 5-15 minutes** — the workflow polls with 30s intervals (up to 30 attempts)
