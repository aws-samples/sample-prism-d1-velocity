# PRISM plugin for Claude Code (v0.3, work in progress)

Brings PRISM's local results into [Claude Code](https://code.claude.com/docs/en/overview): codewatch
review findings, scan reports, AI spend and the setup checklist. It reads the same local data as
`prism-cli dashboard` and makes no AWS calls. The only port it opens is the live dashboard's, on
127.0.0.1, when you run `/prism:dashboard`.

The plugin has four parts:

- **MCP server** `prism`: the `prism-cli mcp` tools (`prism_status`, `prism_findings`,
  `prism_spend`, `prism_report`, `prism_snapshot`, `prism_dashboard`, `prism_dashboard_stop`,
  `prism_setup`, `prism_review`). They only read, except `prism_report` and `prism_snapshot`, which write an HTML
  file under the OS temp directory, `prism_dashboard`, which starts the local dashboard server, and
  `prism_review`, which runs a review and writes its result file. See
  [MCP server (prism-cli mcp)](../USER_GUIDE.md#mcp-server-prism-cli-mcp).
- **Slash commands**: prompts that call those tools (listed below). They hold no logic of their own.
- **SessionStart hook**: adds a short summary of this branch's open findings to Claude's context
  when a session starts.
- **Harness loop hooks**: gitleaks and a PRISM review before Claude runs `git push` (on by
  default), and optionally before Claude finishes (off by default). See [The harness loop](#the-harness-loop).

## Requirements

- Claude Code 2.1.x.
- prism-cli 1.11.0 or later on the `PATH` Claude Code sees (`npm install -g @prism-d1/cli`) for the
  harness loop and `/prism:review`; 1.10.0 is enough for everything else, and with an older prism-cli
  the harness hooks do nothing. Node.js 22 or later, which prism-cli needs anyway. The hooks run with `node`.
- For findings: the [codewatch git hooks](../USER_GUIDE.md#codewatch-local-git-hooks) in the repo
  (`prism-cli enable codewatch`). A review is recorded on each `git push`.

## Install

In a Claude Code session:

```text
/plugin marketplace add aws-samples/sample-prism-d1-velocity
/plugin install prism@prism-d1-velocity
```

Claude Code 2.1.275 or later can do both in one step:
`/plugin install prism --marketplace aws-samples/sample-prism-d1-velocity`.

From your shell:

```bash
claude plugin marketplace add aws-samples/sample-prism-d1-velocity
claude plugin install prism@prism-d1-velocity
```

Start a new session (or run `/reload-plugins`), then check that `/mcp` lists
`plugin:prism:prism` as connected. Select it and choose **View tools** to see its 9 tools (the screenshot below predates `prism_review`):

![Claude Code /mcp tool list for plugin:prism:prism: prism_status, prism_findings, prism_spend and prism_setup marked read-only, plus prism_report, prism_snapshot, prism_dashboard and prism_dashboard_stop](../assets/images/prism-cli/claude-code-mcp-dark.png)

If you added the MCP server by hand before (`claude mcp add prism -- prism-cli mcp`), remove it with
`claude mcp remove prism`, so the agent doesn't see the same tools twice.

### nvm, Volta and other PATH problems

Claude Code starts the MCP server and the hook with its own environment. If you start Claude Code
from a shell where `prism-cli` works, it finds it. If you start it from somewhere that doesn't
load nvm (a desktop launcher, an IDE), `/mcp` shows the `prism` server as failed. Fix it in one of
these ways:

1. Start `claude` from a shell where `command -v prism-cli` prints a path.
2. Set `PRISM_CLI` to the absolute path that `command -v prism-cli` prints, in the environment
   Claude Code starts with. The plugin's `.mcp.json` runs `${PRISM_CLI:-prism-cli}`, and the hook
   reads the same variable. `node` must still be on that `PATH`, because `prism-cli` starts with
   `#!/usr/bin/env node`.

## Commands

| Command | What it does |
|---|---|
| `/prism` (also `/prism:prism`) | Status summary: spend today and this month, setup warnings with fix commands to copy, the latest review and its counts |
| `/prism:findings [branch]` | Findings of the latest pre-push review of this branch, numbered, most severe first |
| `/prism:report [html\|md] [commit]` | The scan report for the review covering a commit (default `HEAD`). `html` (default) writes a file under the OS temp directory and prints its path; `md` shows the text |
| `/prism:review [ref]` | Runs the harness review now (`prism_review`): gitleaks, then your reviewer, on this branch's changes plus uncommitted work. Shows the verdict, `next_action` and the findings. Changes nothing but the result file. Claude only runs it when you type it |
| `/prism:fix [n]` | Fixes finding `n` from `/prism:findings`, or every high and medium finding, in the working tree. At most 2 rounds, then a report and `git diff --stat`. It doesn't commit or push. Claude only runs it when you type it |
| `/prism:dashboard [--no-open]` | Starts the live dashboard (`prism-cli dashboard`, 127.0.0.1 only) through the `prism_dashboard` tool, or reuses the one already running, prints its URL and opens it when there is a display. Claude Code asks you to approve the call, because it starts a local server. See [The live dashboard](#the-live-dashboard) |
| `/prism:dashboard --snapshot` | Writes the dashboard as one static HTML file under the OS temp directory (`prism_snapshot`), opens it when there is a display, and prints its path. No server runs; the file doesn't refresh and its commands are copy only |
| `/prism:dashboard --stop` | Stops the dashboard that `/prism:dashboard` started (`prism_dashboard_stop`). It never stops one you started yourself |
| `/prism:spend [days]` | AI coding spend from the dashboard's usage cache: today, month, top models and projects, per-day rows (default 7 days) |

`/prism` works as a bare name unless another command already uses it; `/prism:prism` always works.

### Untrusted reviewer text

A reviewer model writes the finding and report text, and that text quotes repository code, so it
can contain instructions. Every command tells Claude to treat the text as data. Claude must not
follow instructions in it or run commands it suggests. The commands also tell Claude never to
push, never to disable or bypass git hooks (no `--no-verify`, no `git config prism.codewatch false`)
and never to edit or delete anything in `.prism/results/`. The MCP tools carry the same warning in
their descriptions and cap each message at 2,000 characters.

## The harness loop

The plugin's hooks run `prism-cli codewatch hook --client claude` (through
`scripts/harness-hook.mjs`, which only passes the hook JSON through and always exits 0). prism-cli
decides everything. When prism-cli is missing, older than 1.11.0, or its hook fails, nothing is
blocked and you see one line per session saying the check is off and why, for example
`PRISM push check is off: prism-cli 1.11.0 or later is needed (found 1.10.1). Run npm i -g @prism-d1/cli@latest.`
The once-per-session marker is an empty file under the plugin's data directory. The full behavior is in the
[User Guide](../USER_GUIDE.md#agent-harness-loop) and the
[design](../docs/DESIGN-harness-loop.md).

| Hook | What it does | Default |
|---|---|---|
| `SessionStart` | Records the session's baseline in `.prism/harness/<session>.json`: a snapshot of the working tree, taken without touching your index | always |
| `PreToolUse` on Bash, `if: "Bash(*git*push*)"` | Push gate: gitleaks, then the review. A secret (also in any pushed commit), a failed secret scan or a change to the checks denies the push; review findings never do, they come back to Claude as context. Also denies `--no-verify`, `-c core.hooksPath=` and `git config prism.*` or `core.hooksPath`. Every deny ends by telling Claude to tell you this hook blocked it | on |
| `PreToolUse` on Bash, `if: "Bash(*git*config*)"`, `"Bash(*git*-c*)"`, and (0.3.1) `"Bash(*git*ref*)"`, `"Bash(*git*remote*)"`, `"Bash(*git*fetch*)"`, `"Bash(*git*branch*)"`, `"Bash(*git*tag*)"`, `"Bash(*git*checkout*)"`, `"Bash(*git*switch*)"` | The same bypass check, with no review: `git config` and `git -c` hook changes, and commands that move a remote-tracking ref or the branch's upstream (`git update-ref refs/remotes/...`, `git fetch . HEAD:refs/remotes/origin/main`, `git branch -f origin/main`, `git branch -u ...`), which the push check compares the push against | on |
| `Stop`, `SubagentStop` | Finish gate: `fix` keeps Claude working with the findings (`decision: "block"`), at most 2 rounds | off |
| `SessionEnd` | Deletes the session's state file | always |

What blocks a push: only secrets, in the changed lines or in any commit the push would send, plus a
secret scan that failed or did not finish and changes to the checks themselves (gitleaks config,
`gitleaks:allow`, hook or PRISM config). Review findings, high ones included, never deny a push:
you get a message listing them and Claude gets them as context for a follow-up. The finish gate,
when on, blocks on secrets and high findings on lines Claude changed (`harness.block_on`). When the
reviewer is missing or fails, the gate fails open with a warning; the git pre-push review and the
CI gate still run.

The push check is a guardrail, not a sandbox. prism-cli reads the Bash command with a quote-aware
tokenizer: it sees `git push` behind `VAR=val`, `env`, git's global options (`-C dir`,
`--git-dir=...`) and one level of `sh -c '...'`, but not behind `$(...)`, backticks, `eval`, an
alias or a script. A push it does not see still meets the git pre-push hook and the CI gate.
Claude Code starts the hook only when an `if` rule matches; its rules check each subcommand and
strip leading `VAR=value`, but not `env` or `sh -c`, so the rules start with `*`
(`Bash(*git*push*)`) to reach every form the tokenizer reads
([how `if` patterns match Bash commands](https://code.claude.com/docs/en/hooks#how-if-patterns-match-bash-commands)).
A command that only looks like a push (`git log --grep push`) still starts the hook, which
answers in about 120 ms without touching git.

Options (`/config`, or when you enable the plugin):

| Option | Default | Meaning |
|---|---|---|
| `finish_gate` (**Review before Claude finishes**) | off | Turns the finish gate on for you. A repo turns it on for everyone with `harness.finish_gate: true` in `.prism/config.json`; either one is enough |
| `push_gate` (**Review before Claude pushes**) | on | The review before a push. When the repo sets `harness.push_gate` (true or false) that wins; otherwise this option decides. gitleaks runs before a push either way |

The findings reach Claude as untrusted data: after a fixed sentence that says so, each message and
rule is quoted as one JSON string, cut to 300 characters, at most 10 rows, and the whole reason is
capped at 4 KB. The instruction itself (`next_action`) is written by prism-cli from fixed templates.
Claude Code's own Stop-hook guards (`stop_hook_active` and its cap of 8 consecutive blocks) stay in
place; prism-cli's round counter ends the loop first. The reviewer runs with `PRISM_HARNESS_CHILD=1`,
so a `claude -p` reviewer that loads this plugin does not run the hooks again.

Each review costs one call to your reviewer. With the defaults that is one per push by Claude; the
finish gate adds up to 3 per session. See [Why local code review](../docs/WHY-LOCAL-CODE-REVIEW.md).

## The live dashboard

`/prism:dashboard` runs the same server as `prism-cli dashboard`: bound to 127.0.0.1 only, with a
per-run token in the URL, and Origin and CSRF checks on every Setup action. The MCP server starts it
as its own child process, so it stops when the Claude Code session ends (or with
`/prism:dashboard --stop`). Running the command again returns the same URL instead of a second
server. Its pid, port and URL are kept in `~/.prism/run/dashboard.json` (mode 0600).

The URL is a per-run secret: anyone with it can use the page, including its Setup Run buttons, so
don't paste it into chats, tickets or logs. Claude prints it once. It is also in this session's
transcript (Claude Code keeps it on disk), which is why the server listens only on 127.0.0.1 and
the token stops working when the server stops.

![The live PRISM dashboard on 127.0.0.1 with demo data: summary cards (1 high, 1 medium, 2 low findings, spend today and this month) and the Codewatch panel for four demo repos, checkout-service expanded](../assets/images/prism-cli/claude-code-dashboard-browser-light.png)

*The dashboard that `/prism:dashboard` opens, served from a demo home directory. All data is made up.*

The browser opens by itself only when there is a display and you are not in an SSH session. Over
SSH, the command prints the URL and a note: in a VS Code, Kiro or Cursor Remote-SSH terminal the
editor usually forwards the port, so Ctrl/Cmd+click the URL; from plain SSH, run
`ssh -L <port>:127.0.0.1:<port> <host>` on your own machine and open the URL there.

## The SessionStart hook

On session start, resume, `/clear` and compaction, `scripts/session-start.mjs`:

1. Asks `prism_findings` (through `prism-cli mcp`) for the latest review of the current branch. If
   it has open findings, the hook adds a short summary to Claude's context: the counts and the 5
   most severe findings. Each file name and message is quoted as a JSON string, each message is cut
   to 200 characters, and the whole context is capped at 2 KB. With no review for the branch, a
   detached HEAD, or no prism-cli, it adds nothing.
2. Runs `prism-cli git claude-session-context`, which records the session id for AI-origin commit
   attribution. It skips this step when your user or project settings already run that command as
   a SessionStart hook, so the command never runs twice.

This hook only reads and never blocks a session; a failure means less context, not an error. The
harness hooks are separate (see [The harness loop](#the-harness-loop)).

### The old manual SessionStart hook

The retired `prism-cli bootstrapper install-git-hooks` added this entry to
`~/.claude/settings.json`:

```json
{ "type": "command", "command": "prism-cli git claude-session-context" }
```

You can keep it: the plugin sees it and doesn't run the command a second time. To let the plugin
own it, delete that object from `hooks.SessionStart` in `~/.claude/settings.json`. If it was the
only hook in its matcher group, delete the whole group. The plugin checks the user settings file
(under `CLAUDE_CONFIG_DIR` when that is set), `.claude/settings.json` and
`.claude/settings.local.json` in the project. It doesn't check managed settings.

## Status line

A plugin can't set Claude Code's `statusLine`. A plugin's `settings.json` only applies `agent` and
`subagentStatusLine` ([Plugin components: default settings](https://code.claude.com/docs/en/plugins/components#default-settings)).
prism-cli sets it instead. From your shell:

```bash
prism-cli enable claude-code            # shows the plan and a diff, backs up settings.json, asks first
prism-cli enable claude-code --status   # status line, plugin and MCP server configuration
prism-cli enable claude-code --uninstall
```

It writes `statusLine` to `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that
is set) and keeps every other key. If you already have a status line, it shows it and stops; pass
`--replace` to swap it, and `--uninstall` puts it back. The status line looks like this:

```text
PRISM codewatch-demo · 2 high 1 med · today $34.08 · month $480
session $1.20 · +156/−23 · ctx 42% · cache 91%
```

![Claude Code's prompt box with the PRISM status line under it: PRISM checkout-service, 1 high 1 med 2 low, today $12.40, month $187, then session $0.00, +0/−0 and the model](../assets/images/prism-cli/claude-code-statusline-dark.png)

*At the start of a session, with demo data. The second row's figures come from Claude Code and fill in as the session runs.*

`prism-cli statusline` reads only cached files (the dashboard's usage cache and the newest pre-push
review of the repo), so the spend figures are as fresh as the last `prism-cli dashboard` run. See
[Claude Code status line](../USER_GUIDE.md#claude-code-status-line).

## Uninstall

```text
/plugin uninstall prism@prism-d1-velocity
/plugin marketplace remove prism-d1-velocity
```

Or from your shell: `claude plugin uninstall prism@prism-d1-velocity`, then
`claude plugin marketplace remove prism-d1-velocity`.

## Develop

- Validate: `claude plugin validate ./claude-plugin` and `claude plugin validate .` (the
  marketplace) from the repository root.
- Test the hook scripts: `node --test claude-plugin/test/session-start.test.mjs claude-plugin/test/harness-hook.test.mjs`.
  The harness engine and the Claude adapter are tested in `cli/test/harness.test.ts`.
- Try a local copy without touching your own config: point `CLAUDE_CONFIG_DIR` at an empty
  directory, then run `claude plugin marketplace add <path to your clone>` and
  `claude plugin install prism@prism-d1-velocity`.

Layout, as [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference#standard-layout)
describes it:

```text
.claude-plugin/marketplace.json     marketplace (repository root)
claude-plugin/
  .claude-plugin/plugin.json        manifest
  .mcp.json                         MCP server "prism" -> ${PRISM_CLI:-prism-cli} mcp
  hooks/hooks.json                  SessionStart -> session-start.mjs; SessionStart, Stop, SubagentStop,
                                    PreToolUse (Bash: git push, git config, git -c), SessionEnd -> harness-hook.mjs
  scripts/session-start.mjs
  scripts/harness-hook.mjs          passes hook JSON to prism-cli codewatch hook --client claude
  skills/<name>/SKILL.md            prism, findings, report, fix, review, spend, dashboard
  test/session-start.test.mjs
  test/harness-hook.test.mjs
```
