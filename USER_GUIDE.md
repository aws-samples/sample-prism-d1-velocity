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
- **codeburn** — **Required.** `codeburn sync push` is the only writer to the attribution store, so every AI metric depends on it: AI share, AI-to-merge ratio, AI defect rate, cost per shipped commit, Attribution Coverage, the observed PRISM level, and the entire Developer Productivity dashboard. Install: `npm install -g codeburn` (or `brew install codeburn` on macOS), then run `prism-cli bootstrapper setup-otel-sync` to authenticate and install the sync schedule. codeburn is what parses Kiro, Claude Code, Cursor and other tool sessions — prism-cli does not parse them itself.
- **GitHub Actions or GitLab CI** — For CI/CD workflows
- **AWS OIDC** — For secure CI/CD to AWS authentication (set up via `setup-github-oidc` or `setup-gitlab-oidc`)
- **Amazon Bedrock** — Model access must be enabled for code evaluation
- **Python 3.11+** — For the agent (sample-app/agent)
- **AWS account with Bedrock AgentCore access** — For agent deployment

---

## Administrator Setup

### Step 1: Deploy PRISM Infrastructure

Deploy the CDK stacks — EventBridge bus, DynamoDB tables, Lambda processors, the OTEL collector, four CloudWatch dashboards, alarms, and Bedrock Guardrails:

```bash
cd infra
npm install
npx cdk deploy --all --context enableSecurityAgent=true
```

`enableSecurityAgent=true` additionally creates the AWS Continuum scan bucket and the `prism-d1-continuum-ci-scan` managed policy that Step 2 attaches to the OIDC role. Leave the flag off for a metrics-only deployment. On a non-production deployment, add `--context skipVpc=true` to save roughly $35–50/month.

Note the **`OtelCollectorUrl`** and **`OtelUserPoolId`** outputs — you need both in Step 5, and developers need the URL for `setup-otel-sync`.

**Or use the security-agent wrapper.** `prism-cli securityagent setup` runs the same deploy and then performs the Continuum onboarding that would otherwise follow it:

```bash
prism-cli securityagent setup --profile your-profile --region us-west-2
```

Beyond `cdk deploy --all --context enableSecurityAgent=true`, it:

1. Looks up your Continuum agent space
2. Creates the Continuum application if it does not exist, and attaches its execution role
3. Archives the repository to the scan bucket, creates a Code Review resource, and stores its id at `/prism/continuum/code-review-id/<repo-slug>` in SSM

Item 3 is a convenience rather than a requirement — the eval-gate workflow reads that SSM parameter and creates the Code Review itself on its first run if the parameter is missing.

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

