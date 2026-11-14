# prism-cli: overview of the commands

For engineering managers and leaders. Covers prism-cli **1.12.0** on npm (`@prism-d1/cli`). How to run each command is in the [User Guide](../USER_GUIDE.md#using-prism-locally); every flag is in the [command reference](CLI-REFERENCE.md). This page says what each command is for, what it touches in AWS and what it costs, the safety defaults, and what was decided along the way.

## Summary

prism-cli is the command-line tool a developer installs from npm to measure, secure and review their AI-assisted work from their own machine. The roadmap slide "prism-cli: one tool, three jobs" groups its commands as **Observe** (what is happening in my repos), **Secure** (AWS Security Agent reviews, threat models and penetration tests) and **Advise** (what to fix in my AWS account). 13 of the slide's 15 commands have shipped, plus `security threats`, which is not on the slide. One was dropped (`security design-review`, no public API) and one is blocked (`install transformation-center`, scope unknown).

Since the slide, prism-cli also gained an MCP server for AI agents (`mcp`, 1.8.0), an installer for the PRISM Kiro Crew app (`enable kirocrew`, 1.9.0), a Claude Code status line (`statusline` and `enable claude-code`, 1.10.0), the agent harness loop (`codewatch review` and `codewatch hook`, 1.11.0) and its hook installer for Kiro CLI and Claude Code (`enable agent-hooks`, 1.12.0). The platform-team, Bedrock-audit, CI-bootstrap, assessment and workshop commands predate the slide and are listed under [Other commands](#other-commands).

## Commands by job

"AWS access" says what the command does in the AWS account its credentials point to. "Starts jobs" means it uploads code to a private bucket and starts a Security Agent job, but creates no infrastructure. "Since" is the first prism-cli release with the command.

### Observe

| Command | What it does | AWS access | Cost | Since |
|---|---|---|---|---|
| `version` | Prints the installed version, whether npm has a newer one, and any older copy on the PATH. | None | None | 1.3.0 |
| `enable codewatch` | Installs git hooks: a secret scan that blocks a commit with a secret, and an AI code review on push that only reports. | None | None in AWS; the review uses the developer's own AI tool (Kiro or Claude Code). | 1.2.0 |
| `codewatch report` | Writes the report of one pre-push review (findings by file and commit, and the secret scans) as Markdown, HTML or JSON. | None | None | 1.2.0 |
| `enable codeburn` | Installs codeburn and, in team mode, schedules it to send AI usage and commit attribution to the team's PRISM collector every 12 hours. Local mode (the default) keeps usage on the machine. | None | None in AWS beyond the team's existing PRISM pipeline. | 1.3.0 |
| `enable security` | Sets up AWS Security Agent for one account and region, and this repo's code review for the CI gate. | Deploys resources | A KMS key, an S3 bucket and SSM parameters (small monthly charges). | 1.3.0 |
| `dashboard` | A local web page with each repo's codewatch results, AI usage, security findings and a setup checklist. | None on load; the Setup view's checks are read-only | None | 1.2.0 |
| `mcp` | An MCP server on stdio that gives an AI agent (Kiro, Claude Code) the dashboard's findings, reports, cached spend and setup checklist. It can also write a static dashboard file, start the live dashboard on 127.0.0.1, and run the harness review (`prism_review`), which writes its result file. | None | None in AWS; `prism_review` uses the developer's own AI tool. | 1.8.0 |
| `codewatch review` | The agent harness loop's engine: gitleaks, then the AI review of an agent's changes, answering pass, fix or stop. `codewatch hook` runs it from Claude Code and Kiro CLI hooks; the agent's push is denied only for secrets, a failed secret scan, edits to the checks or an unclear push target. | None | None in AWS; the review uses the developer's own AI tool. | 1.11.0 |
| `enable agent-hooks` | Writes the harness loop hooks for Kiro CLI (`.kiro/hooks/prism-harness.json`) or Claude Code without the PRISM plugin. | None | None | 1.12.0 |
| `enable claude-code`, `statusline` | Sets Claude Code's status line to PRISM's findings and spend, after a diff and a backup. | None | None | 1.10.0 |
| `enable kirocrew` | Installs or updates the PRISM app in Kiro Crew: a PRISM page, the MCP tools, a fix-findings skill and a daily digest. | None | None | 1.9.0 |
| `export otel` | Sends unsent AI usage to the PRISM collector now, instead of waiting for the schedule. | None | None | 1.3.0 |
| `install transformation-center` | Not built. | | | Blocked |

### Secure

All of these use AWS Security Agent. `code-review`, `findings`, `threat-model` and `threats` need `enable security` first; `pentest` sets up its own agent space.

| Command | What it does | AWS access | Cost | Since |
|---|---|---|---|---|
| `security code-review` | Runs the same Security Agent code review as the CI gate on the branch's changes (or the whole repo) and prints the findings. | Starts jobs | Not charged while Security Agent code review is in preview. After preview, AWS's pricing page lists a per-line fee and $10 per inference unit. | 1.3.0 |
| `security findings` | Shows the findings of the latest (or a given) code review or penetration test. | Read-only | None | 1.3.0 |
| `security threat-model` | Runs a Security Agent threat model of the repo, optionally focused by design documents, and prints the threats. Waits up to 120 minutes by default. | Starts jobs | Not charged while in preview. No rate is published for after preview. | 1.3.0 |
| `security threats` | Shows the threats of the latest (or a given) threat model. Not on the slide. | Read-only | None | 1.3.0 |
| `security pentest` | Deploys the repo's app into a temporary private network in the account and runs a Security Agent penetration test against it. | Deploys resources | Billed by AWS in task-hours, publicly reported at $50 per task-hour, plus the temporary environment while it is up. A reference run took about 2 h 50 min. | 1.3.0 |
| `security design-review` | Not built. | | | Dropped |

### Advise

| Command | What it does | AWS access | Cost | Since |
|---|---|---|---|---|
| `aws connect` | Picks and verifies the AWS profile and region the other commands use by default. | Read-only | None | 1.4.0 |
| `aws check` | Checks the account: Bedrock spend and credential safeguards, PRISM setup, and a security baseline (CloudTrail, GuardDuty, Security Hub, budgets and others). | Read-only | None | 1.4.0 |
| `aws recommend` | Turns the latest `aws check` result into a fix list ranked by severity and effort, with the command or steps for each. A check that could not run says what to do first: grant a read permission only when access was denied, otherwise create the missing credential report or fix the item it depends on. | None (read-only with `--refresh`) | None | 1.4.0 |

### Other commands

| Command | What it does | AWS access | Since |
|---|---|---|---|
| `team info`, `team add-developer` | Platform team: print the PRISM stack's collector URL and user pool, and create a developer's telemetry account after asking. | Read-only (`info`); one Cognito user (`add-developer`) | 1.6.0 |
| `bedrock-protection scan-account`, `scan-org`, `scan-repo` | Audit an account, an Organization or a repo for LLMjacking exposure. | Read-only, except generating an IAM credential report | 1.0.95 (`scan-org` 1.0.96) |
| `bootstrapper setup-github-oidc`, `setup-gitlab-oidc` | Create the CI OIDC provider and IAM role. | Creates IAM resources | — |
| `bootstrapper install-github-workflows`, `install-gitlab-workflows`, `install-eval-harness`, `install-coding-agent` | Write CI workflows, the eval gate and the coding agent into a repo. | None (files only) | — |
| `assessment run`, `web`, `deploy-cdk`, `interview-agent` | The PRISM D1 assessment scanner and web app. `deploy-cdk` deploys it to AWS. | Read-only scan; `deploy-cdk` deploys resources | — |
| `workshop *` | Workshop helpers: check prerequisites, deploy infrastructure, generate demo data, run the sample agent and pen test. | Varies; `deploy-infra` and `perform-pen-test` deploy resources | — |
| `parse-code-tool kiro-cli`, `kiro-ide` | Parse Kiro sessions into codeburn-compatible token usage. | None | — |
| `git claude-session-context` | Claude Code SessionStart hook, kept for hooks already installed. | None | — |

"—" means the command predates the releases tracked here.

## How a developer starts

1. Install the CLI: `npm install -g @prism-d1/cli`.
2. `prism-cli aws connect`: choose the AWS profile and region once.
3. `prism-cli enable codewatch` in each repo, or `--global` for all repos at once.
4. `prism-cli enable security`: one-time Security Agent setup per account and region. It shows what it will create and asks first.
5. `prism-cli dashboard`: open the local page to see results across repos. The editor extension, `prism-cli mcp` and `prism-cli enable kirocrew` show the same results in an editor, an AI agent or Kiro Crew.

Developers who report AI usage also run `prism-cli enable codeburn --url` with the collector URL their administrator gives them.

## Safety defaults

- **Private dashboard.** `dashboard` listens on the local machine only (127.0.0.1), needs a one-time token in its URL, reads local files only and makes no AWS calls when it loads. Its Setup view runs only a fixed list of local setup commands and read-only AWS checks, each after a confirmation. Remote use goes through an SSH tunnel.
- **No network listener for agents and editors.** `mcp` talks over stdin and stdout; the one port it can open is the live dashboard's, on 127.0.0.1, as its own child process. The editor extension opens no port and makes no network calls. The Kiro Crew app's page is served through the Kiro Crew gateway's authenticated routes.
- **Read-only checks.** `aws connect`, `aws check`, `aws recommend`, `security findings`, `security threats` and `team info` only describe, get and list. `aws check` does not even generate an IAM credential report; a missing report shows as a check it could not decide. The three `aws` commands say they are read-only before their first AWS call.
- **Confirmation before any deploy or write.** `enable security`, `security pentest` and `team add-developer` show the account, region and what they will create, then ask. All three have `--dry-run`. Without a terminal they refuse unless `--yes` is passed, for CI.
- **Penetration tests target only what they just deployed.** `security pentest` never takes a URL. It deploys the app into a new private network with no public subnet, no internet gateway and no inbound rule from the internet, reachable only by the test agent. It tears the environment down once the job has finished (seen by `--status` or `--wait`), unless asked to keep it.
- **No credentials stored.** `aws connect` saves only the profile name, region, account and alias; the standard AWS credential chain supplies the credentials. Secrets in the pentest config must be references to AWS Secrets Manager; plain values are refused.
- **Local reviews never block a person's push.** The git pre-push review only reports. The agent harness loop denies an AI agent's own `git push` only for a secret, a failed secret scan or an edit to the checks; its review findings never block. CI stays the gate that can block a merge.

## What was tested live

| Command | Result |
|---|---|
| `security code-review` | A review of a branch's changes ran end to end in about 20 minutes. |
| `security threat-model` | A whole-repo run with one design document took about 51 minutes and returned 19 threats. |
| `security pentest` | The first run stopped at the pre-start check because the app was not healthy yet. The command now waits up to 10 minutes for the app to pass its health check. The second run completed in about 2 h 50 min, found the reflected cross-site scripting flaw planted in the sample vulnerable app (4 findings), and removed its environment. |
| `aws check` | Ran 31 checks against a test account. |
| `enable codeburn`, `export otel` | Ran on a developer machine. |

## Decisions

### Decided while building

- **"codewatch"** was an unknown name on the slide; it became the local hook gate. It was first built as `enable security` and renamed, so that `enable security` could be the slide's own Security Agent setup.
- **`enable codeburn` also installs codeburn** (it asks first). Still open: whether codeburn's `--attribution` stays on now that commit trailers are gone; it is on, as before.
- **`enable security` deploys only the Security Agent resources** (`--exclusively`; the old `securityagent setup` deployed `--all` with `--require-approval never`). It writes the slugged SSM parameter the eval gate reads; the old command wrote an unslugged one that nothing read.
- **`aws connect` saves both per user and per repo**, and the repo file wins. The saved connection is the default for every AWS command.
- **`aws recommend` is a fixed mapping**, with no model calls. A later `--explain` could use the codewatch reviewer adapters.
- **`version` checks npm cheaply** (5-second timeout, never fails the command). It does not report hooks, reviewer or codeburn status; `dashboard` and `enable codeburn --status` show those.
- **`export otel` targets the PRISM collector only.** Not built yet: `--endpoint` for a team's own OTLP collector, and exporting `.prism/results/`. Open: whether codeburn accepts a custom endpoint, and whether per-developer gate results should be exported.

### Decided not to build

| Idea | Why not |
|---|---|
| `security design-review` | No public API: design review exists only in the Security Agent web app. `security threat-model --doc` covers threat-modeling a design. Reusing the name would give web-app users a different kind of report than they expect. Research: [RESEARCH-threat-model-design-review.md](RESEARCH-threat-model-design-review.md). |
| Rebuilding codeburn's usage charts in the dashboard | `codeburn web` already does this. The dashboard shows a summary and points to it. |
| A local eval-harness panel in the dashboard | The eval gate runs through kiro-cli in CI and through codewatch's pre-push locally. There is no separate local harness to show. |
| Blocking commits when gitleaks is missing | A missing gitleaks only warns. The dashboard shows a banner, and CI's gitleaks step is the backstop. |
| Blocking pushes on AI review findings | The local review only reports. CI stays the hard gate. |
| Running CI reviews on the developer's own tool | CI stays on kiro-cli because it is shared by the whole team. Only the local hook follows the developer's tool. |
| Codex, Copilot CLI and Cursor reviewers in v1 | Kiro and Claude Code came first. Each new tool is one adapter file. |
| An `enable security --uninstall` that deletes AWS resources | Deleting an agent space, code reviews or the scan bucket needs its own design and explicit sign-off. |

### Made obsolete and renamed

| Old | Replaced by | What happens to it |
|---|---|---|
| AI-Origin commit trailers (`prepare-commit-msg` hook) and their per-commit token and cost limits | codeburn attribution | Retired. `enable codewatch` removes the hook when it finds it. |
| Token tracker (`~/.prism/tokentracker`) | codeburn | Nothing reads it any more. |
| `bootstrapper install-git-hooks` | `enable codewatch` | Deprecated alias; its old flags are accepted and ignored. |
| `git commit-trailers` | (none) | Deprecated; kept because already-installed hooks still call it. |
| `bootstrapper setup-otel-sync` | `enable codeburn` | Deprecated alias with the same flags. |
| `securityagent setup` | `enable security` | Deprecated alias with the same flags; it now asks before deploying. |
| The Bedrock eval-gate mode | kiro-cli eval gate | Retired before this work; `--mode bedrock` errors. |
| `workshop perform-pen-test` | `security pentest` | Proposed as an alias for the workshop target only; not done yet. |
| `bedrock-protection scan-account` | `aws check` (its `bedrock` section) | Both stay and share the same checks. |

The full list of deprecated names, generated from the CLI, is under [Deprecated commands](CLI-REFERENCE.md#deprecated-commands).

## Dropped and blocked

- **Dropped: `security design-review`.** See [Decided not to build](#decided-not-to-build).
- **Blocked: `install transformation-center`.** Nothing in the repo matches the name, and we do not yet know what it should install.
- **Placeholder: the Startup Advisor section of `aws check`.** It reports "not integrated yet" until we know how to consume Startup Advisor's checks and under what license.

## Open questions for leadership

1. **Transformation center:** what is it, and what should `install transformation-center` set up on a developer's machine?
2. **Startup Advisor:** how should `aws check` consume its checks, and is its license compatible with this public sample?
3. **Where `enable security` belongs:** it is the only Observe command that needs AWS credentials. Should the slide list it under Secure?
4. **Commit attribution:** with commit trailers gone, should codeburn's `--attribution` stay on?
5. **Threat models in CI:** the CI policy grants only code-review actions. Running threat models in CI needs six threat-model actions added. Do we want threat models in CI, and who approves the wider policy? Local runs use the developer's own credentials and are not affected.
6. **The repo's own threat model:** the live threat model of this repo returned 4 critical, 10 high and 5 medium threats. The 4 critical ones are:
   - prompt injection: text an attacker places in issues, diffs or review rules can steer the AI tools that read it;
   - the CI pipeline trusts gate and run configuration that a pull request can change;
   - repository content and a clone token can leak into transcripts and to outside reviewers;
   - AI model output drives gate decisions without validation.

   Who owns triage, and do any of these block wider rollout?

## Further reading

- [Command reference](CLI-REFERENCE.md): every command and flag
- [Developer Setup](../USER_GUIDE.md#developer-setup): install, `enable codeburn`, `export otel`, `version`
- [Using PRISM locally](../USER_GUIDE.md#using-prism-locally): where PRISM shows up (editor, Kiro Crew, Claude Code)
- [Codewatch (Local Git Hooks)](../USER_GUIDE.md#codewatch-local-git-hooks)
- [Local Dashboard](../USER_GUIDE.md#local-dashboard)
- [Security Agent Setup (enable security)](../USER_GUIDE.md#security-agent-setup-enable-security)
- [Security Scans from Your Machine](../USER_GUIDE.md#security-scans-from-your-machine): code review, threat model, penetration test
- [AWS Account Advice (aws connect, check, recommend)](../USER_GUIDE.md#aws-account-advice-aws-connect-check-recommend)
- Design history: [DESIGN-prism-cli-local.md](DESIGN-prism-cli-local.md), [DESIGN-prism-cli-aws-advise.md](DESIGN-prism-cli-aws-advise.md), [DESIGN-prism-cli-pentest.md](DESIGN-prism-cli-pentest.md)
