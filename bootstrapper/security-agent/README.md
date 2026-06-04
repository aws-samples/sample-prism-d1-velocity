# AWS Security Agent Integration

Connects AWS Security Agent to the PRISM D1 metrics pipeline for proactive security scanning across the AI-DLC lifecycle.

## What It Does

| Phase | Trigger | What Gets Scanned | How It Works |
|---|---|---|---|
| Design Review | Manual (web console) | Architecture decisions, data flows, auth design | Web-console-only — not automatable via CLI |
| Code Review | PR opened/updated | Source code against org security policies | GitHub App posts inline review comments automatically |
| Pen Testing | Manual or on deploy | Running application (OWASP Top 10, business logic) | CLI-automatable via `create-pentest` + `start-pentest-job` |

Findings flow into the PRISM pipeline where they're:
- Correlated with AI vs human code origin (via git trailer analysis)
- Mapped to severity by CWE ID for dashboard reporting
- Surfaced in Team, Executive, and CISO dashboards
- Used to block the eval gate when **any** findings are present (count > 0)

## Setup

### Option 1: CLI Command (Recommended)

Deploys the CDK stack with Security Agent enabled, creates the application, and attaches the IAM role:

```bash
prism-cli securityagent setup --profile your-profile --region us-west-2
```

This handles:
1. `cdk deploy --all --context enableSecurityAgent=true`
2. Creates a Security Agent application (or finds existing)
3. Attaches the `prism-d1-security-agent-prism-d1-security` IAM role

After running, open the web console link printed at the end to complete GitHub integration (OAuth handshake required).

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

Code review findings are collected automatically by the **eval gate workflow** (`prism-eval-gate.yml`), which:
1. Polls for Security Agent inline review comments on the PR
2. Counts findings and blocks the gate if count > 0
3. Forwards findings to EventBridge with CWE-based severity mapping

No separate Security Agent workflow is needed. Pen tests are triggered manually via CLI.

## Eval Gate Integration

The eval gate (`prism-eval-gate.yml`) blocks PRs when Security Agent posts **any** inline review comments:

1. Waits for Security Agent to post its "reviewing your pull request" comment
2. Polls for completion (second issue comment or inline review comments)
3. Counts inline review comments from `aws-security-agent[bot]`
4. Fails the gate if count > 0

The gate also forwards findings to EventBridge with CWE-based severity mapping for dashboard reporting.

## Dashboards

Security Agent data appears in:
- **Team Velocity** → "Security Agent Findings" section
- **Executive Readout** → "Security & Compliance" section
- **CISO Compliance** → dedicated dashboard with AI risk profile, shift-left, SLA tracking

## Important Limitations

- **Code reviews require a private repository** — public repos won't show the code review option
- **GitHub integration requires web console OAuth** — cannot bypass with CLI tokens or PATs
- **Design reviews are web-console-only** — not automatable via CLI or GitHub Actions
- **Pen tests take hours** — not suitable for blocking CI pipelines
- **Security Agent does NOT block merges directly** — it only posts comments; the eval gate workflow enforces blocking
