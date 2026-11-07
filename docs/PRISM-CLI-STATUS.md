# prism-cli: status of the "one tool, three jobs" commands

Status as of 2026-11-06. It covers the 15 commands on the roadmap slide ("prism-cli: one tool, three jobs"), plus the existing features that this work made obsolete. Design detail for each command is in [DESIGN-prism-cli-local.md](DESIGN-prism-cli-local.md).

`enable codewatch`, `dashboard`, `enable security`, `security code-review` and `security findings` are on `main`. `version`, `enable codeburn` and `export otel` are on the unpushed branch `feat/codeburn-version`.

## Summary

| Job | Command | Status |
|---|---|---|
| Observe | `prism-cli version` | **Built** (not merged) |
| Observe | `prism-cli enable codewatch` | **Built** |
| Observe | `prism-cli enable codeburn` | **Built** (not merged) |
| Observe | `prism-cli enable security` | **Built** |
| Observe | `prism-cli dashboard` | **Built** |
| Observe | `prism-cli export otel` | **Built** (not merged; PRISM collector only, no `--endpoint` yet) |
| Observe | `prism-cli install transformation-center` | Blocked: scope unknown |
| Secure | `prism-cli security design-review` | Planned, API unknown |
| Secure | `prism-cli security threat-model` | Planned, API unknown |
| Secure | `prism-cli security code-review` | **Built** |
| Secure | `prism-cli security pentest` | Planned (reuse, guarded) |
| Secure | `prism-cli security findings` | **Built** |
| Advise | `prism-cli aws connect` | Planned |
| Advise | `prism-cli aws check` | Planned (reuse) |
| Advise | `prism-cli aws recommend` | Planned |

So far 8 of the 15 are built, 6 are planned, and 1 is blocked until we know what it is. None of the slide's commands were dropped.

## Built

### `enable codewatch`
Installs local git hooks in the current repo:

- **`pre-commit`:** gitleaks scans the staged changes and **blocks** the commit if it finds a secret. If gitleaks is not installed, the commit is allowed with a warning and recorded as not scanned.
- **`pre-push`:** an AI code review of the branch diff for quality and security. It **only reports** and never blocks a push. The reviewer is kiro-cli or Claude Code, whichever the developer uses, so a Claude Code user does not need kiro-cli. Both use the same review rules as the CI gate.

Results go to `.prism/results/` in one JSON format. Existing hooks are backed up and still run. `--uninstall` restores them. `--global` installs the hooks once for every repo (`~/.prism/hooks` plus the global `core.hooksPath`); each repo's own hooks still run after codewatch, and `git config prism.codewatch false` opts a repo out. User docs: [Codewatch (Local Git Hooks)](../USER_GUIDE.md#codewatch-local-git-hooks).

"codewatch" was originally an unknown name on the slide. We decided it is this hook gate. The command was first built as `enable security` and renamed.

### `dashboard`
A local web page for one developer, started with `prism-cli dashboard` from any directory.

- **Repos:** it finds them itself by scanning your home directory, 3 levels deep, for every git repo (worktrees included). Repos without codewatch are listed as missing, in a collapsed group. The repo you are in is listed first. `--root <dir>` scans somewhere else. The scan skips hidden and build folders, does not follow symlinks and takes about 50 ms here (34 repos).
- **Panels:**
  - Codewatch: one summary row per repo (findings by severity, last run, reviewer, unscanned commits), most high findings first, and each repo's detail in a collapsible section. The detail starts with a Commits table: each commit's secret scan and review, with each finding placed on the commit that introduced its line (`git blame`). A warning banner shows when secret scanning is off on this machine.
  - A codeburn usage summary, which points to `codeburn web` for full charts.
  - A setup checklist: this machine (codeburn, scheduled sync, gitleaks, AWS credentials, the global codewatch hooks) and one row per repo saying whether codewatch is installed (per repo or "(global)"), with the `cd <repo> && prism-cli enable codewatch` fix.
  - When the global hooks are not installed and two or more repos lack codewatch, a suggestion to cover them all with `prism-cli enable codewatch --global`.
  - A printable report for each scan (`/report/<id>`, also as Markdown), and `prism-cli codewatch report` to export one without the server.
  - Security findings: the latest cached Security Agent code review per repo, with counts and findings.
