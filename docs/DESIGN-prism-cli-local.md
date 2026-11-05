# Design: prism-cli as one local tool with three jobs

> Status: draft for review. `enable codewatch` is implemented on branch `feat/enable-security`; everything else here is a proposal.
> Source: the roadmap slide "prism-cli: one tool, three jobs".

## Summary

prism-cli today is a set of installer groups (`bootstrapper`, `workshop`, `securityagent`, `bedrock-protection`, `assessment`, `git`, `parse-code-tool`). The roadmap reorganises the developer-facing surface around three jobs:

| Job | Commands | Needs AWS? |
|---|---|---|
| **Observe** | `version`, `enable codewatch`, `enable codeburn`, `enable security`, `dashboard`, `export otel --endpoint`, `install transformation-center` | No, except `install transformation-center` (open) |
| **Secure** (AWS Continuum / Security Agent) | `security design-review`, `security threat-model`, `security code-review`, `security pentest`, `security findings` | Yes |
| **Advise** (AWS account) | `aws connect` (read-only), `aws check`, `aws recommend` | Yes, read-only |

The existing groups stay. New top-level groups (`enable`, `security`, `aws`, plus the single commands `version`, `dashboard`, `export`, `install`) are added next to them, and old commands that move become aliases that print a deprecation line and call the new code.

## Settled decisions

These were agreed with the user before this doc was written.

1. **Commit trailers and the token tracker are retired.** The `prepare-commit-msg` hook installed by `bootstrapper install-git-hooks` (AI-Origin trailers plus token/cost limits) is obsolete. `enable codewatch` replaces it and removes it when found.
2. **Usage tracking is codeburn.** codeburn already ships a local web UI (`codeburn web`) and JSON export (`codeburn export`). PRISM does not rebuild either.
3. **`codewatch` is the local git-hook gate.** It is the blocking gitleaks `pre-commit` plus the report-only reviewer `pre-push` (originally built as `enable security`). It is unrelated to the npm package named `codewatch`.
4. **`prism-cli dashboard`** is a local web UI:
   - bound to `127.0.0.1` only, on a random port, with a one-time token in the URL;
   - opens the browser; reads local files only, so the panels below need no AWS credentials;
   - a static single-page app bundled in the CLI, following the `assessment/web.ts` pattern (Node `http` server, HTML built in TypeScript, random session token);
   - `--json` prints the same data instead of serving it;
   - finds repos on its own: it scans the home directory (3 levels) for repos with `.git` and `.prism/`, wherever it is run from, and lists the current repo first.
