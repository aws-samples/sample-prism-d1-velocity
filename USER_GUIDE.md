# PRISM D1 Velocity — User Guide

This guide is for engineering teams adopting AI-native software development practices with PRISM D1 Velocity. It covers infrastructure setup (administrators), developer onboarding, CI/CD workflows, eval gates, security scanning, dashboards, agent development, and the sample workshop application.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Administrator Setup](#administrator-setup)
- [Developer Setup](#developer-setup)
- [Using PRISM locally](#using-prism-locally) (where PRISM shows up, commands by job, editor extension, MCP server, Kiro Crew app)
- [Codewatch (Local Git Hooks)](#codewatch-local-git-hooks)
- [Agent Harness Loop](#agent-harness-loop)
- [Local Dashboard](#local-dashboard)
- [Security Agent Setup (enable security)](#security-agent-setup-enable-security)
- [Security Scans from Your Machine](#security-scans-from-your-machine)
- [CI-CD Workflows (GitHub and GitLab)](#ci-cd-workflows-github-and-gitlab)
- [Eval Gates](#eval-gates)
- [AWS Account Advice (aws connect, check, recommend)](#aws-account-advice-aws-connect-check-recommend)
- [Bedrock Protection Audit](#bedrock-protection-audit)
- [Dashboards](#dashboards)
- [Agent Development (MCP + Agent Configs)](#agent-development-mcp--agent-configs)
- [Sample App](#sample-app)
- [Troubleshooting](#troubleshooting)
- [Event Schema](#event-schema)

Every prism-cli command and flag is in the [command reference](docs/CLI-REFERENCE.md), generated
from `--help`. This guide explains what each feature does and how to set it up.

---

## Prerequisites

- **AWS CLI v2** (latest) — For EventBridge event emission and Security Agent. Install from [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — do NOT use package managers.
- **Node.js 22+** — Required for prism-cli and the sample app
- **jq** — For JSON processing in CI/CD workflows and eval harness
- **prism-cli** — Install: `npm install -g @prism-d1/cli`
- **codeburn** — **Required.** `codeburn sync push` is the only writer to the attribution store, so every AI metric depends on it: AI share, AI-to-merge ratio, AI defect rate, cost per shipped commit, Attribution Coverage, the observed PRISM level, and the entire Developer Productivity dashboard. Install and connect it with `prism-cli enable codeburn`, which runs `npm install -g codeburn` when it is missing (or install it yourself, e.g. `brew install codeburn` on macOS), authenticates and installs the sync schedule. codeburn is what parses Kiro, Claude Code, Cursor and other tool sessions — prism-cli does not parse them itself.
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

Note the **`OtelCollectorUrl`** and **`OtelUserPoolId`** outputs — you need both in Step 5, and developers need the URL for `prism-cli enable codeburn`.

**Or let prism-cli set up Security Agent.** `prism-cli enable security` deploys only the Security
Agent resources (after showing a diff and asking), once per machine from any directory; each repo's
Continuum code review is created on its first scan. If you use it, deploy the pipeline above **without**
`--context enableSecurityAgent=true`. See [Security Agent Setup](#security-agent-setup-enable-security).

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

**One role for many repos.** By default the role trusts one repository (GitHub) or project
(GitLab). `--global` creates one role (`GitHubActions-<owner>-all` or `GitLabCI-<group>-all`) whose
trust policy accepts every repo of the GitHub owner (or every project of the GitLab group), which is
simpler to roll out but lets any of those repos assume it. `setup-github-oidc --pin-ids` pins the trust policy to GitHub's
immutable owner and repo ids instead of names, so a deleted and re-created name cannot inherit the
role (private repos may need the `gh` CLI or `GITHUB_TOKEN`). `setup-gitlab-oidc --project-id`
does the same with the numeric project id.

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

Its flags (region, the agent-eval model and threshold, skipping `.prism/eval-harness/`,
`--uninstall`) are in the
[command reference](docs/CLI-REFERENCE.md#prism-cli-bootstrapper-install-eval-harness).

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

After deploying, create a Cognito user for each developer so they can authenticate with the OTEL collector. `prism-cli team` does this for the platform team:

```bash
prism-cli team info                                  # read-only: OtelCollectorUrl, OtelUserPoolId, and the line to send developers
prism-cli team add-developer dev@example.com --dry-run   # the plan: account, region, user pool, email
prism-cli team add-developer dev@example.com             # asks, then creates the user (--yes for scripts)
```

- **`team info`** is read-only. It finds the `PrismD1MetricsPipeline` stack with the same AWS profile and region resolution as `aws check` (`--profile`, `--region`, then `prism-cli aws connect`), and prints its `OtelCollectorUrl` and `OtelUserPoolId` outputs plus a copy-paste line for developers: `prism-cli enable codeburn --url <url>`. `--json` prints the same as JSON. Needs `cloudformation:DescribeStacks`.
- **`team add-developer <email>`** is an AWS write: one Cognito `AdminCreateUser` on the stack's `OtelUserPoolId` (or `--user-pool-id`), with the email as the username. It prints the account, region, pool and email, and asks before creating; `--dry-run` changes nothing. A user that already exists is reported as "already exists, nothing changed". Cognito emails the invite with a temporary password; prism-cli never sees, prints or stores it. Needs `cloudformation:DescribeStacks` (unless `--user-pool-id`) and `cognito-idp:AdminCreateUser`.

The same with the AWS CLI:

```bash
# Create a user (username MUST be the developer's email)
aws cognito-idp admin-create-user --user-pool-id <OtelUserPoolId output> --username dev@example.com
```

Then share the **OtelCollectorUrl** stack output with your developers — they'll need it for setup below. `prism-cli enable codeburn --admin` prints these platform-team steps on any machine without calling AWS.

**Bring your own IdP** (Okta, Entra ID) instead of Cognito:

```bash
npx cdk deploy --all \
  -c otelIssuer=https://login.example.okta.com/oauth2/default \
  -c otelClientId=0oa1b2c3d4 \
  -c otelIdentityClaim=email
```

Your IdP app must be a **public client with PKCE**, register loopback redirect URIs `http://127.0.0.1:19876/callback` (also ports 19877, 19878), and issue **JWT access tokens** (Okta and Entra ID work; Auth0's opaque access tokens are not supported).

**Federate your IdP *inside* Cognito** instead of replacing it. Developers sign in with corporate credentials, but Cognito stays in the path:

```bash
npx cdk deploy --all \
  -c otelIdpName=CorpIdP \
  -c otelIdpIssuer=https://idp.example.com \
  -c otelIdpClientId=your-client-id \
  -c otelIdpClientSecretArn=my-idp-client-secret \
  -c otelIdentityClaim=email
```

Which option to pick:

| | Bring your own IdP (`otelIssuer`) | Federated IdP (`otelIdpName`) |
|---|---|---|
| Cognito user pool | not created | created, IdP added to it |
| Corporate sign-in | yes | yes |
| Machine-to-machine agent client | **not available** | available |

That last row is the deciding factor for most teams. The OAuth resource server and the client-credentials client that the [coding agent](coding-agent/README.md) uses to push its own telemetry are only created on the Cognito path, so `otelIssuer` silently removes the agent's route to the collector. Choose the federated option if you run the coding agent.

Additional flags: `otelIdpClientSecretJsonKey` if the secret holds JSON rather than a plain string, and `otelIdpScopes` (default `openid email`). The first four flags above must be supplied together — the construct throws on a partial set.

**Before deploying**, put the IdP client secret in Secrets Manager. The value never belongs in a context flag or a template:

```bash
aws secretsmanager create-secret --name my-idp-client-secret --secret-string '<client-secret>'
```

**At your IdP**, register Cognito's callback URL:

```
https://prism-d1-otel-<account-id>.auth.<region>.amazoncognito.com/oauth2/idpresponse
```

#### Why `otelIdentityClaim=email` is required here

Commit attribution keys developers on their **git author email**, so identity resolution has to produce an email or each developer appears twice — once holding their AI token spend, once holding their commits.

Cognito ID tokens carry `email`, but **access tokens do not**, and the HTTP API authorizer validates the access token. Without help, the receiver falls back to `username`, which Cognito prefixes with your provider name (`corpidp_alice`). The deploy therefore also creates a **pre-token-generation trigger** that copies `email` into the access token.

The trigger and the flag are co-dependent, and neither works alone:

| Trigger | `otelIdentityClaim=email` | Resolved identity |
|---|---|---|
| yes | no | `corpidp_alice` — trigger is a silent no-op |
| no | yes | `corpidp_alice` — claim absent, falls through to username |
| yes | yes | `alice@example.com` |

`cdk synth` emits a warning if you configure an IdP without the flag. Access token customization requires the Cognito **Essentials or Plus** feature plan; it is unavailable on Lite.

#### Backfilling emails for existing users

The IdP attribute mapping populates `email` on **sign-in**, so anyone who signed in before you added the mapping has `email: null` and keeps resolving to the prefixed username. The trigger fails open by design — those users keep working rather than being locked out of sync — so the fleet converges as people sign in again.

To avoid waiting, set the attribute directly. The next hourly token refresh picks it up with no re-login:

```bash
aws cognito-idp admin-update-user-attributes \
  --user-pool-id <OtelUserPoolId output> --username CorpIdP_alice \
  --user-attributes Name=email,Value=alice@example.com
```

Be aware the mapping **overwrites** `email` on each federated sign-in. If your IdP returns a different address than the one you set, that developer's identity moves again at their next sign-in.

#### Migrating telemetry already stored under the old identity

Switching identities does not move existing data: history stays under `USER#<provider>_<alias>` in `prism-d1-ai-usage` while new spans land under `USER#<email>`, and dashboards show both rows until you reconcile them. `OTEL_SPAN` records expire on their 90-day TTL, but `OTEL_DAY` aggregates persist indefinitely.

If you re-push history instead of copying it, note two things. `codeburn sync push` skips anything already sent, so a genuine re-push needs `codeburn sync reset --confirm` first, and it can only send telemetry still on the developer's disk — older days may no longer exist locally. `OTEL_DAY` counters are also written with DynamoDB `ADD`, so re-pushing into a partition that **already** holds data double-counts it; only re-push into an empty identity.

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

One command per machine. There is nothing else a developer must install for telemetry — no git
hooks, no per-repo configuration, no CI changes. The optional local checks are covered separately in
[Codewatch (Local Git Hooks)](#codewatch-local-git-hooks).

```bash
npm install -g @prism-d1/cli
prism-cli enable codeburn --url <OtelCollectorUrl>
```

`<OtelCollectorUrl>` is the CDK stack output from Step 1; get it from your platform team. Your platform
team creates your telemetry account in Step 5, using your email address as the username.

**Sync modes.** `enable codeburn` saves where your usage goes, once per user, in `~/.prism/codeburn.json`.
Without a flag it asks "Where should your usage go?" on a terminal:

1. **local** (the default): just me, keep it on this machine. codeburn still works locally (the
   dashboard's usage panel, `codeburn web`); no sync endpoint is set up and no schedule is installed.
   With no terminal and no flag, this is the mode.
2. **team**: my team's PRISM, with the collector URL from the platform team. The steps below.
3. **admin**: I'm the platform team setting up PRISM. It prints the platform-team steps and the
   `prism-cli team` commands, and makes no AWS calls.

`--local`, `--url <url>` (team) and `--admin` choose the mode without the question, and a re-run
with a different flag changes it. A machine that already syncs (an endpoint is configured but no
mode is saved) is treated as team. Moving to local leaves an existing endpoint and schedule in place
and says so, because the schedule still pushes; `--local --remove` also removes the schedule.
`--status` shows the mode.

In team mode the command takes these steps, and a re-run reports the ones already done:

1. **Installs codeburn** when it is not on PATH. It prints the exact command
   (`npm install -g codeburn`) and asks first; `--yes` skips the question. With no terminal and no
   `--yes` it stops and prints the command for you to run.
2. **Connects codeburn's sync** with `codeburn sync setup <url>`, which opens a browser to sign in to
   the Cognito user pool. Without `--url`, it uses the URL codeburn is already configured with (and
   does not sign in again), and otherwise asks for one. When codeburn already syncs somewhere, see
   [Changing the collector URL or signing in again](#changing-the-collector-url-or-signing-in-again).
3. **Backfills** 30 days of history (`codeburn sync push --since 30d --attribution`), on first setup
   only.
4. **Installs a platform-native schedule** — crontab on Linux, LaunchAgent on macOS, Scheduled Task
   on Windows — that runs `codeburn sync push --since 7d --attribution` every 12 hours
   (`--interval <hours>` changes it), pushing AI usage **and** per-commit attribution. An existing
   schedule is refreshed in place. On Linux, `--schedule systemd` uses a systemd user timer instead
   of your crontab, and when the crontab cannot be read a systemd user timer is offered (`--yes`
   accepts it).
5. **Reports `codeburn sync status`.**

### Changing the collector URL or signing in again

`--url` is compared with the URL codeburn stores (in `~/.config/codeburn/sync.json`, as given to
`codeburn sync setup` minus a trailing slash) after normalizing both: scheme and host case, the
default port and trailing slashes do not matter. A path or a different port does, so
`https://collector.example.com` and `https://collector.example.com/otel` are different URLs.

- **Same URL:** it asks `codeburn already syncs to <url>. Re-run the sync setup (sign in again)? [y/N]`.
  `--yes` re-runs it without asking. Use this when the sign-in expired or was revoked.
- **Different URL:** it prints `<old> -> <new>` and asks `Reconfigure for the new URL? [y/N]`;
  `--yes` switches without asking.
- **No terminal and no `--yes`** (a script, CI, the dashboard before 1.21.13): it asks nothing, keeps
  the current setup, prints the command that would change it
  (`prism-cli enable codeburn --url <url> --yes`) and carries on with the schedule, exit 0.

In the dashboard, Settings › Usage sync shows the **Current collector** with a **Re-run sync setup**
button. **Sync to team** with a URL, when one is already set, first opens a dialog naming both URLs
(**Switch to <new>**, or **Re-run sync setup for <url>** when it is the same one); confirming runs
`prism-cli enable codeburn --yes --url <url>`. With no URL set yet it runs as before. The page shows
the current URL without a user name or password, and with query values under secret-looking keys
(token, key, secret, sig, password, auth, code) as `REDACTED`; **Re-run sync setup** runs with the
real URL, which the dashboard reads on this machine. Both buttons are refused while codeburn is not
installed (their `--yes` would install it): install it first with **Set up codeburn**.

**Signing in on a remote machine.** `codeburn sync setup` opens a browser on the machine it runs on and
has no no-browser or device-code option. On a remote machine (a dev desktop over SSH, no display) no
browser opens: open the link codeburn prints instead. In the dashboard, the action drawer shows it as
**Open the codeburn sign-in page** (with **Copy link** beside it) while codeburn waits (5 minutes). In
the Kiro Crew app the link opens in a new browser tab through the Kiro Crew page (since 1.21.14 and
app 0.4.2). The sign-in returns to `http://127.0.0.1:<port>/callback` on the machine running codeburn,
so on your laptop that page does not load. Two ways to finish it:

- **Paste the address** (1.21.14): copy the address your browser ended on
  (`http://127.0.0.1:<port>/callback?code=…&state=…`) into **Paste the address your browser ended on**
  and press **Submit**. The dashboard, on the machine running codeburn, sends it to codeburn's
  listener there, and codeburn finishes the setup in the drawer's output. It accepts only an
  `http://127.0.0.1` address on the port and path of the sign-in that is waiting, with that sign-in's
  `state`, and never logs or shows the address.
- **Forward the port** before you sign in: `ssh -L <port>:127.0.0.1:<port> <remote machine>` (the
  drawer names the port).

`--dry-run` prints the plan with the exact commands and changes nothing. `--status` shows codeburn,
the sync config, the schedule, the last sync log lines and `codeburn sync status`. `--remove`
removes the schedule (on Linux both kinds, unless `--schedule` picks one). Every flag:
[`prism-cli enable codeburn`](docs/CLI-REFERENCE.md#prism-cli-enable-codeburn).

**Push now.** `prism-cli export otel` runs the same push the schedule runs
(`codeburn sync push --since 7d --attribution`), streams codeburn's output and exits with codeburn's
exit code. `--since <window>` changes the window (`today`, `7d`, `30d`, `month`, `all`). It stops
with a pointer to `prism-cli enable codeburn` when codeburn is missing or its sync is not set up.

**Check your install.** `prism-cli version` prints the CLI and Node versions, says whether npm has
a newer `@prism-d1/cli` (a 5-second `npm view` that never fails the command; `--offline` skips it),
and warns when another `prism-cli` on PATH shadows this one or has a different version, such as an
old `/usr/bin/prism-cli` from a system Node. `--json` prints the same report. `prism-cli --version`
still prints only the version number.

**This is required, not optional.** `codeburn sync push` is the only writer to the attribution store,
so every AI metric depends on it: AI share, AI-to-merge ratio, AI defect rate, cost per shipped
commit, Attribution Coverage, the observed PRISM level, and the entire Developer Productivity
dashboard. codeburn is also what parses Kiro, Claude Code, Cursor and other tool sessions —
`prism-cli` does not parse them itself.

**Attribution Coverage is the number to watch first.** The dashboards compare commits CI observed
(a complete census of the repo) against commits attribution captured (only onboarded machines).
Below 80%, every AI metric understates reality, and the fix is getting more developers through this
one command — not changing the dashboard.

Verify with `prism-cli enable codeburn --status`. Within one sync cycle the
**PRISM-D1-Team-Velocity** dashboard should show AI-vs-human commit counts and a coverage
percentage.

> The commit-trailer hook (`prepare-commit-msg`) and its token tracker are retired and are not part
> of developer setup. AI origin now comes from codeburn attribution, which is why these metrics
> survive the hook's removal. If you are migrating off it, see
> [Commit Trailers and Token Tracker (retired)](#commit-trailers-and-token-tracker-retired) in
> Troubleshooting.

---

## Using PRISM locally

`prism-cli` is the local command line for PRISM, published on npm as
[`@prism-d1/cli`](https://www.npmjs.com/package/@prism-d1/cli). It needs Node.js 22 or later.

```bash
npm install -g @prism-d1/cli
prism-cli version        # installed version, newer release on npm, other copies on PATH
```

Why checking changes on your machine, with a separate reviewer model, improves PRs, and how to
measure it: [Why Local Code Review](docs/WHY-LOCAL-CODE-REVIEW.md).

### Where PRISM shows up

The local results (codewatch reviews, AI spend, the setup checklist) appear in these tools. All of
them read the same local data as `prism-cli dashboard` and make no AWS calls.

| Feature | VS Code family (VS Code, Kiro IDE, Cursor) | Kiro Crew | Claude Code plugin |
|---|---|---|---|
| Codewatch findings | Yes: Problems markers, status bar counts, the PRISM panel (the dashboard's own pages) | Yes: PRISM sidebar page | Yes: `/prism:findings`, and a summary of the branch's open findings at session start |
| Open a review report | Yes: quick fix and the panel's report links | Yes: on the page (sandboxed) | Yes: `/prism:report` |
| AI spend | Yes: status bar (today), panel (the dashboard's Spend section) | Yes: on the page | Yes: `/prism:spend`, and the [status line](#claude-code-status-line) |
| Setup checklist | Yes: panel (Settings), with the dashboard's Run buttons and confirm dialogs; AWS uploads also ask in a VS Code dialog | Yes: on the page | Yes: `/prism` lists failing items with fix commands |
| MCP tools (`prism-cli mcp`) | No, not from the extension (Kiro IDE can add the MCP server in its own settings) | Yes: the `prism` MCP server, plus the `prism-fix-findings` skill | Yes: the plugin's `prism` MCP server |
| Agent harness loop | Kiro CLI V3 / Kiro IDE: hooks from `prism-cli enable agent-hooks --client kiro` (push gate on, finish gate opt-in, one fix round per prompt; [Kiro CLI and Kiro IDE](#kiro-cli-and-kiro-ide)). Not in the extension | No hooks (Kiro Crew does not load project hooks): the `prism-fix-findings` skill runs `prism_review` | Yes: push gate on by default (blocks secrets and hook tampering, reports other findings); finish gate opt-in ([Agent Harness Loop](#agent-harness-loop)) |
| Notifications / digest | No | Yes: a daily digest, only when something changed | Planned |
| Plugin, slash commands | No | No | Yes: `/prism`, `/prism:findings`, `/prism:report`, `/prism:fix`, `/prism:review`, `/prism:spend`, `/prism:dashboard` |
| Where it runs | With a repo open or without one (machine mode), and on the remote host over Remote-SSH | The Kiro Crew gateway's machine | Wherever `claude` runs |
| Install | `code --install-extension prism-d1-<version>.vsix` (`kiro` or `cursor` instead of `code`), from the [`ext-v*` releases](https://github.com/aws-samples/sample-prism-d1-velocity/releases?q=ext-v&expanded=true) | `prism-cli enable kirocrew` | `/plugin marketplace add aws-samples/sample-prism-d1-velocity`, then `/plugin install prism@prism-d1-velocity` |

The [Claude Code plugin](#claude-code-plugin) bundles the [MCP server](#mcp-server-prism-cli-mcp),
the slash commands, a SessionStart summary and the [harness loop](#agent-harness-loop) hooks. The
[status line](#claude-code-status-line) comes from `prism-cli enable claude-code`, because a plugin
cannot set it. How the harness loop is built is in [Design: the harness loop](docs/DESIGN-harness-loop.md).

### Commands by job

Most features run on a developer machine with no AWS deployment: the
[codewatch git hooks](#codewatch-local-git-hooks), the [local dashboard](#local-dashboard), the
[editor extension](#editor-extension), the [MCP server](#mcp-server-prism-cli-mcp), the
[Kiro Crew app](#kiro-crew-app), the [Claude Code plugin](#claude-code-plugin) and the read-only
[AWS account checks](#aws-account-advice-aws-connect-check-recommend).

| Job | Commands | How-to |
|-----|----------|--------|
| Send AI usage to PRISM | `enable codeburn`, `export otel` | [Developer Setup](#developer-setup) |
| Check changes before they leave your machine | `enable codewatch`, `codewatch report` | [Codewatch](#codewatch-local-git-hooks) |
| Review agent work before it pushes or finishes | `codewatch review`, the Claude Code plugin, `enable agent-hooks` (Kiro CLI/IDE, Claude Code without the plugin) | [Agent Harness Loop](#agent-harness-loop) |
| See results locally | `dashboard`, `mcp`, `enable kirocrew`, the editor extension | [Local Dashboard](#local-dashboard), [Where PRISM shows up](#where-prism-shows-up) |
| Security scans | `enable security`, `security code-review`, `security findings`, `security threat-model`, `security threats`, `security pentest` | [Security Agent Setup](#security-agent-setup-enable-security), [Security Scans from Your Machine](#security-scans-from-your-machine) |
| Check an AWS account | `aws connect`, `aws check`, `aws recommend`, `bedrock-protection scan-account`, `scan-org`, `scan-repo` | [AWS Account Advice](#aws-account-advice-aws-connect-check-recommend), [Bedrock Protection Audit](#bedrock-protection-audit) |
| Platform team | `team info`, `team add-developer`, `bootstrapper setup-github-oidc` and the other `bootstrapper` commands | [Administrator Setup](#administrator-setup) |
| Assess a team | `assessment run`, `assessment web`, `assessment deploy-cdk` | [Assessment Guide](assessment/ASSESSMENT_GUIDE.md) |
| Run the workshop | `workshop verify-setup`, `deploy-infra`, `generate-demo-data`, `run-agent`, `perform-pen-test` | The workshop modules |

Every command and flag, generated from `--help`, is in the
**[command reference](docs/CLI-REFERENCE.md)**, including the deprecated old names. The
[prism-cli Overview](docs/PRISM-CLI-OVERVIEW.md) lists what each command touches in AWS and what it
costs.

### Editor extension

The [editor extension](editor-extension/README.md) works in VS Code, Kiro and Cursor. Its PRISM panel
is the [local dashboard](#local-dashboard) itself: the same Dashboard, Security Agent, AccountGuard
and Settings pages, drawn from the copy of the UI that ships with your installed prism-cli, with the
same Run buttons and confirm dialogs. Starting a Security Agent code review or threat model (an
upload to your AWS account) also asks in a VS Code dialog. The extension also puts this repo's
codewatch findings in the Problems panel and a one-line summary (findings, spend today, setup
warnings) in the status bar. It opens no ports: the panel talks to `prism-cli dashboard
--serve-stdio`, and the status bar reads `prism-cli dashboard --json`. It needs prism-cli 1.21.0 or
later; with an older one the panel and the status bar say only how to update it.

Download `prism-d1-<version>.vsix` (0.2.0 at the time of writing) and its `.sha256` from the
latest [`ext-v*` release](https://github.com/aws-samples/sample-prism-d1-velocity/releases?q=ext-v&expanded=true),
then install it with `code --install-extension prism-d1-<version>.vsix` (or `kiro`, `cursor`).
Checking the download, Remote-SSH, features, settings and security:
[editor extension README](editor-extension/README.md#install).

![The PRISM panel in the editor with demo data: the dashboard's summary cards, the Codewatch table with three repos, and the header with Dashboard, Security Agent, AccountGuard and Settings](assets/images/prism-cli/editor-extension-panel-dark.png)

*The PRISM panel, rendered with made-up demo data.*

### MCP server (prism-cli mcp)

`prism-cli mcp` is an [MCP](https://modelcontextprotocol.io) server that gives an AI agent (Kiro,
Claude Code or any MCP client) the same local data as the dashboard. The client starts it and talks
to it over stdin and stdout and opens no port itself. The one process it can start is the live
dashboard (`prism_dashboard`), on 127.0.0.1 as its child, which it stops when the client closes
stdin and it exits. It makes no AWS or network calls and never runs a fix. It needs prism-cli 1.8.0
or later.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `prism_status` | none | Spend today and this month, setup warning count and the first warning, the latest codewatch review (repo, when, counts), repos with codewatch, sync mode, prism-cli version |
| `prism_findings` | `repo`, `branch`, `limit` (at most 50) | Findings of the latest pre-push review: severity, category, file, line, message, branch, commit, reviewer, time. Default repo: the one containing the client's working directory |
| `prism_spend` | `days` (at most 31) | Today, this month, calls, sessions, top models, top projects (folder names), per-day rows, `updatedAt` and `stale` |
| `prism_report` | `repo` (required), `commit` (default `HEAD`), `format` (`md`, the default, or `html`) | The scan report for the review covering the commit, or the latest review, and which branch and range it covers. `md` returns the text; `html` writes a file under the OS temp directory and returns its path |
| `prism_snapshot` | `open` (default false) | Writes the dashboard as one static HTML file (see [Static snapshot](#static-snapshot)) under a new folder in the OS temp directory and returns its path, and with `open` true opens it when a display is available. Needs prism-cli 1.10.0 |
| `prism_dashboard` | `open` (default true) | Starts `prism-cli dashboard` (127.0.0.1, per-run token) as a child of the MCP server, or returns the one it already started, and returns its URL. Opens the browser only with a display and outside SSH; otherwise it says how to forward the port. The server stops when the MCP server exits. Needs prism-cli 1.10.0 |
| `prism_dashboard_stop` | none | Stops the dashboard `prism_dashboard` started (recorded in `~/.prism/run/dashboard.json`, mode 0600), never another one |
| `prism_setup` | none | The setup checklist: each item's status, detail and a fix command to copy |
| `prism_review` | `repo`, `session`, `scope`, `since` | Runs the [harness review](#agent-harness-loop) now (gitleaks, then the reviewer) and returns its verdict JSON (`schema: "prism.harness.verdict"`). Writes only its result file and session state. Can take up to the reviewer timeout, twice on a retry. Needs prism-cli 1.11.0 |

`repo` is a repo name as the dashboard shows it, or the path to a repo's top level; it must be a repo
the dashboard found (3 levels under your home directory). Spend comes from the dashboard's usage
cache (`~/.prism/cache`, refreshed every 5 minutes while `prism-cli dashboard` runs); the MCP server
never runs codeburn, so when nothing is cached for today it asks you to open the dashboard once.
Finding and report text is written by a reviewer model and quotes code: the tools return it as JSON
fields, cap each message at 2,000 characters and each answer at about 50 KB, and their descriptions
tell the agent to treat that text as data, not instructions. Every answer carries `schema: 1` and
`prism_cli_version`, except `prism_review`, whose `schema` is the verdict's own.

Kiro (`~/.kiro/settings/mcp.json`, or `.kiro/settings/mcp.json` in a workspace):

```json
{
  "mcpServers": {
    "prism": { "command": "prism-cli", "args": ["mcp"] }
  }
}
```

Claude Code: install the [Claude Code plugin](#claude-code-plugin), which registers this server for
you. To add only the server, without the plugin:

```bash
claude mcp add prism -- prism-cli mcp
```

With an nvm install, a client started outside your shell may not have nvm's directory on PATH. Use
the absolute path that `command -v prism-cli` prints as the command, for example
`"command": "/path/from/command-v/prism-cli"`.

### Claude Code plugin

[`claude-plugin/`](claude-plugin/README.md) is a Claude Code plugin (v0.3.2), and
this repository is its plugin marketplace. It runs the [agent harness loop](#agent-harness-loop):
gitleaks and a PRISM review before Claude runs `git push` (on by default), and optionally before
Claude finishes (`finish_gate`, off by default). It registers `prism-cli mcp` as the `prism` MCP server
and adds these slash commands: `/prism` (status), `/prism:findings` (the latest review of this
branch), `/prism:report` (the scan report as an HTML file or Markdown), `/prism:fix [n]` (fix one
finding, or all high and medium ones, in at most 2 rounds), `/prism:review` (run the harness review
now), `/prism:spend` and `/prism:dashboard`.
`/prism:dashboard` starts the live [dashboard](#local-dashboard) on 127.0.0.1 as a child of the
MCP server (Claude Code asks you to approve it), reuses it on the next call, opens it when there is a
display and outside SSH, and stops it when the session ends or with `/prism:dashboard --stop`. The
URL carries the per-run token, so treat it as a secret. `/prism:dashboard --snapshot` writes a
[static snapshot](#static-snapshot) instead, with no server. Its SessionStart
hook adds a short summary of the branch's open findings to Claude's context, capped at 2 KB, with
the finding text quoted. The hook also runs `prism-cli git claude-session-context`, unless your
settings already register that command. Every command treats finding text as untrusted reviewer
output. None of them pushes or bypasses the git hooks. The plugin needs prism-cli 1.11.0 or later
on the PATH Claude Code sees for the harness loop and `/prism:review` (1.10.0 for the rest; with an
older prism-cli the harness hooks do nothing).

```text
/plugin marketplace add aws-samples/sample-prism-d1-velocity
/plugin install prism@prism-d1-velocity
```

The [plugin README](claude-plugin/README.md) covers the nvm `PRISM_CLI` override, how to remove the
old manual SessionStart hook, why a plugin can't set the status line, and how to uninstall.

![The prism_findings tool result for the demo repo checkout-service: the latest pre-push review on main and its four findings (one high command injection, one medium path traversal, two low quality findings)](assets/images/prism-cli/claude-code-findings-dark.png)

![Claude Code's prompt box with the PRISM status line: PRISM checkout-service, 1 high 1 med 2 low, today $12.40, month $187, then the session row](assets/images/prism-cli/claude-code-statusline-dark.png)

*Top: the `prism_findings` tool result that `/prism:findings` turns into a numbered table (rendered
from the real tool output). Bottom: the status line in Claude Code. Both show made-up demo data.*

### Claude Code status line

A plugin can't set Claude Code's status line, so prism-cli does it:

```bash
prism-cli enable claude-code
```

It adds `{"type": "command", "command": "prism-cli statusline", "refreshInterval": 60}` as
`statusLine` in `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that is set.
When `prism-cli` (and `node`) are not on the PATH a process started outside your shell gets, as
with nvm or Volta, the command uses absolute paths instead. Before it writes, it prints the plan and
a diff, saves a copy as `settings.json.bak-<timestamp>` and asks; `--yes` skips the question, and
without a terminal it stops unless you pass `--yes`. Every other key is kept. If a status line that
isn't PRISM's is already set, it shows it and stops; `--replace` swaps it, and `--uninstall` removes
PRISM's and puts the old one back from the backup. `--dry-run` prints the plan and writes nothing,
and `--status` shows the status line, whether the plugin is installed and where `prism-cli mcp` is
configured. It never installs the plugin; it prints the `/plugin` commands when the plugin is
missing.

`prism-cli statusline` is what Claude Code runs. It reads Claude Code's status JSON on stdin and
prints two lines:

```text
PRISM codewatch-demo · 2 high 1 med · today $34.08 · month $480
session $1.20 · +156/−23 · ctx 42% · cache 91% · Opus
```

The first row is the repo containing the session's working directory, the newest codewatch pre-push
review for the checked-out branch (else the newest of any branch, with its name in brackets) and
spend from the dashboard's usage cache. The second row comes from Claude Code itself: session cost,
lines added and removed, context used, prompt cache hit ratio and model. It reads only those two
cached files and never runs codeburn, git or a network call, so it stays around the cost of starting
Node (about 50 ms). When the usage cache is missing, or more than 5 minutes old, it shows
`usage: run prism-cli dashboard` (dimmed, with the older figures when there are any). It drops
segments to fit `COLUMNS`, colours high findings red and medium amber unless `NO_COLOR` is set,
links the findings to the review's result file (OSC 8, for terminals that support it), and strips
control characters from anything it takes from result files. Bad or empty input prints `PRISM` and
exits 0. `--no-session` prints only the first row and `--json` shows what it would print and which
files it read.

### Kiro Crew app

[`kirocrew-app/`](kirocrew-app/README.md) is a [Kiro Crew](https://github.com/kirodotdev/KiroCrew)
app. It registers the `prism-cli mcp` tools as the `prism` MCP server and finds a `prism-cli`
installed with nvm or Volta even when Kiro Crew's PATH lacks it. It also adds a **PRISM** sidebar
page that is the [local dashboard](#local-dashboard) itself: the same Dashboard, Security Agent,
AccountGuard and Settings pages with the same Run buttons and confirm dialogs, drawn from the copy of
the UI that ships with your installed prism-cli in a sandboxed frame. Its reads and actions go
through the gateway's own authenticated routes to `prism-cli dashboard --serve-stdio`, which checks
them with the browser dashboard's code. While the app is enabled, the gateway keeps that one
`--serve-stdio` process running (restarted with backoff if it exits, and on a prism-cli update) and
stops it when the app is disabled or the gateway stops; it opens no port. Starting a Security Agent
code review or threat model (an
upload to your AWS account) needs the same confirmation as in the browser. The app also adds the
`prism-fix-findings` skill, which has an agent read the latest codewatch review before it finishes,
fix the real issues in at most 2 rounds and report the rest. The third part is a daily 09:00 digest
that runs as a script, with no model call. The digest notifies only on a new high finding, on
today's spend above a threshold you set (off by default), or on a setup item that went from ok to
warn or missing. It needs Kiro Crew 0.12.1 or later and prism-cli 1.21.3 or later; with an older
prism-cli the page shows only how to update it. Installed from the Kiro Crew App Store, the app
checks for that prism-cli itself and, when it is missing or older, installs it with
`npm install -g @prism-d1/cli@^1.21.3` (see [What the install does](kirocrew-app/README.md#what-the-install-does)).

![The PRISM page in Kiro Crew with demo data: the dashboard's summary cards and Codewatch table](assets/images/prism-cli/kirocrew-app-page-dark.png)

![The PRISM page with demo data: a Security Agent code review's findings](assets/images/prism-cli/kirocrew-app-findings-light.png)

*The PRISM page: the Dashboard (top) and a Security Agent run's findings (bottom). Both show made-up demo data.*

Install it with prism-cli, which bundles the app:

```bash
npm install -g @prism-d1/cli@latest && prism-cli enable kirocrew
```

The command prints its plan (install, update or already current, with the versions) and asks first (`--yes` skips the question, `--dry-run` only prints
the plan). It copies the bundled app to `~/.prism/kirocrew-app` and runs `kirocrew app install`
or `kirocrew app update prism --source ~/.prism/kirocrew-app`, then `kirocrew app enable prism` on
a first install. It does not install Kiro Crew. Two steps stay with you: trust the app and approve
`/api/apps/prism/*` under **Apps → PRISM** in the Kiro Crew dashboard, then reload the dashboard
to see the **PRISM** sidebar entry. `prism-cli enable kirocrew --status` shows the installed and
bundled versions, the source folder, the API grants, the digest cron and the steering note. `--uninstall` removes
the app and keeps its data; add `--purge-data` to delete the data too.

The command also writes a short steering note, `~/.kiro/steering/prism-codewatch.md`. That folder is
the global steering root of kiro-cli, Kiro IDE and Kiro Crew, so the note applies to all three. Kiro
Crew loads skills only on demand, so without the note its agents never load `prism-fix-findings`.
The note tells an agent that changes code in a repo with a `.prism/` folder to check the change
before it reports done or pushes: with the `prism-fix-findings` skill where it exists, else with
`prism-cli codewatch review` (exit 0 pass, 3 fix and rerun, 4 stop), and not again when the PRISM
harness hooks already ran the review. `prism-cli enable agent-hooks --client kiro` writes the same
note. A note with the line
`<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->` is replaced when it is
out of date; a file there without that line is yours and is never changed. The App Store install
writes it with the same rules. `--status` and the Settings view show it as installed, outdated,
missing or yours, and an outdated or missing note is a Needs you item. `--uninstall` removes it
only when it carries that line; you can also delete the file. See
[The steering note](kirocrew-app/README.md#the-steering-note). `prism-cli version` and the
dashboard's Settings view say when the installed app is older than the one bundled with your
prism-cli.

To install from a local folder instead, for example a clone you are changing, see
[Install from a folder](kirocrew-app/README.md#install-from-a-folder) in the app README. What the
app can access, its settings and the digest rules are there too.

---

## Codewatch (Local Git Hooks)

Codewatch is an optional pair of git hooks that check your changes on your own machine, before CI
sees them. Telemetry does not depend on it, and the CI eval gate runs with or without it. It
replaces the retired commit-trailer hook.

| Hook | What it does | Blocks? |
|---|---|---|
| `pre-commit` | gitleaks scan of the staged changes | Yes, on a finding |
| `pre-push` | AI code review of the pushed changes with kiro-cli or Claude Code | No, report only |

Every run writes a result file to `.prism/results/`, so you can see later what was checked and what
was bypassed.

### Prerequisites

- **prism-cli** on PATH (`npm install -g @prism-d1/cli`). The hooks call it to scan, review and
  record results.
- **gitleaks** for the pre-commit scan: `brew install gitleaks` on macOS, `scoop install gitleaks`
  on Windows, or a release binary from
  [github.com/gitleaks/gitleaks/releases](https://github.com/gitleaks/gitleaks/releases) on your
  PATH. Without it, commits still go through with a warning (see
  [What the Hooks Do](#what-the-hooks-do)).
- **A reviewer** for the pre-push review: kiro-cli or Claude Code (`claude`). One is enough.
  Claude Code users do not need kiro-cli.

### Install

Per repo, from inside the clone:

```bash
prism-cli enable codewatch                     # detects kiro-cli / claude on PATH
prism-cli enable codewatch --reviewer claude   # or set the team default explicitly
```

This installs the two hooks into the repo's hooks directory and adds these files:

| File | Purpose | Commit it? |
|---|---|---|
| `.prism/review/rules.md` | Review rules. Copied from `.kiro/steering/code-review.md` when that exists, otherwise the bundled default. An existing file is kept | Yes |
| `.prism/config.json` | `eval.reviewer` is the team default reviewer. Other keys in the file are kept. It holds no account details, so it stays safe to commit (`enable security` writes `~/.prism/security.json`, and `--repo` the per-developer `.prism/security.local.json`) | Yes |
| `.gitleaks.toml` | Starter allowlist for gitleaks false positives. An existing file is kept | Yes |
| `.gitignore` | Gains a `.prism/results/` entry | Yes |

If the repo already has a `pre-commit` or `pre-push` hook, it is renamed to `<hook>.pre-prism` and
runs first; if it fails, its exit code stops the hook as before. A `.prism/gitleaks-baseline.json`,
if present, is passed to gitleaks as a baseline of accepted findings.

For every repo on the machine at once:

```bash
prism-cli enable codewatch --global
prism-cli enable codewatch --global --reviewer kiro   # also sets git config --global prism.reviewer
```

`--global` writes the hooks to `~/.prism/hooks` and sets `git config --global core.hooksPath` to
that directory. In each repo, codewatch runs first and then the repo's own `.git/hooks/<hook>`, whose
exit code passes through. Results are excluded locally through `.git/info/exclude` instead of
`.gitignore`, and a repo with no `.prism/review/rules.md` is reviewed against the bundled rules.

| Option | Effect |
|---|---|
| `--force` | With `--global` only. If another tool already set a global `core.hooksPath`, the install is refused; `--force` saves that value, replaces it, and runs that directory's hooks after codewatch. `--global --uninstall` restores it |
| `git config prism.codewatch false` | Run in a repo to opt it out of codewatch, with the per-repo or the global hooks. Its own `.git/hooks` still run. `git config --global prism.codewatch false` turns codewatch off everywhere unless a repo sets it back to `true` |

Running `enable codewatch` in a repo that the global hooks already cover installs the per-repo hooks
into `.git/hooks`. git does not run them while the global `core.hooksPath` is set, so nothing runs
twice.

### Choosing the Reviewer

The pre-push hook picks a reviewer in this order:

1. `git config prism.reviewer <kiro|claude>`: git reads it from the clone first (`--local`, an
   override for this repo, never committed), then from your global git config (`--global`, your
   default for every repo). Either one wins over the team file.
2. `eval.reviewer` in `.prism/config.json`: the team default, set by `enable codewatch`.
3. Whichever of kiro-cli and claude is on PATH.

If the chosen tool is not installed, the other one is used and the substitution is printed and
recorded. With neither installed, the push goes through and the result records "no reviewer".
`enable codewatch` asks which to use when both are installed and no `--reviewer` was given (without a
terminal, or with `--yes`, it keeps the existing setting, or picks claude).

`.prism/config.json` also accepts `eval.timeout_seconds` (default 300).

### Choosing the Review Model

```bash
prism-cli enable codewatch --model claude-sonnet-4.5     # syntax example: pin a model for this repo (eval.model)
prism-cli enable codewatch --model auto                  # clear it: the reviewer's own default
prism-cli enable codewatch --global --reviewer claude --model sonnet   # your Claude Code default for every repo
```

The model ids above are examples; list the ones your kiro-cli offers with
`kiro-cli chat --list-models`. Claude Code takes aliases such as `sonnet`, `opus` and `haiku`, or a
full model name.

- `--model <id>` writes `eval.model` in `.prism/config.json`, next to `eval.reviewer`; other keys are
  kept. The id must match `^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$` (1 to 100 characters, never a
  leading `-`, which the reviewer CLI could read as a flag), the rule the CI eval gate applies; anything
  else is refused and nothing is written. `--model auto` or `--model default` removes the key, so
  kiro-cli runs with `auto` and Claude Code with its own default.
- In a terminal without `--model`, `enable codewatch` asks after the reviewer is chosen. For kiro-cli
  it lists the first models `kiro-cli chat --list-models` reports; for Claude Code it offers
  `sonnet`, `opus` and `haiku`. Both lists start with "default (recommended)" and end with "other
  (type an id)". Enter keeps the current setting. Without a terminal, or with `--yes`, nothing is
  asked and `eval.model` is left as it is.
- `--global --model <id>` sets your own default for one tool, `git config --global prism.<tool>Model`
  (`prism.kiroModel` or `prism.claudeModel`). The tool is `--reviewer`, else your global
  `prism.reviewer`, else the only reviewer on PATH; with none of these the command refuses.
  `--global --model default` unsets that tool's key.

A model id belongs to one tool, and it is never passed to the other one:

- `eval.model` belongs to `eval.reviewer`, the tool it was chosen for. When a push is reviewed by
  the other tool (a per-clone `git config prism.reviewer`, or a fallback because the team's tool is
  not installed), the hook skips it and prints one line such as
  `prism: model sonnet was set for claude; using kiro default`. Running `enable codewatch` with a
  different `--reviewer` removes a model that was set for the old one.
- `prism.kiroModel` is read only when kiro-cli reviews, and `prism.claudeModel` only when Claude
  Code does.

The pre-push review picks the model for the tool that actually runs, in this order:

1. `eval.model` in `.prism/config.json`, when it was set for this tool (or `eval.reviewer` is
   unset): the team's pin. `auto` or `default` here also stops the search, with the reviewer's
   default.
2. `git config prism.<tool>Model`: this clone's value (`--local`), else your default (`--global`),
   for repos that pin none.
3. The reviewer's default: `auto` for kiro-cli, Claude Code's own default for claude.

An invalid value at either level is ignored, with a note in the hook output. The hook prints the
model (`reviewing work against origin/work with kiro-cli, model auto ...`), and the dashboard's
Settings › Repos tab, each repo's page and the `prism_setup` MCP tool show it beside the reviewer.

The CI eval gate uses its own order: the `PRISM_REVIEW_MODEL` repository variable, then `eval.model`
from the **base branch's** `.prism/config.json` (so a PR cannot change the model that reviews it),
then `auto`. CI always runs kiro-cli and reads `eval.model` whichever tool it was set for, so a team
whose `eval.reviewer` is claude should set `PRISM_REVIEW_MODEL` for CI. It never reads
`prism.<tool>Model`. See [Kiro-CLI Eval Gate](#kiro-cli-eval-gate).

### Changing the Reviewer and Model

```bash
prism-cli codewatch reviewer                                        # what a push here uses, and where each value comes from
prism-cli codewatch reviewer --reviewer claude --model sonnet        # override for this repo (git config --local)
prism-cli codewatch reviewer --scope global --reviewer claude --model sonnet   # your default for every repo (git config --global)
prism-cli codewatch reviewer --scope team --model auto               # the team file (.prism/config.json eval); commit it
prism-cli codewatch reviewer --reset                                 # this repo follows your default again
```

`--reset` removes the settings at its scope (`--scope global --reset` removes your default).
`--clear-overrides <dir...>` removes each listed repo's own `prism.reviewer` and `prism.<tool>Model`
so they follow your default; it never touches `.prism/config.json`. The same rules apply as above:
the reviewer comes from this repo's override, then your default, then the team file, then the
installed tool; the model comes from the team's `eval.model` (when it was set for the reviewer that
runs), then this repo's override, then your default, then the tool's default. kiro-cli's
`chat --list-models` answers from your account, so neither the CLI nor the dashboard offers it
offline; the dashboard suggests Claude Code's documented aliases.

In the dashboard, a repo's page has a **Reviewer and model** block in its Repo settings card. It
shows the reviewer and model a push there uses, where each comes from (**overridden for this
repo**, **your default**, **team file** or **tool default**), whether that tool is installed, and,
when the chosen tool is missing, the one that runs instead. **Change** offers **Override for this
repo** (the default choice), **Use my default** (removes the override) and **Team default**. The
team default warns that `.prism/config.json` is a repo file to commit, which the CI eval gate reads
too, and shows the diff before saving and again in the confirm dialog. Picking a personal model
while the team pins one for the same reviewer says that the pin wins and offers the team default.
**Which setting wins** spells out the order. The model field takes an id or `auto`, and a value
that breaks the model id rule is refused on the page and again on the server.

![The Reviewer and model block of the demo repo with the team default chosen: the repo-file warning and the .prism/config.json diff before saving](assets/images/prism-cli/dashboard-codewatch-reviewer-dark.png)

**Settings › Repos** starts with **Codewatch default reviewer and model**: your default
(`git config --global prism.reviewer` and `prism.<tool>Model`) with **Change my default** and
**Remove my default**, then the repos that override it, each with a link and **Reset to default**.
**Apply my default to all repos** removes every override, after a confirm dialog that lists the
repos it changes; team files are never touched. Each row in the repos table links to that repo's
page to change it. Every change runs `prism-cli codewatch reviewer` as a fixed command, with the
reviewer and model checked by the server.

![Settings › Repos with demo data: Codewatch default reviewer and model (Claude Code, sonnet for Claude Code, tool default for kiro-cli) with Change my default and Remove my default, one repo that overrides it with Reset to default, and Apply my default to all repos](assets/images/prism-cli/dashboard-settings-repos-reviewer-dark.png)

### What the Hooks Do

**pre-commit** runs `gitleaks protect --staged` on the staged changes, using `.gitleaks.toml` and
the baseline when present. A finding blocks the commit and lists the rule and file. To proceed:
remove the secret (and rotate it if it is real), allowlist a false positive in `.gitleaks.toml`, or
bypass once with `git commit --no-verify`.

If gitleaks is not installed, the commit is **not** blocked. The hook prints a warning that the
commit was not scanned and records the run as `skipped` with reason `gitleaks-missing`.

**pre-push** reviews what the push adds. For each pushed branch it diffs `base...tip`, where `base`
is the branch's upstream, else what the remote already has for that branch, else the remote's
default branch (a first push), else the commits that are on no remote; when none of the history is
on a remote, the whole tree is reviewed. Lock files are left out of the diff. A diff over 200,000 characters
is cut to that length before review, and the result says so. The reviewer reads the diff against
`.prism/review/rules.md` and the hook prints a short summary.

The pre-push hook never blocks a push: findings, a missing reviewer, a crash or a timeout all exit
0. It also checks each pushed commit for a matching pre-commit scan, and records any commit without
one as skipped (a `--no-verify` commit, or a rebase, cherry-pick or merge that runs no commit hook).

### Results

Each run writes one JSON file to `.prism/results/` in the repo: the kind (`secrets` or `review`), the
hook, a status (`ok`, `findings`, `error`, `skipped`), the tool and model, the commit and branch, and
the findings. The directory is gitignored (per repo) or excluded locally (with `--global`): results
are per-developer evidence and are never committed.

### CI

CI keeps using kiro-cli, whichever reviewer developers use locally. When `.prism/review/rules.md`
exists, the eval gate copies it over `.kiro/steering/code-review.md` before reviewing, so local and
CI reviews use the same rules. See [Eval Gates](#eval-gates).

### Uninstall

```bash
prism-cli enable codewatch --uninstall           # this repo
prism-cli enable codewatch --global --uninstall  # the global hooks
```

The per-repo uninstall removes the hooks and restores any `<hook>.pre-prism` they replaced. It keeps
`.prism/review/rules.md`, `.prism/config.json` and `.prism/results/`; delete them by hand if
unwanted. The global uninstall restores the previous global `core.hooksPath` (or unsets it) and
removes the scripts from `~/.prism/hooks`. It never touches repo-local hooks.

`prism-cli bootstrapper install-git-hooks` is a deprecated alias for `enable codewatch` (its old
flags are accepted and ignored; see the
[command reference](docs/CLI-REFERENCE.md#prism-cli-bootstrapper-install-git-hooks)). Installing
codewatch over the retired `prepare-commit-msg` trailer hook removes it.

### Scan Reports

`prism-cli codewatch report` writes a report for one pre-push review: the pushed range, the
reviewer, the findings grouped by file and attributed to commits, the secret scan of each commit in
the range, and any gitleaks blocks during the push. It reads `.prism/results/` and needs no server.

```bash
prism-cli codewatch report                               # newest review in this repo, Markdown
prism-cli codewatch report --commit 1a2b3c4d             # newest review whose push included this commit
prism-cli codewatch report --format html --output scan.html
```

`--id <result-id>` picks a review by its file name in `.prism/results/` without `.json`; `--commit`
is not allowed with `--id`. Every flag:
[`prism-cli codewatch report`](docs/CLI-REFERENCE.md#prism-cli-codewatch-report).

Reports never contain secret values: results store only the gitleaks rule and location. The same
reports are linked from the dashboard (see [Local Dashboard](#local-dashboard)).

---

## Agent Harness Loop

The harness loop runs the codewatch review inside an AI agent's own loop, so the agent sees and
fixes its findings before a person pushes. It ships in prism-cli 1.11.0 for Claude Code (the
[plugin](#claude-code-plugin), v0.3.0) and for any MCP client (`prism_review`), and in 1.12.0 for
Kiro CLI V3 and the Kiro IDE ([Kiro CLI and Kiro IDE](#kiro-cli-and-kiro-ide)), with an installer
for clients without a plugin ([Installing the hooks](#installing-the-hooks-enable-agent-hooks)).
The design, and what later releases add for Cursor and Codex, is in
[DESIGN-harness-loop.md](docs/DESIGN-harness-loop.md).

One engine command does the work: `prism-cli codewatch review --json`. On each run it:

1. Takes the diff. In an agent session that is the lines the agent changed since the session
   started (the plugin's SessionStart hook snapshots the working tree into
   `.git/prism/harness/<session>.json`, so your own uncommitted work is not blamed on the agent). Without
   a session it is the branch against its upstream plus uncommitted changes. At a push it is every
   commit the push would send: against the upstream, else the remote branch the push names, else
   the remote's default branch (`HEAD`, `main` or `master`), else the commits on no remote, and when
   none of the history is on a remote, the whole tree. A push whose
   target the command does not name (`--all`, several refspecs) is held. An empty diff passes
   at once, with no cost.
2. Stops (`stop`, `human_why: tamper`) if the session changed PRISM's or gitleaks' own
   configuration: `.gitleaksignore`, `.gitleaks.toml`, the gitleaks baseline, `.prism/config.json`,
   the review rules, the eval-gate workflows, client hook files, or an added
   `gitleaks:allow`. A person decides those.
3. Runs gitleaks on the changed files, redacted. Only file, line and rule are kept; the secret
   value never reaches the reviewer, the agent or the result file. When gitleaks is missing the
   verdict says `secrets_scanned: false` with a warning: the secret check did not run, which is not
   the same as passing it. At a push, gitleaks also scans every commit the push would send, so a
   secret that one commit adds and a later commit removes still holds the push: the person rotates
   the key and rewrites the unpushed history first.
4. Runs the AI review with the same reviewer and model choice as the pre-push hook
   ([Choosing the Reviewer](#choosing-the-reviewer), [Choosing the Review Model](#choosing-the-review-model)),
   unless a secret was found (the diff is not sent to a model) or only docs changed. An unparseable
   reply is retried once, as in the CI gate. An unchanged diff is not reviewed again: the review is
   cached by diff hash for 24 hours.
5. Answers `pass`, `fix` or `stop` and writes a result (`kind: agent-harness`) to `.prism/results/`.

What blocks a push: only secrets. The agent's `git push` is denied for a secret in the changed
lines or in any commit the push would send, a secret scan that failed or did not finish, a change
to the checks themselves (gitleaks config, a `gitleaks:allow` marker, hook or PRISM config), or a
push that does not say what it sends (`--all`, `--mirror`, a glob). Review findings, high ones
included, never deny a push: it goes ahead, you see the findings, and the agent gets them as
context to fix in a follow-up.

What blocks finishing (the finish gate, when you turn it on): a secret, and high findings, in the
lines the agent changed. Medium and low findings are reported but do not block, unless the team
adds `"medium"` to `harness.block_on`, which applies to the finish gate only. A finding on a line
the agent did not change never keeps it working.

The agent gets at most 2 fix rounds per session (`harness.max_rounds`, at most 3), counted by
prism-cli, not by a prompt. After that,
or when the agent tries again without changing anything, the answer is `stop` and the agent reports
what remains to you.

If the reviewer is missing, times out, crashes or replies with nothing usable twice, the loop fails
open: the verdict is `pass` with a visible warning and `fail_open: true`, because the git pre-push
review and the CI gate still run. A secret always blocks the agent's push, whether the reviewer
works or not.

The git hooks for people do not change: `pre-push` stays report-only and never blocks you.

### Gates in Claude Code

| Gate | Hook | Default | What it does |
|---|---|---|---|
| Push gate | `PreToolUse` on Bash commands that contain `git` and `push` (also behind `env`, `git -C dir`, `sh -c`) | on | Runs gitleaks and the review before Claude's `git push`. Only a secret, a failed secret scan, a change to the checks or a push that does not say what it sends denies the push, and the reason tells Claude to tell you which hook blocked it. Review findings let the push go ahead and come back to Claude as context. The hook also denies `git push --no-verify`, `git -c core.hooksPath=...` and `git config prism.*` or `core.hooksPath`, and commands that move the refs the push check measures against: `git update-ref refs/remotes/...`, a fetch or push refspec writing `refs/remotes/*`, `git symbolic-ref refs/remotes/... <target>`, a branch or tag named `origin/...`, and changing the branch's upstream |
| Finish gate | `Stop` and `SubagentStop` | off | Reviews when Claude says it is done and keeps it working on blocking findings, at most 2 rounds |

Turn the finish gate on for yourself in Claude Code with `/config` (the plugin's
**Review before Claude finishes** option, `finish_gate`), or for everyone working in a repo with
`harness.finish_gate: true` in `.prism/config.json`. The finish gate runs when either one turns it
on. The push gate's review is the other way round: a `harness.push_gate` the repo sets wins, and
the plugin's `push_gate` option only decides when the repo leaves it unset. With
the finish gate off, the `Stop` hook exits before it reads any diff and costs nothing.

`/prism:review` runs the same review on demand and shows the verdict; it changes nothing.

### Kiro CLI and Kiro IDE

Install the hooks in the repo (or for every repo with `--global`), then commit the file yourself:

```bash
prism-cli enable agent-hooks --client kiro          # writes .kiro/hooks/prism-harness.json
git add .kiro/hooks/prism-harness.json && git commit -m "PRISM Kiro hooks"
```

The hooks run only on Kiro CLI's V3 engine. `kiro-cli chat --no-interactive` starts the v2 engine
by default, where no hook fires, so pass `--agent-engine v3` for headless runs:

```bash
kiro-cli chat --no-interactive --agent-engine v3 "..."
```

| Gate | Hook | Default | What it does |
|---|---|---|---|
| Push gate | `PreToolUse`, matcher `*` (every tool call; the push check reads shell calls) | on | Before the agent's `git push`: gitleaks and the review. A secret, a failed secret scan, a change to the checks, a push that does not say what it sends, or a hook bypass (`--no-verify`, `core.hooksPath`, `git config prism.*`, or moving a remote-tracking ref or the upstream, as in Claude Code) denies the push. Other shell commands pass after a parse of about 80 ms |
| Finish gate | `Stop` | off | Reviews the session's changes when the agent finishes and keeps it working on blocking findings |

How it differs from Claude Code, because of how Kiro hooks work:

- **Kiro denies a command only when the hook exits 2.** If the PRISM check itself fails during a
  push (an internal error, input it cannot read), it denies the push with
  `PRISM push check failed closed` rather than letting it through. A prism-cli that is not on the
  hook's PATH cannot run at all, and then Kiro lets the push run: check with
  `prism-cli enable agent-hooks --status`.
- **Push findings arrive when the agent finishes.** Kiro drops a PreToolUse hook's output, so the
  findings of a push that went ahead are kept and handed to the agent by the Stop hook at the end
  of the same prompt (this costs one more model turn, only after a push with findings). The agent
  is told to tell you and offer a follow-up, not to change code or push again unless you ask.
- **One fix round per prompt.** Kiro runs Stop hooks once per prompt. With the finish gate on, the
  agent gets one fix round; the next review runs when your next prompt finishes. prism-cli still
  counts at most 2 fix rounds per session.
- **No message to you from the hook.** Kiro has no channel from a hook to the person, so when the
  verdict is `stop` the agent is told to relay it, and the full verdict is in `.prism/results/`.
  Warnings on a `pass` are only in the result file.

Turn the finish gate on with `harness.finish_gate: true` in `.prism/config.json`, or for yourself
with `PRISM_HARNESS_FINISH_GATE=1` in the environment Kiro starts from.

**Sessions and your own edits.** The Kiro IDE reads the same `.kiro/hooks` files. It keeps one
Kiro session per opened folder: a new chat or a window reload shares that session, and only
closing and reopening the folder starts a new one. So a session can include a lot of your own
work. The hooks around each agent tool call (`PreToolUse` and `PostToolUse`) record PRISM's
guarded files: the gitleaks config, `.prism/config.json`, the review rules, the eval-gate
workflows and hook files. A guarded file you change between the agent's tool calls is yours: it
does not make the agent `stop` for tamper while it holds what you left. These still count as the
agent's: a change during one of its tool calls (even if you edit that file afterwards), after a
tool call that never finished, and after its last tool call before it finishes or pushes. Secrets
are judged the same for everyone: a key
you wrote still blocks the agent's push. (An agent that edited a guarded file from a background
process between tool calls would be taken for you; the push-time secret scan and the CI gate
still apply.) PRISM keeps its record of this in the git directory
(`$(git rev-parse --git-common-dir)/prism/harness/`), outside your working tree. The hooks deny a
file-tool write there (an exact path check; reading it is fine), but the record is not signed: an
agent set on evading the check could still write it from a shell, and the push-time secret scan
and the CI gate are the backstop. Claude Code gets the same rule, through hooks on `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`, `Bash`, `Task` (a subagent's whole run) and MCP tools.
[Kiro Crew](#kiro-crew-app) sessions do not load project hooks, so there the `prism-fix-findings`
skill is the check. When the hooks are active for its session it reads their verdict instead of
running its own rounds.

### Installing the hooks (enable agent-hooks)

`prism-cli enable agent-hooks` writes the harness hooks for a client that has no PRISM plugin doing
it:

| Client | File (project) | File (`--global`) |
|---|---|---|
| `kiro` | `.kiro/hooks/prism-harness.json` | `~/.kiro/hooks/prism-harness.json` |
| `claude` | `.claude/settings.json` | Claude Code user settings (`CLAUDE_CONFIG_DIR` respected) |

```bash
prism-cli enable agent-hooks --client kiro --dry-run   # the diff, nothing written
prism-cli enable agent-hooks --client kiro
prism-cli enable agent-hooks --status                  # installed / outdated / missing per client and scope
prism-cli enable agent-hooks --client kiro --uninstall
```

- Every write shows a diff and backs the file up first as `<file>.bak-<timestamp>`. Running it
  again with nothing to change writes nothing.
- `--client kiro` also writes the steering note `~/.kiro/steering/prism-codewatch.md`, which
  kiro-cli, Kiro IDE and Kiro Crew load into every session: check codewatch findings before
  finishing, with `prism-cli codewatch review` (or the `prism-fix-findings` skill in Kiro Crew),
  and skip it when these hooks already ran the review. A file there without the prism-cli marker
  line is left alone. `--status` and **Settings → Agent hooks** show its state; project
  `--uninstall` keeps it, `--uninstall --global` removes it when it carries the marker. See
  [The steering note](kirocrew-app/README.md#the-steering-note).
- The hooks call `prism-cli`. A project file always does, because it is committed and shared, so
  prism-cli must be on the PATH the agent starts with (it warns when it is not on the system PATH).
  With `--global` it writes this machine's absolute node and script path when prism-cli is not on
  the PATH a desktop app or IDE starts with (an nvm or Volta install).
- For Claude Code it merges the hooks the plugin ships into the settings file and keeps your other
  hooks and keys. When the PRISM plugin is installed it skips the install, so the hooks do not run
  twice; update an older plugin (before 0.3.0) instead.
- `prism-harness.json` is PRISM's own file. One that holds other hooks is left alone unless you pass
  `--force` (the old file is kept in the backup).
- Kiro runs global and project hooks side by side, so it warns when both scopes have the file.
- `--uninstall` removes only PRISM's entries.
- `--client cursor` and `--client codex` are planned.

Hook files from 1.12.0 still work. `--status` shows them as outdated until you run the installer
again, which adds the `PostToolUse` hook for tool windows (see [Kiro CLI and Kiro IDE](#kiro-cli-and-kiro-ide)).

Hook files are on the tamper list: an agent's push that carries a change to them is held. Commit
the hook file yourself before the agent's session.

### Config keys

All in a `harness` block in `.prism/config.json`, next to `eval`:

| Key | Default | Meaning |
|---|---|---|
| `harness.push_gate` | `true` | AI review before the agent's `git push`. Set here (true or false) it wins over the plugin's `push_gate` option; left unset, the option decides. `false` skips the review; gitleaks still runs and secrets still block |
| `harness.finish_gate` | `false` | Review before the agent finishes |
| `harness.block_on` | `["secret", "high"]` | What makes the verdict `fix`: `secret`, `high`, `medium`. `secret` always applies. It applies to the finish gate and direct reviews (`codewatch review`, `prism_review`) only; the push gate blocks only on secrets and changes to the checks, and says so once per session when this key is changed from the default |
| `harness.max_rounds` | `2` | Fix rounds per session before `stop`; at most 3 |
| `harness.timeout_seconds` | `120` | Reviewer timeout per attempt; at most 135, so two attempts fit in the agent hook's time |
| `harness.skip_paths` | `*.md`, `docs/**`, `*.txt`, images | Changes that get gitleaks only, no AI review |
| `harness.state_ttl_days` | `7` | Age at which session state files are deleted |

```json
{
  "eval": { "reviewer": "kiro" },
  "harness": { "finish_gate": true, "block_on": ["secret", "high", "medium"] }
}
```

Because `.prism/config.json` is on the tamper list, an agent that edits it during a session gets
`stop`.

### Running the engine yourself

```bash
prism-cli codewatch review                 # the branch against its upstream, plus uncommitted work
prism-cli codewatch review --json          # the verdict JSON only
prism-cli codewatch review --staged --no-review   # gitleaks on the index, no AI review
```

Exit codes: 0 `pass`, 3 `fix`, 4 `stop`, 1 a usage or internal error. Every flag:
[`prism-cli codewatch review`](docs/CLI-REFERENCE.md#prism-cli-codewatch-review).

### Cost

Each review is one call to your own reviewer (kiro-cli or Claude Code) with your own credentials,
like the pre-push review. With the defaults that is one review per agent push and none at the
finish. With the finish gate on, a session can add up to 3 reviews at the finish line (the first
check and one after each fix round). Cached, empty and docs-only runs cost nothing. When Claude Code
is the reviewer the result records its reported cost (`cost_usd`); kiro-cli reports none. For why
the review runs locally at all, see [Why local code review](docs/WHY-LOCAL-CODE-REVIEW.md).

---

## Local Dashboard

`prism-cli dashboard` starts a web page for one developer that shows codewatch results across your
repos, codeburn spend, Security Agent and AWS check results, a Security Agent page that runs the
Security Agent commands in a repo you pick, AccountGuard for the connected AWS account, and a Settings view with the setup checklist. Run it from any directory:

```bash
prism-cli dashboard
```

It prints a URL such as `http://127.0.0.1:<port>/?token=<token>` and opens it in your browser.

- **Local only.** It listens on `127.0.0.1`, never on other interfaces. The token is random for each
  run; the first page load exchanges it for a cookie, and requests without it are refused. Do not
  share the URL. Ctrl-C stops the server.
- **Read-only dashboard.** The dashboard view only reads data; every fix it suggests is a command
  for you to run. The **Settings** view (below) can run a fixed set of local setup commands for you,
  the **Security Agent** page (below) runs the Security Agent commands in a repo you pick, and
  **AccountGuard** (below) checks the connected AWS account.
- **AWS.** Loading the Dashboard makes no AWS calls, with one exception: while a code review, threat
  model or pentest is pending in a repo's results, the open page has the dashboard check that job
  (below, Security runs). That check is read-only, except that a finished pentest's environment is
  torn down. **Connect** and **Re-verify** on the Settings AWS tab
  (`aws connect`), AccountGuard's `aws check`, `team info`, the Security Agent page's agent-space check
  (which runs by itself once per session when you open that page and its first two setup steps pass)
  and its fetch and status buttons make read-only calls. The buttons that write to
  AWS are all on the Security Agent page, each after a dialog that says what it changes and where:
  the **Code review** item's **Review this branch** and **Review the whole repo** (`security
  code-review --no-wait`, branch diff or `--full`), **Start threat model** (`security threat-model
  --no-wait`), **Start pentest** (`security pentest --yes`) and a run's **Clean up** (`security
  pentest --cleanup --job <job>`). `enable security` stays Copy only.
- **Theme.** The page opens in the dark theme. The **Light / Dark / System** toggle in the header is
  saved in your browser (`localStorage`) and wins on the next load; System follows your OS setting.
- **Update check.** The version pill in the header shows `prism-cli <version>`, or
  `Update: <installed> → <latest>` in orange when npm has a newer release; it links to the Updates
  tab of the Settings view, which can run `npm i -g @prism-d1/cli@latest` for you after a confirmation.
  The dashboard asks the npm registry (`registry.npmjs.org`) at most once a day, with a 3-second
  timeout, caches the answer in `~/.prism/cache/update-check.json` and says nothing when offline. It
  never updates anything by itself. `PRISM_NO_UPDATE_CHECK=1` turns the check off. The same
  `version` block (`installed`, `latest`, `publishedAt`, `update`, `checkedAt`) is in `--json`.

### Settings View

![The Settings view with demo data: vertical section tabs with count badges and green dots, scores for machine checks, repos with codewatch and agent hook installs, and the Needs you list with fix commands](assets/images/prism-cli/dashboard-settings-overview-dark.png)

The **Settings** tab (`#settings`; the old `#setup` links still work) has the setup checklist with a
**Run** or **Copy** button per item, in section tabs down the left (across the top on a narrow
screen). Each tab shows a count of the items that need you, or a green dot when there are none,
and links straight to it as `#settings/<tab>`:

- **Overview:** how many machine checks pass, how many repos have codewatch and how many agent hook
  files are installed, then **Needs you**: every item to fix, with its command and a link to its
  tab. The Settings tab in the header, the Dashboard's **Settings warnings** card and
  `prism-cli dashboard --json` (`summary.warnings`, and the whole list as `needsYou`) show the same
  count, from one list the dashboard builds. **Check now** under the tabs re-runs the local checks
  and redraws the counts.
- **This machine:** codeburn, gitleaks and the global codewatch hooks.
- **Repos:** the repos with codewatch, with their reviewer and Security Agent state; the repos
  without it are collapsed behind one item with **Enable for every repo**. After **Enable
  codewatch** or **Enable for every repo** finishes, the rows show the new state at once, even when
  another refresh is still running; after a change made in a terminal (`enable codewatch
  --uninstall`), **Re-check status** shows it
  (`enable codewatch --global`).
- **Agent hooks:** the [agent harness loop](#agent-harness-loop) hooks for kiro and claude, for the repo
  the dashboard started in (project) and for your user (global), from the same files
  `prism-cli enable agent-hooks --status` reads, with **Install**, **Update** or **Remove**
  (`enable agent-hooks --client <c> [--global] [--uninstall]`). It shows the Claude Code plugin's
  version, with a warning below 0.3.0 (older plugins predate the harness hooks) and the commands that
  update it, and the Kiro Crew app with a button for `prism-cli enable kirocrew`.
- **Usage sync:** where codeburn usage goes and the sync schedule, the current collector URL with
  **Re-run sync setup** (sign in again), **Sync to team** (asks first, naming both URLs, before it
  replaces a current one), and **Run team info** (`team info`, read-only), which reads the team stack's
  collector URL and user pool.
- **AWS:** the AWS account the AWS commands default to (`prism-cli aws connect`); see below.
- **Updates:** the installed and latest prism-cli, when it was published and when npm was last
  asked; **Update prism-cli** runs `npm i -g @prism-d1/cli@latest` (after the confirm dialog);
  **Check now** asks the npm registry again; a link to the release notes; a reminder to update the
  Claude Code plugin and run `prism-cli enable kirocrew` after an update; and the versions of the
  plugin, the Kiro Crew app, gitleaks and codeburn.

![The Agent hooks tab with demo data: kiro and claude, project and global, with Install buttons, the Claude Code plugin card with its update commands, and the Kiro Crew app card](assets/images/prism-cli/dashboard-settings-agent-hooks-dark.png)

![The Updates tab with demo data: installed 1.21.2 and a newer made-up release on npm with its publish time, the Update prism-cli, Check now and Release notes controls, and the components table](assets/images/prism-cli/dashboard-settings-updates-dark.png)

Every Run first shows the exact command in a confirm dialog. The page sends only an action id; the
server maps it to a fixed argument list for this CLI's own binary (or for npm, for the update), runs
one at a time, without a terminal (so prompts take their no-terminal answer), with a timeout. The
output appears in an **Action output** drawer at the bottom of the window, with secrets masked. Every
12-digit number shows as its last 4 digits, because it may be an account id (another account's id in
an error is masked too); an assumed-role ARN shows its role name only; the home directory shows as
`~`. Each run is logged to `~/.prism/logs/dashboard-actions.log` (time, action, repo name, exit code; no
output and no URLs).

- **Run (local only):** `enable codewatch` in a repo from the list, `enable codewatch --global`,
  `enable codeburn --local`, `--url <collector URL>` (https only), `--schedule systemd` (Linux with
  `systemctl --user`, team mode), `--remove` (asks twice) and `--status`, `enable agent-hooks`,
  `enable kirocrew --yes`, `npm i -g @prism-d1/cli@latest` (not on Windows), and **Re-check status**.
- **Run (read-only in AWS):** `aws connect --profile <p> --region <r>` (**Connect** / **Re-verify**),
  `aws connect --status`, `team info`, and AccountGuard's `aws check`.
- **Run (local only, asks twice):** `aws connect --clear` (**Disconnect**).
- **Copy only:** the gitleaks install hint and `team add-developer`, because they
  write to AWS, install software or need a terminal. The Security Agent commands moved to the
  [Security Agent page](#security-agent-page); the AWS tab starts with a link to it, and each repo on
  the Repos tab links to the page for that repo.

### Settings › AWS

![The Settings AWS tab with demo data: the connected account (profile prism-demo, us-west-2, account ••••3333, verified 25 minutes ago) with Show status and Disconnect, the profile and region pickers with Re-verify, and what prism-cli uses with the resolution order](assets/images/prism-cli/dashboard-settings-aws-dark.png)

The **AWS** tab is only about which AWS account the AWS commands use, the one
[`prism-cli aws connect`](#aws-account-advice-aws-connect-check-recommend) saves:

- **AWS account:** the saved profile, region, account (its last 4 digits) and alias, when it was
  verified, whether it is in use (an AWS env var wins over it), and which file holds it
  (`~/.prism/aws.json`, or the dashboard repo's own `.prism/aws.local.json`, which wins there).
  **Show status** runs `aws connect --status`. **Disconnect** runs `aws connect --clear`, which
  removes the saved file and changes nothing in AWS.
- **Connect or re-verify:** a profile picker and a region picker, and **Connect** (or **Re-verify**
  for the saved pair), which runs `prism-cli aws connect --profile <p> --region <r>` after the confirm
  dialog. It checks the profile with `sts get-caller-identity` and reads the account alias, Organizations
  and the attached IAM policies (all read-only), then saves the profile name, region, account and alias.
  It stores no credentials. The profiles are the section names in `~/.aws/config` and
  `~/.aws/credentials` (or `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`); only the names and a
  configured region are read, never a key or token. The regions are a fixed list of commercial regions
  plus any region a profile has configured. The server accepts only a profile and region from those
  lists, read again for each request. A per-repo connection (`aws connect --repo`) is a terminal command.
- **What prism-cli uses:** which credentials prism-cli would use and why, in the order every AWS
  command uses: env (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`), `.prism/aws.local.json`, `~/.prism/aws.json`,
  then the default profile. It shows the profile and the credential type (credential_process, SSO,
  static keys in `~/.aws/credentials`, or env vars), read from the setting names in the two files;
  secret values are never read or shown. It warns when the default profile has static keys in
  `~/.aws/credentials` (they win over credential_process and often expire) and when no credentials
  are found.
- A line at the bottom points to AccountGuard (account checks), the Security Agent page and Usage sync
  (team stack info), which used to be on this tab.

### AccountGuard

![AccountGuard with demo data: the connected account ••••3333 in us-west-2 with Run aws check again and Run aws recommend, tiles for 10 failing (3 high), 14 passing, 6 could not check and +1 / -2 since the baseline, the checks by area on the left and the ranked fixes on the right](assets/images/prism-cli/dashboard-accountguard-dark.png)

**AccountGuard** in the header (`#accountguard`) shows the read-only account checks of the account
connected on Settings › AWS. Loading it makes no AWS call: it reads the cached `prism-cli aws check`
results (see [AWS Account Advice](#aws-account-advice-aws-connect-check-recommend)) and ranks them with
`aws recommend`'s own code.

- **Run aws check** runs `prism-cli aws check --profile <p> --region <r>` for the connected account,
  from your home directory, so the result lands in `~/.prism/results/`. Every call is a describe, get
  or list. **Run aws recommend** prints the same ranked list to the Action output drawer (no AWS call).
- **Summary:** when it last ran and against which account (last 4 digits) and region; failing checks
  by severity, passing checks, the checks that could not run ("not a pass"), and the change since the
  baseline.
- **Checks by area** (Bedrock protection, PRISM setup, Account baseline, Startup Advisor): failing
  checks first, each with what was found, its fix and its ranked fix number, marked **new since
  baseline** when it was not failing then. A check that could not run says why, from the result's
  `reason`: **access denied** (the IAM action to grant), **not enabled here** (the service is off or
  not offered in the region), **throttled** (re-run), **waits on a fix** (the ranked fix to do first),
  **no credential report**, **not integrated**, or **no answer** (re-run). It says "grant" only when
  access was actually denied. Passing checks are folded.
- **Ranked fixes:** `aws recommend`'s list, severity first and quick wins first, with why, the checks
  each fix covers, the steps, a command to copy when there is one, and a docs link. AccountGuard never
  writes to the account; each fix is a change you make yourself.
- **Baseline:** the oldest full run for the account and region, until you mark another (**Use the
  latest run as the baseline**, or **Use as baseline** on an earlier run). The mark is saved in
  `~/.prism/accountguard.json` on this machine only. **Since the baseline** lists the new failures,
  the fixed checks, checks that failed then and could not run now (not counted as fixed), and how many
  are still failing. A `--section` run is never a baseline or the latest run.
- **Badge:** the AccountGuard tab's count is the failing HIGH and CRITICAL checks in the latest run,
  from the cached result.
- **Not connected:** one state that points to Settings › AWS. **Never run:** what `aws check` checks
  and the Run button.

Account ids appear as their last 4 digits, in check text too, and runs as opaque ids; the result
files themselves stay in `.prism/results/`. The dashboard's APIs (`/api/data`, `/api/setup`,
`/api/accountguard`) and the Action output drawer never carry a full 12-digit account id. The static
snapshot shows a note instead: AccountGuard needs the live dashboard.

**Checklist.** The Settings view's This machine, Usage sync, AWS and Repos tabs list, for this machine: codeburn installed, the scheduled sync from `enable codeburn`
and its last run (by sync mode: local shows "local only" as info with how to join a team; team without
a collector URL says to ask your platform team, with Setup instructions and Platform team guide links;
admin lists the platform-team steps and `prism-cli team` commands), gitleaks, AWS credentials, and the global codewatch hooks (optional, so "not installed" is info and
not a setup warning). Then one row per repo:
codewatch installed (ok); warn, when the global hooks are installed but the repo's own
`core.hooksPath` (husky and similar) bypasses them; missing, including only one hook installed or
hooks from before the codewatch rename; or opted out with `git config prism.codewatch false`. Repos covered by the global hooks are
marked "(global)". Repos missing codewatch are collapsed into one group. Each problem row shows the
command that fixes it. A **Security Agent** column shows **machine setup** when the repo uses
`~/.prism/security.json`, **repo override** when it has its own `.prism/security.local.json` (or a
legacy `security` block in `.prism/config.json`), or missing with the fix `prism-cli enable
security` (once, from any directory). That is local evidence only; `enable security --status`
checks the AWS side (see [Security Agent Setup](#security-agent-setup-enable-security)).

When the global hooks are not installed and at least two repos are missing codewatch, the page
suggests covering them all with `prism-cli enable codewatch --global` (see
[Codewatch (Local Git Hooks)](#codewatch-local-git-hooks)).

### Security Agent Page

![The Security Agent page with demo data once the setup check passes: the Security Agent ready strip with the profile, setup and agent space and Check again, the repo override note, the Security runs table with Type, Repo and Status filters (a code review running, a code review and a threat model complete, a pentest failed with a red marker); below it the target repo picker, the results for demo-shop with Complete. View findings links and Fetch buttons, Start new work with the Pentest target picker (the tracked Dockerfiles, the one .prism/pentest.json names preselected, the build folder, port and health path) and its Pentest item with Start pentest above the command to copy, and on the right the account and region, agent spaces and setup health](assets/images/prism-cli/dashboard-security-agent-dark.png)

**Security Agent** in the header (`#security`, or `#security/<repo-id>` for one repo) runs the
existing [Security Agent commands](#security-scans-from-your-machine) in a repo you pick, as if you
ran them in a terminal there. It adds no new setting and writes nothing to SSM.

**Setup first.** The page opens with a guided check of three steps, in order, and shows only the
first one that is not met, as **step n of 3** with a progress bar. Runs, results and the Start
buttons appear only once all three pass.

![The setup gate with demo data at step 2 of 3: AWS connected, Security Agent not set up yet; the enable security command with the saved profile and region and a Copy button, and I ran it, check again](assets/images/prism-cli/dashboard-security-gate-setup-dark.png)

1. **AWS connected.** A named profile: a saved `aws connect` (Settings › AWS), or `AWS_PROFILE` in
   the environment you started the dashboard from. The page shows which one it uses
   (`aws connect: <profile>` or `AWS_PROFILE: <profile>`). The order is the one every prism-cli AWS
   command uses: `--profile`, then the environment (`AWS_ACCESS_KEY_ID`, then `AWS_PROFILE`, then a
   web identity token or container credentials), then the repo's `.prism/aws.local.json`, then
   `~/.prism/aws.json`, then the default chain. So when `AWS_PROFILE` and a saved `aws connect`
   profile differ, `AWS_PROFILE` wins, and the page says so. Environment keys
   (`AWS_ACCESS_KEY_ID`), a web identity token, container credentials or the bare default chain do
   not pass this step: they win over both, so the page asks you to restart the dashboard without
   them. A profile that is in neither `~/.aws/config` nor `~/.aws/credentials` is named. Only the
   profile name is read from the environment, never a key.
2. **Security Agent set up.** A setup record applies to the repo (`~/.prism/security.json`, or the
   repo's `.prism/security.local.json`), for the account in use. Without one, the card shows
   `prism-cli enable security` with your profile and region and no `cd`, to copy into a terminal (it
   never runs from the page). When the setup is for another account than the one in use, the card
   offers `enable security --repo` (this repo only; it needs the `cd`) or `--replace` (change the
   machine default), or switching back in Settings › AWS. With `aws connect` the account is the one
   it verified; with `AWS_PROFILE` it is known after the check in step 3.
3. **Agent space verified.** Once steps 1 and 2 pass, the page runs a read-only check by itself:
   `sts get-caller-identity` (which also proves the sign-in works), `securityagent list-agent-spaces`
   and `batch-get-agent-spaces`, and `ssm get-parameter` for the agent space and scan bucket. It runs
   once per repo, profile and region, with a 20-second timeout per call and one action at a time, and
   never on the minute refresh. The answer is kept until the dashboard stops; **Check again** on the
   ready strip runs it again. A failure gets its own card with **Retry**: an expired sign-in shows
   the exact `aws sso login --profile <profile>` line, access denied names the IAM action that was
   refused and the read permissions the check needs, and a missing agent space shows
   `enable security` to run again.

Steps 1 and 2 read local files only, and their card checks again every 10 seconds while it is open
and the tab is visible, so it moves on by itself once you have run the command. That re-check reads
only what the two steps need, for the picked repo (the AWS and `aws connect` files, `AWS_PROFILE`
and the setup records): no git and no scan of your other repos, which happens once the step passes. A repo override is shown as information on
the ready page, and a repo's code review is created by its first code review run, so neither is a
step.

![The setup gate at 390 px: Security Agent is set up for a different account, with the --repo and --replace commands, each wrapping only at spaces, and Copy buttons](assets/images/prism-cli/dashboard-security-gate-mismatch-390-dark.png)

- **Target repo.** A picker over the repos the dashboard found, starting with the one it was
  started in. The repo you pick is remembered in `~/.prism/dashboard.json` (key
  `securityAgentRepo`, the repo's real path; a local file, no AWS call), so the page opens on it
  after a restart and in every host: the browser, VS Code and Kiro Crew. It is used only while the
  dashboard still finds that repo; otherwise the page starts on the default repo, and the entry
  stays in the file until the next pick replaces it (reading never rewrites the file). A file that
  does not read as JSON is ignored until the next pick replaces it. When a pick cannot be saved, a
  short note under the picker says why; the pick still applies until the page reloads. Every
  command on the page runs with that repo as its working directory, and the
  confirm dialog shows the exact line, for example
  `cd ~/src/demo-shop && prism-cli security findings --profile demo --region us-west-2`. The page
  sends only the action and the repo's id; the server looks the path up in its own list, adds
  `--profile` and `--region` itself, and runs a fixed argument list with no shell. Under the picker
  the page says which setup the repo uses: `Uses the machine setup (~/.prism/security.json)` or
  `Repo override: .prism/security.local.json (...)`, with the account as its last 4 digits, or that
  Security Agent is not set up on this machine yet.
- **Account and region.** What prism-cli resolves in that repo, in the usual order (env, the repo's
  `.prism/aws.local.json`, `~/.prism/aws.json`, the default chain); the region of the setup in use
  wins, as in the CLI, and is marked `(machine setup)` or `(repo override)`. `--profile` is added only when a
  profile was chosen (`AWS_PROFILE` or a saved `aws connect` profile). prism-cli has no flag to pick an
  agent space: the commands use the one this account and region are set up with (SSM
  `/prism/continuum/agent-space-id`). To use another, change the profile or region.
- **Agent spaces.** The spaces step 3 found in the account and region. Each space is marked **used by prism-cli** (the one SSM names), **temporary pentest
  space** (made by `security pentest` for one run) or **not used by prism-cli**, with whether it lists
  the scan bucket. The account shows as its last 4 digits.
- **Security runs.** At the top: every run in every repo, in the same table as the Dashboard's
  card, with Type, Repo and Status filters. It shows 25 rows, and **Show 25 more** adds the next 25.
- **Results.** The repo's latest code review, threat model and pentest from its `.prism/results/`
  (the card's subtitle says `uses machine setup` or `repo override`),
  with **Fetch findings** (`security findings`), **Fetch threats** (`security threats`) and **Fetch
  pentest findings** (`security findings --pentest`). These are read-only in AWS and save to
  `.prism/results/`. A finished run's row reads **Complete. View findings →**; a running one stays
  amber with no link.
- **A run's page** (`#security/run/<repo-id>/<run-id>`; the run id is its result file's name). It shows:
  - a header with the type, repo, branch and commit, scope or target, account (last 4 digits),
    region, start time, duration, status, and the job id with **Copy**, laid out the same for code
    reviews, threat models and pentests;
  - for a threat model or pentest, an **Overview** card with the overview Security Agent wrote:
    the first paragraph, and the whole document on **Show full overview**. It is drawn as plain
    text with headings, paragraphs, lists, inline code and bold only; links show their text and
    images their alt text, because the overview comes from AWS and the repo's own docs;
  - the counts by severity, then every finding, most severe first, with a severity filter. Open a
    finding for its full description. A threat model also shows its recommendation, the components
    and assets it affects (saved from prism-cli 1.20.1 on) and its evidence.
    Code reviews and pentests show `No remediation provided by this run type.`: Security Agent
    returns no remediation text for them;
  - the result file (shown with `~`) and the same run's `prism-cli security findings` (or `security
    threats`) command with **Copy**.

  ![A code review's page with demo data: the header (demo-shop, main, the whole repo at HEAD, account ••••3333 / us-west-2, 14 min, job job-demo-2 with Copy), 1 critical and 1 low by severity, the findings with the severity filter and the first one open with its full description and "No remediation provided by this run type.", and the result file and CLI command with Copy](assets/images/prism-cli/dashboard-security-run-dark.png)

  There is no direct link to the run in the Security Agent console yet. Open the Security Agent web
  application and find the job id. A run that is still running (or has no verdict yet) is read again
  each time you open its page and on the page's minute refresh, so it shows its findings once they
  are fetched, without a reload. An unknown or deleted run id, or a result file whose job id is not
  a plain id, shows **Run not found** with a link
  back (the API answers 404, and the page does not ask again). If the run cannot be loaded for any
  other reason, the page says **Could not load this run** with **Retry**; that state is not kept. A
  refresh keeps the severity filter you picked and the findings you opened, and leaves the page
  alone when nothing changed. The page reads one local result file through `GET /api/security-run`, which takes only the
  repo id and the run id and matches both against the dashboard's own repo list. Finding text, which
  comes from AWS and from code, is shown as text.
- **Action output.** When a fetch or start action saves a finished run, the drawer ends with
  **Complete. View findings →** (or **Failed. View details →**), linking to the run's page. The
  dashboard takes the run from the result file the command wrote, not from its output. A job that
  is still running shows the amber `still running` state and no link.
- **Start new work.** One **Code review** item with two choices, **Review this branch**
  (`security code-review --no-wait`) first, then **Review the whole repo** (`--full --no-wait`), and
  **Start threat model** (`security threat-model --no-wait`) appear once the setup check passes. Their dialog says what happens, for example
  "Uploads demo-shop source at HEAD to the scan bucket prism-d1-scan-demo in account ••••3333 /
  us-west-2 and starts a code review job.", shows the command, and has Cancel focused, so Enter never
  confirms; the run needs a click on **Upload and start**. The server checks the setup again, and that
  the credentials still point to the same account, before it runs. The job keeps running in AWS;
  fetch its result here later.

  The Code review item says what the branch review diffs against, by the same rule as the CLI: the
  branch's upstream, else the remote's default branch. It reads this from local git only. When the
  branch has nothing new since that base, or there is no base at all, the item says so and disables
  **Review this branch**; **Review the whole repo** stays (with its own guards). It also counts
  uncommitted changes, which no review includes: commit them first. If a branch review still finds
  nothing, the output drawer shows a neutral **nothing to review** (no job, no upload) and offers
  **Review the whole repo instead**.

  ![The Action output drawer with demo data after a branch review found nothing: the amber nothing to review pill, "no job was started and nothing was uploaded", Review the whole repo instead, and the CLI's own lines ending in nothing to review](assets/images/prism-cli/dashboard-security-nothing-to-review-dark.png)

  Before that dialog, a code review checks the repo's own results. If a review of the repo is still
  running, it says so and offers **View it →** or **Start another anyway**. If HEAD already has a
  finished review, it offers **Open those findings →** first, then **Review it again**. A job
  reviews the code review's shared source, `repo/<slug>/latest.zip`, which a new start replaces, and
  the service does not document when a running job reads it. So `security code-review` itself
  refuses to replace it while a job of that code review is pending in the repo's results, unless you
  pass `--force` (**Start another anyway** does). Jobs CI started are not in the local results.

  ![The guard dialog with demo data: a code review of demo-shop is already running, with Cancel focused, View it and Start another anyway](assets/images/prism-cli/dashboard-security-guard-running-dark.png)

  **Pentest.** The **Pentest target** picker chooses the Dockerfile, build folder, port and health
  path, asked each time and never saved. Under it, **Pentest** has **Start pentest** (`security
  pentest --yes` with the picker's `--app-dir`, `--dockerfile`, `--port` and `--health-path`, no
  `--wait`, no `--keep`), with its command under the button to copy for a terminal. The page has no
  plan button since 1.21.7: to see the CDK diff first, run `security pentest --dry-run` in a
  terminal. The server checks the picker's values again with the same rules as the picker before
  it runs anything. Before you confirm, Start pentest's dialog says in plain words what it deploys
  into the account and region it names, as the pentest stack creates it:

  - a VPC with private subnets only in two availability zones (no internet gateway, no NAT gateway,
    no public endpoint), with security groups that let only the pentest agent reach the load
    balancer and only the load balancer reach the app;
  - a Fargate service running your app, built from the picked Dockerfile on this machine and pushed
    to Amazon ECR (Docker must be running), behind an internal Application Load Balancer with a
    private DNS name only the VPC resolves;
  - VPC endpoints for ECR, S3 and CloudWatch Logs (and Secrets Manager when `.prism/pentest.json`
    names secrets);
  - an IAM service role for Security Agent, an S3 source bucket with the repo at HEAD, and
    CloudWatch log groups for the app and the agent;
  - in Security Agent, an agent space for the run, a private target domain, and the pentest and its
    job.

  It also shows the picked Dockerfile, build folder, port and health path; that the environment is
  torn down automatically when the job finishes (the dashboard checks every 5 minutes while it is
  open), that a **Clean up** button appears on the run's page if teardown fails, and the cleanup
  command to run sooner (`security pentest --cleanup --job JOB_ID` with the page's `--profile` and
  `--region`; the run's page shows the job id); and that it runs for hours and costs money while it
  is up (publicly reported at $50 per task-hour, plus the environment). You tick a box to confirm;
  nothing is deployed or called in AWS before **Deploy and start**.

  **Bootstrapping.** Since 1.21.7, Deploy and start runs the deploy in the background, in its own
  process, and answers at once: the action drawer says **Bootstrapping started** with **View
  progress →**. Closing the dashboard, VS Code or Kiro Crew does not stop it, and it does not hold
  the one-action lock, so other actions can run meanwhile. Before anything is deployed, it writes
  the run's record (status `deploying`) with the stack name, the account and region and the picked
  target; its output goes to `.prism/results/<run>.log` beside it (ignored by git, as the results
  are). The deploy takes 10 to 20 minutes or more: `cdk deploy` of the VPC, endpoints, load
  balancer and Fargate service, the first run also installs the CDK app's packages, and the command
  then waits up to 10 minutes for the health check. The Security runs table shows the run as
  **Bootstrapping** with its step (Preparing, Building the app image, Pushing the image to ECR,
  Deploying the environment, Waiting for the app to pass its health check, Registering the target
  with Security Agent, Starting the pentest job) and how long that step has run; its page lists the
  steps and has **View log** (the end of the log, account ids and home paths masked). The dashboard
  reads a bootstrapping run from its record only, with no AWS call. When the job starts, the same
  record becomes the pending run, which the dashboard checks every 5 minutes as before. If the
  deploy fails, the run is **failed** with the reason, keeps what it created, and its page has
  **Clean up**. If its process goes away (it was killed, or the machine restarted) while the record
  still says deploying, the dashboard marks it **deploy interrupted** and offers Clean up too.

  ![The Security runs table with a pentest Bootstrapping at step 2 of 7, Building the app image, with View progress](assets/images/prism-cli/dashboard-security-runs-bootstrapping-dark.png)
  ![A bootstrapping pentest's page: the seven steps with the first two done and Pushing the image to ECR current, the note that closing the dashboard does not stop it, and View log open on the deploy's output](assets/images/prism-cli/dashboard-security-run-bootstrapping-dark.png)

  While a pentest of the repo is bootstrapping or pending in the same account and region, Start
  pentest says so and offers **View it →** only:
  `security pentest` has no `--force`, so start a second one from a terminal if you mean to. The
  environment is torn down automatically when the job finishes (Security runs, below), and the run
  is called complete only once that cleanup is verified. A run whose environment is still up
  afterwards has a card on its page with **Clean up**: **Cleanup failed** (the stack or a Security
  Agent resource would not go; the reason is shown with account ids and home paths masked),
  **Environment kept** (started with `--keep`), or **Environment still up** (an older run whose app
  never became healthy). Clean up runs `security pentest --cleanup --job <its job>` after a confirm
  dialog naming the account and region, stopped after 90 minutes (the teardown waits for the
  agent's network interfaces, then deletes the stack, and retries once), then verifies the cleanup.
  It acts only on that run's recorded resources, and only when the run was recorded in the account
  and region the commands use now. Cleanup failed and kept runs cost money, so they are also items
  in the Needs you list and in the Security Agent tab's badge. See
  [Running a Penetration Test from the CLI](#running-a-penetration-test-from-the-cli).
  ![The Start pentest confirm dialog with demo data, from its top: it deploys a temporary private environment for demo-shop into account ••••3333 / us-west-2; What it creates lists the private-subnet VPC, the Fargate service built from services/api/Dockerfile.prod, the internal load balancer, the VPC endpoints, the IAM service role, the source bucket and log groups, and the Security Agent agent space, target domain and pentest; Your app shows the Dockerfile, build folder, port and health path; Afterwards explains the automatic teardown and Clean up and shows the cleanup command; Time and cost follows](assets/images/prism-cli/dashboard-security-pentest-start-dark.png)
  ![The confirm dialog for Review the whole repo with demo data: it names payments-api, the scan bucket prism-demo-scans, account ••••3333 and us-west-2, shows the exact command, and has Cancel next to Upload and start](assets/images/prism-cli/dashboard-security-agent-confirm-dark.png)
- **Setup.** One folded card for the whole machine, **Set up Security Agent on this machine**
  (the setup check above leads when something is missing). Its steps: **Dry run** (`enable security --dry-run`, read-only; its first run installs the
  CDK app's npm packages into prism-cli's own folder), `prism-cli enable security` to copy, with no
  `cd` because it runs once from any directory (it deploys AWS resources and asks first), then
  **Run status check** (`enable security --status`, which in the picked repo also shows its code
  review and whether it uses the machine setup or a repo override). **Setup health** says which
  setup the picked repo uses.
- **Badge.** The Security Agent tab's count is what needs you in the picked repo: a setup step that
  is not met (not while its check runs), a HIGH or CRITICAL latest result, and a pending code review
  or threat model job. A running pentest is not counted.

Output goes to the same **Action output** drawer as the Settings view. **Fetch findings**, **Fetch
threats** and **Fetch pentest findings** on a job that is still running exit 2; the drawer shows an
amber **still running (exit 2)** pill and "check back later, or run the same command with --wait",
not a red failure, and the results row keeps reading "running". Each run is logged to
`~/.prism/logs/dashboard-actions.log`. IAM permissions the page uses, besides what each command
needs (see [Security Scans from Your Machine](#security-scans-from-your-machine)):
`sts:GetCallerIdentity`, `securityagent:ListAgentSpaces`, `securityagent:BatchGetAgentSpaces` and
`ssm:GetParameter` on `/prism/continuum/*`. The static snapshot (`--snapshot`) shows a note instead:
the page needs the live dashboard.

### Finding Repos

The dashboard scans your home directory, 3 levels deep, for every git repository, including linked
worktrees. It skips hidden directories and build or dependency folders (`node_modules`, `build`,
`dist`, `target`, `venv` and similar), does not follow symlinks, and does not look inside a repo it
has already found. It stops after 200 repos or 20,000 directories, and the page header then says
"scan capped". Use `--root <dir>`
to scan somewhere else. The repo you started it in is listed first.

### Dashboard View

![The PRISM dashboard in the dark theme with demo data: four summary cards, the Codewatch table with a Trend column of stacked severity bars, the Spend section with a 12-week heatmap and the codeburn strip, the Security runs card with four runs (one running with an amber marker, one failed with a red marker, severity chips with greyed zeros) and See all 4 runs, and the AWS account line](assets/images/prism-cli/dashboard-main-dark.png)

**Summary cards.** The latest codewatch review in any repo (severity pills, or skipped / failed),
spend today and this month, and **Settings warnings**: how many items the Settings view's **Needs
you** list has (machine checks that are missing or warn, repos whose own hooks bypass the global
hooks, repos without codewatch, outdated or unreadable agent hooks, an outdated Claude Code plugin
or Kiro Crew app, a prism-cli update; info items never count) and the first one, with a link to the
Settings view. It always matches the Settings badge.

**Codewatch.** One row per repo with codewatch installed or results: the findings in the latest
review of each branch, a **Trend** column with the last 12 pre-push reviews as stacked high / medium
/ low bars (a clean review is a thin green tick, a skipped one a thin grey tick), the last run (a link
to its report), the reviewer, commits pushed without a secret scan, the gitleaks state and this
month's spend for the repo. A banner warns when gitleaks is not installed, because commits on this
machine are then not scanned. Click a row for the repo's own view.

**Spend.** From the local codeburn data: a heatmap of spend per day for the last 12 weeks (a day with
no usage is the lightest square; a day codeburn was not asked about is an empty outline, "no data"),
this month's total and busiest day, bars by model, by project (Kiro Crew workspaces read as
`crew: <name>`) and by activity, and a strip with API calls, sessions, projects, input, output and
cache-read tokens and the top tools. For codeburn's own breakdown run `codeburn web --period month`,
or `codeburn month` in a terminal. The numbers come from one `codeburn export` for this calendar
month (today is read from its per-day rows), plus one for the heatmap weeks before this month, which
runs at most once a day because those days do not change. The month is drawn as soon as its export
answers; while the earlier weeks load (about 8 seconds on a cold cache) their days show as "no data"
with a loading pattern and the note "Loading earlier weeks from codeburn...". If that export fails
or times out they stay "no data" and the note gives the reason; they are never drawn as $0. The
legend shows the date range the heatmap covers. `--json` and `--snapshot` wait for the earlier
weeks, and `usage.history` in `--json` says whether they are `ready`, `pending` or `error`. Both are cached in
`~/.prism/cache/usage.json` (readable only by you) for 5 minutes. The page paints from local data
first, with the spend cards showing "loading", then fills usage in. A cache older than 5 minutes is
shown at once and refreshed in the background. A failed or missing codeburn is shown as such and
never cached.

Before there is a month to draw, the Spend card stays in its place with an empty state. Without
codeburn it says what the card will show once codeburn is set up, with **Set up codeburn** and the
command once to copy, `prism-cli enable codeburn`. The button runs `prism-cli enable codeburn --yes`
after a confirm dialog: it installs codeburn from npm when it is missing, then sets up its sync in
the mode saved on the machine (local only by default; the scheduled push when the machine already
syncs to a team PRISM). With codeburn set up and no usage this month yet, the card says so, with no
button. A static snapshot shows the command only. The repo table's spend column shows `-` either way.

![The Spend card with demo data before codeburn is installed: what the card shows once it is set up, Set up codeburn, and prism-cli enable codeburn to copy](assets/images/prism-cli/dashboard-spend-empty-light.png)

**Security runs.** The latest 5 Security Agent runs (code reviews, threat models and pentests) in
every repo, newest first, read from each repo's `.prism/results/`. Reading them makes no AWS call.
While a run is pending, the open page has the dashboard check its job with AWS: when the page
loads, then while it stays open and visible. For a code review or threat model the check is the
read-only command a Fetch button runs (`security findings --job` or `security threats --job`, no
`--wait`), about every minute. For a pentest it is `security pentest --status --job <job>`, every 5
minutes, since a pentest runs for hours. That one writes to AWS once the job has finished: it saves
the findings and cleans the environment up, so a pentest started from the page needs no status
button. It removes only the resources that run recorded, never another run's, and never a run
started with `--keep`. Since 1.21.12 a finished pentest goes through these states:

| Status | Meaning |
|---|---|
| **Cleaning up** (amber) | The job has finished and its findings are saved; the environment is being removed. The row shows for how long and what is still there (for example the stack, `DELETE_IN_PROGRESS`). Each check takes the cleanup one step on without waiting, so a stack deletion that takes over an hour never holds a check. |
| **Cleanup failed** (red) | The stack failed to delete twice (the teardown's own retry), or a Security Agent resource was still there after a second delete, or the cleanup could not be checked (a read kept failing, for example access denied) for 6 checks in a row. The reason is shown; **Clean up** on the run's page tries again and verifies. |
| **Environment kept** | Started with `--keep`: the environment stays up on purpose until you press **Clean up**. |
| **Complete · cleaned up** | A check confirmed, read-only, that the CloudFormation stack is gone (`DELETE_COMPLETE` or it no longer exists) and that the target domain and agent space (or pentest) the run recorded are gone in Security Agent. A pentest whose job failed shows **failed** at this point instead. |

The findings can be opened in every state. A record an older prism-cli marked complete while it
still names its stack shows **Cleaning up**, and the check removes and verifies it the same way. The command checks the account itself and only finds a run recorded in the
account and region it runs in; a run it cannot find there fails the check visibly. Each check runs
in that repo, with the same profile and region the page's buttons use, so it saves the verdict
exactly as that command does. When the job has finished, the row turns **complete** with its
findings, without a reload. One check runs per job at a time, at most two at once and one pentest
at a time, never while another dashboard action runs, and after a failed check the next one waits
longer each time (up to 30 minutes). While a pentest check runs, Start pentest and Clean up wait
for it. A pentest check is stopped after 90 minutes. A static snapshot (`dashboard --snapshot`)
shows each run's state but checks nothing, cleans nothing up and has no buttons.

![The Security runs table with demo data: a pentest whose cleanup failed, with its DELETE_FAILED reason and a pointer to Clean up on its page; a pentest that is Complete · cleaned up; and code review and threat model runs that are complete](assets/images/prism-cli/dashboard-security-runs-cleanup-dark.png)
![A pentest run's page with demo data while it cleans up: the Cleaning up card says the job has finished and its findings are saved, lists the stack still there, and when the last step ran](assets/images/prism-cli/dashboard-security-run-cleaning-up-dark.png)
Each row shows:

| Column | What it shows |
|---|---|
| Type | Code review, Threat model or Pentest, with an icon |
| Repo | The repo, its branch and commit |
| Status | **complete**, **running** (amber), **failed** (red) or **no verdict yet**. A running or failed row also has an amber or red bar on its left edge. A pending run that the last check found still running reads **running**, with when it was checked. A run still pending after 2 hours (6 for a pentest) reads **no verdict yet** only when no check could run or the check failed (no credentials, an expired SSO session, access denied, job not found): the row then says why, with account ids and home paths masked, and gives the fetch command to run by hand. The same reason is the title of the `stale?` pill on the Security Agent page |
| Started | When it started, and how long it took (or how long it has been running) |
| Summary | Four severity chips (critical, high, medium, low; a zero is greyed out) and the top finding's title, or `No findings`; a failed run shows its reason |
| Link | **View findings →** to the run's page; a running run has no link yet |

**See all N runs →** opens the full table on the [Security Agent page](#security-agent-page). On a
phone the rows stack (type and status on the first line, then repo, time, chips and the link):
[390 px screenshot](assets/images/prism-cli/dashboard-security-runs-390-dark.png). With
no run saved yet, the Get more strip points to `prism-cli enable security` and `prism-cli security
code-review` instead.

**AWS account.** One line per AWS account with a cached `prism-cli aws check` result (from every
repo's `.prism/results/` and `~/.prism/results/`): the account's last 4 digits, region, when it ran,
fails by severity, passing and could-not-check counts, and **Open AccountGuard →**, where the checks,
fixes and baseline are. With none cached, it points to `prism-cli aws check` and AccountGuard. Local
files only; no AWS calls.

**Get more from PRISM.** A section with nothing recorded yet (codewatch, Security Agent results,
AWS account checks) is not shown; instead this strip lists it with the command that fills it.
Spend keeps its card with an empty state (above).

Data is read when the page loads, and again every minute while the tab is visible (usage from the
cache). The **Refresh** button also runs new codeburn exports.

### Repo View

![The repo view for the demo repo checkout-service: four cards, findings over time, the newest reviews with report links and skip reasons, commits, setup, Security Agent and the open findings](assets/images/prism-cli/dashboard-repo-dark.png)

`#repo/<id>` (open it from a Codewatch row; the browser's Back returns to the dashboard) shows one
repo: cards for open findings, pre-push reviews in the last 30 days (and how many were skipped),
commits the pre-commit scan blocked for secrets, and this month's spend; a chart of the last 24
pre-push reviews by severity; the newest 10 reviews with their report links and skip reasons; the
commits with their secret scan and review status (a row with findings expands to list them; each
finding is placed on the commit that introduced the line with `git blame` at the reviewed tip, or
marked "in push of <tip>" when blame cannot place it); the repo's codewatch setup and fix; its
Security Agent setup and latest cached code review and threat model; the open findings; and, at
the bottom, the **Security runs** table filtered to this repo (Type and Status filters, the first 10
rows, **Show 25 more**). Sections with nothing to show are left out.

### Scan Report Pages

Each review in the repo view's **Reviews** list links to `/report/<id>`, a printable page with the same content as
`prism-cli codewatch report`. `/report/<id>.md` returns it as Markdown. See
[Scan Reports](#scan-reports) to export a report without the server.

### Options

`--json` prints the dashboard data as JSON and exits without starting a server; with it, `--fresh`
runs the codeburn exports now instead of using the 5-minute usage cache, and `--timing` prints how
long each stage took (scan, setup, usage, total) to stderr, with the same numbers in the JSON's
`timing`. `--port` takes 1024-65535. Every flag, with its default:
[`prism-cli dashboard`](docs/CLI-REFERENCE.md#prism-cli-dashboard).

### Static snapshot

`prism-cli dashboard --snapshot <file.html>` writes the dashboard as one self-contained HTML file and
exits: no server, no port and no token. It has the same Dashboard and Settings views as the live page,
with the data embedded in the file, and works with or without `--root`. The page shows when it was
generated, doesn't refresh, and makes no network request: its Content Security Policy is
`default-src 'none'`, with the inline script and style allowed by hash. On the Settings view the Run
buttons become Copy buttons that show the command, **Connect** is turned off, and report links
are plain text (use `prism-cli codewatch report`). The file is written with mode 0600 because it
shows local paths and your saved AWS account, like the live page. The path is printed on stdout.

`--open` opens it in your browser (`xdg-open`, `open` or `start`) when a display is available. In an
SSH session with no display it prints the path and a note instead; copy the file to your laptop and
open it there. Usage comes from the 5-minute cache, as with `--json` (`--fresh` runs codeburn first).

### Editor and Kiro Crew hosts (`--serve-stdio`)

`prism-cli dashboard --serve-stdio` is for programs that show the dashboard inside another app: the
PRISM VS Code extension (0.2.0 and later) and the PRISM Kiro Crew app (0.3.0 and later). You don't run
it yourself. It opens no port and no browser. It answers the same API as the live page, one JSON
object per line on stdin and stdout, with the same handlers and checks: the same action allowlist, the
same confirmation for actions that need it, and the same Security Agent check before an AWS upload.
Requests are refused when they name an unknown route, are not valid JSON, or are larger than 20 KB.
It stops, along with any action it is running, when the program that started it closes its stdin.

Those apps draw the page from the copy of the UI that ships with your installed prism-cli
(`dist/ui` in the npm package), so the page and the CLI are always the same version. They need
prism-cli 1.21.0 or later.

### Remote Machines

On a cloud desktop or other remote host, keep the dashboard on the remote loopback and forward the
port over SSH instead of binding it anywhere else:

```bash
# on the remote host
prism-cli dashboard --port 8765 --no-open

# on your laptop
ssh -L 8765:127.0.0.1:8765 <remote-host>
```

Then open the printed URL (`http://127.0.0.1:8765/?token=...`) in your laptop's browser.

---

## Security Agent Setup (enable security)

`prism-cli enable security` sets up AWS Security Agent (Continuum) for PRISM in one account and
region, **once per machine**. Run it from any directory: no repo is needed and the result is the
same everywhere. Unlike codewatch, it calls AWS and can create resources, so it always shows what it
will do and asks first.

```bash
prism-cli enable security --dry-run    # every read, then the plan; changes nothing
prism-cli enable security              # the same plan, then asks before any change
prism-cli enable security --status     # read-only report; in a repo, also that repo's code review
```

Each repo's code review (what the CI eval gate and `security code-review` run against) is per repo,
and nothing has to be enabled for it: `prism-cli security code-review` creates it on its first run
in a repo, and the eval gate does the same on its first CI run. `prism-cli enable security --repo`
sets it up now instead (see [Per-repo code review](#per-repo-code-review-optional)).

### Which setup a command uses

`enable security` saves the machine setup in `~/.prism/security.json`: the agent space and
application ids, the account and the region, and when (no credentials; the file is owner-only, and
the account is shown as its last 4 digits). Every `security` command, `enable security --status`
and the dashboard resolve the setup in this order:

1. Explicit flags (`--region`).
2. The repo override `.prism/security.local.json`, only if the repo has one and git does not track
   it. Repos set up by prism-cli 1.16 or earlier have this file, so they keep working unchanged.
3. The machine setup `~/.prism/security.json`.
4. None: `security code-review`, `findings`, `threat-model` and `threats` stop before any AWS call
   with `Security Agent is not set up on this machine: run prism-cli enable security (once, from
   any directory).`

The setup's region comes before `AWS_REGION` and the `aws connect` region, because the agent space
exists only in the region it was set up in. Credentials are chosen as before (`--profile`,
`AWS_PROFILE`, the `aws connect` profile, the default chain). When they resolve to another account
than the setup's, the command warns and does not use the setup's ids. `enable security --status`
prints a `Setup` row naming the source in use and, in a repo, a `Repo override` row. The SSM
parameters in the account stay the source of truth for the ids; the files only pick the region and
fill in when SSM has no value. `enable security` itself (without `--repo`) reads only the flags and
the machine setup, never a repo override, so it gives the same result in every directory.
`security pentest` does not use the setup: it creates its own agent space for each run.

### Prerequisites

- AWS credentials for the target account. With no `--profile` the standard AWS credential chain is
  used (`AWS_PROFILE`, environment keys, SSO, a container or instance role); `--profile` picks a
  named profile. The account must be CDK-bootstrapped (`npx cdk bootstrap`).
- A region: `--region`, else the region of an existing machine setup, else `AWS_REGION`, else
  `AWS_DEFAULT_REGION`, else the `aws connect` region, else the region configured for the profile in
  use (`aws configure get region`). With none set, the command refuses and asks for `--region`.
  There is no built-in default.
- AWS CLI v2.36 or later, for the `securityagent` commands.
- Node.js 22 (the CDK app is synthesized locally; its dependencies are installed on first use).

### What It Does

1. Before any AWS call it says what it is about to do: deploy an AWS Security Agent space, an IAM
   service role and policies, an encrypted S3 scan bucket and SSM parameters into the account your
   credentials point to, which may incur cost. `--dry-run` and `--status` print one line saying
   nothing will be changed instead.
2. Checks the AWS CLI version and your identity, and prints the account ID and alias, the caller
   ARN, the region and where it came from, and where the credentials come from (`--profile`,
   `AWS_PROFILE`, environment variables, or the default chain).
3. Picks the stack (see [Which Stack It Deploys](#which-stack-it-deploys)), synthesizes the CDK app
   and compares the result with what is deployed.
4. Prints a summary: resources to add, change and remove, with every IAM and resource-policy,
   security group and network, and public endpoint change named. The full `cdk diff` output is
   written to a file and its path printed.
5. Looks up the agent space and the Security Agent application and its role.
6. Prints each item as ok, create, update, conflict or skip, with the exact AWS command for every
   change. The per-repo items show as skip (`per repo, not part of the machine setup`).
7. Asks once, naming the account ID, its alias and the region. Then it deploys the stack if needed,
   and creates the application and attaches the `prism-d1-security-agent-prism-d1-security` role.
8. Writes `~/.prism/security.json` (agent space and application ids, account, region, setup time;
   no secrets; owner-only). A re-run that changes nothing leaves it as it was. The
   [Local Dashboard](#local-dashboard) reads it.

The resolved region is passed to every AWS call and to CDK, so every step works in the same region.

### Another account or region

The machine setup is the default for every repo on the machine, so `enable security` never
rewrites it by accident. When `~/.prism/security.json` exists and a run resolves to a different
account (other credentials) or region (`--region`), the run stops after the read-only identity
check and before any change:

```text
Error: The machine setup ~/.prism/security.json is account ••••3333, region us-west-2; this run
resolves to account ••••3333, region eu-west-1. Writing it would change the Security Agent default
for every repo on this machine. Run it in a repo with --repo to set up an override for that repo
only, or pass --replace to change the machine default. Nothing was changed.
```

- `--repo` sets up that account and region for the current repo only (the repo override below) and
  leaves `~/.prism/security.json` as it was.
- `--replace` makes this account and region the machine default for every repo.
- `--dry-run` prints the same message as a note and still shows the plan.
- A run with the same account and region is a normal, idempotent re-run.

### Per-repo code review (optional)

The only per-repo part of the setup is the code review the eval gate scans pull requests against:

- a snapshot of the repo, `git archive HEAD`, at `s3://<scan bucket>/repo/<repo-slug>/latest.zip`;
- a Security Agent code review titled `<repo-slug>-ci-diff-scan`, with that snapshot as its source;
- the SSM parameter `/prism/continuum/code-review-id/<repo-slug>` holding its id, which the gate
  and `security code-review` read.

There is no CI step, file or marker to add for it. `prism-cli security code-review` creates all
three on its first run in a repo (reusing a code review with that title if one exists, read
across every page of `list-code-reviews`, and never overwriting the SSM parameter), and the eval
gate creates them on its first CI run. To create them up front, run in the repo:

```bash
prism-cli enable security --repo                     # this repo, named from its origin remote
prism-cli enable security --repo github.com/o/name   # when the remote does not match what CI sees
```

`--repo` runs the machine setup too, then the per-repo items (shown in the plan, and asked about
with the rest), and writes the repo override `.prism/security.local.json` (agent space,
application and code review ids, account, region, setup time; no secrets). When the run is for
another account or region than the machine setup, `--repo` writes only the repo override and keeps
`~/.prism/security.json` as it was. The override is per
developer and never committed: if git does not already ignore it, the command adds it to this
clone's `.git/info/exclude` (found with `git rev-parse --git-path`, so linked worktrees work) and
never edits `.gitignore`. `.prism/config.json` is not touched and stays safe to commit. Outside a git
repository `--repo` stops before any change.

Versions before 1.17 wrote the override on every run, and earlier ones a `security` block inside
`.prism/config.json`. Both keep working: the dashboard still accepts the legacy block, `--status`
reports it as legacy, and the next `enable security --repo` moves it into
`.prism/security.local.json` and removes only that key from `config.json`, keeping the other keys
and the indent. Delete `.prism/security.local.json` to make a repo use the machine setup.

`<repo-slug>` is computed exactly as the eval gate does: the `origin` remote as `host/owner/name`
with `/` replaced by `-`, for example `github.com-acme-widgets`.

### Which Stack It Deploys

The Security Agent resources can live in one of two stacks, never both:

| Layout | Stack | CDK context | Used when |
|---|---|---|---|
| Standalone | `PrismD1SecurityAgent` | `securityAgentStandalone=true` | The account has no Security Agent resources yet (also when the metrics pipeline is deployed without them) |
| Pipeline | `PrismD1MetricsPipeline` | `enableSecurityAgent=true` | The account already hosts Security Agent in the pipeline stack (the layout older versions deployed) |

The command reads both stacks and decides:

- Security Agent already in `PrismD1MetricsPipeline`: keep using it. Nothing moves, no second agent
  space is created.
- `PrismD1SecurityAgent` deployed: keep using it.
- Neither: deploy `PrismD1SecurityAgent`. A deployed pipeline stack is not touched.
- An agent space named `prism-d1-security` that neither stack manages, or Security Agent in both
  stacks: it stops and changes nothing.

It deploys with `--exclusively`, never `--all`, and only when needed: the stack is missing, it has
no Security Agent resources yet, or they differ from the local code. In the pipeline layout,
differences elsewhere in the pipeline stack are listed and not deployed.

The two layouts use the same resource names (role, managed policy, bucket, SSM parameters) and the
same CloudFormation exports (`PrismD1SecurityAgentSpaceId`, `PrismD1SecurityAgentRoleArn`,
`PrismD1ContinuumScanBucket`, and `PrismD1SecurityAgentDomainIds` when target domains are set), so
the CI eval gate and `setup-github-oidc` work with either, and CloudFormation refuses a second
copy in one account and region. The CDK app refuses to synthesize with both context flags set.
**In an account using the standalone layout, deploy the pipeline without
`--context enableSecurityAgent=true`.**

If the stack was deployed with extra context, pass the same values with `--context`, for example
`--context skipVpc=true` for the pipeline layout. Without them the diff shows resources being
removed, and the summary warns about it. `--context` cannot change the layout: the command sets that
key itself.

**What the standalone layout does not include.** The Security Agent findings processor and the
remediation tracker read the metrics pipeline's tables, so they stay in `PrismD1MetricsPipeline`.
With only `PrismD1SecurityAgent` deployed, the CI eval gate still runs the Security Agent code
review and blocks on critical and high findings, but its findings events go to the
`prism-d1-metrics` event bus, which does not exist yet, so nothing reaches the dashboards (that step
is `continue-on-error`). Deploying the pipeline later (without `enableSecurityAgent`) starts the
ingestion; earlier findings are not backfilled.

### What the Stack Adds

The standalone stack holds 14 resources (synthesized locally; the pipeline layout adds the same ones
except the key, which is the pipeline's `PrismDataKey`):

| Resource | Exposure |
|---|---|
| Agent space `prism-d1-security` | Managed by the Security Agent service; no endpoint of its own |
| IAM role `prism-d1-security-agent-prism-d1-security` | Assumable only by `securityagent.amazonaws.com`. Allows `securityagent:*` on this account's agent spaces, CloudWatch Logs under `/aws/securityagent/*`, encrypt and decrypt with the KMS key, and read of the scan bucket |
| KMS key `alias/prism-d1-security-agent-key` (standalone only) | Rotation on, retained on stack deletion. Key policy: the account, `securityagent.amazonaws.com` for encrypt and decrypt, and CloudWatch Logs only for `/aws/securityagent/*` log groups. `--context securityAgentKmsKeyArn=<arn>` uses an existing key instead; its policy must already allow `securityagent.amazonaws.com` |
| S3 scan bucket `security-agent-scans-<account>-<region>` | Private: Block Public Access on, SSL required, SSE-S3, 30-day expiry. Its bucket policy denies every request without TLS, allows `s3:PutObject` and `s3:GetObject` only to this account's roles named `prism-d1-github-oidc-*`, and lets the auto-delete helper's role list and delete objects |
| Managed policy `prism-d1-continuum-ci-scan` | Not attached by the stack; `setup-github-oidc` attaches it to the CI role |
| SSM parameters `/prism/continuum/agent-space-id`, `scan-bucket`, `service-role-arn` | Plain ids and names |
| Auto-delete custom resource (Lambda and role) | CDK's standard helper that empties the bucket when the stack is deleted; not invoked from outside |

None of these is a public endpoint, and none changes a security group. The application the command
creates is the Security Agent web console; you reach it through the AWS console ("Admin access") with
your AWS sign-in.

### Confirmation and --yes

- In a terminal, the command asks before the first change. CDK then also asks before any IAM or
  security-group broadening, as it does by default.
- `--yes` approves without a prompt, for CI and other non-interactive use. CDK is not asked again.
- With no terminal and no `--yes`, it refuses and changes nothing.
- An SSM parameter that already holds a different value (a code review that no longer exists) is
  shown as a conflict and needs a second yes (or `--yes`) before it is overwritten.

### Re-running

Re-running is safe. Everything that exists is reused: agent space, application, code review (found
by the SSM id, or by the title the eval gate uses), S3 object (skipped when its ETag equals the MD5 of
the new archive) and SSM parameter. When nothing has changed it prints "Already set up: nothing to
change." and makes no AWS writes. Drift, such as a different role on the application, is shown before
it is fixed.

### --status

Read-only. Reports, per item: credentials, account and caller, which stack holds the Security
Agent resources (pipeline or standalone layout), the agent space, the application and its role, the three SSM parameters, the code
review for this repo (the application row warns when its role is attached but does not exist, and
names the application it checked when there are several), the CI workflow step (the eval gate's `start-code-review-job`), and the local
marker. It also flags the unused `/prism/continuum/code-review-id` parameter left by the old
`securityagent setup`.

At the end of a successful run the command prints the Security Agent web console URL. To check
the setup by hand with the AWS CLI:

```bash
aws securityagent list-agent-spaces --region us-west-2 --output table
# Should show: prism-d1-security | as-xxxxxxxxxxxx | ACTIVE
aws ssm get-parameter --name /prism/continuum/agent-space-id --query Parameter.Value --output text
```

### Options

Every flag, with its default:
[`prism-cli enable security`](docs/CLI-REFERENCE.md#prism-cli-enable-security).

### Permissions

Besides what `cdk deploy` needs (the CDK bootstrap roles), the caller needs `sts:GetCallerIdentity`,
`cloudformation:DescribeStacks` and `GetTemplate`, `ssm:GetParameter` and `PutParameter` on
`/prism/continuum/*`, `s3:GetObject` and `PutObject` on the scan bucket, `iam:PassRole` on the
service role, and `securityagent:ListAgentSpaces`, `ListApplications`, `GetApplication`,
`CreateApplication`, `UpdateApplication`, `ListCodeReviews` and `CreateCodeReview`.
`iam:GetRole` (to confirm the application's role exists) and `iam:ListAccountAliases` are optional;
without `iam:GetRole` the role is reported as attached but unchecked. On an AccessDenied the command names the API that failed and
the permission it needed.

### Removing It

There is no uninstall. Deleting the agent space, code reviews or scan bucket is a separate decision
that needs its own design; until then, remove them in the console or with CloudFormation.

`prism-cli securityagent setup` is a deprecated alias for `enable security` with the same flags. It
now asks before deploying, so scripts that ran it unattended need `--yes`.

---

## Security Scans from Your Machine

AWS Continuum (formerly AWS Security Agent) can review code, threat-model a repo and penetration-test
a running app (OWASP Top 10 and business-logic flaws). These commands run those jobs from a developer machine, against the repo you are in.
`security code-review`, `security findings`, `security threat-model` and `security threats` need
[Security Agent Setup](#security-agent-setup-enable-security) first; `security pentest` sets up its
own agent space. Each command's flags are in the
[command reference](docs/CLI-REFERENCE.md#prism-cli-security). The CI gate runs the same code
review on every pull request (see [Security Agent (Continuum) in the Gate](#security-agent-continuum-in-the-gate)).

Design review has no public API, so it stays in the Security Agent web console; there is no
`design-review` command. A manual, console-and-AWS-CLI route for GitHub integration and for testing
an already-deployed public URL is kept in
[docs/SECURITY-AGENT-MANUAL.md](docs/SECURITY-AGENT-MANUAL.md).

### Running a Review from the CLI

After `prism-cli enable security`, you can run the same Security Agent code review the eval gate
runs, from your machine:

```bash
prism-cli security code-review                    # this branch's diff against its upstream
prism-cli security code-review --full             # the whole repo at HEAD
prism-cli security code-review --fail-on high     # exit 1 on a high or critical finding
prism-cli security code-review --no-wait          # start it and come back later
prism-cli security findings                       # the pending job's findings, else the latest job's
prism-cli security findings --job <id> --wait     # a specific job, waiting if it is still running
```

`security code-review`:

1. Prints a notice, then the same account, caller, region and credential block as `enable
   security`, with the same credential chain, and the region from
   [the setup in use](#which-setup-a-command-uses). With no setup and no `--region` it stops first.
2. Finds the agent space and this repo's code review in SSM (`/prism/continuum/agent-space-id` and
   `/prism/continuum/code-review-id/<repo-slug>`), the source of truth, because a file in the repo
   could be committed by anyone. The setup record (repo override, else machine setup) is used only
   when SSM has no value, only for the same account and region, a repo override only if git does
   not track it, and it says so; when they disagree, SSM wins with a warning. The legacy `security`
   block in `.prism/config.json` is never read here. With no agent space, it says to run `prism-cli
   enable security` first and exits 1. With an agent space but no code review for this repo yet
   (its first run here), it creates one after the upload in step 4, as the eval gate does: titled
   `<repo-slug>-ci-diff-scan` (an existing one with that title is reused), with
   `repo/<repo-slug>/latest.zip` as its source, and its id put in
   `/prism/continuum/code-review-id/<repo-slug>` (never overwritten). `security findings` before
   that first run says so and makes no change.
3. Builds the scope. By default this is `git diff <base>...HEAD`, where the base is the branch's
   upstream, else `origin`'s default branch (`origin/HEAD`). With neither it stops before any upload:
   `This branch has no upstream and the remote has no default branch to diff against. Push the
   branch, or review the whole repo with --full.` Only committed
   changes are included. `--full` takes `git archive HEAD` instead. An empty diff starts nothing
   and exits 0, saying `No changes against <base>; nothing to review. To review the whole repo at
   HEAD, run with --full.`
4. Uploads to the scan bucket, skipping any upload whose object's ETag already matches. Both scopes
   first refresh the code review's own source, `repo/<repo-slug>/latest.zip`, to `git archive
   HEAD` and print `Review context: updated ... to HEAD <sha>`. A diff job reads that zip as the
   code around the patch, so a stale zip would make it report code that no longer exists. The
   Security Agent has no per-job source, so this is the zip CI diff jobs read too. A diff then
   goes to `diffs/<repo-slug>/local/<tip>-<base>.patch`. The result records the zip's commit as
   `security.context_commit`. While a job of the same code review is still pending in this repo's
   results (started within the last 2 hours, no verdict fetched yet), it stops before any upload:
   the service does not document when a running job reads that zip, so replacing it could change
   what the running job reviews. `security findings` fetches that job; `--force` starts another
   anyway. Jobs CI started are not in the local results.
5. Starts the job and at once saves a **pending** result in `.prism/results/` with the job ID, the
   scope and the commits. When the job ends, that same file is completed, so a wait that does not
   finish loses nothing. Then it waits. It polls every 10 seconds, doubling up to 60, with a
   one-line ticker on a terminal and plain lines otherwise. A failed poll (throttling, a network
   error) is retried 3 times, after 2, 4 and 8 seconds.
   - `--timeout <minutes>` (default 30): on timeout it prints the job ID and the `security findings
     --job` command, and exits 2.
   - Ctrl-C stops waiting but leaves the job running, prints the same hint, and exits 130.
   - A poll that still fails, or fails on credentials or permissions, prints the error and the same
     hint, and exits 1.
   - In all three cases, and with `--no-wait`, the pending result stays for `security findings`.
6. Prints the findings, grouped by risk level and then file: title, file:line, CWE when present,
   and a short description. Then totals, our wall time and the service's own job duration.
   Paths are repo-relative: the service's sandbox prefix (`.../source_code/code_sc-<id>/`) is
   removed, and the result keeps the original as `raw_file`.
7. Saves the result in `.prism/results/`, in the codewatch result format with `kind:
   security-review`, `tool: security-agent`, the job ID, base, tip and scope.

The uploads and starting the job are its only AWS writes. It exits 0 (report only, like
codewatch) unless `--fail-on <critical|high|medium|low>` finds a finding at or above that level,
which exits 1. A failed or stopped job exits 1 with its reason. `--json` prints only the result JSON
on stdout, with progress on stderr.

`security findings` is read-only. Without `--job`, it first looks for pending results in this repo
for the current account, region and code review. It takes the newest and names any older ones.
When that job has finished, it fetches the findings and completes the pending result, keeping its
scope and commits. Only when nothing is pending does it ask the API for the latest job (saved with
scope `unknown`). `--job <id>` fetches that job, and completes its pending result if there is
one. `--severity <level>` hides lower levels. A job still running exits 2 with a note; `--wait`
waits for it with the same poller.

**Exit codes** of `security findings`, `security findings --pentest` and `security threats`: `0`
fetched (or nothing to fetch), `2` the job has no verdict yet (still running, or a `--wait` that
timed out; nothing failed, check back later), `1` an error (a bad flag, AWS access, a failed job),
`130` Ctrl-C. Exit 2 is used for nothing else in these commands, so scripts can treat it as "not
finished yet".

Both work on one repository: run them from its top level, or pass `--path <repo>`. A subdirectory
is refused (the message names the top level), and so is a directory that is not a repository; they
never walk up to an enclosing repo. Results are written under that top level. `--repo
<host/owner/name>` is the repo id (not a path) the code review is named after, as in `enable
security`.

Both take `--profile`, `--region` and `--repo`, as `enable security` does. Besides the
`enable security` read permissions, they need `securityagent:StartCodeReviewJob`,
`BatchGetCodeReviewJobs`, `ListCodeReviewJobsForCodeReview`, `ListFindings` and `BatchGetFindings`,
`s3:GetObject` and `s3:PutObject` on the scan bucket, and `ssm:GetParameter`.

### Running a Threat Model from the CLI

A Security Agent threat model reads the repo at HEAD and, optionally, design docs (scope docs). It
returns a system overview and threats with a severity, STRIDE categories and a recommendation. AWS
does not charge for threat modeling while it is in preview. The research behind this command is in
[docs/RESEARCH-threat-model-design-review.md](docs/RESEARCH-threat-model-design-review.md).

```bash
prism-cli security threat-model                          # source + .kiro/specs/*/{design,requirements}.md
prism-cli security threat-model --doc docs/DESIGN.md     # these scope docs instead (repeatable)
prism-cli security threat-model --no-docs                # the source alone
prism-cli security threat-model --no-wait                # start it and come back later
prism-cli security threats                               # the pending job's threats, else the latest job's
prism-cli security threats --job <id> --wait --severity high
```

`security threat-model` works like `security code-review`: the same repo-root check, notice,
identity block, pending record, polling, `--json`, `--no-wait` and exit codes (Ctrl-C 130, timeout 2,
failed job 1). It differs in these ways:

1. The agent space, scan bucket and service role come from SSM (`/prism/continuum/agent-space-id`,
   `scan-bucket`, `service-role-arn`) only. No repo file is read for them.
2. Scope docs are read from **HEAD**, not the working tree, so they match the source that is
   modeled. A `--doc` must be committed, must be inside the repository, must not be a symlink, and
   must be `.md`, `.txt`, `.pdf`, `.doc`, `.docx`, `.png`, `.jpg` or `.jpeg`. A bad `--doc` prints
   one error line before any AWS call. Without `--doc`, the Kiro spec files
   `.kiro/specs/*/design.md` and `requirements.md` in HEAD are used when present.
3. `git archive HEAD` and the docs go to the scan bucket under
   `threat-model/<repo-slug>/<commit>/` (`source.zip`, `docs/<path>`). Identical objects are not
   uploaded again. The CI code review's `repo/<repo-slug>/latest.zip` is not touched.
4. Each run creates its own threat model, titled `<repo-slug>-tm-<commit>-<time>`, and starts its
   job. `security threats` finds the latest one by that title prefix.
5. `--timeout` defaults to 120 minutes. AWS's IDE docs give 5 to 30 minutes for a run, but a full-repo run with one scope doc took about 51 minutes in testing.
6. The output has the first paragraph of the system overview, then the threats by severity
   (CRITICAL, HIGH, MEDIUM, LOW, INFO). Each threat shows its STRIDE categories, title,
   recommendation and evidence paths, with the sandbox prefix removed. The result is saved with
   `kind: security-threat-model` and keeps the full overview in `threat_model.system_overview`.
7. `--fail-on <level>` exits 1 on a threat at or above that level. INFO never fails.

The agent space must list the scan bucket in `awsResources.s3Buckets`, or `create-threat-model`
refuses the upload. The stack lists it since this release. Before any upload, the command checks
the list with `batch-get-agent-spaces` and stops with no writes when the bucket is missing:
`the Security Agent space doesn't list the scan bucket <name>; run prism-cli enable security to
update it.` On an older stack, `enable security` sees the drift and updates the agent space in
place. `enable security --status` shows the same check as the `Scan bucket on agent space` row.
The extra read permission is `securityagent:BatchGetAgentSpaces`.

The API documents no scope-doc limits, so on a client error the command prints a hint to trim the
docs. It also warns when the docs exceed the web app's design-review limits: 5 files, 2 MB each
(0.5 MB for `.md` and `.txt`), 6 MB in total.

`security threats` is read-only and completes pending records like `security findings` does.

**IAM.** Besides the `enable security` read permissions, the two commands need:

- `securityagent:CreateThreatModel` and `StartThreatModelJob` (threat-model only);
- `securityagent:BatchGetAgentSpaces` (threat-model's bucket check);
- `securityagent:BatchGetThreatModelJobs`, `ListThreats` and `BatchGetThreats`;
- for `security threats` without a pending record, `ListThreatModels` and `ListThreatModelJobs`;
- `iam:PassRole` on the service role, conditioned on `iam:PassedToService = securityagent.amazonaws.com`;
- `s3:GetObject` and `s3:PutObject` on the scan bucket, and `ssm:GetParameter`.

The CI managed policy `prism-d1-continuum-ci-scan` grants only the code-review actions. Running a
threat model from CI would need `BatchGetAgentSpaces`, `CreateThreatModel`, `StartThreatModelJob`,
`BatchGetThreatModelJobs`, `ListThreats` and `BatchGetThreats` added to its `ContinuumScanAPIs`
statement. Its PassRole, scan bucket and SSM statements already cover the rest.

There is no `security design-review` command: design review has no public API (see the research
doc).

### Running a Penetration Test from the CLI

`prism-cli security pentest` builds this repo's app from its Dockerfile, deploys it into a
temporary **private** environment in your AWS account, and runs an AWS Security Agent penetration
test against that environment only. It never takes a URL, so it can only test what it just
deployed. The design is in [docs/DESIGN-prism-cli-pentest.md](docs/DESIGN-prism-cli-pentest.md).

```bash
prism-cli security pentest --dry-run                    # the plan, target and cost; changes nothing
prism-cli security pentest                              # deploy, start the job, return (no wait)
prism-cli security pentest --status                     # refresh the job and its run state; clean up once it has finished
prism-cli security findings --pentest                   # read the findings (read-only)
prism-cli security pentest --cleanup                    # remove the environment now
prism-cli security pentest --wait --fail-on high        # wait (up to 6 h), then exit 1 on a high finding
```

**Prerequisites**

1. Docker running locally, to build the image.
2. The account and region bootstrapped for CDK (`npx cdk bootstrap aws://<account>/<region>`).
3. AWS CLI 2.36 or later, with permission to deploy CloudFormation, ECR, ECS, EC2, ELB,
   Route 53, S3, CloudWatch Logs and IAM, and to call the Security Agent pentest APIs.
4. `prism-cli enable security` is **not** required: each run creates its own agent space.

**`.prism/pentest.json`** (committable; every field is optional):

```jsonc
{
  "appType": "dockerfile",                 // v1 supports only dockerfile
  "path": "sample-app",                    // Docker build context, relative to the repo root (default ".")
  "dockerfile": "sample-app/Dockerfile",   // relative to the repo root (default <path>/Dockerfile)
  "port": 8080,                            // the port the container listens on (default 8080)
  "healthPath": "/health",                 // ALB health check path (default /health)
  "env": {
    "LOG_LEVEL": "info",                                              // a literal value
    "DB_PASSWORD": { "secret": "arn:aws:secretsmanager:...:secret:db" } // a Secrets Manager reference
  },
  "actors": [                              // optional signed-in test users
    { "identifier": "user", "auth": { "providerType": "SECRETS_MANAGER", "secret": "arn:aws:secretsmanager:...:secret:user" } }
  ],
  "excludeRiskTypes": ["DENIAL_OF_SERVICE"]
}
```

An `env` name that looks sensitive (`password`, `secret`, `token`, `key`, ...) must be a
`{ "secret": "<arn>" }` reference; a literal value there is refused, so no credential lands in
the committed file. Secrets are injected by ECS when the task starts. An actor's `providerType` is
`SECRETS_MANAGER`, `AWS_LAMBDA` or `AWS_IAM_ROLE`, and its ARN must be in the same account. The
pentest's service role is granted read on exactly the actor ARNs listed. `--app-dir`,
`--dockerfile`, `--port` and `--health-path` override `path`, `dockerfile`, `port` and
`healthPath` for one run.

**From the dashboard.** On the Security Agent page, **Start new work** has a **Pentest target**
picker. It lists the Dockerfiles git tracks in the picked repo (`Dockerfile`, `*.Dockerfile` and
`Dockerfile.*`, at most 50), preselects the one `.prism/pentest.json` names (marked **from
.prism/pentest.json**), else `./Dockerfile`, else the first, and has **Other folder…** for a folder
or Dockerfile you type. The **Build folder** defaults to the Dockerfile's folder; **Port** and
**Health path** start from `.prism/pentest.json`, else the defaults (8080, `/health`). The server
checks a typed path before any command is shown: it must be relative to the repo, stay inside it
(no `..`, no absolute path, no symlink out of it), and name a folder with a Dockerfile or a
Dockerfile; otherwise the reason is shown under the field. The **Pentest** command then carries
`--app-dir`, `--dockerfile`, `--port` and `--health-path`, shell-quoted, to copy, and **Start
pentest** runs it with `--yes`, after a confirm dialog that lists what it deploys (see
[Security Agent Page](#security-agent-page)). `--dry-run` is CLI only: run it in a terminal. The choice is asked each time: nothing is written to the repo or to
`.prism/pentest.json`, and the page keeps it only until you reload it. A `.prism/pentest.json`
that does not load is named on the card and its values are not used. If the Dockerfile list itself
cannot load (the dashboard or its host went away for a moment), the card says why and offers
**Retry**, which lists the files again without a reload; until then the plain commands stay
available to copy.

![The Pentest target item with demo data after the Dockerfile list failed to load: the reason, Retry, and the plain pentest command to copy](assets/images/prism-cli/dashboard-pentest-picker-retry-dark.png)

`security pentest` checks its own flags by the same rules as the picker (one shared check): a
folder and a Dockerfile relative to the repo that stay inside it, symlinks included, at most 400
characters and no control characters; a health path that starts with `/`, with the same limits; a
port from 1 to 65535. A flag given empty (`--port ''`) is an error, not the default.

**Flags.** Every flag, with its default (`--timeout` 360 minutes for `--wait`):
[`prism-cli security pentest`](docs/CLI-REFERENCE.md#prism-cli-security-pentest).

**Waiting, status and teardown.** A run takes hours: the reference runs took about 2 h 50 min,
mostly in the `PENTEST` step. So by default the command starts the job, saves a pending record in
`.prism/results/` and returns. It prints the follow-up commands with the `--profile` and
`--region` you passed.

- `--status` refreshes the job and prints its step and its `Run state:` (Cleaning up, Cleanup
  failed, Environment kept, Complete · cleaned up). Once the job has finished, it saves the
  findings and starts the cleanup, unless the run was started with `--keep`. Each later `--status`
  takes the cleanup one step on and returns without waiting: the stack still deleting stays
  Cleaning up; the agent's network interfaces still attached wait (up to 10 minutes) before the
  stack is deleted; a stack that ends `DELETE_FAILED` is deleted once more, then the run is
  Cleanup failed (exit 1). Once the stack and the Security Agent resources are checked gone it
  prints `Cleanup verified`. `--job <id>` picks the run (default: the latest in this account and
  region); the dashboard runs `--status --job <id>` by itself for each pending pentest and each one
  still cleaning up.
- `--wait` polls until the job finishes (or `--timeout`), prints the findings, then tears down and
  verifies.
- `--keep` leaves the environment up after the job, to reproduce a finding. The run records it, so a
  later `--status` (and the dashboard's check) leaves it up too; remove it with `--cleanup`.
- `--cleanup` removes a run's environment at any time; it stops a running job first. `--job <id>`
  picks the run.
- `security findings --pentest [<job>]` reads the findings without deleting anything.

Teardown deletes the pentest, the run's agent space, its target domain and the CloudFormation
stack. It first waits for the agent's network interfaces to be released, then retries the stack
deletion once. Then it verifies, with read-only calls (`cloudformation describe-stacks`,
`securityagent batch-get-target-domains`, `batch-get-agent-spaces` or `batch-get-pentests`), that
each is gone; what is still there in Security Agent is deleted once more. Only then is the run
complete. If it still fails, the record keeps a `teardown failed` marker and the state Cleanup
failed, which `--status` and the dashboard show; run `--cleanup` again later. The record keeps the
state as `pentest.cleanup` (`state`, `since`, `left`, `reason`, `verified_at`).

**What it creates.** One CloudFormation stack per run, `PrismPentest-<repo>-<id>`, tagged
`prism:purpose=pentest` and `prism:expires-at`:

- a new VPC with two private subnets only: no public subnet, no internet gateway, no NAT, and no
  `0.0.0.0/0` ingress;
- VPC endpoints for ECR, S3, CloudWatch Logs, and Secrets Manager when `env` uses secrets;
- the app on Fargate behind an **internal** ALB, reachable only from the pentest agent's security
  group, under a private Route 53 name `app.<id>.prism.internal`;
- a scoped service role, a private source bucket (the repo at HEAD, for white-box testing) and a
  log group.

Before deploying, the command shows the plan and the cost and asks for confirmation (`--yes`
skips the prompt). It starts the job only after the app passes the ALB health check, waiting up
to 10 minutes. If the app never becomes healthy, no pentest is created; the command prints the
target's health reason and an `aws logs tail` command for the app's log group, and leaves the
environment up for `--cleanup`.

**The run record (1.21.7).** Right after the confirm and before anything is deployed, the command
writes the run's record in `.prism/results/` with status `deploying`, and updates its step as it
goes (the same steps the dashboard shows as Bootstrapping). When the job starts, the same file
becomes the pending record; if the deploy fails, it becomes an error that keeps the stack name and
anything already created in Security Agent, so `--cleanup` removes it. Started from a terminal or
from the dashboard, the run looks the same on the dashboard. `--status` on a run that is still
deploying prints its step and exits 0; if its process is gone, it marks the run interrupted.
`--cleanup` refuses while the deploy is still running (it would delete the stack under it) and
removes an interrupted or failed deploy's environment.

**Cost.** Security Agent penetration testing is billed in task-hours, publicly reported at **$50
per task-hour** (per-second metered; check the current AWS Security Agent pricing page). The
environment adds Fargate, internal ALB and VPC endpoint charges while it is up. With a
reference run of about 2 h 50 min, budget accordingly, and do not leave `--keep` environments
running.

**Findings.** Each finding has a risk level and the agent's confidence, but no file or line.
Findings the agent rated `FALSE_POSITIVE` are hidden by default, and `--fail-on` ignores them;
`--include-false-positives` shows them. The result is saved with `kind: security-pentest`, and the
dashboard's Security card shows it under "Penetration tests".

**VPC quota.** Each run creates one VPC, and an account allows 5 VPCs per region by default.
Concurrent runs, `--keep` environments or a failed teardown count against that quota. When a
deploy fails with `VpcLimitExceeded`, run `--cleanup` on old runs, or request a higher quota in
Service Quotas.

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
5. Outputs structured JSON: findings with file/line, severity, score. If the reply is not valid JSON, the gate re-runs the same review once with an instruction to return only the JSON object, and the job summary records which attempt was used. If both replies are unparseable, the gate fails closed
6. Gate fails if any high-severity finding, score < 0.82, **or any gitleaks finding**
7. PR comment posted with the review verdict and the secret-scan result

Without `KIRO_API_KEY` the review reports `SKIPPED` — never a silent pass — while the secret scan
still runs and can still block. That is the fork-PR condition, and it is why gitleaks is the gate
with teeth there.

**Review model.** The gate passes one model to kiro-cli (`--model`) for the smoke test, the first
attempt and the retry. It takes the first of:

1. The `PRISM_REVIEW_MODEL` repository variable (Settings → Secrets and variables → Actions →
   Variables). On GitLab, a CI/CD variable of the same name.
2. `eval.model` in `.prism/config.json` as committed on the **base branch** (GitLab: the merge
   request's target branch), the same key the local pre-push review reads.
3. `auto`.

```json
{ "eval": { "model": "claude-sonnet-4.5" } }
```

The gate never reads the PR's own copy of `.prism/config.json`, so a PR cannot pick a weaker model
to pass its own review; a model change in that file takes effect after it merges. The value must
match `^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$`: 1 to 100 letters, digits and `._:/-`, not
starting with `-` (the id is passed to kiro-cli as an argument). Anything else (or a base-branch config that is not valid JSON)
fails the gate closed with `Invalid review model` instead of falling back to `auto`. The resolved
model and where it came from are shown in the job summary and the PR comment, and sent as
`ai_context.model` on the `prism.d1.eval` event. `eval.model` is shared with the local review, so
if your local reviewer is Claude Code and the name is not one kiro-cli accepts, set
`PRISM_REVIEW_MODEL` for CI instead.

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

### Security Agent (Continuum) in the Gate

When the account has Security Agent set up ([Security Agent Setup](#security-agent-setup-enable-security))
and the OIDC role has the `prism-d1-continuum-ci-scan` policy, the eval gate (`prism-eval-gate.yml`)
also runs an AWS Continuum code review of the pull request as a deterministic security scan:

1. Uploads the PR diff to S3 as a `.patch` file
2. Calls `StartCodeReviewJob` with the diff S3 URI
3. Polls `BatchGetCodeReviewJobs` every 30 seconds, up to 60 attempts (a 30-minute ceiling; scans
   typically finish in 5-15 minutes)
4. Calls `ListFindings` to get structured results with risk levels
5. Fails the gate on a **critical or high** finding
6. Forwards findings to EventBridge for dashboard reporting

No GitHub App polling or comment parsing is involved; it is fully API-driven. The findings that
reach the PRISM pipeline are tagged with Continuum's own `riskLevel` and, where the finding carries
one, a CWE id; correlated with AI vs human code origin from codeburn attribution; and surfaced in
the Team, Executive and CISO dashboards.

Limitations:

- **Code reviews require the `securityagent` CLI subcommands**: AWS CLI v2.36 or later.
- **Code Review resources are per repo.** The eval gate creates one on its first run and stores
  the id in SSM, so pre-provisioning it with `prism-cli enable security` is a convenience rather
  than a prerequisite.
- **Design reviews are web-console-only**: not automatable from the CLI or CI.
- **Pen tests take hours**, so they do not belong in a blocking CI gate. Run them with
  [`prism-cli security pentest`](#running-a-penetration-test-from-the-cli).

### Uninstall

```bash
prism-cli bootstrapper install-eval-harness --uninstall
```

---

## AWS Account Advice (aws connect, check, recommend)

Three commands that look at one AWS account and say what to fix. All three are **read-only** against AWS: they only describe, get and list, and each says so before its first AWS call. Design notes: [DESIGN-prism-cli-aws-advise.md](docs/DESIGN-prism-cli-aws-advise.md).

```bash
prism-cli aws connect --profile prism-sa-test --region us-west-2   # verify and save the default profile and region
prism-cli aws check                                                 # run the checks, save the result
prism-cli aws recommend                                             # ranked fix list from that result (no AWS calls)
```

### aws connect

Picks the AWS profile and region the other AWS commands use by default, checks them with `sts get-caller-identity`, and reports:

- the account and its alias (`iam list-account-aliases`);
- whether it is an Organizations management account (`organizations describe-organization`; "unknown" when that is denied);
- whether the identity looks admin or read-only, from its attached managed policies when they can be read, else from the role or user name; "unknown" when neither is conclusive.

Without `--profile`, on a terminal it lists `aws configure list-profiles` to choose from; without a terminal it uses `AWS_PROFILE` or refuses. The region comes from `--region`, else `AWS_REGION`/`AWS_DEFAULT_REGION` or the profile's region (asked on a terminal).

It stores **no credentials**: only `{profile, region, account, alias, verifiedAt}`, in `~/.prism/aws.json` (per user) or, with `--repo`, in `.prism/aws.local.json` (per repo; added to `.git/info/exclude` so it is never committed). The AWS CLI still resolves the profile's credentials itself on every call, so an expired SSO session still needs `aws sso login`.

`--status` shows both files, which one applies, and whether it still validates; it exits 1 when it
does not, or when the account changed. `--clear` removes the user file, or the repo file with
`--repo`. Every flag: [`prism-cli aws connect`](docs/CLI-REFERENCE.md#prism-cli-aws-connect).

`--json` (with a connect, `--status` or `--clear`) prints one JSON object on stdout and the usual
lines on stderr, and never prompts. The shape is `prism.aws-connect.v1`; fields are only ever added:

```json
{
  "schema": "prism.aws-connect.v1",
  "action": "connect",
  "ok": true,
  "connection": { "profile": "prism-sa-test", "region": "us-west-2", "account": "••••3333", "alias": "sandbox", "verifiedAt": "2026-11-14T10:00:00.000Z", "scope": "user" },
  "access": "read-only",
  "org": "unknown"
}
```

- `action` is `connect`, `status` or `clear`. `ok` is false on the same runs that exit 1, and then
  `error` holds the Error line (also when saving the connection file fails).
- `connection` is what was saved (connect) or the connection that applies (status), with the account
  as its last 4 digits; null after `--clear`, or when nothing is saved.
- connect adds `access` (`admin`, `read-only` or `unknown`) and `org` (`management`, `member`, `none`
  or `unknown`). status adds `inUse`, `envOverride` (the env var that wins over the saved profile, or
  null) and `validation` (`{ok, accountMatches, error}`). clear adds `removed` and `scope`.
- The JSON never carries a credential or a full account id. `error` and `validation.error` go through
  the same masking as the dashboard's Action output drawer: every 12-digit number as its last 4 digits,
  an assumed-role ARN as its role name. The human lines on stderr still name the full account and the
  caller, as without `--json`.

**How the saved connection is used.** It becomes the default for `enable security`, every `security` command, `aws check`/`aws recommend` and `bedrock-protection`. The order, per field:

- profile: `--profile`, then the environment (`AWS_PROFILE`, or env keys / web identity / container credentials), then the repo file, then the user file, then the default credential chain;
- region: `--region`, then `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the saved region, then the profile's configured region.

The saved region applies only together with its own profile: `--profile other` uses `other`'s region. The identity header names the source, e.g. `Credentials: profile prism-sa-test (aws connect, user)`, and warns when the profile now resolves to a different account than the one saved. With no saved file, every command behaves as before.

### aws check

Runs read-only checks in sections and saves the result to `.prism/results/` as kind `aws-check` (in the current repo, or `~/.prism/results/` outside one). Each check is PASS, FAIL or INDETERMINATE; a check that could not run is INDETERMINATE and is never counted as a pass.

The result file is `aws-<run_id>-aws-check.json`, where `run_id` (also saved in the result) is the
start time plus 6 random hex characters, so no account id is in the file name. Results from before
1.16.0, named `aws-<account>-<region>-<time>-aws-check.json`, are still read by `aws recommend`,
AccountGuard and the Dashboard.

Each INDETERMINATE check records why it could not run in `reason`, and the report prints it on a
`Reason:` line with advice to match. Only `access-denied` says "Grant"; it also lists the IAM actions
in `needs`.

| `reason` | Meaning | Advice |
|---|---|---|
| `access-denied` | `AccessDenied`, `AccessDeniedException`, `UnauthorizedOperation`, `AuthorizationError` or "not authorized" | Grant the named read-only action (from the error message when it names one) |
| `not-available` | `OptInRequired`, `SubscriptionRequired…`, a service not enabled for the account (Cost Explorer that is switched off answers AccessDenied and still counts here), or no support in the region ("Could not connect to the endpoint URL" is `other`: it also means offline) | Nothing to grant: turn the service on if you use it, or check a region where it is offered |
| `throttled` | `Throttling`, `ThrottlingException`, `TooManyRequestsException`, `RequestLimitExceeded`, `Rate exceeded`, `SlowDown` | Nothing to grant: wait a minute and re-run |
| `no-credential-report` | No IAM credential report yet (`ReportNotPresent`) | Create one first; `aws check` never generates it |
| `prerequisite` | The check waits on another fix (budget alerts need a budget) | Do that fix first |
| `not-integrated` | The Startup Advisor placeholder | Nothing to do yet |
| `other` | Any other failure (a timeout, a service error) | Re-run; check the network and the AWS CLI if it repeats |

The summary adds one line counting the INDETERMINATE checks per reason. Results from before 1.16.0
have no `reason`; `aws recommend` and AccountGuard read it from the check's detail instead.

| Section | Checks |
|---|---|
| `bedrock` | The [`bedrock-protection scan-account`](docs/CLI-REFERENCE.md#prism-cli-bedrock-protection-scan-account) checks, unchanged, except that it never calls `iam generate-credential-report` (the credential-report checks are INDETERMINATE until a report exists) |
| `prism-setup` | The `PrismD1MetricsPipeline` stack; the Security Agent stack, its `/prism/continuum/*` SSM parameters and the scan bucket on the agent space (the `enable security --status` checks); a GitHub/GitLab OIDC provider and a `GitHubActions-*`/`GitLabCI-*` role; the codeburn sync endpoint on this machine (local file, no AWS call) |
| `baseline` | A logging multi-region CloudTrail trail; a GuardDuty detector; Security Hub; IAM Access Analyzer; at least one AWS Budget; account-level S3 Block Public Access; EBS encryption by default. Root MFA is checked once, in `bedrock` |
| `startup-advisor` | Placeholder, INDETERMINATE ("not integrated yet") until how PRISM consumes Startup Advisor is settled |

Regional checks (GuardDuty, Security Hub, Access Analyzer, EBS, the stacks) look at the resolved region only.

`aws check` refuses when no region resolves. It only reports by default: `--fail-on <severity>`
exits 1 when a FAIL is at or above it, and INDETERMINATE never trips it. `--json` prints the
findings on stdout, with notices on stderr. Every flag:
[`prism-cli aws check`](docs/CLI-REFERENCE.md#prism-cli-aws-check).

The dashboard's **AWS account** panel shows the latest result per account: counts by status, fails by severity and the top failures.

### aws recommend

Reads the latest `aws-check` result for the account (the `aws connect` account, or `--account`) and region, and turns it into a fix list. It makes no AWS calls and no model calls; `--refresh` runs `aws check` first.

- Each FAIL is looked up in a fixed table: a title, why it matters, the steps, the `prism-cli` command that fixes it when there is one (`enable security`, `enable codeburn`, `bootstrapper setup-github-oidc`) and a doc link.
- Fixes are ranked by severity, then effort (quick wins first), and grouped by section.
- Each INDETERMINATE check becomes an item that says what to do before it can be checked, by its
  `reason` (see [aws check](#aws-check)):
  - **access denied**: "Grant read access to check" this, naming the read-only IAM actions the check
    needs;
  - **not enabled here** or **throttled**: nothing to grant; turn the service on (or check another
    region), or wait and re-run;
  - **no IAM credential report yet**: create one first (`prism-cli bedrock-protection scan-account`
    generates one, which is a write, or `aws iam generate-credential-report`), because `aws check`
    never generates it;
  - **depends on another fix**: fix the named item first (for example, the budget-alert checks wait
    for a budget to exist), then re-run;
  - **not integrated yet** (the Startup Advisor placeholder) or any other cause: why it could not
    run.

  Items with the same step are merged into one. None of them counts as a pass.
- With no result it says so and suggests `prism-cli aws check` or `--refresh`.

`--json` prints the recommendations as JSON (`prism.aws-recommend.v1`), and `--markdown` also
writes `<result>.recommend.md` next to the result. Every flag:
[`prism-cli aws recommend`](docs/CLI-REFERENCE.md#prism-cli-aws-recommend).

### Permissions

Every check needs only read actions, so a read-only identity is enough. When a read is denied, the check is INDETERMINATE and `aws recommend` names the action to grant; a check that could not run for another reason (a service not enabled in the region, throttling, no credential report, a missing prerequisite) names that instead. Admin credentials work but are not needed; `aws connect` points this out.

---

## Bedrock Protection Audit

Three read-only commands that audit an account, an Organization and a repository for LLMjacking
exposure: credential theft aimed at model inference, where a leaked long-lived key is spent on
Bedrock. The layered model, every check, the IAM policies to run them and their verification are in
**[Bedrock Protection](docs/BEDROCK-PROTECTION.md)**; this section is how to run them.

```bash
# AWS account — IAM credential hygiene + Bedrock spend guardrails (15 checks)
prism-cli bedrock-protection scan-account --region us-west-2

# AWS Organization or specific OUs — IAM per account, Bedrock once at the payer, 9 org guardrail checks
prism-cli bedrock-protection scan-org --ou ou-1234-abcd5678

# Repository — gitleaks over full history, working tree and commit messages (6 checks)
prism-cli bedrock-protection scan-repo
```

All three are **audit-only**: nothing is provisioned, rotated or deleted. The one non-read AWS call
is `iam:GenerateCredentialReport`, which produces a report artifact; IAM has no way to read the
report without generating it first. `scan-org` assumes a role in each member account
(`OrganizationAccountAccessRole` by default, `--role-name AWSControlTowerExecution` in Control Tower
orgs) and runs from the management account or a delegated admin. `--session-duration` sets that
AssumeRole session length (at least 900 seconds). A member account that holds its
own budget is not detected by `scan-org`; run `scan-account --bedrock-only` there.

`scan-repo` needs a `gitleaks` binary on PATH (or `--gitleaks <path>`) and never downloads one.
It scans all history, all refs, the working tree and commit messages, unlike the CI gate, which
scans only the pull request's commits; a green gate means nothing new was added, not that the
repository is clean.

Each check is PASS, FAIL or INDETERMINATE, and **INDETERMINATE is not a pass**: a missing
permission, Cost Explorer being off or a missing gitleaks all produce it. `--fail-on <severity>`
exits 1 only on a FAIL at or above that severity, so in CI also assert on the indeterminate count in
the `--json` output ([Running it in CI](docs/BEDROCK-PROTECTION.md#running-it-in-ci)). Secret values
never appear in the output.

Every flag and default: [`bedrock-protection`](docs/CLI-REFERENCE.md#prism-cli-bedrock-protection).
Required IAM permissions:
[IAM policy required to run the audit](docs/BEDROCK-PROTECTION.md#iam-policy-required-to-run-the-audit).
What it does not do (no `--fix`, region-scoped Provisioned Throughput, budget size not judged):
[What this does not do](docs/BEDROCK-PROTECTION.md#what-this-does-not-do).

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

### Codewatch

| Issue | Solution |
|---|---|
| Every commit fails with `unknown command 'codewatch'`, or the hooks say prism-cli is not on PATH | An older prism-cli is first on PATH (`which -a prism-cli`). The hooks probe for `codewatch pre-commit` and fall back to running gitleaks directly, so commits are still scanned, but nothing is recorded and pushes are not reviewed. Upgrade with `npm install -g @prism-d1/cli` or fix the PATH order |
| Hooks never run in a repo that uses husky (or sets its own `core.hooksPath`) | A repo-local `core.hooksPath` overrides both the global hooks and `.git/hooks`. Check with `git config --show-origin core.hooksPath`. Either call `prism-cli codewatch pre-commit` and `prism-cli codewatch pre-push --remote "$1"` (with the pushed refs on stdin) from that tool's hooks, or remove the override |
| `enable codewatch --global` refuses to install | Another tool owns the global `core.hooksPath`. Re-run with `--force` to chain its hooks after codewatch; `--global --uninstall` restores it |
| A pushed commit is recorded as skipped with no pre-commit scan | It was committed with `--no-verify`, or created by a rebase, cherry-pick or merge, which run no commit hook. This is recorded on purpose so bypasses stay visible |
| A warning says gitleaks is not installed and the commit was not scanned | Install gitleaks (see the codewatch [Prerequisites](#prerequisites-1)). Until then commits are allowed and recorded as `gitleaks-missing` |
| The review reports "no reviewer" | Neither kiro-cli nor claude is on PATH in the shell that runs the push |

### Commit Trailers and Token Tracker (retired)

The `prepare-commit-msg` hook that appended `AI-Origin`, `AI-Tool`, `AI-Model`, token, cost and
`Spec-Ref` trailers to commit messages is retired, along with the token tracker that kept per-repo
snapshots in `~/.prism/tokentracker/`. AI origin and usage now come from codeburn attribution, pushed
by `enable codeburn` (see [Developer Setup](#developer-setup)), and no CI workflow reads trailers.

- `prism-cli bootstrapper install-git-hooks` now installs codewatch (see
  [Codewatch (Local Git Hooks)](#codewatch-local-git-hooks)) and removes the trailer hook if it
  finds it, restoring any hook the trailer hook had backed up.
- `prism-cli git commit-trailers` still exists, marked deprecated, so trailer hooks already
  installed in other repos keep working until they are replaced. Running `prism-cli enable codewatch`
  in such a repo removes the old hook.
- Nothing in PRISM reads `~/.prism/tokentracker/` any more, and you can delete it. It is written
  again only if an old trailer hook still runs `git commit-trailers`, or if you run
  `prism-cli parse-code-tool kiro-ide`, which keeps a parse cache there.

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
| Agent space not found | CDK not deployed with Security Agent | Run `prism-cli enable security` (`--status` shows what is missing) |
| KMS 403 on agent space creation | `securityagent.amazonaws.com` lacks KMS grants | Add `kms:Encrypt/Decrypt` grant for the service principal |
| Pen test fails at PREFLIGHT | `logs.amazonaws.com` lacks KMS permissions | Grant `kms:Encrypt/Decrypt/GenerateDataKey*/DescribeKey` with log group ARN condition |
| No findings in PRISM dashboards | Eval gate not emitting, or the OIDC role lacks the Continuum policy | Check the eval gate job log and `security-agent-processor` Lambda logs; confirm `PRISM_METRICS_ROLE_ARN` is set and `prism-d1-continuum-ci-scan` is attached |
| Eval gate does not block a merge on a Security Agent finding | No branch protection rule requires the check, or the Continuum review did not finish | Add `eval-gate` as a required check ([Making the Gate Block Merges](#making-the-gate-block-merges)). The gate polls the Continuum job every 30 seconds for up to 30 minutes and reads findings from the API, not from bot comments; a job that does not complete in that time fails the gate closed |
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
| `bootstrapper/metric-hooks/` | Retired commit-trailer hook, kept for reference (AI origin comes from `enable codeburn`; local hooks are [codewatch](#codewatch-local-git-hooks)) |

**Copy-me artifacts** — present only in a clone of this repo; copy them into your own project by hand:

| Directory | What It Contains |
|---|---|
| `bootstrapper/claude-code/` | CLAUDE.md templates for backend, frontend, platform, and agent teams |
| `bootstrapper/spec-templates/` | Kiro-compatible specification templates (API endpoint, data model, integration, agent workflow, MCP server) |
| `bootstrapper/aidlc-steering/` | AI-DLC development workflow rules for Claude Code, Kiro, and Q Developer |
| `bootstrapper/agent-configs/` | AgentCore Runtime, Memory, Gateway, and Guardrail templates |
| `bootstrapper/security-agent/` | Legacy script that forwards Security Agent findings to the PRISM API ([manual steps](docs/SECURITY-AGENT-MANUAL.md)); setup is `prism-cli enable security` |
