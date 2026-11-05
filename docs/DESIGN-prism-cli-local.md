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
   - shows the current repo by default; `--all` covers every repo with a `.prism/` directory.
5. **`enable codewatch`** installs those hooks (spec and implementation below).
6. **`enable security` is an open slot.** It is not an alias for codewatch. It will probably wrap the existing Security Agent setup (`securityagent setup`); see [`enable security`](#enable-security-open-slot).

## How the new commands fit the CLI

Commands are auto-registered: each folder under `cli/src/commands/<group>/` is a command group and each file in it a subcommand (`cli/src/index.ts`). That gives `prism-cli <group> <command>` for free, which fits `enable codewatch`, `security pentest` and `aws check`.

Single-word top-level commands (`version`, `dashboard`) and commands with a positional object (`export otel`, `install transformation-center`) do not fit the two-level layout as cleanly:

- `export otel` and `install transformation-center` are two-level already (`export/otel.ts`, `install/transformation-center.ts`).
- `version` and `dashboard` need a small extension to `index.ts`: a `commands/_top/` folder whose files register as top-level commands. Proposed rule: files in `_top/` attach to `program` directly; everything else is unchanged. `--version` keeps working; `version` adds more detail (CLI version, installed hooks, codeburn version, reviewer tool).

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

### `dashboard` (new)
- **Reuses:** the server pattern of `assessment/web.ts` (Node `http`, generated HTML, `randomBytes` session token); `verify-setup` checks for the setup panel; `setup-otel-sync`'s log location; the result schema in `cli/src/codewatch/results.ts`.
- **Serving:** `127.0.0.1`, port 0 (random), a 32-byte token required on every request (query string on first load, then a cookie with `HttpOnly; SameSite=Strict`), `Host` header must be `127.0.0.1:<port>` (DNS-rebinding guard). Static HTML, no external resources.
- **Panels:**
  1. **Usage:** summary from `codeburn export` (JSON), plus a link that starts or points to `codeburn web`. No charts are rebuilt.
  2. **Local eval and gitleaks:** `.prism/results/*.json`, latest per branch; counts of skipped checks (`status: skipped`).
  3. **Security findings:** findings from local results and, once `security findings` exists, its cached output.
  4. **Setup checklist:** codeburn installed; scheduled sync installed and last sync time (from `~/.prism/logs`); codewatch hooks installed (hook marker) and which reviewer; CI eval workflow present (`.github/workflows/prism-eval-gate.yml` or GitLab equivalent); OIDC set up (workflow role ARN configured); Security Agent set up; AWS/Bedrock access. Reuse the `verify-setup` check functions after moving them to a shared module that returns data instead of printing.
  5. **Advise** (later): output of `aws check`.
- **`--json`:** the same panel data as one JSON document.
- **`--all`:** repos found how? See open questions.
- **Open questions:**
  - `--all` discovery: scan a configured root (`~/workplace`?), keep a registry in `~/.prism/repos.json` written by `enable codewatch`, or both?
  - The OIDC and Security Agent checks need AWS calls to be exact. Is a local signal (config file present, workflow references a role ARN) enough for the panel, with exact checks behind an explicit button?
  - Does `codeburn export` have a stable schema we can pin, and which version range?

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
| `pre-commit` hook | `gitleaks protect --staged --redact` with `.gitleaks.toml` and `.prism/gitleaks-baseline.json` when present. **Blocks** on a finding. Also blocks when gitleaks runs but cannot produce a verdict. A missing gitleaks warns and allows (CI's gitleaks step is the backstop). Works without prism-cli: the hook falls back to calling gitleaks directly. |
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

### The old hook

`bootstrapper install-git-hooks` is now a **deprecated alias** for `enable codewatch` (chosen over a deprecation-only error so existing docs and scripts keep working). `enable codewatch` removes a PRISM `prepare-commit-msg` (identified by `AI-Origin`) and restores whatever it had backed up. `git commit-trailers` stays, marked deprecated, because hooks already installed in other repos call it. Not touched automatically: `~/.git-templates/hooks/prepare-commit-msg` (from the old `--global`) and the Claude Code `SessionStart` entry in `~/.claude/settings.json`; the alias prints a note for the template.

## Open questions

1. **`enable security`:** confirm it wraps the Security Agent setup (`securityagent setup`), and whether it sits under Observe or Secure. (Resolved: codewatch is the git-hook gate.)
2. **transformation-center:** what is it and what does installing it do locally?
3. **codeburn attribution:** with commit trailers retired, what does `codeburn sync push --attribution` attribute usage to, and should it stay on?
4. **`dashboard --all`:** discover repos by scanning a root, by a registry written at install, or both?
5. **`dashboard` setup panel:** are local signals enough for the OIDC and Security Agent checks, or must the panel call AWS?
6. **codeburn export schema:** which codeburn versions do we support, and is `codeburn export` JSON stable?
7. **`export otel`:** does codeburn accept a custom endpoint, and should local gate results be exported?
8. **Security Agent APIs:** which APIs back `design-review` and `threat-model`, and what input do they take?
9. **`security pentest` authorization:** what evidence beyond domain verification is required?
10. **`aws connect`:** store the profile per repo or per user; create a read-only role or only document one?
11. **Startup Advisor:** how are its checks consumed (library, CLI, API), and under what license and versioning?
12. **`aws recommend`:** static mapping or model-generated, and if model-generated, where does inference run?
13. **`version`:** offline only, or check npm for updates?
14. **codewatch pre-commit without gitleaks:** currently warns and allows. Should a team be able to make it block (for example `eval.require_gitleaks: true`)?
15. **Rebase noise:** the skipped-check heuristic flags rebased commits. Acceptable for v1, or should pre-push skip commits whose patch-id matches a scanned one?