5. **`enable codewatch`** installs those hooks (spec and implementation below).
6. **`enable security` is an open slot.** It is not an alias for codewatch. It will probably wrap the existing Security Agent setup (`securityagent setup`); see [`enable security`](#enable-security-open-slot).

## How the new commands fit the CLI

Commands are auto-registered: each folder under `cli/src/commands/<group>/` is a command group and each file in it a subcommand (`cli/src/index.ts`). That gives `prism-cli <group> <command>` for free, which fits `enable codewatch`, `security pentest` and `aws check`.

Single-word top-level commands (`version`, `dashboard`) and commands with a positional object (`export otel`, `install transformation-center`) do not fit the two-level layout as cleanly:

- `export otel` and `install transformation-center` are two-level already (`export/otel.ts`, `install/transformation-center.ts`).
- `version` and `dashboard` need a small extension to `index.ts`: a `commands/_top/` folder whose files register as top-level commands (built on `feat/dashboard`: files in `_top/` attach to `program` directly; everything else is unchanged). `--version` keeps working; `version` adds more detail (CLI version, installed hooks, codeburn version, reviewer tool).

Proposed layout:

```
commands/
  _top/        version.ts, dashboard.ts          (new: top-level commands)
  enable/      codewatch.ts (built), codeburn.ts, security.ts (open slot: likely wraps securityagent setup)
  export/      otel.ts
  install/     transformation-center.ts
  security/    design-review.ts, threat-model.ts, code-review.ts, pentest.ts, findings.ts
  aws/         connect.ts, check.ts, recommend.ts
  codewatch/   pre-commit.ts, pre-push.ts (built; hook entry points called by the installed hooks)
  bootstrapper/, workshop/, securityagent/, bedrock-protection/, assessment/, parse-code-tool/  (unchanged)
```

Shared logic moves out of command files into `cli/src/<area>/` modules (as done for `cli/src/codewatch/`), so an old command and its new alias call the same function instead of duplicating it.

### Keeping old commands working

An old command that moves keeps its file and becomes a thin alias:

1. print one `⚠ "<old>" is deprecated; use "<new>"` line on stderr;
2. accept its old flags (retired flags are accepted and ignored with a note, so pinned scripts do not fail on an unknown option);
3. call the new implementation.

Aliases stay for at least one minor release after the new command ships, and their descriptions start with `[deprecated]` so `--help` shows the new name.

| Old | New | Status |
|---|---|---|
| `bootstrapper install-git-hooks` | `enable codewatch` | **Done:** deprecated alias. Old trailer flags are ignored. |
| `securityagent setup` | `enable security` | Proposed alias (see the open slot below) |
| `git commit-trailers` | (none) | Kept, marked `[deprecated]`, because already-installed `prepare-commit-msg` hooks call it. Remove after one release. |
| `bootstrapper setup-otel-sync` | `enable codeburn` | Proposed alias |
| `securityagent setup` | `security` setup step (see below) | Proposed alias |
| `workshop perform-pen-test` | `security pentest` (workshop target only) | Proposed alias |
| `bedrock-protection scan-account` | `aws check` (Bedrock section) | Proposed alias |
| `workshop verify-setup` | `dashboard` setup panel + `version` | Keep; reuse its checks |

## Observe

### `version` (new)
- **Reuses:** `package.json` version (as `--version` does today); the setup checks below for the extra detail.
- **Prints:** CLI version, Node version, codeburn version and sync status, installed PRISM hooks, configured reviewer.
- **Open questions:** Should it check npm for a newer release (a network call) or stay offline?

### `enable codeburn` (mostly reuse)
- **Reuses:** `bootstrapper setup-otel-sync` (installs codeburn, runs `codeburn sync setup`, schedules `codeburn sync push --attribution` every 12h via crontab/launchd/Task Scheduler, logs to `~/.prism/logs`). `workshop verify-setup` `checkCodeburn`.
- **New:** the command name and alias only.
- **Open questions:** Is "enable" also responsible for installing codeburn itself, or only for wiring sync? Should attribution remain on by default now that commit trailers are gone (what does `--attribution` attribute to without trailers)?

### `enable codewatch` (built)
The local git-hook gate. See [enable codewatch: implementation](#enable-codewatch-implementation).
- **Reuses:** `.gitleaks.toml` starter and `.prism/gitleaks-baseline.json` from `install-eval-harness` (the starter config is now a shared module both use); the review rules `install-eval-harness` installs; the hook backup convention of `install-git-hooks` (`<hook>.pre-prism`).
- **New:** hooks, reviewer adapters, result schema and writer.

### `enable security` (open slot)
- **Not** codewatch, and deliberately not an alias for it, so the name stays free for the slide's own command.
- **Likely reuses:** `securityagent setup` (deploys Security Agent infrastructure and creates the web console application) and `bootstrapper/security-agent/setup.sh`. That makes it the setup step for the Secure commands, and `securityagent setup` would become its alias.
- **Open questions:** Is that the intended meaning? It needs AWS credentials, unlike the rest of Observe; does it belong under Observe or Secure on the slide?

### `dashboard` (built on `feat/dashboard`)
- **Code:** `cli/src/commands/_top/dashboard.ts` (top-level commands now live in `commands/_top/`), data collectors and server in `cli/src/dashboard/`.
- **Reuses:** the `assessment/web.ts` pattern (Node `http`, HTML generated in TypeScript, random token); the codewatch result schema; schedule detection moved out of `setup-otel-sync` into `utils/otel-sync-schedule.ts`; the tool probe in `utils/tool-check.ts`, now shared with `verify-setup` and codewatch.
- **Serving:** `127.0.0.1` only (a constant, no flag), random free port unless `--port`. A per-run 256-bit token is accepted once from `/?token=`, exchanged for an `HttpOnly; SameSite=Strict` cookie named per port, and required on every request. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). GET only, no CORS headers, strict CSP with a per-response nonce, no external resources. Ctrl-C stops it.
- **Data:** local files only, no AWS calls. `--json` prints the same payload (`prism.dashboard.v2`) and exits.
- **Repo discovery** (`discoverRepos()` in `cli/src/dashboard/repos.ts`): scans the home directory, or `--root <dir>`, up to 3 levels deep for repos with both `.git` and `.prism/`, from any working directory. It never enters hidden directories (`.git`, `.cache`, `.venv`, ...), `node_modules`, `Library`, `build`, `dist`, `target` or `venv`; does not follow symlinks; stops at any git repo, so nested repos are skipped; treats unreadable directories as skips; and is capped at 200 repos and 20,000 listed directories. The repo containing the working directory is listed first even without `.prism/`. Measured on the author's home directory: about 50 ms, 57 directories listed. `--all` is kept as a no-op that prints a deprecation note.
- **Panels:**
  1. **Codewatch** (`.prism/results/`): the machine-level secret-scanning banner, then one summary row per repo (high/medium/low from the latest reviews, last run, reviewer, unscanned commits, gitleaks warning), most high findings first. Below it, each repo's detail sits in a collapsed `<details>`: latest run per branch, findings, gitleaks blocks, commits pushed without a scan and a 20-run trend. The current repo starts expanded; a repo with no results says to run `cd <repo> && prism-cli enable codewatch`.
  2. **Usage** (`codeburn export -f json`, two runs: default for Today, `--from <1st> --to <today>` for this month): today and month totals, top 5 models and projects. "codeburn not installed", "no data" and error states. Points at `codeburn web` as a command, not a link.
  3. **Setup checklist**: the machine section (codeburn installed; scheduled sync and last sync-log write; gitleaks; AWS credentials by presence only, no STS) and one row per repo for codewatch only (both PRISM hooks plus the reviewer), repos missing codewatch first, each with the fix `cd <repo> && prism-cli enable codewatch`. The CI eval workflow, OIDC and Security Agent rows were removed: they could only ever show local guesses.
  4. **Security findings:** placeholder until `prism-cli security findings`.
  5. **Advise** (later): output of `aws check`.
- **Open questions:**
  - codeburn's export schema (`codeburn.export.v2`, checked against 0.9.24): which versions do we support?

### `export otel --endpoint` (new, thin)
- **Reuses:** codeburn's OTEL push (`codeburn sync push`), which `setup-otel-sync` schedules.
- **New:** pass-through to a user-supplied OTLP endpoint for teams with their own collector; optionally also export `.prism/results/` as OTEL events.
- **Open questions:** Does codeburn support a custom endpoint directly (then this is a wrapper), or does PRISM need its own exporter? Which auth headers must be supported? Should local gate results be exported, given they are per-developer?

### `install transformation-center` (unknown scope)
- **Reuses:** nothing identified in the repo.
- **Open questions:** What is "transformation center" (AWS Transform? an internal portal?), what does installing it mean locally, and does it need AWS credentials?

## Secure (AWS Continuum / Security Agent)

All of these call AWS and need credentials; none run in hooks.

### Setup step
- **Reuses:** `securityagent setup`, proposed to move to `enable security` (see the open slot under Observe).
- **Proposal:** `security` commands detect a missing agent space and print the one command to run (`prism-cli enable security`).

### `security design-review`, `security threat-model` (new)
- **Reuses:** the agent-space lookup and SSM parameter convention in the CI gate (`/prism/continuum/code-review-id/<repo>`).
- **Open questions:** Which Security Agent APIs back these (design review and threat model are not used anywhere in the repo yet)? What is the input: a spec under `specs/`, a design doc path, or a repo? Where do results go: `.prism/results/` with `kind: design-review`, or only the Security Agent console?

### `security code-review` (reuse from CI)
- **Reuses:** the Continuum steps in `prism-eval-gate-kiro.yml` (`create-code-review`, `start-code-review-job`, `batch-get-code-review-jobs`, `list-findings`), moved into TypeScript.
- **Open questions:** Should it review the working branch diff (like pre-push) or the whole repo? Same fail-closed semantics as CI?

### `security pentest` (reuse, guarded)
- **Reuses:** `workshop perform-pen-test` (deploys sample-app, sets up Lambda + API Gateway, domain verification).
- **Guard:** runs only against targets the customer owns and authorizes. The command requires the target to pass Security Agent domain verification and asks for explicit confirmation naming the target; there is no flag that skips verification.
- **Open questions:** Beyond domain verification, what evidence of authorization is required (account ownership of the endpoint, a written scope)? Does the workshop variant stay a separate alias that targets sample-app only?

### `security findings` (new)
- **Reuses:** `list-findings` handling from the CI gate; the `Finding` type in `cli/src/codewatch/results.ts`.
- **Proposal:** lists Continuum findings and local results in one table; `--json` for the dashboard.
- **Open questions:** Cache findings locally for the dashboard (so it stays credential-free), and if so, for how long?

## Advise (AWS account)

### `aws connect` (new, read-only)
- **Proposal:** records which profile/role to use and verifies with `sts get-caller-identity`. Read-only by construction: it stores a profile name, never credentials, and refuses roles whose name suggests write access unless confirmed.
- **Open questions:** Store the profile per repo (`.prism/config.json`, committed) or per user (`~/.prism/`)? Should it create a read-only role (that is a write) or only document one?

### `aws check` (reuse)
- **Reuses:** Startup Advisor's account checks for everything general, and `bedrock-protection scan-account` (`utils/audit-iam.ts`, `utils/audit-bedrock.ts`) for Bedrock.
- **PRISM adds only:** AI-DLC checks and Bedrock checks (invocation logging, spend guardrails, model access, Guardrails, LLMjacking exposure).
- **Open questions:** How is Startup Advisor consumed: a library, a CLI, or an API? Its license and version pinning? Which AI-DLC checks are account-level rather than repo-level?

### `aws recommend` (new)
- **Reuses:** findings from `aws check`.
- **Open questions:** Static mapping from finding to recommendation, or model-generated? If model-generated, does it run through Bedrock in the customer's account?

## enable codewatch: implementation

Built on `feat/enable-security` (the branch keeps its original name). Entry points: `prism-cli enable codewatch` installs; the hooks call `prism-cli codewatch pre-commit` and `prism-cli codewatch pre-push`.

### What it installs

| Piece | Behaviour |
|---|---|
| `pre-commit` hook | `gitleaks protect --staged --redact` with `.gitleaks.toml` and `.prism/gitleaks-baseline.json` when present. **Blocks** on a finding. Also blocks when gitleaks runs but cannot produce a verdict. A missing gitleaks never blocks (decided): it warns, allows the commit and records `status: skipped`, `reason: gitleaks-missing` (CI's gitleaks step is the backstop). Works without prism-cli: the hook falls back to calling gitleaks directly. |
| `pre-push` hook | Reviews the branch diff (`git diff <upstream>...<head>`, lock files excluded, capped at 200,000 characters) with the configured reviewer. **Report only:** always exits 0, including when the reviewer is missing, crashes, times out (default 300s) or returns unparseable output. Prints a short summary. |
| `.prism/review/rules.md` | The one tool-neutral rule set. Seeded from `.kiro/steering/code-review.md` if the repo has one (keeps team edits), else from the bundled rules `install-eval-harness` ships. |
| `.prism/config.json` `eval.reviewer` | Team default reviewer, merged into the existing file. Optional `eval.model` and `eval.timeout_seconds`. |
| `.gitignore` | Adds `.prism/results/`. |

### Reviewers

One interface (`cli/src/codewatch/reviewers/types.ts`), one file per tool. An adapter only builds argv and parses output; running, timeouts and error handling are shared.

| Tool | Invocation | Rules passed as | Tools allowed |
|---|---|---|---|
| `kiro` | `kiro-cli chat --no-interactive --trust-tools=fs_read --model auto "<prompt>"` | context: the prompt tells kiro to read `.prism/review/rules.md` and the diff file | `fs_read` only |
| `claude` | `claude -p --output-format json --allowed-tools Read,Grep,Glob --disallowed-tools Bash,Edit,Write,...` (prompt on stdin) | inline in the prompt | `Read`, `Grep`, `Glob` |

- **Detection at install:** whichever is on PATH; if both, the installer asks (`--reviewer` skips the question; with no TTY it uses the existing setting, else `claude`).
- **Developer override:** `git config prism.reviewer <kiro|claude>` (per clone, never committed). Chosen over an env var because it persists across shells and IDE-launched git.
- **Fallback:** if the selected tool is not installed, another installed one is used and the result records the tool actually used. A Claude Code user never needs kiro-cli.
- **CI stays on kiro-cli.** The only CI change: both eval-gate templates copy `.prism/review/rules.md` over `.kiro/steering/code-review.md` before the review step when the file exists, so CI and local review use the same rules.

### Results

Each run writes `.prism/results/<commit12|tree-<tree12>>-<UTC time>-<hook>-<kind>.json` (mode 0600, written atomically). The schema is `PrismResult` in `cli/src/codewatch/results.ts`:

```ts
{
  schema_version: 1,
  kind: 'secrets' | 'review',
  hook: 'pre-commit' | 'pre-push' | 'ci' | 'manual',
  status: 'ok' | 'findings' | 'error' | 'skipped',
  tool: 'gitleaks' | 'kiro' | 'claude' | 'none',
  tool_version, model,              // model: as reported, else as requested, else null
  commit, tree, branch, upstream, base,
  started_at, finished_at,          // ISO 8601 UTC
  findings: [{ severity: 'high'|'medium'|'low', category: 'quality'|'security',
               rule, file, line, message }],
  summary, score, reason
}
```

- gitleaks findings use the same schema (`severity: high`, `category: security`, `rule` = gitleaks RuleID). The secret value is never read from the report.
- **Skipped checks:** pre-commit records the staged tree id, which equals the tree of the commit it becomes. At pre-push, each pushed commit whose tree has no pre-commit result gets a `kind: secrets, status: skipped` result. This catches `git commit --no-verify`; it also flags commits made by rebase, cherry-pick or merge (no commit hook runs), which the `reason` says. A skipped pre-push (`git push --no-verify`) cannot be seen locally at push time; the dashboard can detect it as a pushed commit with no pre-push review result.

### Uninstall and existing hooks

- Existing hooks are moved to `<hook>.pre-prism` (the `install-git-hooks` convention) and **called first** by the PRISM hook, so a team's hook keeps running. A second backup never overwrites the first.
- `--uninstall` removes only hooks carrying the PRISM marker and moves backups back. Rules, config and results are kept.
- Hooks are found with `git rev-parse --git-path hooks`, so `core.hooksPath` and linked worktrees work.
- Hooks written before the rename (marker `# prism-cli enable security`, calling the removed `prism-cli git pre-commit`/`git pre-push`) are recognised as PRISM hooks: install overwrites them in place and uninstall removes them. There is no compatibility shim for the old command names.

### Global install (`--global`)

`prism-cli enable codewatch --global` covers every existing and future repo with no per-repo step:

- Writes `pre-commit` and `pre-push` (same marker plus `# prism-codewatch-global`) to `~/.prism/hooks/` and runs `git config --global core.hooksPath ~/.prism/hooks`.
- A global `core.hooksPath` makes git ignore each repo's `.git/hooks`, so the global hooks run the repo-local hook themselves, after codewatch, with the same arguments and (for pre-push) the same buffered stdin, and pass its exit code through. A per-repo codewatch hook is never run twice: the team hook it had backed up (`<hook>.pre-prism`) runs instead.
- pre-commit: a gitleaks finding blocks before the repo hook runs. pre-push: codewatch's part stays report-only; the repo hook's exit code still counts.
- An existing global `core.hooksPath` that is not ours is refused unless `--force`; with `--force` it is saved to `~/.prism/hooks/.previous-hookspath`, and its hooks are chained too (`.chain-hookspath`).
- Opt a repo out with `git config prism.codewatch false` (repo-local hooks still run). A repo that sets its own `core.hooksPath` (husky) overrides the global one and is not covered.
- Results go to each repo's `.prism/results/`, created on demand and excluded through `.git/info/exclude`, so a repo that never had `.prism/` stays clean. Without a repo rules file, pre-push reviews against the bundled default rules.
- `--reviewer` with `--global` sets `git config --global prism.reviewer`.
- `--global --uninstall` restores the saved value (or unsets it), removes only marked files, and never touches repo-local hooks. If `core.hooksPath` was changed to something else since, it is left alone.
- `bootstrapper install-git-hooks --global` still ignores its old flag; it does not map to this.

### The old hook

`bootstrapper install-git-hooks` is now a **deprecated alias** for `enable codewatch` (chosen over a deprecation-only error so existing docs and scripts keep working). `enable codewatch` removes a PRISM `prepare-commit-msg` (identified by `AI-Origin`) and restores whatever it had backed up. `git commit-trailers` stays, marked deprecated, because hooks already installed in other repos call it. Not touched automatically: `~/.git-templates/hooks/prepare-commit-msg` (from the old `--global`) and the Claude Code `SessionStart` entry in `~/.claude/settings.json`; the alias prints a note for the template.

## Open questions

1. **`enable security`:** confirm it wraps the Security Agent setup (`securityagent setup`), and whether it sits under Observe or Secure. (Resolved: codewatch is the git-hook gate.)
2. **transformation-center:** what is it and what does installing it do locally?
3. **codeburn attribution:** with commit trailers retired, what does `codeburn sync push --attribution` attribute usage to, and should it stay on?
4. **Decided: repo discovery is a home-directory scan.** The dashboard scans `~` (or `--root`) 3 levels deep from any working directory; a registry is not needed for now.
5. **`dashboard` setup panel:** decided to show codewatch only per repo; CI workflow, OIDC and Security Agent rows are gone.
6. **codeburn export schema:** which codeburn versions do we support, and is `codeburn export` JSON stable?
7. **`export otel`:** does codeburn accept a custom endpoint, and should local gate results be exported?
8. **Security Agent APIs:** which APIs back `design-review` and `threat-model`, and what input do they take?
9. **`security pentest` authorization:** what evidence beyond domain verification is required?
10. **`aws connect`:** store the profile per repo or per user; create a read-only role or only document one?
11. **Startup Advisor:** how are its checks consumed (library, CLI, API), and under what license and versioning?
12. **`aws recommend`:** static mapping or model-generated, and if model-generated, where does inference run?
13. **`version`:** offline only, or check npm for updates?
14. **Decided: codewatch pre-commit without gitleaks never blocks.** The hook warns, allows the commit, and records a `secrets` result with `status: skipped` and `reason: gitleaks-missing`. The dashboard shows a warning banner counting those commits, and its gitleaks checklist row is a warning.
15. **Rebase noise:** the skipped-check heuristic flags rebased commits. Acceptable for v1, or should pre-push skip commits whose patch-id matches a scanned one?
