# prism-cli: overview of the local commands

As of 2026-11-08. For engineering managers and leaders. Detailed per-command status is in [PRISM-CLI-STATUS.md](PRISM-CLI-STATUS.md); how to run each command is in the [User Guide](../USER_GUIDE.md).

## Summary

prism-cli is the command-line tool a developer installs from npm (`@prism-d1/cli`) to measure, secure and review their AI-assisted work from their own machine. The roadmap slide "prism-cli: one tool, three jobs" lists 15 commands in three jobs: **Observe** (what is happening in my repos), **Secure** (AWS Security Agent reviews, threat models and penetration tests) and **Advise** (what to fix in my AWS account). 13 of the 15 have shipped, plus `security threats`, which is not on the slide. One was dropped (`security design-review`, no public API) and one is blocked (`install transformation-center`, scope unknown). The current version is **1.4.0**, published to npm on 2026-11-08.

## Commands by job

"AWS access" says what the command does in the AWS account its credentials point to. "Starts jobs" means it uploads code to a private bucket and starts a Security Agent job, but creates no infrastructure.

### Observe

| Command | What it does | AWS access | Cost | Release |
|---|---|---|---|---|
| `version` | Prints the installed version, whether npm has a newer one, and any older copy on the PATH. | None | None | 1.3.0 |
| `enable codewatch` | Installs git hooks: a secret scan that blocks a commit with a secret, and an AI code review on push that only reports. | None | None in AWS; the review uses the developer's own AI tool (Kiro or Claude Code). | 1.2.0 |
| `enable codeburn` | Installs codeburn and schedules it to send AI usage and commit attribution to the team's PRISM collector every 12 hours. | None | None in AWS beyond the team's existing PRISM pipeline. | 1.3.0 |
| `enable security` | Sets up AWS Security Agent for one account and region, and this repo's code review for the CI gate. | Deploys resources | A KMS key, an S3 bucket and SSM parameters (small monthly charges). | 1.3.0 |
| `dashboard` | A local web page with each repo's codewatch results, AI usage, security findings and a setup checklist. | None | None | 1.2.0 |
| `mcp` | An MCP server on stdio that gives an AI agent (Kiro, Claude Code) the dashboard's findings, reports, cached spend and setup checklist, read-only. | None | None | 1.8.0 |
| `export otel` | Sends unsent AI usage to the PRISM collector now, instead of waiting for the schedule. | None | None | 1.3.0 |
| `install transformation-center` | Not built. | | | Blocked |

### Secure

All of these use AWS Security Agent. `code-review`, `findings`, `threat-model` and `threats` need `enable security` first; `pentest` sets up its own.

| Command | What it does | AWS access | Cost | Release |
|---|---|---|---|---|
| `security code-review` | Runs the same Security Agent code review as the CI gate on the branch's changes (or the whole repo) and prints the findings. | Starts jobs | Not charged while Security Agent code review is in preview. After preview, AWS's pricing page lists a per-line fee and $10 per inference unit. | 1.3.0 |
| `security findings` | Shows the findings of the latest (or a given) code review or penetration test. | Read-only | None | 1.3.0 |
| `security threat-model` | Runs a Security Agent threat model of the repo, optionally focused by design documents, and prints the threats. | Starts jobs | Not charged while in preview. No rate is published for after preview. | 1.3.0 |
| `security threats` | Shows the threats of the latest (or a given) threat model. Not on the slide. | Read-only | None | 1.3.0 |
| `security pentest` | Deploys the repo's app into a temporary private network in the account and runs a Security Agent penetration test against it. | Deploys resources | Billed by AWS in task-hours, publicly reported at $50 per task-hour, plus the temporary environment while it is up. A reference run took about 2 h 50 min. | 1.3.0 |
| `security design-review` | Not built. | | | Dropped |

### Advise

| Command | What it does | AWS access | Cost | Release |
|---|---|---|---|---|
| `aws connect` | Picks and verifies the AWS profile and region the other commands use by default. | Read-only | None | 1.4.0 |
| `aws check` | Checks the account: Bedrock spend and credential safeguards, PRISM setup, and a security baseline (CloudTrail, GuardDuty, Security Hub, budgets and others). | Read-only | None | 1.4.0 |
| `aws recommend` | Turns the latest `aws check` result into a fix list ranked by severity and effort, with the command or steps for each. | None (read-only with `--refresh`) | None | 1.4.0 |

## How a developer starts

