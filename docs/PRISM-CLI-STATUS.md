# prism-cli: status of the "one tool, three jobs" commands

Status as of 2026-11-06. It covers the 15 commands on the roadmap slide ("prism-cli: one tool, three jobs"), plus the existing features that this work made obsolete. Design detail for each command is in [DESIGN-prism-cli-local.md](DESIGN-prism-cli-local.md).

`enable codewatch` and `dashboard` are on `main` (release 1.2.0). `enable security` is on the unpushed branch `feat/enable-security-agent`.

## Summary

| Job | Command | Status |
|---|---|---|
| Observe | `prism-cli version` | Planned |
| Observe | `prism-cli enable codewatch` | **Built** |
| Observe | `prism-cli enable codeburn` | Planned (mostly reuse) |
| Observe | `prism-cli enable security` | **Built** (not merged) |
| Observe | `prism-cli dashboard` | **Built** |
| Observe | `prism-cli export otel --endpoint` | Planned |
| Observe | `prism-cli install transformation-center` | Blocked: scope unknown |
| Secure | `prism-cli security design-review` | Planned, API unknown |
| Secure | `prism-cli security threat-model` | Planned, API unknown |
| Secure | `prism-cli security code-review` | Planned (reuse from CI) |
| Secure | `prism-cli security pentest` | Planned (reuse, guarded) |
| Secure | `prism-cli security findings` | Planned |
| Advise | `prism-cli aws connect` | Planned |
| Advise | `prism-cli aws check` | Planned (reuse) |
| Advise | `prism-cli aws recommend` | Planned |

So far 3 of the 15 are built, 11 are planned, and 1 is blocked until we know what it is. None of the slide's commands were dropped.

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
  - A placeholder for security findings.
- **Access:** it listens on `127.0.0.1` only and needs a one-time token. It is read-only and reads local files only, with no AWS calls.
- **Other options:** `--json` prints the same data. `--port` and `--no-open` suit remote use over `ssh -L`. `--all` is deprecated and does nothing.
- **User docs:** [Local Dashboard](../USER_GUIDE.md#local-dashboard).

### `enable security`
Sets up AWS Security Agent (Continuum) for one account and region, plus the code review the CI eval gate uses for the current repo. It replaces `securityagent setup`, which stays as a deprecated alias.

- **Scoped deploy:** only the `PrismD1MetricsPipeline` stack (`--exclusively`), which holds every Security Agent resource. The old command deployed `--all`.
- **Asks first:** prints a resource diff with IAM, network and public endpoint changes named (the full `cdk diff` goes to a file), then asks with the account ID, alias and region named. `--yes` approves for CI; with no terminal and no `--yes` it refuses. `--require-approval never` is gone.
- **`--dry-run`:** runs every read and prints the exact create and update calls. **`--status`:** a read-only report.
- **Idempotent:** reuses the agent space, application, code review, S3 snapshot (skipped when its ETag matches) and SSM parameter. A different value already in SSM is a conflict that needs a second yes.
- **Fixes:** writes `/prism/continuum/code-review-id/<repo-slug>`, the parameter the eval gate reads (the old command wrote an unslugged one nothing read), and reads the `codeReviewSummaries` the API returns.
- **Marker:** `.prism/config.json` gets a `security` block (ids only); the dashboard's setup checklist shows a Security Agent column from it.
- **No uninstall** yet: deleting AWS resources needs its own design.
- **User docs:** [Security Agent Setup](../USER_GUIDE.md#security-agent-setup-enable-security).

## Planned

### Observe
- **`version`:** prints the CLI version plus installed hooks, the reviewer and the codeburn status. Open: offline only, or check npm for updates?
- **`enable codeburn`:** a new name for `bootstrapper setup-otel-sync`, which schedules `codeburn sync push`. Open: should `--attribution` stay on now that commit trailers are gone?
- **`export otel --endpoint`:** sends usage to a team's own OTLP collector. Open: whether codeburn accepts a custom endpoint, and whether local codewatch results should be exported too.

### Secure (AWS Continuum)
All of these call AWS and need credentials.
- **`security design-review`, `security threat-model`:** new. Open: which Security Agent APIs back them, and what input they take (a spec, a design doc or a repo).
- **`security code-review`:** moves the Continuum code-review steps from the CI gate into the CLI.
- **`security pentest`:** reuses `workshop perform-pen-test`. It runs only against targets the customer owns and authorizes: the target must pass domain verification and the user confirms it by name, with no flag to skip that. Open: what authorization evidence is needed beyond domain verification.
- **`security findings`:** lists Continuum findings and local codewatch results together, and fills the dashboard panel.

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
| The retired Bedrock eval-gate mode | kiro-cli eval gate | It was already retired before this work. `--mode bedrock` errors. |

These existing commands get new names. The old names stay as deprecated aliases for at least one release:

| Old | New |
|---|---|
| `bootstrapper setup-otel-sync` | `enable codeburn` |
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