- **Access:** it listens on `127.0.0.1` only and needs a one-time token. It is read-only and reads local files only, with no AWS calls.
- **Other options:** `--json` prints the same data. `--port` and `--no-open` suit remote use over `ssh -L`. `--all` is deprecated and does nothing.
- **User docs:** [Local Dashboard](../USER_GUIDE.md#local-dashboard).

### `enable security`
Sets up AWS Security Agent (Continuum) for one account and region, plus the code review the CI eval gate uses for the current repo. It replaces `securityagent setup`, which stays as a deprecated alias.

- **Scoped deploy:** only the Security Agent resources (`--exclusively`; the old command deployed `--all`). A new standalone stack, `PrismD1SecurityAgent`, holds them with its own KMS key; an account that already hosts them in `PrismD1MetricsPipeline` keeps that layout. The two never coexist (same names and exports). A standalone-only account gets the CI code review but no findings in the dashboards until the pipeline is deployed.
- **Notice and defaults:** a cost and resource notice before any AWS call, then the account, caller, region and credential source. No hardcoded profile or region: the AWS credential chain and the CLI's region order apply, and it refuses when no region resolves.
- **Asks first:** prints a resource diff with IAM, network and public endpoint changes named (the full `cdk diff` goes to a file), then asks with the account ID, alias and region named. `--yes` approves for CI; with no terminal and no `--yes` it refuses. `--require-approval never` is gone.
- **`--dry-run`:** runs every read and prints the exact create and update calls. **`--status`:** a read-only report.
- **Idempotent:** reuses the agent space, application, code review, S3 snapshot (skipped when its ETag matches) and SSM parameter. A different value already in SSM is a conflict that needs a second yes.
- **Fixes:** writes `/prism/continuum/code-review-id/<repo-slug>`, the parameter the eval gate reads (the old command wrote an unslugged one nothing read), and reads the `codeReviewSummaries` the API returns.
- **Marker:** `.prism/security.local.json` (ids, account and region; per developer, never committed, git-ignored through `.git/info/exclude` when needed). `.prism/config.json` stays the committed team file; a legacy `security` block in it is read and moved on the next run. The dashboard's setup checklist shows a Security Agent column from it.
- **No uninstall** yet: deleting AWS resources needs its own design.
- **User docs:** [Security Agent Setup](../USER_GUIDE.md#security-agent-setup-enable-security).

### `security code-review` and `security findings`
Run the Security Agent code review the CI gate runs, from a developer's machine, and read its findings.

- **`security code-review`:** the branch diff (or `--full` repo) is uploaded to the scan bucket (skipped when unchanged) and a job is started; it then waits with backoff and prints the findings grouped by risk level and file. `--timeout` exits 2 and Ctrl-C exits 130, both leaving the job running with a fetch-later hint. `--fail-on <level>` makes it fail closed; `--no-wait` and `--json` are there for scripts.
- **`security findings`:** read-only; the latest job or `--job <id>`, `--severity`, `--wait` for a running job.
- **Results:** cached in `.prism/results/` as `kind: security-review`; the dashboard's Security findings panel shows them with no AWS calls.
- **User docs:** [Running a Review from the CLI](../USER_GUIDE.md#running-a-review-from-the-cli).

### `version`
Prints the CLI version (from `package.json`) and the Node version.

- **Update check:** `npm view @prism-d1/cli version` with a 5-second timeout. It never fails the command; a timeout or no network is reported as "not checked". `--offline` skips it. Decided: check npm, cheaply.
- **PATH check:** lists every `prism-cli` on PATH (deduplicated by real path) and warns when another one shadows this one or has a different version, e.g. an old `/usr/bin/prism-cli` 1.0.16 from a system Node.
- **`--json`:** the same report as `prism.version.v1`. `prism-cli --version` still prints only the version number.
- **Not included:** the hooks, reviewer and codeburn status the design proposed; `dashboard` and `enable codeburn --status` show those.

### `enable codeburn`
Installs codeburn and connects its sync to the PRISM OTEL collector. It replaces `bootstrapper setup-otel-sync`, which stays as a deprecated alias with the same flags; the code moved, it was not rewritten.

- **Steps:** installs codeburn with `npm install -g codeburn` when it is missing (prints the command and asks; `--yes` skips the question; no terminal and no `--yes` refuses), runs `codeburn sync setup <url>`, backfills 30 days on first setup, installs or refreshes the crontab / LaunchAgent / Scheduled Task that runs `codeburn sync push --since 7d --attribution` every 12 h, and prints `codeburn sync status`.
- **URL:** `--url`, else the endpoint codeburn already syncs to, else a prompt.
- **Idempotent:** a re-run with the same endpoint skips sync setup and the backfill and says so; the schedule is refreshed in place.
- **`--dry-run`:** runs the read-only checks and prints each step with its exact command. `--status` and `--remove` are unchanged from `setup-otel-sync`.
- **Dashboard:** the setup checklist's "codeburn installed" and "Scheduled codeburn sync push" rows now point to `prism-cli enable codeburn`.
- **Decided:** "enable" also installs codeburn. Still open: whether `--attribution` stays on (see the questions below); it is on, as before.

### `export otel`
Pushes codeburn's unsent telemetry to the configured PRISM collector now: `codeburn sync push --since 7d --attribution`, the same argv the schedule runs. `--since <window>` changes the window. It streams codeburn's output and exits with codeburn's exit code. When codeburn is missing or its sync is not set up, it says so and points to `prism-cli enable codeburn`.

- **Not yet:** `--endpoint` for a team's own OTLP collector, and exporting `.prism/results/`. Open: whether codeburn accepts a custom endpoint, and whether per-developer gate results should be exported.

## Planned

### Secure (AWS Continuum)
All of these call AWS and need credentials.
- **`security design-review`, `security threat-model`:** new. Open: which Security Agent APIs back them, and what input they take (a spec, a design doc or a repo).
- **`security pentest`:** reuses `workshop perform-pen-test`. It runs only against targets the customer owns and authorizes: the target must pass domain verification and the user confirms it by name, with no flag to skip that. Open: what authorization evidence is needed beyond domain verification.

### Advise (AWS account)
- **`aws connect`:** read-only. It records which AWS profile to use and stores no credentials. Open: per repo or per user.
- **`aws check`:** reuses Startup Advisor's account checks. PRISM adds only the AI-DLC and Bedrock checks, building on `bedrock-protection scan-account`. Open: how Startup Advisor is consumed, and its license.
- **`aws recommend`:** turns `aws check` findings into recommendations. Open: a fixed mapping or model-generated.

## Blocked

- **`install transformation-center`:** nothing in the repo matches it. We need to know what "transformation center" is and what installing it locally should do before it can be designed.

## Decided not to build

None of the slide's commands. These ideas came up during design and were dropped:

| Idea | Why not |
|---|---|
| Rebuilding codeburn's usage charts in the dashboard | `codeburn web` already does this. The dashboard shows a summary and points to it. |
| A local eval-harness panel in the dashboard | The eval gate runs through kiro-cli in CI and through codewatch's pre-push locally. There is no separate local harness to show. |
| Blocking commits when gitleaks is missing | We decided a missing gitleaks only warns. The dashboard shows a banner, and CI's gitleaks step is the backstop. |
| Blocking pushes on AI review findings | The local review only reports. CI stays the hard gate. |
| Running CI reviews on the developer's own tool | CI stays on kiro-cli because it is shared by the whole team. Only the local hook follows the developer's tool. |
| Codex, Copilot CLI and Cursor reviewers in v1 | We started with Kiro and Claude Code. Each new tool is one adapter file. |
| Keeping `enable security` as an alias for codewatch | That name is kept free for the slide's own `enable security`. |
| An `enable security --uninstall` that deletes AWS resources | Deleting an agent space, code reviews or the scan bucket needs its own design and explicit sign-off. |

## Made obsolete

| Existing feature | Replaced by | What happens to it |
|---|---|---|
| AI-Origin commit trailers (`prepare-commit-msg` hook) | codeburn attribution | The hook is retired. `enable codewatch` removes it when found. |
| Per-commit token and cost limits (part of that hook) | codeburn usage tracking | Retired with the hook. |
| Token tracker (`~/.prism/tokentracker`) | codeburn | No longer used. Nothing new reads it. |
| `bootstrapper install-git-hooks` | `enable codewatch` | Kept as a deprecated alias. Its old flags (`--team-id`, `--max-tokens`, `--max-cost`, `--global`) are accepted and ignored. |
| `git commit-trailers` | (none) | Kept, marked deprecated, because already-installed hooks still call it. Remove after one release. |
| `bootstrapper setup-otel-sync` | `enable codeburn` | Kept as a deprecated alias with the same flags. |
| The retired Bedrock eval-gate mode | kiro-cli eval gate | It was already retired before this work. `--mode bedrock` errors. |

These existing commands get new names. The old names stay as deprecated aliases for at least one release:

| Old | New |
|---|---|
| `bootstrapper setup-otel-sync` | `enable codeburn` (done) |
| `securityagent setup` | `enable security` (done) |
| `workshop perform-pen-test` | `security pentest` (workshop target only) |
| `bedrock-protection scan-account` | `aws check` (Bedrock section) |

## Questions for the roadmap owner

1. What is `install transformation-center`?
2. `enable security` now wraps the Security Agent setup (decided). Does it belong under Observe or Secure on the slide? It is the only Observe command that needs AWS credentials.
3. Which Security Agent APIs back `design-review` and `threat-model`?
4. How do we consume Startup Advisor's checks, and under what license?
5. Should `aws recommend` be a fixed mapping or model-generated?
6. With commit trailers gone, should codeburn's `--attribution` stay on?
