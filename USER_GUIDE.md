# PRISM D1 Velocity — User Guide

This guide is for engineering teams adopting AI-native software development practices with PRISM D1 Velocity. It covers infrastructure setup (administrators), developer onboarding, CI/CD workflows, eval gates, security scanning, dashboards, agent development, and the sample workshop application.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Administrator Setup](#administrator-setup)
- [Developer Setup](#developer-setup)
- [CI-CD Workflows (GitHub and GitLab)](#ci-cd-workflows-github-and-gitlab)
- [Eval Gates](#eval-gates)
- [Bedrock Protection Audit](#bedrock-protection-audit)
- [AWS Continuum Security Agent](#aws-continuum-security-agent)
- [Dashboards](#dashboards)
- [Agent Development (MCP + Agent Configs)](#agent-development-mcp--agent-configs)
- [Sample App](#sample-app)
- [Troubleshooting](#troubleshooting)
- [Event Schema](#event-schema)

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
- Inline policy with `events:PutEvents` and `bedrock:InvokeModel` (the latter is granted
  unconditionally, but only `prism-agent-eval.yml` consumes it — the eval gate does not)

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
prism-cli bootstrapper install-github-workflows --region us-west-2

# GitLab — writes to .prism/gitlab-workflows/
prism-cli bootstrapper install-gitlab-workflows --gitlab-url https://gitlab.com --region us-west-2
```

Both platforms get the same eval gate: agentic review via kiro-cli headless plus gitleaks secret
scanning, installed as `prism-eval-gate.yml`. Both require a `KIRO_API_KEY` secret (GitHub) or
masked CI/CD variable (GitLab).

For GitLab, merge `.prism/gitlab-workflows/.gitlab-ci.yml` into your repo root `.gitlab-ci.yml`
afterwards; the installer deliberately does not overwrite an existing pipeline definition.

Pass the **same `--region` you gave `setup-github-oidc` in Step 2**. The OIDC policy scopes
`events:PutEvents` to one region's event bus, and the installer rewrites every region reference in
the workflows it copies — a mismatch is denied at merge time with nothing failing at setup.

> **`--mode bedrock` is retired.** Passing `--mode bedrock` now exits 1 with a migration message.
> The Bedrock eval gate asset has been removed from the GitHub workflow set.

**Eval harness.**

```bash
prism-cli bootstrapper install-eval-harness
```

This installs four things into your repo:

1. `.kiro/steering/code-review.md` — review rules (plain English) used by the kiro-cli eval gate
2. `.github/workflows/prism-eval-gate.yml` — the kiro-cli headless CI workflow
3. `.gitleaks.toml` — starter allowlist for secret scanning
4. `.prism/eval-harness/` — containing `run-eval.sh`, `eval-config.json`, and `rubrics/agent-quality.json`

> **Important:** `.prism/eval-harness/` is now used **only** by `prism-agent-eval.yml` (which scores
> agent output via Bedrock). It is **not** used by the eval gate. The eval gate reads
> `.kiro/steering/code-review.md` for its review rules and runs gitleaks for secret scanning.

The kiro-cli gate needs `KIRO_API_KEY` from the next step and a paid Kiro subscription.
See [Eval Gates](#eval-gates) for full details.

Available flags:

| Flag | Purpose |
|---|---|
| `--region <region>` | AWS region (default `us-west-2`) |
| `--agent-eval-model <id>` | Bedrock model for `prism-agent-eval.yml` |
| `--agent-eval-threshold <n>` | Pass threshold for agent eval (0–1) |
| `--skip-agent-eval-harness` | Skip installing `.prism/eval-harness/` |
| `--uninstall` | Remove all installed files |

> **`--mode` and `--with-rubrics` are retired.** Passing `--mode bedrock` now exits 1 with a
> migration message.

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
| `KIRO_API_KEY` | Kiro API key | https://app.kiro.dev → Settings → API Keys | `prism-eval-gate.yml` |

No repository **variables** are required — the workflows read none. Team identity comes from a file in the repo instead, `.prism/config.json`:

```json
{ "team_id": "team-alpha" }
```

`prism-ai-metrics.yml` reads that file with `jq` and falls back to `no_team` when it is absent, so a missing config downgrades attribution grouping rather than failing the run and losing that PR's facts.

`KIRO_API_KEY` requires a paid Kiro subscription.

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
| `bedrock:InvokeModel` | `*` | `prism-agent-eval.yml`, via `.prism/eval-harness/run-eval.sh` |

`bedrock:InvokeModel` is **not** needed for the eval gate — `prism-eval-gate.yml` calls the Kiro
API with `KIRO_API_KEY` and never touches Bedrock. It is only required if you use
`prism-agent-eval.yml` for agent output scoring.

The eval gate installs to `.github/workflows/prism-eval-gate.yml` and needs only `events:PutEvents`
and `KIRO_API_KEY`.

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
| `prism-eval-gate.yml` | PR open/update | Agentic code review via kiro-cli headless against `.kiro/steering/code-review.md`, plus secret scanning via gitleaks. Needs `KIRO_API_KEY` |
| `prism-agent-eval.yml` | PR modifying agent code | Runs agent in mock mode, evaluates output with `agent-quality.json` rubric via Bedrock |

The eval gate also waits for the AWS Continuum review when it is configured and blocks the merge on
critical or high findings. See [Eval Gates](#eval-gates) for details.

The kiro-cli eval gate asset `prism-eval-gate-kiro.yml` installs **as**
`.github/workflows/prism-eval-gate.yml`. The old Bedrock eval gate asset has been removed.

### GitLab CI Workflows

GitLab workflow files are installed to `.prism/gitlab-workflows/`. Copy or merge `.prism/gitlab-workflows/.gitlab-ci.yml` into your repo root `.gitlab-ci.yml`.

| Job | Trigger | Purpose |
|---|---|---|
| `prism-ai-metrics` | Post-merge | Same as GitHub equivalent |
| `prism-eval-gate` | MR open/update | kiro-cli agentic review + gitleaks secret scan (same as GitHub) |
| `prism-agent-eval` | MR modifying agent code | Same as GitHub equivalent |

The GitLab gate is a port of the GitHub one and behaves identically: the secret scan never skips and
fails closed, while the review reports `SKIPPED` when `KIRO_API_KEY` is absent — which is what GitLab
does for fork merge requests, since it withholds protected variables from them. `bedrock:InvokeModel`
is **not** required by the gate; only `prism-agent-eval` needs it.

### Events Emitted

All three workflows publish to the `prism-d1-metrics` EventBridge bus with source
`prism.d1.velocity`. For the detail types, their emitters and triggers, see
[Event Schema](#event-schema).

### Customization

| Setting | How |
|---|---|
| Branch | Edit `branches` in each workflow |
| AWS region | Reinstall with `install-github-workflows --region <region>`, which rewrites every region reference in one pass. Hand-editing is error-prone — the workflows spell the region three ways (`aws-region:`, `--region`, `AWS_REGION:`) and missing one leaves calls pointed at the old region |

---

## Eval Gates

### Kiro-CLI Eval Gate

```bash
prism-cli bootstrapper install-eval-harness
```

Installs:
- `.kiro/steering/code-review.md` — review rules (plain English)
- `.github/workflows/prism-eval-gate.yml` — kiro-cli headless CI workflow
- `.gitleaks.toml` — starter allowlist for secret scanning
- `.prism/eval-harness/` — `run-eval.sh`, `eval-config.json`, `rubrics/agent-quality.json` (used by `prism-agent-eval.yml` only — **not** by the eval gate)

> **`.prism/eval-harness/` is for agent eval, not the eval gate.** The eval gate reads
> `.kiro/steering/code-review.md` for code review and runs gitleaks for secret scanning. The
> eval harness directory is consumed exclusively by `prism-agent-eval.yml`, which scores agent
> output against `agent-quality.json` via Bedrock.

**Requirements:**
- `KIRO_API_KEY` repository secret (generate at https://app.kiro.dev → Settings → API Keys)
- (Optional) `PRISM_METRICS_ROLE_ARN` for EventBridge metrics + AWS Continuum security scanning

**How it works:**
1. PR opened → workflow triggers
2. **gitleaks installs and scans first**, before anything else runs (see [Secret Scanning](#secret-scanning-gitleaks) for why the order matters)
3. kiro-cli installs **only if the `KIRO_API_KEY` secret is present** — on a fork PR the install is skipped rather than piping `curl` into `bash` for a binary that will never be invoked
4. kiro-cli reads the changed files + the diff via `--trust-all-tools`
5. Outputs structured JSON: findings with file/line, severity, score
6. Gate fails if any high-severity finding, score < 0.82, **or any gitleaks finding**
7. PR comment posted with the review verdict and the secret-scan result

Without `KIRO_API_KEY` the review reports `SKIPPED` — never a silent pass — while the secret scan
still runs and can still block. That is the fork-PR condition, and it is why gitleaks is the gate
with teeth there.

A failing gate does **not** block the merge on its own; see
[Making the Gate Block Merges](#making-the-gate-block-merges).

### Secret Scanning (gitleaks)

The eval gate also performs secret scanning using gitleaks:

- **Pinned version:** 8.28.0 with a hard-pinned verified SHA256 checksum
- **Scan scope:** Only the PR's commit range (`BASE..HEAD`), **not** full repository history
- **Redaction:** Always uses `--redact` — detected secrets are never printed into the CI log
- **Runs first:** gitleaks installs and scans ahead of the kiro-cli install, the review and the Continuum scan. The order is load-bearing rather than cosmetic — the kiro-cli install pipes `curl` into `bash` with no failure guard, so behind it a network blip or an unsupported glibc would abort the job and take out the one gate that needs no secret. It also means a committed credential surfaces without waiting on a model call
- **No skip:** gitleaks never skips. It runs on every PR, including fork PRs (it needs no secret and no AWS role, so it is the **only** gate that functions when `KIRO_API_KEY` is unavailable)
- **Fail-closed:** Install failure, scan error, or any finding fails the gate

**Optional tuning:**
- `.gitleaks.toml` — add allowlist rules (a starter file is installed by `install-eval-harness`)
- `.prism/gitleaks-baseline.json` — adopt on a repo with known pre-existing findings to avoid blocking on them

### Making the Gate Block Merges

**Installing the gate does not, on its own, prevent a bad merge.** A failing check makes the PR
red, but GitHub still reports it as mergeable and the merge button stays enabled unless a **branch
protection rule** names the check as required. Verified behaviour on a PR where the gate detected
committed credentials and exited 1:

```
eval-gate  ->  conclusion=failure
PR         ->  mergeable=MERGEABLE   mergeStateStatus=UNSTABLE
```

`UNSTABLE` means "a check failed but nothing blocks the merge". Until you add the rule the gate is
**advisory** — it reports, it does not enforce.

**GitHub — add the required check:**

Settings → Branches → add or edit a rule for `main` → enable *Require status checks to pass before
merging* → search for and add:

```
eval-gate
```

> **Use the job id, not the workflow name.** The check is named `eval-gate` (the job id in
> `prism-eval-gate.yml`), **not** `PRISM Eval Gate` (the workflow `name:`). Searching for the
> workflow name finds nothing, which reads as though the gate never reported.

The check only appears in that search list after the workflow has run at least once on the branch,
so open a throwaway PR first if the list is empty.

Or with the CLI:

```bash
gh api -X PUT "repos/OWNER/REPO/branches/main/protection/required_status_checks" \
  -F strict=true \
  -f 'contexts[]=eval-gate'
```

**GitLab — add the equivalent:**

Settings → Merge requests → *Merge checks* → enable **Pipelines must succeed**. The gate job fails
the pipeline, so this blocks the merge. Optionally also enable *All threads must be resolved*.

**Why this is left to you rather than automated:** branch protection is a repository administration
setting, and `install-github-workflows` deliberately does not require admin scope. Adding a required
check can also block merges immediately on a repo with pre-existing findings — see
`.prism/gitleaks-baseline.json` under [Secret Scanning](#secret-scanning-gitleaks) for adopting the
gate on a dirty repo without freezing it.

### Bedrock Rubric Eval Gate (Retired)

The Bedrock rubric eval gate has been retired for GitHub. The asset
`bootstrapper/github-workflows/prism-eval-gate.yml` has been deleted.

Passing `--mode bedrock` to `install-eval-harness` or `install-github-workflows` now exits 1 with a
migration message directing you to remove `--mode` and re-run.

GitLab's `bootstrapper/gitlab-workflows/prism-eval-gate.yml` was rewritten in place rather than
deleted, so the job name and the `.gitlab-ci.yml` include path are unchanged and any merge-request
approval rule matching that job keeps working.

### Agent Eval (prism-agent-eval.yml)

`prism-agent-eval.yml` is a separate workflow that scores agent output via Bedrock against
`.prism/eval-harness/rubrics/agent-quality.json`. It is **not** the eval gate — it runs only on PRs
modifying agent code.

Only `agent-quality.json` is installed into repos. Four additional rubrics (`code-quality.json`,
`api-response-quality.json`, `security-compliance.json`, `spec-compliance.json`) still exist in
the CLI's bundled assets as reference material but are **no longer installed**.

### Running Agent Evaluations Locally

The eval harness can be run locally to test agent output scoring:

```bash
# Evaluate agent output against the agent-quality rubric
./.prism/eval-harness/run-eval.sh .prism/eval-harness/rubrics/agent-quality.json src/agent.py
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

`eval-config.json` (used by `prism-agent-eval.yml` only — not the eval gate):

| Field | Description | Default |
|---|---|---|
| `pass_threshold` | Minimum score to pass (0-1) | `0.82` |
| `eval_model_id` | Bedrock model for evaluation | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `aws_region` | AWS region | `us-west-2` |
| `event_bus` | EventBridge bus name | `prism-d1-metrics` |
| `emit_to_eventbridge` | Emit events (workflow handles this) | `true` |

### Rubrics

Only `agent-quality.json` is installed into repos by `install-eval-harness`. Four additional rubrics
are available as reference material in the CLI's bundled assets but are not installed:

| Rubric | Status |
|---|---|
| `agent-quality.json` | **Installed** — used by `prism-agent-eval.yml` |
| `code-quality.json` | Reference only (bundled in CLI) |
| `api-response-quality.json` | Reference only (bundled in CLI) |
| `security-compliance.json` | Reference only (bundled in CLI) |
| `spec-compliance.json` | Reference only (bundled in CLI) |

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

`prism-eval-gate.yml` performs three checks:

1. **Code review** — kiro-cli headless reviews the full PR diff against `.kiro/steering/code-review.md`
2. **Secret scanning** — gitleaks scans the PR's commit range (`BASE..HEAD`) for leaked credentials
3. **Security scan** — waits for the AWS Continuum review when configured

The gate fails on:
- Any high-severity kiro finding or score below threshold
- Any gitleaks finding (secrets detected)
- A critical or high Continuum finding

The gate emits `prism.d1.eval` to EventBridge and posts a PR comment with the results.

A failing gate does **not** block the merge by itself — see
[Making the Gate Block Merges](#making-the-gate-block-merges) for the branch protection rule that
turns it from advisory into enforcing.

kiro-cli does not read commit trailers — it reviews human-written and AI-written code alike,
since AI attribution now comes from codeburn rather than trailers.

gitleaks needs no secret and no AWS role, so it is the only check that runs on fork PRs (where
`KIRO_API_KEY` is unavailable). It fails closed: if gitleaks cannot be installed or errors during
the scan, the gate fails.

### Uninstall

```bash
prism-cli bootstrapper install-eval-harness --uninstall
```

---

## Bedrock Protection Audit

Two read-only commands that audit an account and a repository for LLMjacking exposure — credential
theft aimed at model inference, where a leaked long-lived key is spent on Bedrock. Full rationale,
the layered model and the check-by-check reference are in
**[Bedrock Protection](docs/BEDROCK-PROTECTION.md)**; this section is how to run them.

```bash
# AWS account — IAM credential hygiene + Bedrock spend guardrails (15 checks)
prism-cli bedrock-protection scan-account --region us-west-2

# AWS Organization or specific OUs — IAM per account, Bedrock once at the payer
prism-cli bedrock-protection scan-org --ou ou-1234-abcd5678

# Repository — gitleaks over full history, working tree and commit messages (6 checks)
prism-cli bedrock-protection scan-repo
```

Both are **audit-only**: nothing is provisioned, rotated or deleted. The one non-read AWS call is
`iam:GenerateCredentialReport`, which produces a report artifact — IAM has no way to read the report
without generating it first.

### scan-account

| Option | Default | Purpose |
|--------|---------|---------|
| `--region <region>` | `us-west-2` | Region for Bedrock, CloudWatch and Provisioned Throughput checks |
| `--profile <name>` | ambient credentials | AWS CLI profile to audit |
| `--max-key-age <days>` | `90` | Flag active access keys older than this |
| `--unused-days <days>` | `90` | Flag credentials idle longer than this |
| `--iam-only` | — | Only the 7 IAM credential hygiene checks |
| `--bedrock-only` | — | Only the 8 Bedrock spend guardrail and forensics checks |
| `--json` | — | Machine-readable output |
| `--fail-on <severity>` | `none` | Exit 1 if any FAIL is at or above this severity |

Covers root MFA and root access keys, access key age, console users without MFA,
`AdministratorAccess` attached directly to users, idle credentials, password policy, budgets across
**both** Bedrock billing surfaces, budget alert subscribers, Cost Explorer, cost anomaly detection,
a CloudWatch alarm on `AWS/Bedrock` metrics, Provisioned Throughput commitments, and model
invocation logging.

### scan-org

Audits an Organization, or specific OUs within it. Run from the management account or a delegated
admin.

| Option | Default | Purpose |
|--------|---------|---------|
| `--ou <ids>` | entire organization | Comma-separated OU ids to scope to |
| `--role-name <name>` | `OrganizationAccountAccessRole` | Role to assume in each member account (`AWSControlTowerExecution` in Control Tower orgs) |
| `--region <region>` | `us-west-2` | Region for Bedrock, CloudWatch and Provisioned Throughput checks |
| `--profile <name>` | ambient credentials | Management-account profile |
| `--max-accounts <n>` | `50` | Stop after this many accounts (~10 API calls each) |
| `--session-duration <seconds>` | `3600` | AssumeRole session length (minimum 900) |
| `--max-key-age <days>` | `90` | Flag active access keys older than this |
| `--unused-days <days>` | `90` | Flag credentials idle longer than this |
| `--skip-bedrock` | — | Skip the org-wide Bedrock spend guardrail checks |
| `--skip-guardrails` | — | Skip the SCP and AWS Config organization guardrail checks |
| `--json` | — | Machine-readable output |
| `--fail-on <severity>` | `none` | Exit 1 if any FAIL is at or above this severity |

`scan-org` also runs 9 **organization guardrail** checks that have no single-account equivalent:
whether SCPs are enabled and attached, whether one denies CloudTrail/Config/GuardDuty teardown,
whether one restricts Bedrock by region or denies `bedrock:CreateProvisionedModelThroughput`, and
whether AWS Config organization rules continuously cover the IAM checks this audit only samples.
Attachment is judged against the audited target **plus every ancestor**, since SCPs inherit downward.
These detect presence and attachment, **not enforcement** — inheritance, `NotAction` and
principal-tag exemptions can neutralise a policy that reads correctly, so confirm with a live call.
Skip them with `--skip-guardrails`.

The two account-side layers run at different scopes, deliberately: **IAM hygiene per account** via an
assumed role, and **Bedrock spend guardrails once at the management account**, because under
consolidated billing the payer's budgets bound every linked account. Evaluating budgets per member
account would report "no budget" for every account in an org that is in fact fully covered by one
consolidated budget. The trade-off is stated in the output: a member account holding its own budget
is not detected — run `scan-account --bedrock-only` there if you need that.

Enumeration always recurses into nested OUs, since a non-recursive walk would report on a fraction of
an OU and look complete. An account whose role cannot be assumed is reported **INDETERMINATE, never
skipped**, and the rollup prints explicit coverage (`Org coverage is 3/5`). After assuming,
`sts:GetCallerIdentity` confirms the session landed in the intended account before any finding is
attributed to it.

Needs these in the management account, plus the IAM read actions in each member account's assumed
role:

```
organizations:DescribeOrganization, organizations:ListRoots,
organizations:ListAccountsForParent, organizations:ListOrganizationalUnitsForParent,
organizations:DescribeOrganizationalUnit, organizations:ListParents,
organizations:ListPolicies, organizations:DescribePolicy,
organizations:ListTargetsForPolicy, config:DescribeOrganizationConfigRules,
sts:AssumeRole
```

### scan-repo

| Option | Default | Purpose |
|--------|---------|---------|
| `--repo <path>` | `.` | Repository to scan |
| `--gitleaks <path>` | `$GITLEAKS_PATH`, then `PATH` | Path to the gitleaks binary |
| `--skip-history` | — | Skip the full-history scan (the slow one on a large repo) |
| `--json` | — | Machine-readable output |
| `--fail-on <severity>` | `none` | Exit 1 if any FAIL is at or above this severity |

Requires a `gitleaks` binary. It is **not** auto-downloaded — the CI eval gate fetches a
version-pinned, checksum-verified binary into a disposable container, but a developer CLI silently
pulling an executable onto a workstation is a different risk. Without it the three detection checks
report INDETERMINATE and state that the repository is not cleared.

Honours `.gitleaks.toml` (auto-loaded by gitleaks from the scanned path) and
`.prism/gitleaks-baseline.json`, the same tuning surface as the [eval gate](#eval-gates). When either
is present the report says so, because a silently applied allowlist is indistinguishable from a clean
repository.

**This is a different scope from the CI gate, deliberately.** The gate scans only the PR's commits
(`BASE..HEAD`) so it can go green on a repo with pre-existing findings; `scan-repo` scans all
history, all refs, the working tree including ignored files, and commit message text. A green gate
means nothing new was added — not that the repository is clean.

### Reading the output

Three statuses, and the third one matters:

| Status | Meaning |
|--------|---------|
| ✅ `PASS` | Control present and asserted |
| ❌ `FAIL` | Control absent or ineffective |
| ❓ `INDETERMINATE` | **The check could not run.** Not a pass |

A missing IAM permission, Cost Explorer being disabled, or an absent gitleaks binary all produce
INDETERMINATE. The summary names them and tells you to treat the result as a floor:

```
15 checks: 4 pass, 9 fail, 2 indeterminate
Findings by severity: CRITICAL 1, HIGH 4, MEDIUM 4, LOW 0

❓ 2 check(s) could not run and are NOT passes: budget-alerting, anomaly-monitor
   Treat the result as a floor, not a clean bill of health.
```

Secret values never appear in output. `scan-repo` always passes `--redact` and projects only rule id,
path, line and commit — never the matched value, and never the commit message, which is itself a
scan target.

### Running in CI

```bash
prism-cli bedrock-protection scan-account --json --fail-on HIGH
prism-cli bedrock-protection scan-repo --json --fail-on CRITICAL
```

`--fail-on` reacts only to **FAIL**, never INDETERMINATE — otherwise a missing permission would be
indistinguishable from a real finding. Assert on the indeterminate count in the JSON separately, so a
silently degraded audit does not read as a passing one.

Ready-to-attach IAM policy documents — caller, `scan-org` additions, and the member-account role with
its trust policy — are in
**[Bedrock Protection → IAM policy required to run the audit](docs/BEDROCK-PROTECTION.md#iam-policy-required-to-run-the-audit)**.
All were verified by **creating roles that carry them verbatim and running the audit under those
roles**, not only with the policy simulator: every check reached the same verdict as an admin
session. That step matters — the simulator had passed a budgets statement that is denied in
practice. Simulator results are retained as a second signal (24/24 required allowed, 17/17 dangerous
denied).

Required read-only permissions:

```
iam:GetAccountSummary, iam:GetAccountPasswordPolicy, iam:ListUsers,
iam:ListAttachedUserPolicies, iam:GenerateCredentialReport, iam:GetCredentialReport,
budgets:ViewBudget, ce:GetAnomalyMonitors,
ce:GetAnomalySubscriptions, cloudwatch:DescribeAlarms,
bedrock:ListProvisionedModelThroughputs,
bedrock:GetModelInvocationLoggingConfiguration, sts:GetCallerIdentity
```

`budgets:ViewBudget` covers all three budget read operations the audit calls. Granting the
operation names (`budgets:DescribeBudgets` and friends) instead denies every one of them --
verified live, not inferred.

### Limitations

- No `--fix`. Audit only.
- Single account per invocation; no Organization scope.
- `provisioned-throughput` is region-scoped — a commitment elsewhere will not appear.
- Budget limits are not judged for size. A $1,000,000 Bedrock budget passes.

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
- Used to block the eval gate on **critical or high** findings

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
5. Fails the gate on a **critical or high** finding
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
3. Eval gate workflow collects findings and blocks on critical/high findings
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
| **Agent Eval** | Bedrock rubric scoring (`agent-quality.json`) via `prism-agent-eval.yml` | `bootstrapper/eval-harness/` |
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
| Eval gate skips every file | Possible `KIRO_API_KEY` secret is missing or invalid. Check the workflow log for the kiro-cli exit code |
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
| `prism.d1.eval` | `prism-eval-gate.yml` | PR opened or updated |
| `prism.d1.agent.eval` | `prism-agent-eval.yml` | PR touching agent code |
| `prism.d1.security.code_review` | `prism-eval-gate.yml` (Continuum scan) | PR security scan |
| `prism.d1.assessment` | `api-handler` Lambda | `POST /assessment` |
| `prism.d1.push` | `prism-ai-metrics.yml` | Direct push to main/master (census only, no DORA fields) |
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
| `bootstrapper/eval-harness/` | Agent eval rubric (`agent-quality.json`), runner script with `--spec` flag, and the `code-review.md` Kiro steering file |
| `bootstrapper/metric-hooks/` | Git hooks for automatic AI-origin tagging (deprecated — use `setup-otel-sync`) |

**Copy-me artifacts** — present only in a clone of this repo; copy them into your own project by hand:

| Directory | What It Contains |
|---|---|
| `bootstrapper/claude-code/` | CLAUDE.md templates for backend, frontend, platform, and agent teams |
| `bootstrapper/spec-templates/` | Kiro-compatible specification templates (API endpoint, data model, integration, agent workflow, MCP server) |
| `bootstrapper/aidlc-steering/` | AI-DLC development workflow rules for Claude Code, Kiro, and Q Developer |
| `bootstrapper/agent-configs/` | AgentCore Runtime, Memory, Gateway, and Guardrail templates |
| `bootstrapper/security-agent/` | AWS Continuum setup script and configuration |