1. Install the CLI: `npm install -g @prism-d1/cli`.
2. `prism-cli aws connect`: choose the AWS profile and region once.
3. `prism-cli enable codewatch` in each repo, or `--global` for all repos at once.
4. `prism-cli enable security`: one-time Security Agent setup per account and region. It shows what it will create and asks first.
5. `prism-cli dashboard`: open the local page to see results across repos.

Developers who report AI usage also run `prism-cli enable codeburn` with the collector URL their administrator gives them.

## Safety defaults

- **Private dashboard.** `dashboard` listens on the local machine only (127.0.0.1), needs a one-time token in its URL, reads local files only and makes no AWS calls. Remote use goes through an SSH tunnel.
- **Read-only checks.** `aws connect`, `aws check`, `aws recommend`, `security findings` and `security threats` only describe, get and list. `aws check` does not even generate an IAM credential report; a missing report shows as a check it could not decide. The three `aws` commands say they are read-only before their first AWS call.
- **Confirmation before any deploy.** `enable security` and `security pentest` show the account, region and what they will create, then ask. Both have `--dry-run`. Without a terminal they refuse unless `--yes` is passed, for CI.
- **Penetration tests target only what they just deployed.** `security pentest` never takes a URL. It deploys the app into a new private network with no public subnet, no internet gateway and no inbound rule from the internet, reachable only by the test agent. It tears the environment down once the job has finished (seen by `--status` or `--wait`), unless asked to keep it.
- **No credentials stored.** `aws connect` saves only the profile name, region, account and alias; the standard AWS credential chain supplies the credentials. Secrets in the pentest config must be references to AWS Secrets Manager; plain values are refused.
- **Local reviews never block a push.** The AI review on push only reports. CI stays the gate that can block a merge.

## What was tested live

| Command | Result |
|---|---|
| `security code-review` | A review of a branch's changes ran end to end in about 20 minutes. |
| `security threat-model` | A whole-repo run with one design document took about 51 minutes and returned 19 threats. |
| `security pentest` | The first run stopped at the pre-start check because the app was not healthy yet. The command now waits up to 10 minutes for the app to pass its health check. The second run completed in about 2 h 50 min, found the reflected cross-site scripting flaw planted in the sample vulnerable app (4 findings), and removed its environment. |
| `aws check` | Ran 31 checks against a test account. |
| `enable codeburn`, `export otel` | Ran on a developer machine. |

## Dropped and blocked

- **Dropped: `security design-review`.** Security Agent's design review exists only in its web console; AWS publishes no API for it. `security threat-model` with design documents covers threat-modeling a design. Reusing the name would give web-console users a different kind of report than they expect. Research: [RESEARCH-threat-model-design-review.md](RESEARCH-threat-model-design-review.md).
- **Blocked: `install transformation-center`.** Nothing in the repo matches the name, and we do not yet know what it should install.
- **Placeholder: the Startup Advisor section of `aws check`.** It reports "not integrated yet" until we know how to consume Startup Advisor's checks and under what license.

## Open questions for leadership

1. **Transformation center:** what is it, and what should `install transformation-center` set up on a developer's machine?
2. **Startup Advisor:** how should `aws check` consume its checks, and is its license compatible with this public sample?
3. **Threat models in CI:** the CI policy grants only code-review actions. Running threat models in CI needs six threat-model actions added. Do we want threat models in CI, and who approves the wider policy? Local runs use the developer's own credentials and are not affected.
4. **The repo's own threat model:** the live threat model of this repo returned 4 critical, 10 high and 5 medium threats. The 4 critical ones are:
   - prompt injection: text an attacker places in issues, diffs or review rules can steer the AI tools that read it;
   - the CI pipeline trusts gate and run configuration that a pull request can change;
   - repository content and a clone token can leak into transcripts and to outside reviewers;
   - AI model output drives gate decisions without validation.

   Who owns triage, and do any of these block wider rollout?

## Further reading

- [Developer Setup](../USER_GUIDE.md#developer-setup): install, `enable codeburn`, `export otel`, `version`
- [Codewatch (Local Git Hooks)](../USER_GUIDE.md#codewatch-local-git-hooks)
- [Local Dashboard](../USER_GUIDE.md#local-dashboard)
- [Security Agent Setup (enable security)](../USER_GUIDE.md#security-agent-setup-enable-security)
- [Running a Review from the CLI](../USER_GUIDE.md#running-a-review-from-the-cli)
- [Running a Threat Model from the CLI](../USER_GUIDE.md#running-a-threat-model-from-the-cli)
- [Running a Penetration Test from the CLI](../USER_GUIDE.md#running-a-penetration-test-from-the-cli)
- [AWS Account Advice (aws connect, check, recommend)](../USER_GUIDE.md#aws-account-advice-aws-connect-check-recommend)