Both commands take `--region <region>` (default `us-west-2`), which sets the event bus ARN in the
inline policy. Pass the same region to the workflow installer below, or `events:PutEvents` will be
denied at merge time. See [IAM Permissions Required](#iam-permissions-required).

### Step 3: Install CI/CD Workflows and Eval Harness

Run these from the root of the repository you want instrumented. They only write files — nothing
reaches AWS until you commit them and a PR merges.

**CI/CD workflows.**

```bash
# GitHub — writes three workflows to .github/workflows/
prism-cli bootstrapper install-github-workflows --mode kiro --region us-west-2

# GitLab — writes to .prism/gitlab-workflows/
prism-cli bootstrapper install-gitlab-workflows --gitlab-url https://gitlab.com --region us-west-2
```

`--mode` picks which eval gate to install — `kiro` (the default) or `bedrock`. Only one is written,
as `prism-eval-gate.yml`, because the two modes declare the same check name and trigger. GitLab has
no kiro variant and always gets the Bedrock gate.

For GitLab, merge `.prism/gitlab-workflows/.gitlab-ci.yml` into your repo root `.gitlab-ci.yml`
afterwards; the installer deliberately does not overwrite an existing pipeline definition.

Pass the **same `--region` you gave `setup-github-oidc` in Step 2**. The OIDC policy scopes
`events:PutEvents` to one region's event bus, and the installer rewrites every region reference in
the workflows it copies — a mismatch is denied at merge time with nothing failing at setup.

**Eval harness — same mode.**

```bash
prism-cli bootstrapper install-eval-harness --mode kiro
```

The workflow installed above is the gate; this installs what the gate reads — for kiro mode the
`code-review.md` Kiro steering file, for bedrock mode `.prism/eval-harness/` with its rubrics. Pass
the same `--mode` to both, or the gate runs against rules that were never installed. kiro mode needs
`KIRO_API_KEY` from the next step and a paid Kiro subscription; it is the recommended path and the
only one that does not call Bedrock. See [Eval Gates](#eval-gates) for the difference.

> Upgrading a repo instrumented before `--mode` existed? That installer copied both gates. The new
> one warns if it finds a leftover `prism-eval-gate-kiro.yml` and prints the `rm` to run — it will
> not delete a tracked file in your repo for you.

**Team attribution (optional).** `prism-ai-metrics.yml` reads the team id from `.prism/config.json`
in the repo. Create it by hand — it is a single field, and the git-hook installer that used to
generate it is deprecated:

```json
{ "team_id": "team-alpha" }
```

Without the file, events are emitted under `no_team` rather than failing the run.

Committing the workflows before the next step is safe: without `PRISM_METRICS_ROLE_ARN` the AWS
credential step fails and the job stops before emitting anything.

### Step 4: Configure GitHub Secrets

In GitHub → your repo → Settings → Secrets and Variables → Actions, add two secrets:

| Name | Value | Where to Find It | Used By |
|---|---|---|---|
| `PRISM_METRICS_ROLE_ARN` | ARN printed by `setup-github-oidc` | Step 2 output | All three installed workflows |
| `KIRO_API_KEY` | Kiro API key | https://app.kiro.dev → Settings → API Keys | `prism-eval-gate.yml` only, in kiro mode |

No repository **variables** are required — the workflows read none. Team identity comes from a file in the repo instead, `.prism/config.json`:

```json
{ "team_id": "team-alpha" }
```

`prism-ai-metrics.yml` reads that file with `jq` and falls back to `no_team` when it is absent, so a missing config downgrades attribution grouping rather than failing the run and losing that PR's facts.

If you are not using the kiro-cli eval gate, `PRISM_METRICS_ROLE_ARN` alone is enough. `KIRO_API_KEY` requires a paid Kiro subscription and gates only the kiro-mode `prism-eval-gate.yml`.

### Step 5: Create Developer Accounts

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

You do not need to write these policies — Step 2 attaches both. This is a reference for
review, or for building the role by hand.

**Inline policy `PrismD1WorkshopPolicy`**, created by `setup-github-oidc` / `setup-gitlab-oidc`:

| Permission | Resource | Used by |
|---|---|---|
| `events:PutEvents` | `event-bus/prism-d1-metrics` | All workflows |
| `bedrock:InvokeModel` | `*` | `prism-eval-gate.yml` (Bedrock mode) and `prism-agent-eval.yml`, via `.prism/eval-harness/run-eval.sh` |

`bedrock:InvokeModel` is **not** needed for the recommended kiro-cli gate — in kiro mode
`prism-eval-gate.yml` calls the Kiro API with `KIRO_API_KEY` and never touches Bedrock. If you only
run that gate, `events:PutEvents` is the only permission the metrics path requires.

Both eval modes install to the same path, `.github/workflows/prism-eval-gate.yml`, so which
permissions that file needs depends on the `--mode` you chose in Step 3.

**Managed policy `prism-d1-continuum-ci-scan`**, created by the CDK when you deploy with
`--context enableSecurityAgent=true`, and attached to the same role by Step 2. Required by the
Continuum security-finding gate in both eval-gate workflows:

| Sid | Actions | Resource |
|---|---|---|
| `ContinuumScanAPIs` | `securityagent:CreateCodeReview`, `ListCodeReviews`, `StartCodeReviewJob`, `BatchGetCodeReviewJobs`, `BatchGetCodeReviewJobTasks`, `ListFindings`, `BatchGetFindings` | `agent-space/*` |
| `PassRoleForCodeReview` | `iam:PassRole` (conditioned on `iam:PassedToService = securityagent.amazonaws.com`) | The Continuum service role |
| `ScanBucketWrite` | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` | The Continuum scan bucket |
| `KMSForScanBucket` | `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey*`, `kms:DescribeKey` | The PRISM KMS key |
| `SSMReadConfig` | `ssm:GetParameter`, `ssm:GetParameters`, `ssm:PutParameter` | `parameter/prism/continuum/*` |

`PutParameter` is needed because the eval gate writes the Code Review id it creates back to
`/prism/continuum/code-review-id/<repo-slug>`. KMS appears because the scan bucket is
encrypted with a customer-managed key — bucket access alone is not enough.

If this policy is absent, `setup-github-oidc` says so and the eval gate skips security scanning
rather than failing.

> **Keep the region consistent.** The inline policy scopes `events:PutEvents` to one region's
> event bus, so the OIDC setup and the workflow installer must be given the same region or
> `put-events` fails with AccessDenied at merge time — nothing errors at setup:
>
> ```bash
> prism-cli bootstrapper setup-github-oidc      --region eu-west-1
> prism-cli bootstrapper install-github-workflows --region eu-west-1
> ```
>
> Both default to `us-west-2`, so you can omit the flag entirely if that is where you deployed.
> GovCloud and China regions are rejected — every ARN the bootstrapper builds is hard-coded to
> the `aws` commercial partition.

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
| **Lambda** (11 functions) | $1–3 | Invoked per event; negligible at <50 devs |
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

One command per machine. There is nothing else for a developer to install — no git hooks, no
per-repo configuration, no CI changes.

```bash
npm install -g @prism-d1/cli codeburn
prism-cli bootstrapper setup-otel-sync --url <OtelCollectorUrl>
```

`<OtelCollectorUrl>` is the CDK stack output from Step 1. Your administrator creates your telemetry
account in Step 5, using your email address as the username.

The command authenticates against the Cognito user pool, backfills 30 days of history, then installs
a platform-native schedule — crontab on Linux, LaunchAgent on macOS, Scheduled Task on Windows —
that pushes AI usage **and** per-commit attribution every 12 hours.

| Flag | Purpose |
|---|---|
| `--url <url>` | OTEL collector URL (the `OtelCollectorUrl` stack output) |
| `--interval <hours>` | Sync interval, default `12` |
| `--status` | Show the current schedule |
| `--remove` | Remove the schedule |

**This is required, not optional.** `codeburn sync push` is the only writer to the attribution store,
so every AI metric depends on it: AI share, AI-to-merge ratio, AI defect rate, cost per shipped
commit, Attribution Coverage, the observed PRISM level, and the entire Developer Productivity
dashboard. codeburn is also what parses Kiro, Claude Code, Cursor and other tool sessions —
`prism-cli` does not parse them itself.

**Attribution Coverage is the number to watch first.** The dashboards compare commits CI observed
(a complete census of the repo) against commits attribution captured (only onboarded machines).
Below 80%, every AI metric understates reality, and the fix is getting more developers through this
one command — not changing the dashboard.

Verify with `prism-cli bootstrapper setup-otel-sync --status`. Within one sync cycle the
**PRISM-D1-Team-Velocity** dashboard should show AI-vs-human commit counts and a coverage
percentage.

> Git hooks and commit trailers are deprecated and are not part of developer setup. AI origin now
> comes from codeburn attribution, which is why these metrics survive hook removal. If you are
> migrating off hooks, see [Git Hooks (deprecated)](#git-hooks-deprecated) in Troubleshooting.

---

## CI-CD Workflows (GitHub and GitLab)

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics.yml` | PR merge to main/master | Emits per-PR **facts** — lead time, failure-fix label, review verdicts, commit SHAs. Computes no rates; the dashboard aggregates at query time. Emits `prism.d1.pr` + `prism.d1.deploy` |
| `prism-eval-gate.yml` | PR open/update | The eval gate, in whichever mode you installed. **Kiro mode (default)** does an agentic review via kiro-cli headless against `.kiro/steering/code-review.md` and needs `KIRO_API_KEY`. **Bedrock mode (legacy)** scores changed files against auto-selected rubrics via `bedrock:InvokeModel` |
| `prism-agent-eval.yml` | PR modifying agent code | Runs agent in mock mode, evaluates output with agent-quality rubric |

Either eval mode waits for the AWS Continuum review when it is configured and blocks the merge on
failure. See [Eval Gates](#eval-gates) for the difference in detail.

**Only one eval gate is ever installed.** It ships as two assets —
`prism-eval-gate-kiro.yml` and `prism-eval-gate.yml` — and both
`install-github-workflows --mode <mode>` and `install-eval-harness --mode <mode>` write the selected
one to `prism-eval-gate.yml`. That is deliberate: the two assets declare the same
`name: PRISM Eval Gate` with identical `pull_request` triggers, so having both in
`.github/workflows/` would produce two same-named check runs on every PR, one billing Bedrock and one
billing Kiro. Repos instrumented before `--mode` existed received both; the installer now flags the
leftover file.

### GitLab CI Workflows

GitLab workflow files are installed to `.prism/gitlab-workflows/`. Copy or merge `.prism/gitlab-workflows/.gitlab-ci.yml` into your repo root `.gitlab-ci.yml`.

| Job | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics` | Post-merge | Same as GitHub equivalent |
| `prism-eval-gate` | MR open/update | Same as the GitHub **Bedrock mode** gate |
| `prism-agent-eval` | MR modifying agent code | Same as GitHub equivalent |

There is no GitLab equivalent of the kiro gate — `install-eval-harness` only writes GitHub
workflows, so on GitLab the eval gate is Bedrock mode and `bedrock:InvokeModel` is required.

### Events Emitted

All EventBridge events use source `prism.d1.velocity` and bus `prism-d1-metrics`:

| Detail Type | Source Workflow | Destination |
|---|---|---|
| `prism.d1.pr` | ai-metrics | EventBridge |
| `prism.d1.deploy` | ai-metrics | EventBridge |
| `prism.d1.eval` | eval-gate (either mode) | EventBridge |
| `prism.d1.agent.eval` | agent-eval | EventBridge |
| `prism.d1.security.code_review` | eval-gate (AWS Continuum scan) | EventBridge |
| `prism.d1.assessment` | `api-handler` Lambda, on `POST /assessment` | EventBridge |

`prism.d1.commit` is routed and consumed by the pipeline but **no shipped workflow or hook emits
it** — the git hooks only append trailers to commit messages. The only producer is
`generate-demo-data`, for seeding. Per-commit facts now reach PRISM through codeburn attribution
instead, which is why AI metrics survive hook removal.

### Customization

| Setting | How |
|---|---|
| Branch | Edit `branches` in each workflow |
| AWS region | Reinstall with `install-github-workflows --region <region>`, which rewrites every region reference in one pass. Hand-editing is error-prone — the workflows spell the region three ways (`aws-region:`, `--region`, `AWS_REGION:`) and missing one leaves calls pointed at the old region |

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
- `.prism/eval-harness/run-eval.sh` — evaluation script
- `.prism/eval-harness/eval-config.json` — model, threshold, region
- `.prism/eval-harness/rubrics/` — rubric JSON files
- `.github/workflows/prism-eval-gate.yml` — CI workflow

### Running Evaluations Locally

```bash
# Evaluate a single file
./.prism/eval-harness/run-eval.sh .prism/eval-harness/rubrics/code-quality.json src/handler.ts

# With a spec file (for spec-compliance rubric)
./.prism/eval-harness/run-eval.sh .prism/eval-harness/rubrics/spec-compliance.json src/api.ts --spec specs/api.md
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

`prism-eval-gate.yml` behaves differently depending on which mode you installed. The shared steps:

1. Emits `prism.d1.eval` to EventBridge
2. Posts a PR comment with the results
3. Waits for the AWS Continuum review when it is configured
4. Fails the check on a failing review or a blocking Continuum finding

Where they diverge:

| | Kiro mode (default) | Bedrock mode (legacy) |
|---|---|---|
| **File selection** | The full PR diff — every changed source file is reviewed | Only files touched by commits carrying an `AI-Origin:` trailer |
| **Review rules** | `.kiro/steering/code-review.md`, applied by kiro-cli headless | A rubric auto-selected per file by path match |
| **Per-file scoring** | One review over the diff, with findings by file and line | `run-eval.sh` invoked per file |
| **Fails on** | score below threshold, any high-severity finding, an unparseable review, or a **critical/high** Continuum finding | `overall_result == FAIL`, or **any** Continuum finding regardless of severity |

Two consequences worth knowing. Kiro mode does not read commit trailers at all, so it reviews human-written code in the PR as well — deliberate, since AI attribution now comes from codeburn rather than trailers. And Bedrock mode blocks on a MEDIUM Continuum finding where kiro mode would not.

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
- Tagged with Continuum's own `riskLevel` and, where the finding carries one, a CWE id
- Correlated with AI vs human code origin from codeburn attribution
- Surfaced in Team, Executive, and CISO dashboards
- Used to block the eval gate — on **critical or high** findings in kiro mode, on **any** finding in Bedrock mode

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

### How Eval Gate Integrates Continuum

The eval gate (`prism-eval-gate.yml`) integrates Continuum as a deterministic security scan:

1. Uploads the PR diff to S3 as a `.patch` file
2. Calls `StartCodeReviewJob` with the diff S3 URI
3. Polls `BatchGetCodeReviewJobs` every 30s, up to 60 attempts (30-minute ceiling; scans typically finish in 5-15 min)
4. Calls `ListFindings` to get structured results with risk levels
5. Fails the gate — on **critical or high** findings in kiro mode, on **any** finding in Bedrock mode
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
3. Eval gate workflow collects findings and blocks — on critical/high in kiro mode, on any finding in Bedrock mode
4. Findings forwarded to EventBridge carrying Continuum's `riskLevel` as severity, plus the CWE id as metadata

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
- **Code Review resources are per-repo** — the eval gate creates one on its first run and stores the id in SSM, so pre-provisioning via `prism-cli securityagent setup` is a convenience rather than a prerequisite
- **Design reviews are web-console-only** — not automatable via CLI or GitHub Actions
- **Pen tests take hours** — not suitable for blocking CI pipelines
- **Scans typically take 5-15 minutes** — the workflow polls every 30s for up to 60 attempts, a 30-minute ceiling before it gives up

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

The four CloudWatch dashboards are created by the CDK stack. There is no dashboard JSON to deploy and no `put-dashboard` step — `npx cdk deploy --all` builds them from `infra/lib/dashboard-stack.ts`, so changing a dashboard is a code change rather than a console or CLI operation.

| Dashboard | Audience | Deployed |
|---|---|---|
| `PRISM-D1-Team-Velocity` | Engineering teams, tech leads | Always |
| `PRISM-D1-Executive-Readout` | CTOs, VPEs, engineering directors | Always |
| `PRISM-D1-CISO-Compliance` | CISOs, security leaders, compliance officers | Always |
| `PRISM-D1-Developer-Productivity` | Engineering managers, FinOps | Only when the OTEL collector is enabled |

Metrics are published to the `PRISM/D1/Velocity` namespace. Each metric is emitted twice: once carrying `TeamId` and `Repository` dimensions for per-team views, and once dimensionless for aggregate queries and alarms.

For what each dashboard contains, which store each panel reads from, and screenshots of all four, see the **[Dashboard Guide](docs/DATA-ARCHITECTURE.md#dashboard-guide)**. That is the single source of truth and is kept in step with `dashboard-stack.ts`. The nine alarms that ship by default are listed under [Active Alarms](docs/DATA-ARCHITECTURE.md#active-alarms).

To change a dashboard or an alarm, edit `infra/lib/dashboard-stack.ts` and redeploy.

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
| Agent eval rubric | `.prism/eval-harness/rubrics/agent-quality.json` |
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
| **Workshop** | Module 02: Agent Development | [Workshop Studio catalog](https://catalog.us-east-1.prod.workshops.aws/workshops/d0a8b037-dfe0-4023-9ce2-f5de32ee4c67/en-US) |



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
| GET | /tasks | List all tasks |
| POST | /tasks | Create a task |
| GET | /tasks/:id | Get task by ID |
| PUT | /tasks/:id | Update a task |
| DELETE | /tasks/:id | Delete a task |

#### Workshop Exercises

`sample-app/specs/` ships one spec in Kiro-compatible format, `task-api.md`, covering the CRUD
endpoints above — a worked reference for what a spec looks like when the feature is already built.

The exercise is to author the next spec yourself rather than implement a supplied one. Start from a
template in `bootstrapper/spec-templates/` — `api-endpoint.md` fits a search-and-filter or priority
feature — write it into `sample-app/specs/`, then hand it to your agent:

```
> Read specs/<your-spec>.md and implement all requirements. Write tests first.
```

#### Project Structure

```
sample-app/
  src/
    index.ts            — Express app entry point
    types.ts            — TypeScript interfaces
    routes/
      tasks.ts          — Task CRUD routes
    mcp/
      server.ts         — MCP server entry point
      tools.ts          — MCP tool definitions
      resources.ts      — MCP resource definitions
      auth/
        authorizer.ts   — Scope-based tool authorization
        tool-registry.ts — Tool-to-scope mapping
        session-store.ts — Session state
        audit-logger.ts — Authorization audit trail
  tests/
    tasks.test.ts       — Task CRUD tests
    mcp-server.test.ts  — MCP server + auth tests
    session-store.test.ts
  specs/
    task-api.md         — Implemented spec (reference)
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
4. **Cursor**: `CURSOR_AGENT=1` or `CURSOR_TRACE_ID`, or a `cursor` path in `VSCODE_GIT_ASKPASS_NODE` / `VSCODE_GIT_ASKPASS_MAIN` / `GIT_ASKPASS`. `TERM_PROGRAM` is not usable here — Cursor inherits VS Code's value
5. **Default**: No indicators → `AI-Origin: human`

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
| EventBridge put fails | Check `events:PutEvents` on the bus ARN, and that the region matches the one you passed to `setup-github-oidc` |
| Eval gate skips every file (Bedrock mode) | Bedrock mode only reviews files from commits carrying an `AI-Origin:` trailer. Switch to kiro mode, which reviews the whole PR diff and needs no trailers |
| Agent eval skips | No agent entry point found — the workflow tries `agent/main.py`, `agents/main.py`, then `agent.py`, and each must accept `--mock` |
| Continuum scan never completes | The workflow polls every 30s for up to 60 attempts, then gives up. Check the job status with `aws securityagent batch-get-code-review-jobs` |

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
| No findings in PRISM dashboards | Eval gate not emitting, or the OIDC role lacks the Continuum policy | Check the eval gate job log and `security-agent-processor` Lambda logs; confirm `PRISM_METRICS_ROLE_ARN` is set and `prism-d1-continuum-ci-scan` is attached |
| Eval gate not blocking | Security Agent hasn't posted yet | Gate polls for up to 10 min; check if bot posted comments |
| Pen test log group missing | IAM path wrong | Logs go to `/aws/securityagent/<space-name>/pt-<id>`, not `/prism/security-agent/*` |
| `UnrecognizedClientException` | Security Agent not enabled for your account | Request access via your AWS account team |
| `AccessDeniedException` | IAM role needs `securityagent:*` permissions | Add Security Agent permissions to role |

---

## Event Schema

All events flow to the `prism-d1-metrics` EventBridge bus with source `prism.d1.velocity`:

| Detail Type | Emitted By | Trigger |
|---|---|---|
| `prism.d1.pr` | `prism-ai-metrics.yml` | PR merge |
| `prism.d1.deploy` | `prism-ai-metrics.yml` | Merge to main |
| `prism.d1.eval` | `prism-eval-gate.yml`, either mode | PR opened or updated |
| `prism.d1.agent.eval` | `prism-agent-eval.yml` | PR touching agent code |
| `prism.d1.security.code_review` | `prism-eval-gate.yml` (Continuum scan) | PR security scan |
| `prism.d1.assessment` | `api-handler` Lambda | `POST /assessment` |
| `prism.d1.commit` | *no active producer* | — see note below |

`prism.d1.commit` has no shipped emitter. It is still routed by the pipeline and read by
`security-agent-processor` and `api-handler`, so the plumbing exists, but the git hooks that were
once expected to emit it only ever wrote commit-message trailers. Commit-level facts now arrive via
codeburn attribution into the attribution store instead of over EventBridge.

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
