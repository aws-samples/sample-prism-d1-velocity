# PRISM D1 Velocity — User Guide

This guide is for engineering teams adopting AI-native software development practices with PRISM D1 Velocity. It covers infrastructure setup (administrators), developer onboarding, CI/CD workflows, eval gates, security scanning, dashboards, agent development, and the sample workshop application.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Administrator Setup](#administrator-setup)
- [Developer Setup](#developer-setup)
- [CI-CD Workflows (GitHub and GitLab)](#ci-cd-workflows-github-and-gitlab)
- [Eval Gates](#eval-gates)
- [AWS Continuum Security Agent](#aws-continuum-security-agent)
- [Dashboards](#dashboards)
- [Agent Development (MCP + Agent Configs)](#agent-development-mcp--agent-configs)
- [Sample App](#sample-app)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **AWS CLI v2** (latest) — For EventBridge event emission and Security Agent. Install from [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — do NOT use package managers.
- **Node.js 22+** — Required for prism-cli and the sample app
- **jq** — For JSON processing in CI/CD workflows and eval harness
- **prism-cli** — Install: `npm install -g @prism-d1/cli`
- **codeburn** *(optional)* — Token usage tracking for non-Kiro tools. Install: `npm install -g codeburn` (or `brew install codeburn` on macOS). Kiro sessions are parsed directly by prism-cli, no codeburn needed.
- **GitHub Actions or GitLab CI** — For CI/CD workflows
- **AWS OIDC** — For secure CI/CD to AWS authentication (set up via `setup-github-oidc` or `setup-gitlab-oidc`)
- **Amazon Bedrock** — Model access must be enabled for code evaluation
- **Python 3.11+** — For the agent (sample-app/agent)
- **AWS account with Bedrock AgentCore access** — For agent deployment

---

## Administrator Setup

### Step 1: Deploy PRISM Infrastructure

Deploy the CDK stacks that create the EventBridge bus, DynamoDB tables, Lambda processors, and CloudWatch dashboards:

```bash
prism-cli securityagent setup --profile your-profile --region us-west-2
```

This handles:
1. `cdk deploy --all --context enableSecurityAgent=true`
2. Creates a Continuum Code Review resource (or finds existing)
3. Attaches the `prism-d1-continuum-ci-scan` managed policy to the OIDC role

### Step 2: Set Up OIDC (CI/CD → AWS Authentication)

**GitHub:**
```bash
prism-cli bootstrapper setup-github-oidc
```

This interactively creates:
- OIDC identity provider for `token.actions.githubusercontent.com`
- IAM role `GitHubActions-<repo>` with trust policy scoped to your repo
- Inline policy with `events:PutEvents` and `bedrock:InvokeModel`

Add `PRISM_METRICS_ROLE_ARN` as a GitHub repo secret (ARN printed by the command).

**GitLab:**
```bash
prism-cli bootstrapper setup-gitlab-oidc
```

Creates OIDC provider + IAM role. Add `PRISM_METRICS_ROLE_ARN` as a CI/CD variable (unprotected).

### Step 3: Configure GitHub Repository Variables

In GitHub → your repo → Settings → Secrets and Variables → Actions:

| Type | Name | Value | Where to Find It |
|---|---|---|---|
| **Secret** | `PRISM_METRICS_ROLE_ARN` | ARN printed by `setup-github-oidc` | Step 2 output |
| **Secret** | `PRISM_API_KEY` | Your PRISM API key | CDK stack output |
| **Secret** | `KIRO_API_KEY` | Kiro API key (for eval gate) | https://app.kiro.dev → Settings → API Keys |
| Variable | `PRISM_API_URL` | `https://xxx.execute-api.us-west-2.amazonaws.com/v1` | CDK output `ApiUrl` |
| Variable | `PRISM_TEAM_ID` | `team-alpha` (your team name) | Your choice |
| Variable | `PRISM_AWS_ROLE_ARN` | `arn:aws:iam::123456789012:role/GitHubActionsRole` | Your OIDC role |
| Variable | `PRISM_AGENT_SPACE_ID` | `as-xxxxxxxxxxxx` | Security Agent setup output |
| Variable | `PRISM_PENTEST_ID` | `pt-xxxxxxxxxxxx` | Pen test creation output |

### Step 4: Deploy CloudWatch Dashboards

```bash
# Replace placeholders
sed -e 's/REPLACE_TEAM_ID/your-team-id/g' \
    -e 's/REPLACE_REPO/your-repo-name/g' \
    dashboards/cloudwatch/team-velocity.json > /tmp/team-velocity-configured.json

aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-TeamVelocity-YourTeam" \
  --dashboard-body file:///tmp/team-velocity-configured.json

# Executive dashboard
sed -e 's/REPLACE_TEAM_ID/your-team-id/g' \
    -e 's/REPLACE_REPO/your-repo-name/g' \
    dashboards/cloudwatch/executive-readout.json > /tmp/executive-readout-configured.json

aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-ExecutiveReadout" \
  --dashboard-body file:///tmp/executive-readout-configured.json
```

### 4. Create Developer Accounts

After deploying, create a Cognito user for each developer so they can authenticate with the OTEL collector:

```bash
# Create a user (username MUST be the developer's email)
aws cognito-idp admin-create-user --user-pool-id <OtelUserPoolId output> --username dev@example.com
```

Then share the **OtelCollectorUrl** stack output with your developers — they'll need it for setup below.

**Bring your own IdP** (Okta, Entra ID) instead of Cognito:

```bash
npx cdk deploy --all \
  -c otelIssuer=https://login.example.okta.com/oauth2/default \
  -c otelClientId=0oa1b2c3d4 \
  -c otelIdentityClaim=email
```

Your IdP app must be a **public client with PKCE**, register loopback redirect URIs `http://127.0.0.1:19876/callback` (also ports 19877, 19878), and issue **JWT access tokens** (Okta and Entra ID work; Auth0's opaque access tokens are not supported).

### IAM Permissions Required

The OIDC role needs:

| Permission | Used by |
|---|---|
| `events:PutEvents` | All workflows |
| `bedrock:InvokeModel` | eval-gate, agent-eval |
| `cloudwatch:PutDashboard` | Dashboard deployment |

---

## Infrastructure Configuration

### VPC Configuration

By default, all Lambda functions deploy into a VPC with private isolated subnets and VPC endpoints (gateway: S3, DynamoDB — free; interface: EventBridge, CloudWatch, CloudWatch Logs, KMS, Bedrock Runtime — billable) for network isolation. This adds ~$35-50/month in endpoint costs.

| Option | Command | Use Case |
|--------|---------|----------|
| **New VPC** (default) | `npx cdk deploy --all` | Production — full network isolation |
| **Skip VPC** | `npx cdk deploy --all -c skipVpc=true` | Workshop/demo — saves cost, faster cold starts |
| **Existing VPC** | `npx cdk deploy --all -c vpcId=vpc-0123456789abcdef0` | Enterprise — use shared VPC with existing endpoints or NAT |

When using an existing VPC, ensure it has either VPC endpoints for the required services or a NAT gateway for outbound internet access.

**Data layout:**

| Destination | Content | Purpose |
|-------------|---------|---------|
| S3 (`prism-d1-otlp-archive-*`) | Raw OTLP JSON batches, partitioned by `dt=` | External contract — Athena, data lake, replay into any OTel backend |
| DynamoDB (`prism-d1-ai-usage`) | Per-span rows (90-day TTL) + daily per-user/tool aggregates | PRISM dashboards |

Duplicate pushes are safe: codeburn's deterministic span IDs act as an idempotency key server-side. Historical sessions are backfilled on first push (aggregates bucket by span date). Running a full ADOT collector for fan-out to X-Ray/Grafana/Datadog is on the [roadmap](docs/ROADMAP.md).

### Cost Estimate

Monthly cost depends on team size and configuration. All resources are serverless (pay-per-use) except VPC endpoints.

| Component | ~Monthly Cost | Notes |
|-----------|--------------|-------|
| **VPC endpoints** (5 interface) | $35–50 | Gateway endpoints (S3, DynamoDB) are free. Skip all with `-c skipVpc=true` |
| **DynamoDB** (3 tables) | $1–5 | On-demand billing; scales with commit volume |
| **Lambda** (9 processors) | $1–3 | Invoked per event; negligible at <50 devs |
| **EventBridge** | < $1 | $1/million events |
| **CloudWatch** (4 dashboards, 9 alarms) | $3–10 | Per-dashboard fee + metric costs |
| **OTEL Collector** (API Gateway + Cognito + S3) | $2–5 | Per-request + S3 storage |
| **Bedrock Guardrails** | $1–5 | Per-invocation; depends on eval gate frequency |
| **KMS** (1 key) | $1 | Fixed monthly fee + $0.03/10K requests |

**Typical total:**
- Workshop/demo (no VPC): **~$10–25/month**
- Production (with VPC, <50 devs): **~$50–80/month**
- Large team (100+ devs, heavy CI): **~$80–150/month**

> 💡 The largest cost driver is VPC endpoints. For workshops and demos, use `-c skipVpc=true` to stay under $25/month.

## Developer Setup

### Install Git Hooks and Config

```bash
# For all future clones (global template):
prism-cli bootstrapper install-git-hooks --global

# For an existing repo (run inside the repo):
prism-cli bootstrapper install-git-hooks
```

The `--global` flag sets `init.templateDir` so all future `git clone` / `git init` automatically get the hooks. Existing repos need a one-time in-repo install.

Set custom bounds at install time:

```bash
prism-cli bootstrapper install-git-hooks --team-id my-team --max-tokens 500000 --max-cost 50
```

To remove:

```bash
prism-cli bootstrapper install-git-hooks --uninstall
```

The installer creates `.prism/config.json`:

```json
{
  "team_id": "your-team",
  "max_tokens": 1000000,
  "max_cost": 100
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `team_id` | Team identifier for metric attribution | *(required)* |
| `max_tokens` | Max input/output tokens per commit (capped at this value) | `1000000` |
| `max_cost` | Max cost in USD per commit (capped at this value) | `100` |

The installer also registers a Claude Code `SessionStart` hook in `~/.claude/settings.json` (served by `prism-cli git claude-session-context`). It captures the Claude session id into the environment so commits made during a Claude Code session are attributed correctly.

### Commit Metadata Reference (deprecated)

> These trailers are produced by the git hooks, which are being removed. Retained
> as reference for teams still running hooks during the migration. Post-removal,
> AI origin comes from codeburn attribution — see the Data Architecture guide.

![Workflow](assets/images/PrismDashboard.drawio.png)

The `prepare-commit-msg` git hook automatically injects trailers into every commit message to track AI tool involvement and token usage.

**Trailers injected:**

| Trailer | Example | Description |
|---------|---------|-------------|
| `AI-Origin` | `ai-generated` or `human` | Whether an AI tool was detected |
| `AI-Tool` | `claude-code`, `kiro`, `q-developer` | Which tool was active (omitted for human commits) |
| `AI-Model` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Model used (Claude Code only) |
| `AI-Input-Tokens` | `12450` | Input tokens since last commit (via codeburn) |
| `AI-Output-Tokens` | `3200` | Output tokens since last commit |
| `AI-Cost` | `$0.42` | Estimated cost since last commit |
| `Spec-Ref` | `.kiro/specs/auth.md` | Spec file if staged or declared |

**Tool support:**

| Tool | Detection Method | Status |
|------|-----------------|--------|
| Claude Code | `CLAUDE_CODE_SESSION_ID` env var | ✅ Supported |
| Kiro IDE | `TERM_PROGRAM=kiro` env var | ✅ Supported |
| Kiro CLI | `KIRO_SESSION_ID` env var | ✅ Supported |
| Amazon Q Developer | `Q_DEVELOPER_SESSION` env var | ✅ Supported |
| Cursor | `VSCODE_SHELL_INTEGRATION=1` (agent mode) | 🔜 Planned |
| GitHub Copilot | codeburn session correlation | 🔜 Planned |
| Windsurf | Process tree or codeburn | 🔜 Planned |
| Codex (OpenAI) | Process tree detection | 🔜 Planned |
| Aider | Process tree or codeburn | 🔜 Planned |
| Cline / Roo Code | codeburn session correlation | 🔜 Planned |

Install the hooks globally so all future repos get attribution automatically:

```bash
prism-cli bootstrapper install-git-hooks --team-id your-team --global
```

### Install CI/CD Workflows

**GitHub:**
```bash
prism-cli bootstrapper install-github-workflows --region us-west-2
# Copies workflow files to .github/workflows/
```

**GitLab:**
```bash
prism-cli bootstrapper install-gitlab-workflows --gitlab-url https://gitlab.com --region us-west-2
# Copies workflow files to .prism/gitlab-workflows/
# Then copy or merge .prism/gitlab-workflows/.gitlab-ci.yml into your repo root .gitlab-ci.yml
```

### Install Eval Harness

```bash
# Kiro mode (recommended)
prism-cli bootstrapper install-eval-harness --mode kiro

# Bedrock mode — workshop (empty rubrics, create your own)
prism-cli bootstrapper install-eval-harness

# Bedrock mode — production (includes all 5 rubrics)
prism-cli bootstrapper install-eval-harness --with-rubrics
```

### Choose a CLAUDE.md Template (Optional)

Pick the template that matches your team:

```bash
cp bootstrapper/claude-code/CLAUDE-backend-api.md ./CLAUDE.md
# Or: CLAUDE-frontend.md, CLAUDE-platform.md, CLAUDE-agent.md
```

### Set Up OTEL Attribution (Recommended)

`setup-otel-sync` provides attribution telemetry that supersedes the git hooks for AI-origin tracking:

```bash
prism-cli setup-otel-sync
```

### Adoption Path

| Phase | Actions | Metrics You Get |
|---|---|---|
| **Day 1** | Install hooks + CLAUDE.md | AI-origin tagging on every commit |
| **Week 1** | Add GitHub workflows | AI-to-merge ratio, lead time, eval scores |
| **Week 2** | Configure eval harness + gate | Automated quality checks on AI code |
| **Ongoing** | Weekly DORA assessment | Full DORA + AI-DORA dashboard |

---

## CI-CD Workflows (GitHub and GitLab)

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics.yml` | PR merge to main/master | Emits per-PR **facts** — lead time, failure-fix label, review verdicts, commit SHAs. Computes no rates; the dashboard aggregates at query time. Emits `prism.d1.pr` + `prism.d1.deploy` |
| `prism-eval-gate.yml` | PR open/update | Evaluates AI-generated code per-file with auto-selected rubrics, waits for Security Agent, blocks merge on failure |
| `prism-agent-eval.yml` | PR modifying agent code | Runs agent in mock mode, evaluates output with agent-quality rubric |

### GitLab CI Workflows

GitLab workflow files are installed to `.prism/gitlab-workflows/`. Copy or merge `.prism/gitlab-workflows/.gitlab-ci.yml` into your repo root `.gitlab-ci.yml`.

| Job | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics` | Post-merge | Same as GitHub equivalent |
| `prism-eval-gate` | MR open/update | Same as GitHub equivalent |
| `prism-agent-eval` | MR modifying agent code | Same as GitHub equivalent |

### Events Emitted

All EventBridge events use source `prism.d1.velocity` and bus `prism-d1-metrics`:

| Detail Type | Source Workflow | Destination |
|---|---|---|
| `prism.d1.commit` | Git hooks | EventBridge |
| `prism.d1.pr` | ai-metrics | EventBridge |
| `prism.d1.deploy` | ai-metrics | EventBridge |
| `prism.d1.eval` | eval-gate | EventBridge |
| `prism.d1.agent.eval` | agent-eval | EventBridge |
| `prism.d1.security.code_review` | eval-gate (Security Agent) | EventBridge |
| `prism.d1.assessment` | GitHub Actions (weekly cron) | EventBridge |

### Customization

| Setting | How |
|---|---|
| Branch | Edit `branches` in each workflow |
| AWS region | Edit `aws-region` field + EventBridge commands |
| Eval threshold | Edit `.prism/.prism/eval-harness/eval-config.json` → `pass_threshold` |
| Eval model | Edit `.prism/.prism/eval-harness/eval-config.json` → `eval_model_id` |

---

## Eval Gates

### Kiro Mode (Recommended)

```bash
prism-cli bootstrapper install-eval-harness --mode kiro
```

Installs:
- `.kiro/steering/code-review.md` — review rules (plain English)
- `.github/workflows/prism-eval-gate.yml` — kiro-cli headless CI workflow

**Requirements:**
- `KIRO_API_KEY` repository secret (generate at https://app.kiro.dev → Settings → API Keys)
- (Optional) `PRISM_METRICS_ROLE_ARN` for EventBridge metrics + AWS Continuum security scanning

**How it works:**
1. PR opened → workflow triggers
2. kiro-cli reads changed files + the diff via `--trust-all-tools`
3. Outputs structured JSON: findings with file/line, severity, score
4. Gate fails if any high-severity finding or score < 0.82
5. PR comment posted with findings table

### Bedrock Mode (Legacy)

```bash
# Non-interactive install
prism-cli bootstrapper install-eval-harness --model us.anthropic.claude-haiku-4-5-20251001-v1:0 --threshold 0.82 --with-rubrics
```

Installs into your repo:
- `.prism/.prism/eval-harness/run-eval.sh` — evaluation script
- `.prism/.prism/eval-harness/eval-config.json` — model, threshold, region
- `.prism/.prism/eval-harness/rubrics/` — rubric JSON files
- `.github/workflows/prism-eval-gate.yml` — CI workflow

### Running Evaluations Locally

```bash
# Evaluate a single file
./.prism/.prism/eval-harness/run-eval.sh .prism/.prism/eval-harness/rubrics/code-quality.json src/handler.ts

# With a spec file (for spec-compliance rubric)
./.prism/.prism/eval-harness/run-eval.sh .prism/.prism/eval-harness/rubrics/spec-compliance.json src/api.ts --spec specs/api.md
```

**Output:**

```
correctness: 0.9 — Handles all inputs correctly including edge cases
readability: 0.85 — Clear naming, minor style inconsistency in helper
...

Score: 0.8720
Result: PASS
Hallucinations: 0
```

Exit codes: `0` = pass, `1` = fail, `2` = error.

### Configuration

`eval-config.json`:

| Field | Description | Default |
|---|---|---|
| `pass_threshold` | Minimum score to pass (0-1) | `0.82` |
| `eval_model_id` | Bedrock model for evaluation | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `aws_region` | AWS region | `us-west-2` |
| `event_bus` | EventBridge bus name | `prism-d1-metrics` |
| `emit_to_eventbridge` | Emit events (workflow handles this) | `true` |

### Rubrics

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

### CI Workflow Behavior

The `prism-eval-gate.yml` workflow:

1. Detects commits with `AI-Origin:` trailers
2. Identifies changed source files from those commits
3. Auto-selects a rubric per file based on path
4. Runs `run-eval.sh` per file (Bedrock mode) or kiro-cli (Kiro mode)
5. Posts a PR comment with per-file scores
6. Waits for AWS Continuum review (if installed)
7. Emits `prism.d1.eval` event to EventBridge
8. Fails the check if any file scores below threshold or Security Agent finds issues

### Uninstall

```bash
prism-cli bootstrapper install-eval-harness --uninstall
```

---

## AWS Continuum Security Agent

### Overview

AWS Continuum (formerly AWS Security Agent) provides proactive security scanning across the AI-DLC lifecycle:

| Phase | Trigger | What Gets Scanned | How It Works |
|---|---|---|---|
| Design Review | Manual (web console) | Architecture decisions, data flows, auth design | Web-console-only — not automatable via CLI |
| Code Review | PR opened/updated | Source code diff via S3 upload | `StartCodeReviewJob` API with diff patch file |
| Pen Testing | Manual or on deploy | Running application (OWASP Top 10, business logic) | CLI-automatable via `create-pentest` + `start-pentest-job` |

Findings flow into the PRISM pipeline where they're:
- Correlated with AI vs human code origin (via git trailer analysis)
- Mapped to severity by CWE ID for dashboard reporting
- Surfaced in Team, Executive, and CISO dashboards
- Used to block the eval gate when **CRITICAL or HIGH** findings are present

### Setup (CLI — Recommended)

```bash
prism-cli securityagent setup --profile your-profile --region us-west-2
```

This:
1. Runs `cdk deploy --all --context enableSecurityAgent=true`
2. Creates a Security Agent application (or finds existing)
3. Attaches the `prism-d1-security-agent-prism-d1-security` IAM role
4. Prints the web console URL

**Verify:**

```bash
aws securityagent list-agent-spaces --region us-west-2 --output table
# Should show: prism-d1-security | as-xxxxxxxxxxxx | ACTIVE
```

After running, verify SSM parameters are populated:

```bash
aws ssm get-parameter --name /prism/continuum/agent-space-id --query Parameter.Value --output text
```

### Setup Script (Alternative)

For forwarding findings to the PRISM API independently:

```bash
/path/to/bootstrapper/security-agent/setup.sh \
  --api-url https://your-api.execute-api.us-west-2.amazonaws.com/v1 \
  --api-key your-prism-api-key \
  --team-id your-team-name
```

Creates `.prism/security-agent.json` with scan trigger configuration and remediation SLAs.

### Domain Registration for Pen Testing

> **Skip this step** if you only need code review (domain is only required for pen testing).

#### Option A: DNS TXT Record (Recommended)

```bash
aws securityagent create-target-domain \
  --target-domain-name api.yourcompany.com \
  --verification-method DNS_TXT \
  --region us-west-2
```

Add the DNS TXT record at your DNS provider:

```
Type:   TXT
Name:   _securityagent.api.yourcompany.com
Value:  <paste the verification token from the command output>
TTL:    300
```

Verify:

```bash
dig TXT _securityagent.api.yourcompany.com

aws securityagent verify-target-domain \
  --target-domain-name api.yourcompany.com \
  --region us-west-2

aws securityagent batch-get-target-domains \
  --target-domain-names api.yourcompany.com \
  --region us-west-2 \
  --query 'targetDomains[0].verificationStatus'
```

**Expected:** `VERIFIED`

#### Option B: HTTP Route

```bash
aws securityagent create-target-domain \
  --target-domain-name api.yourcompany.com \
  --verification-method HTTP_ROUTE \
  --region us-west-2
```

Host a verification endpoint at:
`https://api.yourcompany.com/.well-known/security-agent-verification`

> **⚠️ Critical:** The endpoint must return JSON in this exact format:
> ```json
> {"tokens": ["<your-verification-token>"]}
> ```
> Not `{"token": "..."}` or plain text — it must be `{"tokens": [...]}` with an array.

#### Associate Domain with Agent Space

**⚠️ Required:** A verified domain is NOT automatically usable for pen tests. You must explicitly associate it:

```bash
DOMAIN_ID=$(aws securityagent batch-get-target-domains \
  --target-domain-names api.yourcompany.com \
  --region us-west-2 \
  --query 'targetDomains[0].targetDomainId' --output text)

aws securityagent update-agent-space \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --target-domain-ids "${DOMAIN_ID}" \
  --region us-west-2
```

### Connect GitHub for Code Review

> **⚠️ Important:** GitHub integration requires an OAuth authorization code from AWS's pre-registered GitHub OAuth App. You **cannot** bypass this with `gh` CLI tokens or PATs. The initial setup must be done via the web console.

1. Open [Security Agent console](https://console.aws.amazon.com/securityagent)
2. Click your agent space (`prism-d1-security`)
3. Go to **Integrations** → **Add Integration**
4. Select **GitHub**
5. Complete the OAuth authorization flow
6. Select the repositories to monitor (must be **private** repos)
7. Save

**After initial OAuth setup**, manage repos via CLI:

```bash
aws securityagent list-integrations \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --region us-west-2 --output table

aws securityagent update-integrated-resources \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --integration-id <integration-id> \
  --add-resources '["your-org/new-repo"]' \
  --region us-west-2
```

After this, Security Agent automatically reviews every PR opened against the connected repositories. It posts as `aws-security-agent[bot]` with inline review comments on specific lines.

> **Note:** Code reviews only work on **private repositories**. Public repos will not show the code review option.

### Create a Pen Test Configuration

```bash
SERVICE_ROLE_ARN=$(aws iam list-roles \
  --query "Roles[?contains(RoleName, 'security-agent')].Arn" \
  --output text | head -1)

# ⚠️ Title only allows: letters, numbers, hyphens, underscores. No spaces. Max 100 chars.
PENTEST_RESULT=$(aws securityagent create-pentest \
  --title "PRISM-D1-Application-Pen-Test" \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --service-role "${SERVICE_ROLE_ARN}" \
  --assets '{
    "endpoints": [
      {"url": "https://api.yourcompany.com"}
    ]
  }' \
  --code-remediation-strategy DISABLED \
  --region us-west-2 \
  --output json)

PENTEST_ID=$(echo "${PENTEST_RESULT}" | jq -r '.pentestId')
echo "Pen Test ID: ${PENTEST_ID}"
```

### Configure the PRISM Webhook

In the Security Agent console → **Settings** → **Notifications** (or **Webhooks**):

| Field | Value |
|---|---|
| **URL** | `${PRISM_API_URL}/security-findings` |
| **Method** | POST |
| **Header name** | `x-api-key` |
| **Header value** | Your PRISM API key |
| **Events** | All finding types |
| **Format** | JSON |

> **Note:** This webhook is for pen test findings only. Code review findings are collected by the eval gate workflow directly from GitHub PR comments.

### How Eval Gate Integrates Continuum

The eval gate (`prism-eval-gate.yml`) integrates Continuum as a deterministic security scan:

1. Uploads the PR diff to S3 as a `.patch` file
2. Calls `StartCodeReviewJob` with the diff S3 URI
3. Polls `BatchGetCodeReviewJobs` until COMPLETED (5-15 min)
4. Calls `ListFindings` to get structured results with risk levels
5. Fails the gate if any CRITICAL or HIGH findings exist
6. Forwards findings to EventBridge for dashboard reporting

No GitHub App polling or comment parsing needed — fully API-driven and deterministic.

### Verify End-to-End

**Test Code Review:**

```bash
git checkout -b test-security-review
echo "// test change" >> src/index.ts
git add src/index.ts
git commit -m "Test code for security review"
git push -u origin test-security-review
# Open a PR via GitHub UI
```

What happens:
1. Security Agent GitHub App automatically reviews the PR
2. Posts inline review comments on specific lines (as `aws-security-agent[bot]`)
3. Eval gate workflow collects findings and blocks if count > 0
4. Findings forwarded to EventBridge with CWE-based severity mapping

**Test Pen Test:**

> ⚠️ Pen tests take several hours to complete. Not suitable for blocking CI.

```bash
# Warm the verification Lambda
for i in {1..3}; do
  curl -s https://api.yourcompany.com/.well-known/security-agent-verification > /dev/null
  sleep 2
done

# Start
aws securityagent start-pentest-job \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --region us-west-2

# Monitor
aws securityagent list-pentest-jobs-for-pentest \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --region us-west-2 \
  --query 'pentestJobSummaries[0].{JobId:pentestJobId,Status:status}' \
  --output table
```

### Important Limitations

- **Code reviews require the `securityagent` CLI subcommands** — AWS CLI v2.36+ needed
- **Code Review resources are per-repo** — must run `prism-cli securityagent setup` or create via API before first scan
- **Design reviews are web-console-only** — not automatable via CLI or GitHub Actions
- **Pen tests take hours** — not suitable for blocking CI pipelines
- **Scans take 5-15 minutes** — the workflow polls with 30s intervals (up to 30 attempts)

### Quick Reference: All Continuum Commands

```bash
# Deploy Security Agent
prism-cli securityagent setup --profile your-profile --region us-west-2

# List agent spaces
aws securityagent list-agent-spaces --region us-west-2

# Register and verify a domain
aws securityagent create-target-domain \
  --target-domain-name api.example.com \
  --verification-method DNS_TXT --region us-west-2
aws securityagent verify-target-domain \
  --target-domain-name api.example.com --region us-west-2

# Associate domain with agent space (required before pen test)
aws securityagent update-agent-space \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --target-domain-ids "<domain-id>" --region us-west-2

# Upload spec as context for pen tests
aws securityagent add-artifact \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --artifact-content fileb://specs/my-spec.md \
  --artifact-type MD --file-name my-spec.md --region us-west-2

# Start a pen test
aws securityagent start-pentest-job \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" --region us-west-2

# Check pen test status
aws securityagent list-pentest-jobs-for-pentest \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --query 'pentestJobSummaries[0].status' --region us-west-2

# Get findings from a pen test job
aws securityagent list-findings \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-job-id <job-id> --region us-west-2

# Manage GitHub integration repos (after initial OAuth via console)
aws securityagent list-integrations \
  --agent-space-id "${AGENT_SPACE_ID}" --region us-west-2
aws securityagent update-integrated-resources \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --integration-id <id> \
  --add-resources '["org/repo"]' --region us-west-2
```

---

## Dashboards

### Available Dashboards

| Dashboard | File | Audience |
|-----------|------|----------|
| Team Velocity | `dashboards/cloudwatch/team-velocity.json` | Engineering teams, tech leads |
| Executive Readout | `dashboards/cloudwatch/executive-readout.json` | CTOs, VPEs, engineering directors |

### Prerequisites

- CloudWatch `PutDashboard` permission (`cloudwatch:PutDashboard`)
- Metrics flowing into the `PRISM/D1` namespace (via the PRISM collector pipeline)

### Deploying Dashboards

```bash
aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-TeamVelocity" \
  --dashboard-body file://dashboards/cloudwatch/team-velocity.json

aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-ExecutiveReadout" \
  --dashboard-body file://dashboards/cloudwatch/executive-readout.json
```

### Deploy via CloudFormation

```yaml
Resources:
  TeamVelocityDashboard:
    Type: AWS::CloudWatch::Dashboard
    Properties:
      DashboardName: !Sub "PRISM-D1-TeamVelocity-${TeamId}"
      DashboardBody: !Sub |
        # Inline the JSON with ${TeamId} substitutions
```

### Dimensions

All metrics use the following dimensions:

| Dimension | Description | Example |
|-----------|-------------|---------|
| `TeamId` | Unique team identifier | `platform-team`, `payments-squad` |
| `Repo` | Repository name | `backend-api`, `web-frontend` |
| `Environment` | Deployment target | `production`, `staging` |

### Adding Custom Widgets

Append to the `widgets` array in either dashboard JSON. CloudWatch uses a 24-column grid:

```json
{
  "type": "metric",
  "x": 0,
  "y": 25,
  "width": 12,
  "height": 6,
  "properties": {
    "title": "My Custom Metric",
    "view": "timeSeries",
    "metrics": [
      ["PRISM/D1", "YourMetricName", "TeamId", "your-team", {"stat": "Average", "period": 86400}]
    ],
    "region": "${AWS::Region}"
  }
}
```

Widget types:

| Type | `view` value | Use case |
|------|-------------|----------|
| Line graph | `timeSeries` | Trend data over time |
| Bar chart | `bar` | Counts, frequencies |
| Stacked area | `timeSeries` + `"stacked": true` | Comparative breakdowns |
| Single number | `singleValue` | Current/latest metric value |
| Text | (type: `text`) | Section headers, notes |

### Threshold Recommendations by PRISM Level

#### DORA Metrics

| Metric | L1 (Ad Hoc) | L2 (Emerging) | L3 (Scaling) | L4 (Optimized) | L5 (Transformative) |
|--------|-------------|---------------|--------------|-----------------|---------------------|
| Deployment Frequency | < 1/week | 1-2/week | Daily | Multiple/day | On-demand |
| Lead Time | > 30 days | 7-30 days | 1-7 days | < 1 day | < 1 hour |
| Change Failure Rate | > 45% | 30-45% | 15-30% | 5-15% | < 5% |
| MTTR | > 7 days | 1-7 days | < 1 day | < 1 hour | < 15 min |

#### AI-DORA Metrics

| Metric | L1 | L2 | L3 | L4 | L5 |
|--------|----|----|----|----|-----|
| AI Acceptance Rate | 0% | 10-30% | 30-50% | 50-70% | > 70% |
| AI-to-Merge Ratio | 0 | 0.1-0.3 | 0.3-0.5 | 0.5-0.7 | > 0.7 |
| Eval Gate Pass Rate | N/A | > 60% | > 80% | > 90% | > 95% |
| Spec-to-Code Hours | N/A | > 48h | 24-48h | 8-24h | < 8h |

### Metric Namespace Reference

All metrics live under `PRISM/D1`:

- `PRISM/D1/AIAcceptanceRate` — Percentage of AI suggestions accepted
- `PRISM/D1/DeploymentCount` — Number of deployments
- `PRISM/D1/LeadTimeSeconds` — Time from commit to production (seconds)
- `PRISM/D1/ChangeFailureRate` — Percentage of deployments causing failure
- `PRISM/D1/MTTRSeconds` — Mean time to recovery (seconds)
- `PRISM/D1/AIToMergeRatio` — Ratio of AI-generated code to total merged code
- `PRISM/D1/EvalGatePassRate` — Percentage of AI outputs passing eval gates
- `PRISM/D1/SpecToCodeHours` — Hours from spec approval to code completion
- `PRISM/D1/DefectRateAI` — Post-merge defect rate for AI-generated code
- `PRISM/D1/DefectRateHuman` — Post-merge defect rate for human-written code
- `PRISM/D1/AITestCoverageDelta` — Change in test coverage from AI-generated tests
- `PRISM/D1/PRISMLevel` — Current assessed PRISM maturity level (1-5)
- `PRISM/D1/AIROIMultiplier` — Return on AI investment multiplier

### Updating Dashboards

CloudWatch `put-dashboard` is idempotent. Re-run the deploy command to update:

```bash
aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-TeamVelocity" \
  --dashboard-body file://dashboards/cloudwatch/team-velocity.json
```

---

## Agent Development (MCP + Agent Configs)

### AgentCore Deployment Templates

Configuration templates for deploying agents using Amazon Bedrock AgentCore:

| Template | Purpose |
|---|---|
| `bootstrapper/agent-configs/agentcore-runtime.json` | Agent runtime — handler, memory, timeout, model access |
| `bootstrapper/agent-configs/agentcore-memory.json` | Session memory — TTL, branching, storage backend |
| `bootstrapper/agent-configs/agentcore-gateway.json` | API Gateway — endpoint, auth, rate limits, MCP servers |
| `bootstrapper/agent-configs/guardrails-template.json` | Bedrock Guardrails — content filters, denied topics, sensitive info |

#### Getting Started

```bash
# Copy templates into your project
cp -r bootstrapper/agent-configs/ .prism/agent-configs/

# Find all placeholders to replace
grep -r '<' .prism/agent-configs/*.json

# Deploy
aws bedrock-agentcore create-runtime \
  --cli-input-json file://.prism/agent-configs/agentcore-runtime.json

aws bedrock create-guardrail \
  --cli-input-json file://.prism/agent-configs/guardrails-template.json
```

#### Configuration Relationships

```
agentcore-gateway.json
  |
  +-- agentcore-runtime.json (the agent that handles requests)
  |     |
  |     +-- agentcore-memory.json (session memory for the runtime)
  |     +-- guardrails-template.json (content safety for the runtime)
  |
  +-- mcp_servers[] (external tool servers the agent connects to)
```

#### PRISM Metrics Integration

Include in environment variables:

```json
{
  "PRISM_TEAM_ID": "your-team-id",
  "PRISM_EVENT_BUS": "prism-d1-metrics"
}
```

#### AgentCore Prerequisites

- AWS account with Bedrock AgentCore access enabled
- IAM role with `bedrock-agentcore:*`, `bedrock:*`, and `events:PutEvents`
- PRISM D1 infrastructure deployed (`infra/` CDK stacks)
- Agent code packaged and tested locally before deployment

### MCP Server Patterns

MCP (Model Context Protocol) servers expose tools and resources that agents can discover and invoke at runtime. Instead of hard-coding tool integrations, you expose them as MCP servers that any compatible agent can discover and use.

Key concepts:
- **Tools**: Functions the agent can call (e.g., `query_database`, `create_ticket`, `run_test`)
- **Resources**: Read-only data the agent can access (e.g., configuration, documentation, schemas)
- **Transports**: How the client and server communicate (`stdio` for local, `streamable-http` for production)

#### Server Patterns

| Pattern | Tools | Resources | Transport |
|---------|-------|-----------|-----------|
| Database Query | `query_table`, `get_record_by_id`, `search_records` | `table_schemas`, `query_examples` | stdio (dev), streamable-http (prod) |
| CI/CD Integration | `get_build_status`, `trigger_deploy`, `get_deploy_logs`, `rollback` | `pipeline_config`, `environment_list` | streamable-http |
| Code Analysis | `search_codebase`, `run_linter`, `get_file_ast`, `find_references` | `lint_rules`, `project_structure` | stdio |
| Notification/Communication | `send_slack_message`, `create_jira_ticket`, `send_email` | `channel_list`, `ticket_templates` | streamable-http |

#### Building an MCP Server

**1. Write the spec first:**

```bash
cp bootstrapper/spec-templates/mcp-server.md specs/my-mcp-server.md
```

**2. Implement with the MCP SDK:**

TypeScript:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "your-org/your-server",
  version: "1.0.0",
});

server.tool(
  "query_records",
  "Search records by filter criteria",
  { filter: { type: "string", description: "Search query" } },
  async ({ filter }) => {
    const results = await db.search(filter);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Python:

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server

server = Server("your-org/your-server")

@server.tool()
async def query_records(filter: str) -> str:
    """Search records by filter criteria."""
    results = await db.search(filter)
    return json.dumps(results)

async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write)
```

**3. Test independently:**

```bash
npx @modelcontextprotocol/inspector your-server-command
```

**4. Register in agent config:**

```json
{
  "mcp_servers": [
    {
      "name": "your-server",
      "transport": "stdio",
      "command": "node",
      "args": ["dist/server.js"]
    }
  ]
}
```

#### Connecting MCP Servers to Strands Agents

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp import StdioServerParameters

mcp_client = MCPClient(
    lambda: StdioServerParameters(
        command="node",
        args=["path/to/server.js"],
    )
)

with mcp_client:
    agent = Agent(
        tools=mcp_client.list_tools_sync(),
    )
    result = agent("Use the tools to complete the task.")
```

#### Related Resources

| Resource | Location |
|---|---|
| MCP server spec template | `bootstrapper/spec-templates/mcp-server.md` |
| Agent eval rubric | `.prism/.prism/eval-harness/rubrics/agent-quality.json` |
| AgentCore gateway config | `bootstrapper/agent-configs/agentcore-gateway.json` |
| Agent CLAUDE.md template | `bootstrapper/claude-code/CLAUDE-agent.md` |
| MCP specification | https://modelcontextprotocol.io/ |

---

## Sample App

### Run the Sample Agent (No AWS Required)

```bash
cd sample-app
npm install && npm run dev          # Start the task API

cd agent
pip install -e ".[dev]"
python scripts/run-demo.py --mock   # Run agent demo with mock model
```

### AI Agent Development

| Component | Technology | Location |
|-----------|-----------|----------|
| **Agent Framework** | Strands Agents SDK (Python) | `sample-app/agent/` |
| **Tool Integration** | Model Context Protocol (MCP) with scope-based auth | `sample-app/src/mcp/` |
| **Production Hosting** | Amazon Bedrock AgentCore | `bootstrapper/agent-configs/` |
| **Agent Eval** | kiro-cli headless review + Bedrock rubrics (legacy) | `bootstrapper/eval-harness/` |
| **Security** | Bedrock Guardrails + MCP authorization + Security Agent | `infra/lib/constructs/` |
| **Workshop** | Module 02: Agent Development | `workshop/02-agent-development/` |



### Task Management API

A simple REST API for the PRISM D1 Velocity workshop. Participants use Claude Code to extend this API by implementing features from specs.

#### Quick Start

```bash
cd sample-app/
npm install
npm run dev     # Start dev server on http://localhost:3000
npm test        # Run test suite
```

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /tasks | List all tasks |
| POST | /tasks | Create a task |
| GET | /tasks/:id | Get task by ID |
| PUT | /tasks/:id | Update a task |
| DELETE | /tasks/:id | Delete a task |

#### Workshop Exercises

The `sample-app/specs/` directory contains feature specs in Kiro-compatible format:

- **specs/task-api.md** — Already implemented (reference example)
- **specs/task-search.md** — Exercise 2: Add search and filtering
- **specs/task-priority.md** — Exercise 3: Add priority levels

Use Claude Code to implement each spec:

```
> Read specs/task-search.md and implement all requirements. Write tests first.
```

#### Project Structure

```
sample-app/
  src/
    index.ts            — Express app entry point
    types.ts            — TypeScript interfaces
    routes/
      health.ts         — Health check route
      tasks.ts          — Task CRUD routes
  tests/
    tasks.test.ts       — Jest test suite
  specs/
    task-api.md         — Implemented spec (reference)
    task-search.md      — Unimplemented (workshop exercise)
    task-priority.md    — Unimplemented (workshop exercise)
```

### Task Assistant Agent

A Strands Agents SDK-based AI agent that manages tasks via natural language.

#### Architecture

```
User (CLI / API)
      |
  Strands Agent (Python)
      |
  MCP Client ────── MCP Server (TypeScript, stdio)
      |                    |
  Amazon Bedrock      Task Store (in-memory)
  (Claude Sonnet)          |
      |              Express REST API
  AgentCore
  (Runtime + Memory + Gateway)
```

#### Agent Setup

```bash
# 1. Start the task API
cd sample-app/
npm install && npm run dev

# 2. Install agent dependencies
cd sample-app/agent/
pip install -e ".[dev]"

# 3. Run the interactive agent
python scripts/run-agent.py

# 4. Or run the demo (no AWS required)
python scripts/run-demo.py --mock
```

#### MCP Server

The agent connects to the task API via MCP:

```bash
cd sample-app/
npx ts-node src/mcp/server.ts
```

The agent auto-discovers tools (list_tasks, create_task, etc.) via the MCP protocol.

#### Agent Types

| Agent | Location | Description |
|-------|----------|-------------|
| Single Agent (Module 06, Exercise 1) | `sample-app/agent/src/task_assistant/agent.py` | Conversational task manager using `@tool` or MCP |
| Multi-Agent (Module 06, Exercise 3) | `sample-app/agent/src/multi_agent/orchestrator.py` | Planner + executor + reviewer ("agents-as-tools" pattern) |

#### Metrics

Every agent invocation emits a `prism.d1.agent` event to EventBridge with:
- `agent_name`, `steps_taken`, `tools_invoked`, `duration_ms`, `tokens_used`, `status`

#### Testing

```bash
pytest                      # All tests (mocked Bedrock)
pytest tests/test_agent.py  # Agent tests only
pytest tests/test_tools.py  # Tool tests only
```

#### Deploy to AgentCore

```bash
bash sample-app/agent/scripts/deploy-agentcore.sh
```

Options:
- `--plan` — preview deployment changes without deploying
- `--local` — run locally with `agentcore dev`
- `--destroy` — tear down deployed resources
- `-v, --verbose` — verbose output

---

## Troubleshooting

### Git Hooks (deprecated)

> **Note:** Git hooks for AI-origin tagging are being deprecated. The `setup-otel-sync` command provides codeburn-based attribution telemetry that supersedes this approach. Keep hooks installed during migration to maintain backwards compatibility with CI workflows that read trailers.

#### What the Hook Does

Every commit gets trailers appended to the message:

```
feat: add order creation endpoint

AI-Origin: ai-generated
AI-Tool: claude-code
AI-Model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
AI-Input-Tokens: 12450
AI-Output-Tokens: 3200
AI-Cost: $0.08
Spec-Ref: specs/create-order-endpoint.md
```

#### How AI Detection Works

The hook (via `prism-cli git commit-trailers`) checks, in order:

1. **Claude Code**: `CLAUDE_CODE` or `CLAUDE_CODE_SESSION_ID` environment variable
2. **Kiro**: `KIRO_SESSION_ID` / `KIRO_SESSION` env var, `TERM_PROGRAM=kiro` (IDE terminal), or a `kiro` path in `VSCODE_GIT_ASKPASS_NODE` / `GIT_ASKPASS`
3. **Q Developer**: `Q_DEVELOPER_SESSION` environment variable
4. **Default**: No indicators → `AI-Origin: human`

#### Token Tracking

When an AI tool is detected, the hook computes a per-commit delta:

1. Collects lifetime token totals — Kiro sessions are parsed directly by prism-cli; other tools use `codeburn report -p all --format json`
2. Compares against a snapshot from the previous commit (`~/.prism/tokentracker/<project-basename>.json`)
3. Writes the delta as `AI-Input-Tokens` and `AI-Output-Tokens` trailers
4. Saves the new snapshot for next time

If no usage data is available or no AI tool is detected, token trailers are omitted.

#### Safety

- Never blocks a commit — exits 0 even if prism-cli or codeburn is missing or errors
- Only appends trailers — never modifies code
- Skips merge and squash commits
- Won't duplicate trailers if already present

> The hook is a thin bash delegator to prism-cli. It requires only `git` and `bash` (with `prism-cli` on PATH) — **no `jq`, `bc`, or `sed`** — so it works on Linux, macOS, and Windows Git Bash.

### General Issues

| Issue | Solution |
|---|---|
| OIDC auth fails | Verify trust policy `sub` matches `repo:org/repo:*` |
| EventBridge put fails | Check `events:PutEvents` on bus ARN |
| Eval gate always skips | Ensure commits have `AI-Origin:` trailers (install git hooks) |
| Weekly not running | Workflow must exist on default branch; test with `workflow_dispatch` |
| Agent eval skips | No `agent/main.py` found — add `--mock` support to your agent |
| Security Agent timeout | Agent takes 2+ min to start; workflow waits up to 12 min total |

### Security Agent Issues

| Problem | Likely Cause | Fix |
|---|---|---|
| `aws securityagent` command not found | AWS CLI too old | Install from [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — not package managers |
| Agent space not found | CDK not deployed with Security Agent | Run `prism-cli securityagent setup` |
| KMS 403 on agent space creation | `securityagent.amazonaws.com` lacks KMS grants | Add `kms:Encrypt/Decrypt` grant for the service principal |
| Pen test fails at PREFLIGHT | `logs.amazonaws.com` lacks KMS permissions | Grant `kms:Encrypt/Decrypt/GenerateDataKey*/DescribeKey` with log group ARN condition |
| Domain verification stuck (DNS) | DNS not propagated | Wait 5 min; verify with `dig TXT _securityagent.yourdomain.com` |
| Domain verification stuck (HTTP) | Wrong JSON format | Must return `{"tokens": ["<token>"]}` — not `{"token": "..."}` |
| `create-pentest` title rejected | Invalid characters | Only letters, numbers, hyphens, underscores. No spaces. Max 100 chars |
| Pen test start times out | Domain re-verification + Lambda cold start | Warm the verification Lambda first; add retry logic |
| Code review not triggering | Repo is public or not connected | Must be private; re-authorize via web console OAuth |
| GitHub integration CLI fails | OAuth not completed | Initial setup requires web console; CLI only works after OAuth |
| No findings in PRISM dashboards | Webhook misconfigured or eval gate not collecting | Check Lambda logs; verify GitHub variables are set |
| Eval gate not blocking | Security Agent hasn't posted yet | Gate polls for up to 10 min; check if bot posted comments |
| Pen test log group missing | IAM path wrong | Logs go to `/aws/securityagent/<space-name>/pt-<id>`, not `/prism/security-agent/*` |
| `UnrecognizedClientException` | Security Agent not enabled for your account | Request access via your AWS account team |
| `AccessDeniedException` | IAM role needs `securityagent:*` permissions | Add Security Agent permissions to role |

---

## Event Schema

All events flow to the `prism-d1-metrics` EventBridge bus with source `prism.d1.velocity`:

| Detail Type | Emitted By | Trigger |
|---|---|---|
| `prism.d1.commit` | Git hooks | Every commit |
| `prism.d1.pr` | GitHub Actions / Git hooks | PR merge |
| `prism.d1.deploy` | GitHub Actions | Merge to main |
| `prism.d1.eval` | Eval harness / GitHub Actions | Bedrock Evaluation run |
| `prism.d1.assessment` | GitHub Actions | Weekly cron |
| `prism.d1.agent.eval` | Agent eval workflow | Agent evaluation run |
| `prism.d1.security.code_review` | Eval gate (Security Agent) | PR security scan |

---

## Bootstrapper Component Reference

Usage instructions for the copy-me artifacts live in [`bootstrapper/README.md`](bootstrapper/README.md).

**Bundled in the `@prism-d1/cli` npm package** — installed by a `prism-cli bootstrapper install-*` command, no clone needed:

| Directory | What It Contains |
|---|---|
| `bootstrapper/github-workflows/` | Reusable GitHub Actions for metric collection and eval gating |
| `bootstrapper/gitlab-workflows/` | GitLab CI templates for metric collection and eval gating |
| `bootstrapper/eval-harness/` | Bedrock Evaluation rubrics, runner script with `--spec` flag, and the `code-review.md` Kiro steering file |
| `bootstrapper/metric-hooks/` | Git hooks for automatic AI-origin tagging (deprecated — use `setup-otel-sync`) |

**Copy-me artifacts** — present only in a clone of this repo; copy them into your own project by hand:

| Directory | What It Contains |
|---|---|
| `bootstrapper/claude-code/` | CLAUDE.md templates for backend, frontend, platform, and agent teams |
| `bootstrapper/spec-templates/` | Kiro-compatible specification templates (API endpoint, data model, integration, agent workflow, MCP server) |
| `bootstrapper/aidlc-steering/` | AI-DLC development workflow rules for Claude Code, Kiro, and Q Developer |
| `bootstrapper/agent-configs/` | AgentCore Runtime, Memory, Gateway, and Guardrail templates |
| `bootstrapper/security-agent/` | AWS Continuum setup script and configuration |
